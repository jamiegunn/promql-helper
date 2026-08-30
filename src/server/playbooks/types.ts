import type { Resolved } from '../signals.ts'
import type { Finding, Series, Unit } from '../../shared/types.ts'

export interface PanelContext {
  /** Signals that resolved for this run. Guarded by the panel's `requires`. */
  signals: Map<string, Resolved>
  /** Fetch a required signal. Throws if absent — `requires` should prevent that. */
  s(id: string): Resolved
  /** True if every listed signal resolved. */
  hasAll(...ids: string[]): boolean
  range: { start: number; end: number; step: number }
  /**
   * Rate window sized to the selected range — always at least 4 scrape
   * intervals wide, so `rate()` has enough samples to be meaningful, and never
   * narrower than the step, which would leave gaps between points.
   */
  rateWindow: string
  /** The whole selected window as a PromQL duration, for *_over_time. */
  windowDuration: string
}

export interface QuerySpec {
  expr: string
  /** Fixed legend name — for single-series queries like "p99". */
  name?: string
  /** Label names to build the legend from, in order. Falls back to all labels. */
  legendLabels?: string[]
}

export interface PanelDef {
  id: string
  title: string
  /** The plain-language question this panel answers. Shown above the chart. */
  question: string
  viz: 'timeseries' | 'stat' | 'table'
  unit: Unit
  /** Signal ids that must all resolve for this panel to run. */
  requires: string[]
  /** Extra guard beyond `requires` — e.g. "this flavor has a status label". */
  when?: (ctx: PanelContext) => boolean
  build: (ctx: PanelContext) => QuerySpec[]
  /** Turns the numbers into a sentence. Runs after the queries return. */
  interpret?: (series: Series[], ctx: PanelContext) => Finding | null
  /** Label beneath the number on a `stat` panel. */
  statLabel?: string
}

export interface Playbook {
  id: string
  title: string
  /** The user's question, in their words. */
  question: string
  summary: string
  /** Every signal any panel might use. Resolved once per run. */
  signals: string[]
  /**
   * Set when the playbook needs a second scrape target — a Redis or database
   * exporter, which lives under its own job rather than the application's.
   */
  dependency?: {
    label: string
    hint: string
    /** Signal whose presence identifies a candidate job. */
    probeSignal: string
  }
  panels: PanelDef[]
}

// ---------------------------------------------------------------------------
// Helpers shared by every playbook
// ---------------------------------------------------------------------------

/** Applies a signal's unit scale, omitting the multiply when it is a no-op. */
export function scaled(expr: string, scale: number): string {
  return scale === 1 ? expr : `(${expr}) * ${scale}`
}

/** Last non-null value of a series. */
export function lastValue(series: Series): number | null {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const v = series.points[i]?.v
    if (v !== null && v !== undefined) return v
  }
  return null
}

/** Largest value across every series in a panel. */
export function peak(all: Series[]): number | null {
  let max: number | null = null
  for (const s of all) {
    for (const p of s.points) {
      if (p.v !== null && (max === null || p.v > max)) max = p.v
    }
  }
  return max
}

/** Mean of every non-null point across every series. */
export function mean(all: Series[]): number | null {
  let sum = 0
  let n = 0
  for (const s of all) {
    for (const p of s.points) {
      if (p.v !== null) {
        sum += p.v
        n++
      }
    }
  }
  return n === 0 ? null : sum / n
}

/** The series carrying the largest single value, for naming the worst offender. */
export function worstSeries(all: Series[]): { series: Series; value: number } | null {
  let best: { series: Series; value: number } | null = null
  for (const s of all) {
    for (const p of s.points) {
      if (p.v !== null && (best === null || p.v > best.value)) best = { series: s, value: p.v }
    }
  }
  return best
}

/** Fraction of points across all series that exceed a threshold. */
export function fractionAbove(all: Series[], threshold: number): number {
  let hits = 0
  let total = 0
  for (const s of all) {
    for (const p of s.points) {
      if (p.v === null) continue
      total++
      if (p.v > threshold) hits++
    }
  }
  return total === 0 ? 0 : hits / total
}

export function fmtSeconds(v: number): string {
  if (v < 0.001) return `${(v * 1_000_000).toFixed(0)}µs`
  if (v < 1) return `${(v * 1000).toFixed(0)}ms`
  return `${v.toFixed(2)}s`
}

export function fmtBytes(v: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let n = v
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtPercent(v: number): string {
  return `${v.toFixed(v < 10 ? 1 : 0)}%`
}

export function fmtShort(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
  if (Math.abs(v) >= 10) return v.toFixed(0)
  return v.toFixed(2)
}

/** A finding meaning "the query ran but there was nothing to measure". */
export function noData(what: string): Finding {
  return {
    severity: 'unknown',
    headline: `No ${what} recorded in this window.`,
    detail:
      'Either the workload is idle, or the metric stopped being scraped. Try a longer time range to tell those apart.',
  }
}
