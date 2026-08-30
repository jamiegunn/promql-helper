import { getCatalog } from './catalog.ts'
import { PLAYBOOKS } from './playbooks/index.ts'
import { SIGNALS } from './signals.ts'
import type { CapabilityReport, SourceGroup } from '../shared/types.ts'

/**
 * Everything this app knows how to look for, checked against what the
 * connected Prometheus actually exposes.
 *
 * The signal registry is a curated allowlist, which is the app's main
 * limitation — so rather than leave that implicit, this renders the whole
 * registry as an auditable list: every metric name it will try, which
 * instrumentation convention it belongs to, whether it exists here, and which
 * investigation depends on it.
 *
 * Presence is global rather than per-target. This answers "does this
 * Prometheus have it at all", which is the question when you are auditing
 * coverage; whether a specific job has it is what the wizard's step 2 reports.
 */
export async function buildCapabilityReport(): Promise<CapabilityReport> {
  const catalog = await getCatalog()

  // Which investigations depend on each signal, so a missing metric can be
  // traced to the questions it stops you asking.
  const usedBy = new Map<string, string[]>()
  for (const playbook of PLAYBOOKS) {
    for (const id of playbook.signals) {
      usedBy.set(id, [...(usedBy.get(id) ?? []), playbook.title])
    }
  }

  // Panels name their signals, so a signal can point at the specific checks it
  // unlocks rather than just the investigation.
  const unlocks = new Map<string, string[]>()
  for (const playbook of PLAYBOOKS) {
    for (const panel of playbook.panels) {
      for (const id of panel.requires) {
        unlocks.set(id, [...(unlocks.get(id) ?? []), panel.title])
      }
    }
  }

  const bySource = new Map<string, SourceGroup>()

  for (const signal of SIGNALS) {
    for (const candidate of signal.candidates) {
      const present = catalog.names.has(candidate.metric)
      const meta = catalog.meta.get(candidate.metric)

      const group = bySource.get(candidate.flavor) ?? {
        flavor: candidate.flavor,
        origin: originOf(candidate.flavor),
        metricsKnown: 0,
        metricsPresent: 0,
        entries: [],
      }

      group.metricsKnown++
      if (present) group.metricsPresent++

      group.entries.push({
        signalId: signal.id,
        signalTitle: signal.title,
        metric: candidate.metric,
        kind: signal.kind,
        scope: signal.scope,
        present,
        help: meta?.help,
        labels: candidate.labels ? Object.entries(candidate.labels).map(([role, name]) => ({ role, name })) : [],
        remedy: signal.remedy,
        usedBy: usedBy.get(signal.id) ?? [],
        unlocks: [...new Set(unlocks.get(signal.id) ?? [])],
      })

      bySource.set(candidate.flavor, group)
    }
  }

  const sources = [...bySource.values()].sort(
    (a, b) => b.metricsPresent - a.metricsPresent || a.flavor.localeCompare(b.flavor),
  )

  return {
    metricCount: catalog.names.size,
    signalCount: SIGNALS.length,
    candidateCount: SIGNALS.reduce((n, s) => n + s.candidates.length, 0),
    sources,
    investigations: PLAYBOOKS.map((playbook) => ({
      id: playbook.id,
      title: playbook.title,
      question: playbook.question,
      summary: playbook.summary,
      dependencyLabel: playbook.dependency?.label,
      panels: playbook.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        question: panel.question,
        viz: panel.viz,
        unit: panel.unit,
        requires: panel.requires,
      })),
    })),
  }
}

/**
 * Where a convention's metrics physically come from. This is the distinction
 * that trips people up — application metrics and container metrics are scraped
 * from completely different places, under different jobs.
 */
function originOf(flavor: string): SourceGroup['origin'] {
  if (/exporter|mysqld|postgres|redis_/i.test(flavor)) return 'exporter'
  if (/cAdvisor|kube-state/i.test(flavor)) return 'platform'
  return 'application'
}
