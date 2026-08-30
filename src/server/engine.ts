import {
  buildDependencySelector,
  buildSelector,
  deriveInfraSelector,
  escapeRegex,
} from './catalog.ts'
import { instantQuery, rangeQuery } from './prom.ts'
import { getSignal, resolveSignals } from './signals.ts'
import type { Resolved, Selectors } from './signals.ts'
import { getPlaybook, PLAYBOOKS } from './playbooks/index.ts'
import type { PanelContext, PanelDef, Playbook } from './playbooks/index.ts'
import { SEVERITY_RANK, TIME_RANGES } from '../shared/types.ts'
import type {
  Finding,
  InvestigationOffer,
  PanelResult,
  Report,
  Series,
  Severity,
  TargetSelection,
  TimeRangeId,
} from '../shared/types.ts'

// ---------------------------------------------------------------------------
// Time range arithmetic
// ---------------------------------------------------------------------------

/** Roughly how many points we want across a chart. */
const TARGET_POINTS = 240

export interface TimeWindow {
  start: number
  end: number
  step: number
  rateWindow: string
  windowDuration: string
  seconds: number
}

export function resolveWindow(rangeId: TimeRangeId, now = Math.floor(Date.now() / 1000)): TimeWindow {
  const range = TIME_RANGES.find((r) => r.id === rangeId) ?? TIME_RANGES[1]
  const seconds = range.seconds

  // Snap the step to something a human recognises, so axis ticks land on
  // round times rather than at 37-second intervals.
  const raw = seconds / TARGET_POINTS
  const NICE = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600]
  const step = NICE.find((s) => s >= raw) ?? NICE[NICE.length - 1]!

  return {
    start: now - seconds,
    end: now,
    step,
    // A rate() window narrower than the step leaves gaps between points, and
    // one narrower than a few scrape intervals is too noisy to read. Four
    // steps, floored at a minute, satisfies both.
    rateWindow: fmtDuration(Math.max(step * 4, 60)),
    windowDuration: fmtDuration(seconds),
    seconds,
  }
}

/** Formats seconds as a PromQL duration literal. */
export function fmtDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export async function buildSelectors(selection: TargetSelection): Promise<Selectors> {
  const target = buildSelector(selection)
  return {
    target,
    dependency: buildDependencySelector(selection),
    infra: await deriveInfraSelector(target),
  }
}

// ---------------------------------------------------------------------------
// Step 2: which investigations can this target support?
// ---------------------------------------------------------------------------

/**
 * Resolves every signal any playbook might need in one pass, then works out
 * per playbook how much of it would actually run. This is the step that turns
 * "here are 40,000 metric names" into "here are the four questions you can
 * answer about this service".
 */
export async function offerInvestigations(selection: TargetSelection): Promise<InvestigationOffer[]> {
  const selectors = await buildSelectors(selection)
  const allSignals = [...new Set(PLAYBOOKS.flatMap((p) => p.signals))]
  const { resolved, gaps } = await resolveSignals(allSignals, selectors, false)

  const gapById = new Map(gaps.map((g) => [g.signalId, g]))

  const offers = await Promise.all(
    PLAYBOOKS.map(async (playbook) => {
      const mine = new Map<string, Resolved>()
      for (const id of playbook.signals) {
        const r = resolved.get(id)
        if (r) mine.set(id, r)
      }

      const ctx = makeContext(mine, resolveWindow('1h'))
      const runnable = playbook.panels.filter((panel) => canRun(panel, mine, ctx))

      const myGaps = playbook.signals
        .map((id) => gapById.get(id))
        .filter((g): g is NonNullable<typeof g> => Boolean(g))

      const availability: InvestigationOffer['availability'] =
        runnable.length === 0
          ? 'unavailable'
          : runnable.length === playbook.panels.length
            ? 'ready'
            : 'partial'

      const offer: InvestigationOffer = {
        id: playbook.id,
        title: playbook.title,
        question: playbook.question,
        summary: playbook.summary,
        availability,
        panelsAvailable: runnable.length,
        panelsTotal: playbook.panels.length,
        resolved: [...mine.values()].map(stripResolved),
        gaps: myGaps,
      }

      if (playbook.dependency) {
        offer.dependency = {
          label: playbook.dependency.label,
          hint: playbook.dependency.hint,
          candidates: await findDependencyJobs(playbook.dependency.probeSignal),
        }
      }

      return offer
    }),
  )

  // Ready investigations first — that is the whole point of the screen.
  const order = { ready: 0, partial: 1, unavailable: 2 }
  return offers.sort(
    (a, b) => order[a.availability] - order[b.availability] || b.panelsAvailable - a.panelsAvailable,
  )
}

