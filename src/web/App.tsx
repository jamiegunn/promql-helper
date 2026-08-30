import { useCallback, useEffect, useState } from 'react'
import type {
  ConnectionStatus,
  InvestigationOffer,
  Report,
  Target,
  TargetFilter,
  TargetSelection,
  TimeRangeId,
} from '../shared/types.ts'
import { api } from './api.ts'
import { StepTarget } from './components/StepTarget.tsx'
import { StepQuestion } from './components/StepQuestion.tsx'
import { StepReport } from './components/StepReport.tsx'

type Step = 'target' | 'question' | 'report'

const STEP_LABELS: Record<Step, string> = {
  target: 'Pick a service',
  question: 'Choose a question',
  report: 'Read the answer',
}

export function App() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [step, setStep] = useState<Step>('target')
  const [error, setError] = useState<string | null>(null)

  const [targets, setTargets] = useState<Target[]>([])
  const [job, setJob] = useState<string | null>(null)
  const [filters, setFilters] = useState<TargetFilter[]>([])
  const [dependencyJob, setDependencyJob] = useState<string | undefined>()

  const [offers, setOffers] = useState<InvestigationOffer[]>([])
  const [offersLoading, setOffersLoading] = useState(false)

  const [report, setReport] = useState<Report | null>(null)
  const [range, setRange] = useState<TimeRangeId>('1h')
  const [running, setRunning] = useState(false)

  const selection: TargetSelection = { job: job ?? '', filters, dependencyJob }

  useEffect(() => {
    api.health().then(setStatus).catch(() => setStatus(null))
    api
      .targets()
      .then(setTargets)
      .catch((err: Error) => setError(err.message))
  }, [])

  const loadOffers = useCallback(async () => {
    if (!job) return
    setOffersLoading(true)
    setError(null)
    try {
      setOffers(await api.investigations({ job, filters, dependencyJob }))
    } catch (err) {
      setError((err as Error).message)
      setOffers([])
    } finally {
      setOffersLoading(false)
    }
  }, [job, filters, dependencyJob])

  const run = useCallback(
    async (investigationId: string, withRange: TimeRangeId) => {
      if (!job) return
      setRunning(true)
      setError(null)
      try {
        const result = await api.run(investigationId, { job, filters, dependencyJob }, withRange)
        setReport(result)
        setStep('report')
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setRunning(false)
      }
    },
    [job, filters, dependencyJob],
  )

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">
          PromQL Helper
          <span>diagnose a service from its metrics</span>
        </div>
        <div className="conn">
          <span
            className={`dot ${status === null ? 'pending' : status.connected ? 'up' : 'down'}`}
            aria-hidden
          />
          {status === null
            ? 'connecting…'
            : status.connected
              ? `${hostOf(status.url)} · ${status.metricCount?.toLocaleString()} metrics${status.version ? ` · v${status.version}` : ''}`
              : 'not connected'}
        </div>
      </header>

      <nav className="stepper" aria-label="Progress">
        {(['target', 'question', 'report'] as Step[]).map((id, index) => {
          const order: Step[] = ['target', 'question', 'report']
          const current = order.indexOf(step)
          const state = index === current ? 'current' : index < current ? 'done' : ''
          const reachable = index < current || (index === 1 && job) || (index === 2 && report)
          return (
            <span key={id} style={{ display: 'contents' }}>
              {index > 0 && <span className="step-sep">→</span>}
              <button
                className={`step-chip ${state}`}
                disabled={!reachable && index !== current}
                onClick={() => {
                  if (index === 0) setStep('target')
                  if (index === 1 && job) setStep('question')
                  if (index === 2 && report) setStep('report')
                }}
              >
                <span className="step-num">{index + 1}</span>
                {STEP_LABELS[id]}
              </button>
            </span>
          )
        })}
      </nav>

      {status && !status.connected && (
        <div className="banner">
          <strong>Cannot reach Prometheus.</strong> {status.error}
          <div style={{ marginTop: 6 }} className="muted">
            Check <span className="mono">PROMETHEUS_URL</span> and{' '}
            <span className="mono">PROMETHEUS_TOKEN</span> in your environment, then restart.
          </div>
        </div>
      )}

      {error && <div className="banner">{error}</div>}

      {step === 'target' && (
        <StepTarget
          targets={targets}
          job={job}
          filters={filters}
          onPick={setJob}
          onFilters={setFilters}
          onNext={() => {
            setStep('question')
            void loadOffers()
          }}
        />
      )}

      {step === 'question' && job && (
        <StepQuestion
          job={job}
          offers={offers}
          loading={offersLoading || running}
          dependencyJob={dependencyJob}
          onDependency={setDependencyJob}
          onPick={(offer) => void run(offer.id, range)}
          onBack={() => setStep('target')}
        />
      )}

      {step === 'report' && report && (
        <StepReport
          report={report}
          range={range}
          refreshing={running}
          onRange={(next) => {
            setRange(next)
            void run(report.investigationId, next)
          }}
          onRerun={() => void run(report.investigationId, range)}
          onBack={() => setStep('question')}
        />
      )}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
