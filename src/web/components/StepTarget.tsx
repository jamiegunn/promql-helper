import { useEffect, useMemo, useState } from 'react'
import type { Target, TargetFilter } from '../../shared/types.ts'
import { api } from '../api.ts'
import { formatShort } from '../format.ts'

interface Props {
  targets: Target[]
  job: string | null
  filters: TargetFilter[]
  onPick: (job: string) => void
  onFilters: (filters: TargetFilter[]) => void
  onNext: () => void
}

export function StepTarget({ targets, job, filters, onPick, onFilters, onNext }: Props) {
  const [search, setSearch] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const [values, setValues] = useState<Record<string, string[]>>({})

  useEffect(() => {
    if (!job) {
      setLabels([])
      return
    }
    let cancelled = false
    api
      .narrowingLabels(job)
      .then((result) => {
        if (!cancelled) setLabels(result)
      })
      .catch(() => setLabels([]))
    return () => {
      cancelled = true
    }
  }, [job])

  // Values for each narrowing label, re-fetched as earlier filters change so
  // picking a namespace narrows the pod list rather than listing every pod.
  useEffect(() => {
    if (!job || labels.length === 0) return
    let cancelled = false

    Promise.all(
      labels.map(async (label) => {
        const earlier = filters.filter((f) => labels.indexOf(f.label) < labels.indexOf(label))
        try {
          return [label, await api.narrowingValues(job, label, earlier)] as const
        } catch {
          return [label, [] as string[]] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setValues(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [job, labels, filters])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return targets
    return targets.filter((t) => t.job.toLowerCase().includes(needle))
  }, [targets, search])

  function setFilter(label: string, value: string) {
    const next = filters.filter((f) => f.label !== label)
    if (value) next.push({ label, value })
    onFilters(next)
  }

  return (
    <div>
      <h1>Which service do you want to look at?</h1>
      <p className="lede">
        These are the jobs Prometheus is scraping, busiest first. Pick the one running the code you
        care about — the next step works out which questions its metrics can answer.
      </p>

      <input
        className="input"
        placeholder="Filter jobs…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 14 }}
      />

      <div className="target-list">
        {filtered.map((target) => (
          <button
            key={target.job}
            className={`target-row${target.job === job ? ' selected' : ''}`}
            onClick={() => {
              onPick(target.job)
              onFilters([])
            }}
          >
            <span className="target-name">{target.job}</span>
            <span className="pill">{formatShort(target.seriesCount)} series</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: 20 }} className="muted">
            No jobs match “{search}”.
          </div>
        )}
      </div>

      {job && labels.length > 0 && (
        <>
          <div className="filter-row">
            {labels.map((label) => (
              <div className="filter-field" key={label}>
                <label htmlFor={`filter-${label}`}>{label}</label>
                <select
                  id={`filter-${label}`}
                  className="input"
                  value={filters.find((f) => f.label === label)?.value ?? ''}
                  onChange={(e) => setFilter(label, e.target.value)}
                >
                  <option value="">All {values[label]?.length ?? 0}</option>
                  {(values[label] ?? []).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            Optional. Narrowing to a single pod isolates one replica; leaving these as “All” looks at
            the service as a whole.
          </p>
        </>
      )}

      <div style={{ marginTop: 26 }}>
        <button className="btn btn-primary" disabled={!job} onClick={onNext}>
          {job ? `Continue with ${job}` : 'Pick a job to continue'}
        </button>
      </div>
    </div>
  )
}