/** Jobs where a dependency's metrics live, e.g. which job is the Redis exporter. */
async function findDependencyJobs(probeSignalId: string): Promise<string[]> {
  const signal = getSignal(probeSignalId)
  const names = signal.candidates.map((c) => escapeRegex(c.metric)).join('|')
  try {
    const rows = await instantQuery(`count by (job) ({__name__=~"${names}"})`)
    return [...new Set(rows.map((r) => r.metric.job).filter((j): j is string => Boolean(j)))].sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Step 3: run the investigation
// ---------------------------------------------------------------------------

export async function runInvestigation(
  playbookId: string,
  selection: TargetSelection,
  rangeId: TimeRangeId,
): Promise<Report> {
  const playbook = getPlaybook(playbookId)
  if (!playbook) throw new Error(`Unknown investigation: ${playbookId}`)

  const startedAt = Date.now()
  const window = resolveWindow(rangeId)
  const selectors = await buildSelectors(selection)
  const { resolved, gaps } = await resolveSignals(playbook.signals, selectors, true)

  const ctx = makeContext(resolved, window)
  const runnable = playbook.panels.filter((panel) => canRun(panel, resolved, ctx))

  // Bounded concurrency: an investigation can be twenty-odd queries and firing
  // them all at once is a good way to get rate-limited by a shared Prometheus.
  const panels = await mapWithConcurrency(runnable, 6, (panel) => runPanel(panel, ctx))

  return {
    investigationId: playbook.id,
    title: playbook.title,
    question: playbook.question,
    target: selection,
    range: { start: window.start, end: window.end, step: window.step },
    verdict: buildVerdict(playbook, panels),
    panels,
    resolved: [...resolved.values()].map(stripResolved),
    gaps,
    tookMs: Date.now() - startedAt,
  }
}

async function runPanel(panel: PanelDef, ctx: PanelContext): Promise<PanelResult> {
  const result: PanelResult = {
    id: panel.id,
    title: panel.title,
    question: panel.question,
    viz: panel.viz,
    unit: panel.unit,
    queries: [],
    series: [],
  }

  let specs
  try {
    specs = panel.build(ctx)
  } catch (err) {
    result.note = `Could not build this query: ${errText(err)}`
    return result
  }

  result.queries = specs.map((spec) => ({
    expr: spec.expr,
    legend: spec.name ?? (spec.legendLabels ? `by ${spec.legendLabels.join(', ')}` : 'all series'),
  }))

  const collected: Series[] = []

  for (const spec of specs) {
    try {
      if (panel.viz === 'timeseries') {
        const raw = await rangeQuery(spec.expr, ctx.range.start, ctx.range.end, ctx.range.step)
        for (const item of raw) {
          collected.push({
            name: legendFor(spec, item.metric, raw.length),
            labels: item.metric,
            points: item.points,
          })
        }
      } else {
        // Stats and tables are a single number per series, so an instant query
        // at the end of the window is both cheaper and more accurate than
        // reducing a range result client-side.
        const raw = await instantQuery(spec.expr, ctx.range.end)
        for (const item of raw) {
          collected.push({
            name: legendFor(spec, item.metric, raw.length),
            labels: item.metric,
            points: [{ t: ctx.range.end, v: item.value }],
          })
        }
      }
    } catch (err) {
      result.note = errText(err)
    }
  }

  // Sorted by name so a series keeps the same categorical slot across reruns.
  // Colour is assigned by position, and a reader who learned "checkout is
  // green" must not have it repainted when the next refresh returns the same
  // series in a different order.
  collected.sort((a, b) => a.name.localeCompare(b.name))
  result.series = collected

  if (panel.viz === 'stat') {
    const first = collected[0]
    const value = first ? (first.points[first.points.length - 1]?.v ?? null) : null
    result.stat = { value, label: panel.statLabel ?? panel.title, unit: panel.unit }
  }

  if (panel.interpret) {
    try {
      const finding = panel.interpret(collected, ctx)
      if (finding) result.finding = finding
    } catch (err) {
      // A broken heuristic must never take the data down with it.
      result.note = result.note ?? `Could not interpret this panel: ${errText(err)}`
    }
  }

  return result
}

/**
 * Rolls panel findings up into one answer. The verdict is the worst thing
 * found, because that is what the person asking the question needs to hear
 * first — an average of the findings would hide exactly the panel that matters.
 */
function buildVerdict(playbook: Playbook, panels: PanelResult[]): Report['verdict'] {
  const findings = panels
    .map((p) => p.finding)
    .filter((f): f is Finding => Boolean(f))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])

  const worst = findings[0]
  if (!worst) {
    return {
      severity: 'unknown',
      headline: 'The queries ran, but there was not enough data to draw a conclusion.',
      findings: [],
    }
  }

  const notable = findings.filter((f) => f.severity !== 'ok')

  if (notable.length === 0) {
    return {
      severity: 'ok',
      headline: healthyHeadline(playbook.id),
      findings,
    }
  }

  const severity: Severity = worst.severity
  const extra = notable.length - 1
  const headline =
    extra > 0
      ? `${worst.headline} (and ${extra} other finding${extra === 1 ? '' : 's'})`
      : worst.headline

  return { severity, headline, findings }
}

