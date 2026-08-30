import { useState } from 'react'
import type { PanelResult, Series } from '../../shared/types.ts'
import { SEVERITY_COLOR, SEVERITY_ICON, formatValue, seriesColor } from '../format.ts'
import { TimeSeriesChart } from './TimeSeriesChart.tsx'

export function Panel({ panel, start, end }: { panel: PanelResult; start: number; end: number }) {
  const [showTable, setShowTable] = useState(false)
  const [showQuery, setShowQuery] = useState(false)

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">{panel.title}</span>
        <span className="panel-question">{panel.question}</span>
        <div className="panel-actions">
          {panel.viz === 'timeseries' && (
            <button className="btn-ghost" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Chart' : 'Table'}
            </button>
          )}
          <button className="btn-ghost" onClick={() => setShowQuery((v) => !v)}>
            PromQL
          </button>
        </div>
      </div>

      {panel.note && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          {panel.note}
        </p>
      )}

      {panel.viz === 'timeseries' &&
        (showTable ? (
          <SeriesSummaryTable panel={panel} />
        ) : (
          <TimeSeriesChart series={panel.series} unit={panel.unit} start={start} end={end} />
        ))}

      {panel.viz === 'table' && <RankedBars panel={panel} />}

      {panel.finding && (
        <div className="finding">
          <span className="finding-icon" style={{ color: SEVERITY_COLOR[panel.finding.severity] }}>
            {SEVERITY_ICON[panel.finding.severity]}
          </span>
          <span>
            {panel.finding.headline}
            {panel.finding.detail && <div className="finding-detail">{panel.finding.detail}</div>}
          </span>
        </div>
      )}

      {showQuery && (
        <div className="promql">
          {panel.queries.map((query, i) => (
            <div className="promql-row" key={i}>
              <div className="promql-expr">{query.expr}</div>
              <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(query.expr)}>
                Copy
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Ranked comparison. One series, so every bar takes categorical slot 1 —
 * shading bars by their own length would double-encode the value and burn the
 * only free channel the chart has.
 */
function RankedBars({ panel }: { panel: PanelResult }) {
  const rows = panel.series
    .map((s) => ({ name: s.name, value: s.points[s.points.length - 1]?.v ?? null }))
    .filter((r): r is { name: string; value: number } => r.value !== null)
    .sort((a, b) => b.value - a.value)

  if (rows.length === 0) {
    return <p className="muted" style={{ margin: '14px 0' }}>No data returned for this window.</p>
  }

  const max = Math.max(...rows.map((r) => r.value)) || 1

  return (
    <div className="table-scroll">
      <table className="data" style={{ marginTop: 12 }}>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="name" style={{ maxWidth: 320 }}>
                {row.name}
              </td>
              <td style={{ width: '55%', padding: '6px 12px 6px 0' }}>
                {/* Rounded at the data-end, square at the baseline. A CSS bar
                    keeps that radius a true 4px at any width — an SVG path
                    scaled to a percentage would stretch it. */}
                <div
                  style={{
                    height: 12,
                    width: `${Math.max(1.5, (row.value / max) * 100)}%`,
                    background: seriesColor(0),
                    borderRadius: '0 4px 4px 0',
                  }}
                />
              </td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                {formatValue(row.value, panel.unit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The table twin every chart needs. Point-by-point would be hundreds of rows,
 * so it summarises each series — which is also what someone reading a chart is
 * actually extracting from it.
 */
function SeriesSummaryTable({ panel }: { panel: PanelResult }) {
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Series</th>
            <th style={{ textAlign: 'right' }}>Min</th>
            <th style={{ textAlign: 'right' }}>Average</th>
            <th style={{ textAlign: 'right' }}>Max</th>
            <th style={{ textAlign: 'right' }}>Latest</th>
          </tr>
        </thead>
        <tbody>
          {panel.series.map((s, i) => {
            const stats = summarise(s)
            return (
              <tr key={`${s.name}-${i}`}>
                <td className="name">
                  <span className="legend-key" style={{ background: seriesColor(i) }} />
                  {s.name}
                </td>
                <td className="num">{formatValue(stats.min, panel.unit)}</td>
                <td className="num">{formatValue(stats.avg, panel.unit)}</td>
                <td className="num">{formatValue(stats.max, panel.unit)}</td>
                <td className="num">{formatValue(stats.last, panel.unit)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function summarise(series: Series) {
  const values = series.points.map((p) => p.v).filter((v): v is number => v !== null && Number.isFinite(v))
  if (values.length === 0) return { min: null, avg: null, max: null, last: null }
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    last: values[values.length - 1]!,
  }
}
