import type { Report, TimeRangeId } from '../../shared/types.ts'
import { TIME_RANGES } from '../../shared/types.ts'
import { SEVERITY_COLOR, SEVERITY_ICON, SEVERITY_WORD, formatValue } from '../format.ts'
import { Panel } from './Panel.tsx'

interface Props {
  report: Report
  range: TimeRangeId
  refreshing: boolean
  onRange: (range: TimeRangeId) => void
  onRerun: () => void
  onBack: () => void
}

export function StepReport({ report, range, refreshing, onRange, onRerun, onBack }: Props) {
  const stats = report.panels.filter((p) => p.viz === 'stat')
  const rest = report.panels.filter((p) => p.viz !== 'stat')

  return (
    <div>
      <h1>{report.question}</h1>

      <div className={`verdict ${report.verdict.severity}`}>
        <span className="verdict-icon" style={{ color: SEVERITY_COLOR[report.verdict.severity] }}>
          {SEVERITY_ICON[report.verdict.severity]}
        </span>
        <div>
          <div className="verdict-label">{SEVERITY_WORD[report.verdict.severity]}</div>
          <div className="verdict-headline">{report.verdict.headline}</div>
        </div>
      </div>

      {/* One filter row above everything it scopes — never per-panel controls. */}
      <div className="report-controls">
        <button className="btn" onClick={onBack}>
          ← Other questions
        </button>

        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {TIME_RANGES.map((option) => (
            <button
              key={option.id}
              className={option.id === range ? 'btn btn-primary' : 'btn'}
              onClick={() => onRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <button className="btn" onClick={onRerun} disabled={refreshing}>
          {refreshing ? <span className="spinner" /> : 'Refresh'}
        </button>
      </div>

      <div className={refreshing ? 'stale' : undefined}>
        {stats.length > 0 && (
          <div className="stat-row">
            {stats.map((panel) => (
              <div className="stat-tile" key={panel.id}>
                <span className="stat-question">{panel.question}</span>
                <span className="stat-value">
                  {formatValue(panel.stat?.value ?? null, panel.unit, true)}
                </span>
                <span className="stat-label">{panel.stat?.label ?? panel.title}</span>
                {panel.finding && (
                  <span className="stat-finding">
                    <span style={{ color: SEVERITY_COLOR[panel.finding.severity] }}>
                      {SEVERITY_ICON[panel.finding.severity]}
                    </span>
                    <span>{panel.finding.headline}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {rest.map((panel) => (
          <Panel key={panel.id} panel={panel} start={report.range.start} end={report.range.end} />
        ))}
      </div>

      {report.gaps.length > 0 && (
        <details className="gaps">
          <summary>
            {report.gaps.length} additional check{report.gaps.length === 1 ? '' : 's'} this service
            is not instrumented for
          </summary>
          <div style={{ marginTop: 8 }}>
            {report.gaps.map((gap) => (
              <div className="gap-item" key={gap.signalId}>
                <div className="gap-title">{gap.title}</div>
                <div className="gap-remedy">{gap.remedy}</div>
                <div className="gap-names">Looked for: {gap.lookedFor.slice(0, 5).join(', ')}</div>
              </div>
            ))}
          </div>
        </details>
      )}

      <details style={{ marginTop: 14 }}>
        <summary>
          Metrics this used ({report.resolved.length}) · {report.tookMs}ms
        </summary>
        <div className="table-scroll">
          <table className="data" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Signal</th>
                <th>Metric in your Prometheus</th>
                <th>Convention</th>
                <th style={{ textAlign: 'right' }}>Series</th>
              </tr>
            </thead>
            <tbody>
              {report.resolved.map((signal) => (
                <tr key={signal.signalId}>
                  <td className="name">{signal.title}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {signal.metric}
                  </td>
                  <td>{signal.flavor}</td>
                  <td className="num">{signal.seriesCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
