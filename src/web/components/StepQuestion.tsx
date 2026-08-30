import type { InvestigationOffer } from '../../shared/types.ts'

interface Props {
  job: string
  offers: InvestigationOffer[]
  loading: boolean
  dependencyJob: string | undefined
  onDependency: (job: string | undefined) => void
  onPick: (offer: InvestigationOffer) => void
  onBack: () => void
}

export function StepQuestion({
  job,
  offers,
  loading,
  dependencyJob,
  onDependency,
  onPick,
  onBack,
}: Props) {
  if (loading) {
    return (
      <div>
        <h1>Working out what {job} can tell us…</h1>
        <p className="lede">
          <span className="spinner" /> Matching the metrics this job exposes against the questions
          they can answer.
        </p>
      </div>
    )
  }

  const ready = offers.filter((o) => o.availability !== 'unavailable')
  const unavailable = offers.filter((o) => o.availability === 'unavailable')

  return (
    <div>
      <h1>What do you want to know about {job}?</h1>
      <p className="lede">
        Each question below is answerable from the metrics this service actually exposes. Pick one
        and it runs the queries, reads the results, and tells you what it found.
      </p>

      {ready.length === 0 && (
        <div className="banner">
          None of the built-in investigations match the metrics on <span className="mono">{job}</span>.
          That usually means it uses a naming convention this tool does not recognise yet, rather
          than that the data is missing.
        </div>
      )}

      <div className="offer-grid">
        {ready.map((offer) => (
          <Offer
            key={offer.id}
            offer={offer}
            dependencyJob={dependencyJob}
            onDependency={onDependency}
            onPick={onPick}
          />
        ))}
      </div>

      {unavailable.length > 0 && (
        <details style={{ marginTop: 26 }}>
          <summary>
            {unavailable.length} question{unavailable.length === 1 ? '' : 's'} this service cannot
            answer yet
          </summary>
          <div className="offer-grid" style={{ marginTop: 14 }}>
            {unavailable.map((offer) => (
              <Offer
                key={offer.id}
                offer={offer}
                dependencyJob={dependencyJob}
                onDependency={onDependency}
                onPick={onPick}
              />
            ))}
          </div>
        </details>
      )}

      <div style={{ marginTop: 26 }}>
        <button className="btn" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  )
}

function Offer({
  offer,
  dependencyJob,
  onDependency,
  onPick,
}: {
  offer: InvestigationOffer
  dependencyJob: string | undefined
  onDependency: (job: string | undefined) => void
  onPick: (offer: InvestigationOffer) => void
}) {
  const available = offer.availability !== 'unavailable'

  // Which instrumentation libraries this resolved against — worth showing,
  // because it is the evidence that the tool matched the right metrics.
  const flavors = [...new Set(offer.resolved.map((r) => r.flavor))].slice(0, 3)

  return (
    <div className={`offer ${available ? 'available' : 'unavailable'}`}>
      <span className="offer-question">{offer.question}</span>
      <span className="offer-summary">{offer.summary}</span>

      {offer.dependency && available && offer.dependency.candidates.length > 0 && (
        <div className="filter-field" style={{ minWidth: 0 }}>
          <label htmlFor={`dep-${offer.id}`}>{offer.dependency.label}</label>
          <select
            id={`dep-${offer.id}`}
            className="input"
            value={dependencyJob ?? ''}
            onChange={(e) => onDependency(e.target.value || undefined)}
          >
            <option value="">All instances</option>
            {offer.dependency.candidates.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="offer-foot">
        <span className={`badge ${offer.availability}`}>
          {offer.availability === 'ready'
            ? '✓ Ready'
            : offer.availability === 'partial'
              ? `${offer.panelsAvailable} of ${offer.panelsTotal} checks`
              : 'Not available'}
        </span>
        {flavors.length > 0 && <span className="flavors">{flavors.join(' · ')}</span>}
      </div>

      {available ? (
        <button className="btn btn-primary" style={{ marginTop: 4 }} onClick={() => onPick(offer)}>
          Find out
        </button>
      ) : (
        <details>
          <summary>What is missing</summary>
          <div style={{ marginTop: 6 }}>
            {offer.gaps.slice(0, 4).map((gap) => (
              <div className="gap-item" key={gap.signalId}>
                <div className="gap-title">{gap.title}</div>
                <div className="gap-remedy">{gap.remedy}</div>
                <div className="gap-names">Looked for: {gap.lookedFor.slice(0, 4).join(', ')}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
