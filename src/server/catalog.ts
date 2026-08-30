import { config } from './config.ts'
import { instantQuery, labelNames, labelValues, metadata, metricNames } from './prom.ts'
import type { MetricMetadata } from './prom.ts'
import type { Target, TargetFilter, TargetSelection } from '../shared/types.ts'

export interface Catalog {
  names: Set<string>
  meta: Map<string, MetricMetadata>
  fetchedAt: number
}

let cached: Catalog | null = null
let inflight: Promise<Catalog> | null = null

/**
 * The metric catalog is every metric name plus its HELP/TYPE. Signal
 * resolution consults it constantly, so it is fetched once and cached — but
 * the fetch is deduped, because the first page load fires several requests
 * that all want it at the same time.
 */
export async function getCatalog(force = false): Promise<Catalog> {
  const fresh = cached && Date.now() - cached.fetchedAt < config.catalogTtlMs
  if (fresh && !force) return cached!
  if (inflight && !force) return inflight

  inflight = (async () => {
    const [names, meta] = await Promise.all([
      metricNames(),
      metadata().catch(() => ({}) as Record<string, MetricMetadata[]>),
    ])

    const metaMap = new Map<string, MetricMetadata>()
    for (const [name, entries] of Object.entries(meta)) {
      // Different targets can report different HELP for the same name; the
      // first entry is representative enough for a tooltip.
      if (entries[0]) metaMap.set(name, entries[0])
    }

    cached = { names: new Set(names), meta: metaMap, fetchedAt: Date.now() }
    return cached
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
}

export function invalidateCatalog(): void {
  cached = null
}

/** Label values that are dangerous or useless to offer as a narrowing filter. */
const NON_NARROWING_LABELS = new Set([
  '__name__',
  'job',
  'instance',
  'le', // histogram bucket boundary
  'quantile',
])

/** Labels worth offering as a narrowing filter, in the order we prefer them. */
const NARROWING_PREFERENCE = [
  'namespace',
  'cluster',
  'environment',
  'env',
  'service',
  'application',
  'app',
  'pod',
  'container',
  'deployment',
  'region',
  'zone',
]

/**
 * Every job Prometheus is scraping, with a series count so the user can tell
 * a real application apart from a barely-instrumented sidecar.
 */
export async function listTargets(): Promise<Target[]> {
  const counts = await instantQuery('count by (job) ({__name__=~".+"})')

  const targets = counts
    .filter((row) => row.metric.job)
    .map((row) => ({
      job: row.metric.job!,
      seriesCount: row.value ?? 0,
      narrowableBy: [] as string[],
    }))
    .sort((a, b) => b.seriesCount - a.seriesCount)

  return targets
}

/** Which labels can usefully narrow this job, and are actually present on it. */
export async function narrowingLabelsFor(job: string): Promise<string[]> {
  const names = await labelNames([`{job="${escapeLabelValue(job)}"}`])
  const present = new Set(names.filter((n) => !NON_NARROWING_LABELS.has(n)))

  const preferred = NARROWING_PREFERENCE.filter((n) => present.has(n))
  return preferred.slice(0, 6)
}

/** Distinct values of `label` within a job, so the UI can offer a dropdown. */
export async function narrowingValuesFor(
  job: string,
  label: string,
  filters: TargetFilter[] = [],
): Promise<string[]> {
  const selector = buildSelector({ job, filters })
  const values = await labelValues(label, [`{${selector}}`])
  return values.sort().slice(0, 500)
}

/**
 * Escapes a label value for interpolation into PromQL. Prometheus label values
 * are arbitrary UTF-8, and a stray quote or backslash would otherwise produce a
 * syntax error or, worse, a selector that silently matches the wrong series.
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Escapes a string for use inside a PromQL regex matcher (`=~`). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Builds the label-matcher body for a target, e.g.
 * `job="checkout",namespace="prod"`. Callers wrap it in braces or splice it
 * into an existing selector.
 */
export function buildSelector(selection: { job: string; filters: TargetFilter[] }): string {
  const parts = [`job="${escapeLabelValue(selection.job)}"`]
  for (const filter of selection.filters) {
    if (!filter.label || !filter.value) continue
    parts.push(`${filter.label}="${escapeLabelValue(filter.value)}"`)
  }
  return parts.join(',')
}

/**
 * Selector for a playbook's dependency (a Redis or Postgres exporter), which
 * lives under its own job rather than the application's. Falls back to an
 * empty selector so a signal can still resolve across all jobs.
 */
export function buildDependencySelector(selection: TargetSelection): string {
  if (!selection.dependencyJob) return ''
  return `job="${escapeLabelValue(selection.dependencyJob)}"`
}

/** Joins a base selector with extra matchers, tolerating an empty base. */
export function withSelector(base: string, ...extra: string[]): string {
  const parts = [base, ...extra].filter((p) => p && p.length > 0)
  return parts.join(',')
}

/** Above this many pods, a `pod=~"a|b|c"` matcher stops being reasonable. */
const MAX_PODS_IN_SELECTOR = 120

/**
 * Container metrics come from cAdvisor and kube-state-metrics, which scrape
 * under their own jobs — `job="my-app"` will never match them. They are keyed
 * by namespace and pod instead, so to tie them back to the application we ask
 * Prometheus which namespace/pod the application's *own* series carry, and
 * build a selector out of that.
 *
 * Returns null when the application's metrics carry no such labels, which is
 * the honest answer: there is no way to connect the two. Resolution turns that
 * into a gap with an explanation rather than silently matching the whole
 * cluster.
 */
export async function deriveInfraSelector(targetSelector: string): Promise<string | null> {
  let rows: { metric: Record<string, string>; value: number | null }[]
  try {
    rows = await instantQuery(`count by (namespace, pod) ({${targetSelector}})`)
  } catch {
    return null
  }

  const namespaces = new Set<string>()
  const pods = new Set<string>()
  for (const row of rows) {
    if (row.metric.namespace) namespaces.add(row.metric.namespace)
    if (row.metric.pod) pods.add(row.metric.pod)
  }

  const parts: string[] = []

  // A namespace matcher alone is far too broad, but combined with pods it
  // keeps the query cheap by pruning most of the index up front.
  if (namespaces.size > 0 && namespaces.size <= 5) {
    parts.push(`namespace=~"${[...namespaces].map(escapeRegex).join('|')}"`)
  }

  if (pods.size > 0 && pods.size <= MAX_PODS_IN_SELECTOR) {
    parts.push(`pod=~"${[...pods].map(escapeRegex).join('|')}"`)
  } else if (pods.size > MAX_PODS_IN_SELECTOR && parts.length > 0) {
    // Too many pods to enumerate, but we do have a namespace. Better to scope
    // to the namespace than to give up entirely.
    return parts.join(',')
  }

  // A namespace on its own would pull in every workload sharing it, so require
  // a pod matcher before claiming we identified this application.
  if (pods.size === 0) return null

  return parts.join(',')
}
