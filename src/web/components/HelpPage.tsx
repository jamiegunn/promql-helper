import { useEffect, useMemo, useState } from 'react'
import type { CapabilityReport, SourceGroup } from '../../shared/types.ts'
import { api } from '../api.ts'

type Presence = 'all' | 'present' | 'missing'

const ORIGIN_LABEL: Record<SourceGroup['origin'], string> = {
  application: 'From your application',
  exporter: 'From a dedicated exporter',
  platform: 'From the container platform',
}

const ORIGIN_HINT: Record<SourceGroup['origin'], string> = {
  application: "Scraped from the service's own /metrics endpoint, under its own job.",
  exporter: 'Scraped from a sidecar exporter running next to the datastore, under its own job.',
  platform: 'Scraped from the cluster, keyed by namespace and pod rather than by job.',
}

const SCOPE_HINT: Record<string, string> = {
  target: 'matched on the job you select',
  dependency: 'matched on a job you pick separately',
  infra: 'matched on namespace/pod derived from your app',
}

/**
 * An audit of everything the app knows how to look for, checked against what
 * this Prometheus actually has.
 *
 * The signal registry is a curated allowlist rather than a discovery
 * mechanism, which is the app's main limitation. Rendering the whole registry
 * makes that limitation inspectable instead of something you infer from an
 * investigation being greyed out.
 */
export function HelpPage() {
  const [report, setReport] = useState<CapabilityReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [presence, setPresence] = useState<Presence>('all')

  useEffect(() => {
    api
      .capabilities()
      .then(setReport)
      .catch((err: Error) => setError(err.message))
  }, [])

  const filtered = useMemo(() => {
    if (!report) return []
    const needle = search.trim().toLowerCase()

    return report.sources
      .map((source) => ({
        ...source,
        entries: source.entries.filter((entry) => {
          if (presence === 'present' && !entry.present) return false
          if (presence === 'missing' && entry.present) return false
          if (!needle) return true
          return (
            entry.metric.toLowerCase().includes(needle) ||
            entry.signalTitle.toLowerCase().includes(needle) ||
            entry.signalId.toLowerCase().includes(needle) ||
            source.flavor.toLowerCase().includes(needle) ||
            entry.usedBy.some((u) => u.toLowerCase().includes(needle))
          )
        }),
      }))
      .filter((source) => source.entries.length > 0)
  }, [report, search, presence])

  if (error) return <div className="banner">{error}</div>
  if (!report) {
    return (
      <p className="lede">
        <span className="spinner" /> Reading the metric catalogue…
      </p>
    )
  }

  const totalPresent = report.sources.reduce((n, s) => n + s.metricsPresent, 0)

  return (
    <div>
      <h1>What this app can look for</h1>
      <p className="lede">
        Every metric name the app knows, which instrumentation convention it belongs to, and whether
        it exists in the Prometheus you are connected to. This is the full list — the app does not
        discover metrics beyond it.
      </p>

      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-question">In your Prometheus</span>
          <span className="stat-value">{report.metricCount.toLocaleString()}</span>
          <span className="stat-label">distinct metric names</span>
        </div>
        <div className="stat-tile">
          <span className="stat-question">This app looks for</span>
          <span className="stat-value">{report.candidateCount}</span>
          <span className="stat-label">
            metric names, across {report.signalCount} signals
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-question">Found here</span>
          <span className="stat-value">{totalPresent}</span>
          <span className="stat-label">of the names it looks for</span>
        </div>
      </div>

      <div className="report-controls">
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder="Filter by metric, signal or convention…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {(
            [
              ['all', 'All'],
              ['present', 'Found here'],
              ['missing', 'Not found'],
            ] as [Presence, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              className={presence === value ? 'btn btn-primary' : 'btn'}
              onClick={() => setPresence(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <p className="muted">Nothing matches that filter.</p>
      )}

      {filtered.map((source) => (
        <details key={source.flavor} className="source" open={source.metricsPresent > 0}>
          <summary>
            <span className="source-name">{source.flavor}</span>
            <span className={`badge ${source.metricsPresent > 0 ? 'ready' : 'unavailable'}`}>
              {source.metricsPresent} of {source.metricsKnown} found
            </span>
            <span className="source-origin">{ORIGIN_LABEL[source.origin]}</span>
          </summary>

          <p className="source-hint">{ORIGIN_HINT[source.origin]}</p>

          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 24 }} />
                  <th>Metric</th>
                  <th>Signal</th>
                  <th>Type</th>
                  <th>Unlocks</th>
                </tr>
              </thead>
              <tbody>
                {source.entries.map((entry) => (
                  <tr key={`${entry.signalId}-${entry.metric}`}>
                    <td>
                      <span
                        className="presence"
                        style={{
                          color: entry.present ? 'var(--status-good)' : 'var(--text-muted)',
                        }}
                        title={entry.present ? 'Present in this Prometheus' : 'Not found here'}
                      >
                        {entry.present ? '✓' : '·'}
                      </span>
                    </td>
                    <td>
                      <div className="mono" style={{ fontSize: 12 }}>
                        {entry.metric}
                      </div>
                      {entry.help && <div className="entry-help">{entry.help}</div>}
                      {!entry.present && <div className="entry-remedy">{entry.remedy}</div>}
                      {entry.labels.length > 0 && (
                        <div className="entry-labels">
                          {entry.labels.map((l) => (
                            <span key={l.role}>
                              {l.role}=<b>{l.name}</b>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {entry.signalTitle}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {SCOPE_HINT[entry.scope]}
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {entry.kind}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {entry.unlocks.slice(0, 3).join(', ')}
                      {entry.unlocks.length > 3 && ` +${entry.unlocks.length - 3}`}
                      {entry.usedBy.length > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {[...new Set(entry.usedBy)].join(' · ')}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}

      <h2 style={{ fontSize: 17, fontWeight: 600, margin: '34px 0 6px' }}>
        The five investigations
      </h2>
      <p className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
        Each panel runs only when every signal it needs resolved.
      </p>

      {report.investigations.map((investigation) => (
        <details key={investigation.id} className="source">
          <summary>
            <span className="source-name">{investigation.question}</span>
            <span className="badge partial">{investigation.panels.length} checks</span>
            {investigation.dependencyLabel && (
              <span className="source-origin">needs a {investigation.dependencyLabel}</span>
            )}
          </summary>
          <p className="source-hint">{investigation.summary}</p>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Answers</th>
                  <th>Needs</th>
                </tr>
              </thead>
              <tbody>
                {investigation.panels.map((panel) => (
                  <tr key={panel.id}>
                    <td>{panel.title}</td>
                    <td style={{ fontSize: 12 }}>{panel.question}</td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {panel.requires.join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}

      <p className="muted" style={{ fontSize: 12.5, marginTop: 28 }}>
        Missing something you know you expose? The list lives in{' '}
        <span className="mono">src/server/signals.ts</span> — adding a metric name there is enough
        to teach the app your convention.
      </p>
    </div>
  )
}
