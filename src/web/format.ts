import type { Severity, Unit } from '../shared/types.ts'

/** Formats a value for display, given the unit its panel declared. */
export function formatValue(value: number | null, unit: Unit, compact = false): string {
  if (value === null || !Number.isFinite(value)) return '—'

  switch (unit) {
    case 'bytes':
      return formatBytes(value)
    case 'seconds':
      return formatSeconds(value)
    case 'milliseconds':
      return formatSeconds(value / 1000)
    case 'percent':
      return `${round(value, value < 10 ? 1 : 0)}%`
    case 'ratio':
      return `${round(value * 100, 1)}%`
    case 'rps':
      return compact ? formatShort(value) : `${formatShort(value)}/s`
    case 'cores':
      return `${round(value, value < 10 ? 2 : 1)}`
    case 'short':
    case 'none':
    default:
      return formatShort(value)
  }
}

/** Axis ticks want the bare number — no unit suffix cluttering the gutter. */
export function formatTick(value: number, unit: Unit): string {
  if (unit === 'bytes') return formatBytes(value)
  if (unit === 'seconds') return formatSeconds(value)
  if (unit === 'percent') return `${round(value, value < 10 ? 1 : 0)}%`
  if (unit === 'ratio') return `${round(value * 100, 0)}%`
  return formatShort(value)
}

export function formatBytes(v: number): string {
  const sign = v < 0 ? '-' : ''
  let n = Math.abs(v)
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${sign}${round(n, n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatSeconds(v: number): string {
  const abs = Math.abs(v)
  if (abs === 0) return '0'
  if (abs < 0.001) return `${round(v * 1_000_000, 0)}µs`
  if (abs < 1) return `${round(v * 1000, abs < 0.01 ? 1 : 0)}ms`
  if (abs < 60) return `${round(v, 2)}s`
  if (abs < 3600) return `${round(v / 60, 1)}m`
  return `${round(v / 3600, 1)}h`
}

export function formatShort(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `${round(v / 1_000_000_000, 1)}B`
  if (abs >= 1_000_000) return `${round(v / 1_000_000, 1)}M`
  if (abs >= 1000) return `${round(v / 1000, 1)}k`
  if (abs >= 100) return round(v, 0)
  if (abs >= 1) return round(v, 1)
  if (abs === 0) return '0'
  return round(v, 3)
}

function round(v: number, places: number): string {
  const fixed = v.toFixed(places)
  // Trim a trailing .0 so "12.0" reads as "12" without losing "12.5".
  return places > 0 ? fixed.replace(/\.0+$/, '') : fixed
}

export function formatTime(unixSeconds: number, spanSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  if (spanSeconds > 3 * 86400) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  if (spanSeconds > 86400) {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatFullTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * Status is never carried by colour alone — every severity ships with a glyph
 * and a word, so it survives colour-blindness, greyscale print and
 * forced-colors mode.
 */
export const SEVERITY_ICON: Record<Severity, string> = {
  ok: '✓',
  warning: '▲',
  serious: '▲',
  critical: '✕',
  unknown: '·',
}

export const SEVERITY_WORD: Record<Severity, string> = {
  ok: 'Healthy',
  warning: 'Worth a look',
  serious: 'Needs attention',
  critical: 'Acting up',
  unknown: 'Not enough data',
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  ok: 'var(--status-good)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)',
  unknown: 'var(--status-unknown)',
}

/** Categorical slots, assigned in fixed order and never cycled past eight. */
export const SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
]

export function seriesColor(index: number): string {
  return SERIES_COLORS[index] ?? 'var(--text-muted)'
}
