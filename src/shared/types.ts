/**
 * Types shared between the server and the browser. Kept free of any Node or
 * DOM imports so both sides can pull from here.
 */

export type Severity = 'ok' | 'warning' | 'serious' | 'critical' | 'unknown'

/** Rank used to roll panel findings up into a single verdict. */
export const SEVERITY_RANK: Record<Severity, number> = {
  ok: 0,
  unknown: 1,
  warning: 2,
  serious: 3,
  critical: 4,
}

export type Unit =
  | 'none'
  | 'short' // 1.2k, 3.4M — unitless counts
  | 'rps' // per-second rate
  | 'seconds'
  | 'milliseconds'
  | 'percent' // already 0–100
  | 'ratio' // 0–1, rendered as a percentage
  | 'bytes'
  | 'cores'

/** One scrape target the user can investigate. */
export interface Target {
  job: string
  seriesCount: number
  /** Label names present on this job that are useful for narrowing further. */
  narrowableBy: string[]
}

/** A refinement the user picked in step 1, e.g. namespace=prod, pod=checkout-7f. */
export interface TargetFilter {
  label: string
  value: string
}

export interface TargetSelection {
  job: string
  filters: TargetFilter[]
  /** Optional job for a playbook's dependency (the Redis or DB exporter). */
  dependencyJob?: string
}

/** What a signal resolved to in this particular Prometheus. */
export interface ResolvedSignal {
  signalId: string
  title: string
  /** The concrete metric name that exists here, e.g. http_server_requests_seconds_bucket. */
  metric: string
  /** Which exporter convention matched — shown to the user as provenance. */
  flavor: string
  /** Live label names carried by this metric on this target. */
  labels: string[]
  /** Series count at resolution time — a cheap cardinality signal. */
  seriesCount: number
}

export interface SignalGap {
  signalId: string
  title: string
  /** Metric names we looked for and did not find. */
  lookedFor: string[]
  /** What the user would have to instrument to unlock this. */
  remedy: string
}

/** An investigation the user can choose in step 2. */
export interface InvestigationOffer {
  id: string
  title: string
  /** The question in the user's words, e.g. "Is it serving happy users?" */
  question: string
  summary: string
  /** 'ready' = every panel can run. 'partial' = some panels. 'unavailable' = none. */
  availability: 'ready' | 'partial' | 'unavailable'
  panelsAvailable: number
  panelsTotal: number
  resolved: ResolvedSignal[]
  gaps: SignalGap[]
  /** Present when the playbook needs a second target (a Redis or DB exporter). */
  dependency?: {
    label: string
    hint: string
    /** Jobs where the dependency's metrics were found. */
    candidates: string[]
  }
}

export interface SeriesPoint {
  t: number // unix seconds
  v: number | null // null = gap in the data, not zero
}

export interface Series {
  /** Rendered legend label, e.g. `GET /checkout · 500`. */
  name: string
  /** Raw Prometheus labels, for the table view and tooltip. */
  labels: Record<string, string>
  points: SeriesPoint[]
}

export interface Finding {
  severity: Severity
  /** One sentence, plain language, no PromQL. */
  headline: string
  /** Optional supporting detail — what to look at next. */
  detail?: string
}

export interface PanelResult {
  id: string
  title: string
  /** The plain-language question this panel answers. */
  question: string
  viz: 'timeseries' | 'stat' | 'table'
  unit: Unit
  /** The PromQL that produced this, for the copy button. */
  queries: { expr: string; legend: string }[]
  series: Series[]
  /** Single headline number for `stat` panels. */
  stat?: { value: number | null; label: string; unit: Unit }
  finding?: Finding
  /** Set when the panel ran but Prometheus returned an error or nothing. */
  note?: string
}

export interface Report {
  investigationId: string
  title: string
  question: string
  target: TargetSelection
  range: { start: number; end: number; step: number }
  verdict: {
    severity: Severity
    headline: string
    findings: Finding[]
  }
  panels: PanelResult[]
  resolved: ResolvedSignal[]
  gaps: SignalGap[]
  /** Wall-clock ms the whole investigation took. */
  tookMs: number
}

export interface ConnectionStatus {
  connected: boolean
  url: string
  authenticated: boolean
  version?: string
  metricCount?: number
  error?: string
}

/** Named time windows offered in the UI. `seconds` drives start/end/step. */
export const TIME_RANGES = [
  { id: '30m', label: 'Last 30 min', seconds: 1800 },
  { id: '1h', label: 'Last hour', seconds: 3600 },
  { id: '6h', label: 'Last 6 hours', seconds: 21600 },
  { id: '24h', label: 'Last 24 hours', seconds: 86400 },
  { id: '7d', label: 'Last 7 days', seconds: 604800 },
] as const

export type TimeRangeId = (typeof TIME_RANGES)[number]['id']
