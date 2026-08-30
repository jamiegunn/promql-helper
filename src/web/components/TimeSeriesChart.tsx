import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Series, Unit } from '../../shared/types.ts'
import { formatFullTime, formatTick, formatTime, formatValue, seriesColor } from '../format.ts'

const PAD = { top: 10, bottom: 26, left: 62 }
/** Right gutter when nothing is labelled at the line ends. */
const PAD_RIGHT_BARE = 18
/** Right gutter reserved for direct end-labels, wide enough for the truncation. */
const PAD_RIGHT_LABELLED = 68
const PLOT_HEIGHT = 200
/** Below this vertical gap, end-labels stop reading as attached to their line. */
const LABEL_COLLISION_PX = 13
/** Past this many series, direct end-labels become clutter; the legend carries it. */
const MAX_DIRECT_LABELS = 4
/** Characters that fit in the label gutter at 11px. */
const LABEL_MAX_CHARS = 10

interface Props {
  series: Series[]
  unit: Unit
  start: number
  end: number
}

export function TimeSeriesChart({ series, unit, start, end }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(680)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState(0)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const model = useMemo(() => buildModel(series), [series])
  const { times, lookup, min, max } = model

  const yFor = (value: number) =>
    PAD.top + PLOT_HEIGHT - ((value - min) / (max - min || 1)) * PLOT_HEIGHT

  // Resolved before the plot width, because whether labels render decides how
  // much right gutter to reserve for them. The y scale depends only on the
  // data and the fixed plot height, so there is no circularity.
  const endLabels = useMemo(() => {
    if (series.length < 2 || series.length > MAX_DIRECT_LABELS) return null
    const items = series.map((s, i) => {
      const last = lastDefined(times, lookup[i]!)
      return last === null ? null : { name: s.name, y: yFor(last), color: seriesColor(i) }
    })
    if (items.some((item) => item === null)) return null

    // Converging lines make stacked labels read as noise rather than as
    // identity, so drop them wholesale and let the legend carry it.
    const ys = items.map((item) => item!.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) {
      if (ys[i]! - ys[i - 1]! < LABEL_COLLISION_PX) return null
    }
    return items as { name: string; y: number; color: string }[]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, times, lookup, min, max])

  const padRight = endLabels ? PAD_RIGHT_LABELLED : PAD_RIGHT_BARE
  const plotW = Math.max(80, width - PAD.left - padRight)
  const height = PLOT_HEIGHT + PAD.top + PAD.bottom

  const xFor = (index: number) =>
    PAD.left + (times.length <= 1 ? plotW / 2 : (index / (times.length - 1)) * plotW)

  const yTicks = useMemo(() => niceTicks(min, max, 4), [min, max])
  const xTickIndexes = useMemo(() => pickXTicks(times.length, plotW), [times.length, plotW])

  useEffect(() => setHoverIndex(null), [series])

  if (series.length === 0 || times.length === 0) {
    return <p className="muted" style={{ margin: '14px 0' }}>No data returned for this window.</p>
  }

  function handleMove(event: React.MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    if (x < PAD.left - 8 || x > PAD.left + plotW + 8) {
      setHoverIndex(null)
      return
    }
    const ratio = (x - PAD.left) / plotW
    const index = Math.round(ratio * (times.length - 1))
    setHoverIndex(Math.max(0, Math.min(times.length - 1, index)))
    setHoverX(x)
  }

  const span = end - start

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        className="chart-svg"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Time series chart with ${series.length} series. The same values are available in the table view.`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Gridlines: solid hairlines one step off the surface, never dashed. */}
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke="var(--gridline)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 10}
              y={yFor(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--text-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatTick(tick, unit)}
            </text>
          </g>
        ))}

        <line
          x1={PAD.left}
          x2={PAD.left + plotW}
          y1={PAD.top + PLOT_HEIGHT}
          y2={PAD.top + PLOT_HEIGHT}
          stroke="var(--baseline)"
          strokeWidth={1}
        />

        {xTickIndexes.map((index) => (
          <text
            key={index}
            x={xFor(index)}
            y={PAD.top + PLOT_HEIGHT + 17}
            textAnchor={index === 0 ? 'start' : index === times.length - 1 ? 'end' : 'middle'}
            fontSize={11}
            fill="var(--text-muted)"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatTime(times[index]!, span)}
          </text>
        ))}

        {hoverIndex !== null && (
          <line
            x1={xFor(hoverIndex)}
            x2={xFor(hoverIndex)}
            y1={PAD.top}
            y2={PAD.top + PLOT_HEIGHT}
            stroke="var(--baseline)"
            strokeWidth={1}
          />
        )}

        {series.map((s, i) => (
          <path
            key={`${s.name}-${i}`}
            d={buildPath(times, lookup[i]!, xFor, yFor)}
            fill="none"
            stroke={seriesColor(i)}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Hover markers carry a 2px surface ring so they stay legible where
            lines cross each other. */}
        {hoverIndex !== null &&
          series.map((s, i) => {
            const value = lookup[i]!.get(times[hoverIndex]!)
            if (value === undefined || value === null) return null
            return (
              <circle
                key={`dot-${i}`}
                cx={xFor(hoverIndex)}
                cy={yFor(value)}
                r={4}
                fill={seriesColor(i)}
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            )
          })}

        {endLabels?.map((label, i) => (
          <text
            key={`end-${i}`}
            x={PAD.left + plotW + 6}
            y={label.y}
            dominantBaseline="middle"
            fontSize={11}
            fill="var(--text-secondary)"
          >
            {truncate(label.name, LABEL_MAX_CHARS)}
          </text>
        ))}
      </svg>

      {hoverIndex !== null && (
        <Tooltip
          x={hoverX}
          containerWidth={width}
          time={times[hoverIndex]!}
          rows={series
            .map((s, i) => ({
              name: s.name,
              color: seriesColor(i),
              value: lookup[i]!.get(times[hoverIndex]!) ?? null,
            }))
            .filter((row) => row.value !== null)
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))}
          unit={unit}
        />
      )}

      {/* A single series is named by the panel title — a one-swatch legend box
          would only restate it. Two or more always get a legend. */}
      {series.length >= 2 && (
        <div className="legend">
          {series.map((s, i) => (
            <span className="legend-item" key={`${s.name}-${i}`}>
              <span className="legend-key" style={{ background: seriesColor(i) }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Tooltip({
  x,
  containerWidth,
  time,
  rows,
  unit,
}: {
  x: number
  containerWidth: number
  time: number
  rows: { name: string; color: string; value: number | null }[]
  unit: Unit
}) {
  const flip = x > containerWidth - 200
  return (
    <div
      className="tooltip"
      style={{ left: flip ? undefined : x + 14, right: flip ? containerWidth - x + 14 : undefined, top: 8 }}
    >
      <div className="tooltip-time">{formatFullTime(time)}</div>
      {rows.slice(0, 10).map((row, i) => (
        <div className="tooltip-row" key={i}>
          <span className="legend-key" style={{ background: row.color }} />
          <span className="tooltip-name">{row.name}</span>
          <span className="tooltip-value">{formatValue(row.value, unit)}</span>
        </div>
      ))}
      {rows.length > 10 && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>+{rows.length - 10} more</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface Model {
  times: number[]
  lookup: Map<number, number>[]
  min: number
  max: number
}

/**
 * Series from separate queries in one panel can start at slightly different
 * timestamps, so the x-axis is the union of every timestamp seen and each
 * series is indexed into it. A missing entry is a genuine gap and breaks the
 * line rather than being drawn as zero.
 */
function buildModel(series: Series[]): Model {
  const timeSet = new Set<number>()
  const lookup: Map<number, number>[] = []

  let min = Infinity
  let max = -Infinity

  for (const s of series) {
    const map = new Map<number, number>()
    for (const point of s.points) {
      timeSet.add(point.t)
      if (point.v !== null && Number.isFinite(point.v)) {
        map.set(point.t, point.v)
        if (point.v < min) min = point.v
        if (point.v > max) max = point.v
      }
    }
    lookup.push(map)
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0
    max = 1
  }

  // Always include zero for rates and counts — a chart of "requests/sec"
  // floating between 480 and 500 exaggerates the variation enormously.
  if (min > 0 && min / (max || 1) > 0.35) min = 0
  if (min === max) {
    min = min === 0 ? 0 : min * 0.9
    max = max === 0 ? 1 : max * 1.1
  } else {
    max += (max - min) * 0.08
  }

  return { times: [...timeSet].sort((a, b) => a - b), lookup, min, max }
}

function buildPath(
  times: number[],
  values: Map<number, number>,
  xFor: (i: number) => number,
  yFor: (v: number) => number,
): string {
  let path = ''
  let pen = false
  for (let i = 0; i < times.length; i++) {
    const value = values.get(times[i]!)
    if (value === undefined) {
      pen = false
      continue
    }
    const command = pen ? 'L' : 'M'
    path += `${command}${xFor(i).toFixed(1)},${yFor(value).toFixed(1)}`
    pen = true
  }
  return path
}

function lastDefined(times: number[], values: Map<number, number>): number | null {
  for (let i = times.length - 1; i >= 0; i--) {
    const value = values.get(times[i]!)
    if (value !== undefined) return value
  }
  return null
}

/** Axis ticks on round numbers, so the gutter reads 0 / 500 / 1,000. */
function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min]
  const raw = (max - min) / count
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  const normalised = raw / magnitude
  const step = (normalised >= 5 ? 10 : normalised >= 2 ? 5 : normalised >= 1 ? 2 : 1) * magnitude

  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + step * 0.001; t += step) {
    ticks.push(Number(t.toPrecision(12)))
  }
  return ticks
}

function pickXTicks(length: number, plotWidth: number): number[] {
  if (length <= 1) return length === 1 ? [0] : []
  const count = Math.max(2, Math.min(6, Math.floor(plotWidth / 90)))
  const indexes = new Set<number>()
  for (let i = 0; i < count; i++) {
    indexes.add(Math.round((i / (count - 1)) * (length - 1)))
  }
  return [...indexes].sort((a, b) => a - b)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