function healthyHeadline(playbookId: string): string {
  switch (playbookId) {
    case 'service-health':
      return 'Users are being served quickly and successfully.'
    case 'resources':
      return 'CPU and memory are well within the limits configured for this workload.'
    case 'jvm':
      return 'The JVM is healthy — heap, garbage collection and threads all look normal.'
    case 'database':
      return 'The database is keeping up and nothing is queueing for a connection.'
    case 'redis':
      return 'Redis is keeping up and the cache is doing its job.'
    default:
      return 'Nothing concerning found.'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(resolved: Map<string, Resolved>, window: TimeWindow): PanelContext {
  return {
    signals: resolved,
    s(id) {
      const signal = resolved.get(id)
      if (!signal) throw new Error(`Signal ${id} was not resolved`)
      return signal
    },
    hasAll(...ids) {
      return ids.every((id) => resolved.has(id))
    },
    range: { start: window.start, end: window.end, step: window.step },
    rateWindow: window.rateWindow,
    windowDuration: window.windowDuration,
  }
}

function canRun(panel: PanelDef, resolved: Map<string, Resolved>, ctx: PanelContext): boolean {
  if (!panel.requires.every((id) => resolved.has(id))) return false
  if (!panel.when) return true
  try {
    return panel.when(ctx)
  } catch {
    return false
  }
}

/** Builds a legend label from a spec and a series' labels. */
function legendFor(
  spec: { name?: string; legendLabels?: string[] },
  labels: Record<string, string>,
  seriesCount: number,
): string {
  if (spec.name && seriesCount <= 1) return spec.name

  if (spec.legendLabels?.length) {
    const parts = spec.legendLabels.map((l) => labels[l]).filter(Boolean)
    if (parts.length) return parts.join(' · ')
  }

  // Fall back to whatever distinguishing labels survived aggregation.
  const parts = Object.entries(labels)
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => (spec.legendLabels?.includes(k) ? v : `${k}=${v}`))
  if (parts.length) return parts.join(' · ')

  return spec.name ?? 'value'
}

/** Drops the closures so a Resolved can cross the wire as JSON. */
function stripResolved(r: Resolved) {
  return {
    signalId: r.signalId,
    title: r.title,
    metric: r.metric,
    flavor: r.flavor,
    labels: r.labels,
    seriesCount: r.seriesCount,
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
