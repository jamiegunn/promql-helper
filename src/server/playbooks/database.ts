import type { Playbook } from './types.ts'
import { fmtPercent, fmtSeconds, lastValue, noData, peak, worstSeries } from './types.ts'

/**
 * "Is this app pummelling the database?"
 *
 * Deliberately looks from both ends. The application's connection pool tells
 * you whether *your threads* are waiting; the database server tells you whether
 * *it* is struggling. They disagree more often than people expect — a pool
 * starved at 100% utilisation against a database sitting at 3% CPU means the
 * pool is too small, not that the database is overloaded.
 */
export const database: Playbook = {
  id: 'database',
  title: 'Database pressure',
  question: 'Is this app pummelling the database?',
  summary:
    'Connection-pool saturation and query load from the application side, checked against what the database server itself reports — so you can tell a starved pool apart from an overloaded database.',
  signals: [
    'db.pool.active',
    'db.pool.max',
    'db.pool.pending',
    'db.pool.acquire.sum',
    'db.pool.acquire.count',
    'db.pool.timeout',
    'db.query.sum',
    'db.query.count',
    'dbserver.connections',
    'dbserver.connections.max',
    'dbserver.cache.hit',
    'dbserver.cache.read',
    'dbserver.transactions',
    'dbserver.deadlocks',
  ],
  dependency: {
    label: 'Database exporter',
    hint: 'Optional. Pick the job scraping postgres_exporter or mysqld_exporter to see the database side too.',
    probeSignal: 'dbserver.connections',
  },
  panels: [
    // -- Headline numbers ----------------------------------------------------
    {
      id: 'pool-utilisation-stat',
      title: 'Connection pool in use',
      question: 'How much of the pool is checked out?',
      viz: 'stat',
      unit: 'percent',
      statLabel: 'of pool connections in use',
      requires: ['db.pool.active', 'db.pool.max'],
      build: (ctx) => {
        const active = ctx.s('db.pool.active')
        const max = ctx.s('db.pool.max')
        return [
          {
            expr:
              `sum(${active.metric}{${active.sel()}})` +
              ` / clamp_min(sum(${max.metric}{${max.sel()}}), 1e-9) * 100`,
            name: 'Pool %',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('connection pool samples')
        if (v >= 90)
          return {
            severity: 'critical',
            headline: `${fmtPercent(v)} of the connection pool is checked out.`,
            detail:
              'At this level requests start queueing for a connection. Check whether threads are waiting — that panel tells you whether this is actually hurting.',
          }
        if (v >= 70)
          return { severity: 'warning', headline: `${fmtPercent(v)} of the connection pool is checked out.` }
        return { severity: 'ok', headline: `${fmtPercent(v)} of the connection pool is checked out.` }
      },
    },
    {
      id: 'pool-pending-stat',
      title: 'Threads waiting for a connection',
      question: 'Is anything queueing to talk to the database?',
      viz: 'stat',
      unit: 'short',
      statLabel: 'threads waiting, peak in window',
      requires: ['db.pool.pending'],
      build: (ctx) => {
        const p = ctx.s('db.pool.pending')
        return [
          {
            expr: `max_over_time(sum(${p.metric}{${p.sel()}})[${ctx.windowDuration}:${ctx.range.step}s])`,
            name: 'Peak waiting',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('pool waiting data')
        if (v >= 5)
          return {
            severity: 'critical',
            headline: `Up to ${v.toFixed(0)} threads were queued waiting for a database connection.`,
            detail:
              'This is the clearest signal that the pool — not the database — is the bottleneck. Every waiting thread is a request doing nothing. Raising the pool size usually fixes it outright.',
          }
        if (v >= 1)
          return {
            severity: 'warning',
            headline: `Up to ${v.toFixed(0)} thread(s) waited for a database connection.`,
            detail: 'Brief queueing under a burst. Worth watching if it grows.',
          }
        return {
          severity: 'ok',
          headline: 'No thread ever waited for a connection — the pool is comfortably sized.',
        }
      },
    },
    {
      id: 'pool-timeouts',
      title: 'Connection timeouts',
      question: 'Did anything give up waiting?',
      viz: 'stat',
      unit: 'short',
      statLabel: 'connection timeouts in window',
      requires: ['db.pool.timeout'],
      build: (ctx) => {
        const t = ctx.s('db.pool.timeout')
        return [
          { expr: `sum(increase(${t.metric}{${t.sel()}}[${ctx.windowDuration}]))`, name: 'Timeouts' },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('timeout data')
        if (v >= 1)
          return {
            severity: 'critical',
            headline: `${Math.round(v)} request(s) gave up waiting for a database connection.`,
            detail:
              'A pool timeout becomes a failed request. This is user-visible. The pool is too small for the offered load, or connections are being held too long.',
          }
        return { severity: 'ok', headline: 'No connection timeouts.' }
      },
    },

    // -- Application-side time series ----------------------------------------
    {
      id: 'pool-over-time',
      title: 'Pool utilisation over time',
      question: 'When does the pool run tight?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['db.pool.active', 'db.pool.max'],
      build: (ctx) => {
        const active = ctx.s('db.pool.active')
        const max = ctx.s('db.pool.max')
        const pool = active.label('pool')
        const by = pool ? `by (${pool}) ` : ''
        return [
          {
            expr:
              `sum ${by}(${active.metric}{${active.sel()}})` +
              ` / clamp_min(sum ${by}(${max.metric}{${max.sel()}}), 1e-9) * 100`,
            legendLabels: pool ? [pool] : undefined,
            name: pool ? undefined : 'Pool %',
          },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('pool samples')
        if (p >= 99)
          return {
            severity: 'serious',
            headline: `The pool hit ${fmtPercent(p)} — fully exhausted at least once.`,
            detail: 'Every connection checked out means the next request waits.',
          }
        return { severity: 'ok', headline: `Pool utilisation peaked at ${fmtPercent(p)}.` }
      },
    },
    {
      id: 'pool-pending-over-time',
      title: 'Threads waiting over time',
      question: 'When did requests start queueing for the database?',
      viz: 'timeseries',
      unit: 'short',
      requires: ['db.pool.pending'],
      build: (ctx) => {
        const p = ctx.s('db.pool.pending')
        const pool = p.label('pool')
        return [
          {
            expr: pool
              ? `sum by (${pool}) (${p.metric}{${p.sel()}})`
              : `sum(${p.metric}{${p.sel()}})`,
            legendLabels: pool ? [pool] : undefined,
            name: pool ? undefined : 'Threads waiting',
          },
        ]
      },
    },
    {
      id: 'acquire-time',
      title: 'Time spent getting a connection',
      question: 'How long does a thread wait before it can even start its query?',
      viz: 'timeseries',
      unit: 'seconds',
      requires: ['db.pool.acquire.sum', 'db.pool.acquire.count'],
      build: (ctx) => {
        const sum = ctx.s('db.pool.acquire.sum')
        const count = ctx.s('db.pool.acquire.count')
        const w = ctx.rateWindow
        return [
          {
            expr:
              `sum(rate(${sum.metric}{${sum.sel()}}[${w}]))` +
              ` / clamp_min(sum(rate(${count.metric}{${count.sel()}}[${w}])), 1e-9)`,
            name: 'Average acquire time',
          },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('acquisition samples')
        if (p >= 0.1)
          return {
            severity: 'serious',
            headline: `Threads spent up to ${fmtSeconds(p)} just acquiring a connection.`,
            detail:
              'This is time added to every database-backed request before any query runs. It is pure pool contention.',
          }
        if (p >= 0.01)
          return { severity: 'warning', headline: `Acquiring a connection took up to ${fmtSeconds(p)}.` }
        return { severity: 'ok', headline: `Connections are acquired almost instantly (${fmtSeconds(p)}).` }
      },
    },
    {
      id: 'query-rate',
      title: 'Query rate from the application',
      question: 'How hard is the app hitting the database?',
      viz: 'timeseries',
      unit: 'rps',
      requires: ['db.query.count'],
      build: (ctx) => {
        const c = ctx.s('db.query.count')
        const op = c.label('database') ?? c.label('operation')
        return [
          {
            expr: op
              ? `topk(8, sum by (${op}) (rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}])))`
              : `sum(rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}]))`,
            legendLabels: op ? [op] : undefined,
            name: op ? undefined : 'Queries/sec',
          },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst) return noData('query samples')
        return {
          severity: 'ok',
          headline: `${worst.series.name} is the busiest at ${worst.value.toFixed(1)} calls/sec.`,
          detail:
            'Compare this against the request rate in the Service health investigation. Many database calls per HTTP request is the classic N+1 query pattern.',
        }
      },
    },
    {
      id: 'query-latency',
      title: 'Query time from the application',
      question: 'Which queries are slow?',
      viz: 'timeseries',
      unit: 'seconds',
      requires: ['db.query.sum', 'db.query.count'],
      build: (ctx) => {
        const sum = ctx.s('db.query.sum')
        const count = ctx.s('db.query.count')
        const op = sum.label('database') ?? sum.label('operation')
        const by = op ? `by (${op}) ` : ''
        const w = ctx.rateWindow
        return [
          {
            expr:
              `sum ${by}(rate(${sum.metric}{${sum.sel()}}[${w}]))` +
              ` / clamp_min(sum ${by}(rate(${count.metric}{${count.sel()}}[${w}])), 1e-9)`,
            legendLabels: op ? [op] : undefined,
            name: op ? undefined : 'Average query time',
          },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst || worst.value === 0) return noData('query timings')
        if (worst.value >= 1)
          return {
            severity: 'serious',
            headline: `${worst.series.name} averaged ${fmtSeconds(worst.value)} per call.`,
            detail: 'Slow enough to hold a pool connection open, which pushes every other request into the queue.',
          }
        if (worst.value >= 0.1)
          return { severity: 'warning', headline: `${worst.series.name} averaged ${fmtSeconds(worst.value)} per call.` }
        return { severity: 'ok', headline: `Slowest call averaged ${fmtSeconds(worst.value)}.` }
      },
    },

    // -- Database-server side ------------------------------------------------
    {
      id: 'server-connections',
      title: 'Connections at the database',
      question: 'How close is the server to its connection limit?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['dbserver.connections', 'dbserver.connections.max'],
      build: (ctx) => {
        const conn = ctx.s('dbserver.connections')
        const max = ctx.s('dbserver.connections.max')
        return [
          {
            expr:
              `sum(${conn.metric}{${conn.sel()}})` +
              ` / clamp_min(max(${max.metric}{${max.sel()}}), 1e-9) * 100`,
            name: '% of max_connections',
          },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('server connection data')
        if (p >= 90)
          return {
            severity: 'critical',
            headline: `The database reached ${fmtPercent(p)} of its connection limit.`,
            detail:
              'New connections will be refused at the limit. If several application replicas each hold a large pool, the sum can exhaust the server even when each pool looks reasonable.',
          }
        if (p >= 70)
          return { severity: 'warning', headline: `The database reached ${fmtPercent(p)} of its connection limit.` }
        return { severity: 'ok', headline: `The database peaked at ${fmtPercent(p)} of its connection limit.` }
      },
    },
    {
      id: 'server-cache-hit',
      title: 'Database buffer cache hit ratio',
      question: 'Is the database serving from memory or going to disk?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['dbserver.cache.hit', 'dbserver.cache.read'],
      build: (ctx) => {
        const hit = ctx.s('dbserver.cache.hit')
        const read = ctx.s('dbserver.cache.read')
        const w = ctx.rateWindow
        return [
          {
            expr:
              `sum(rate(${hit.metric}{${hit.sel()}}[${w}]))` +
              ` / clamp_min(sum(rate(${hit.metric}{${hit.sel()}}[${w}])) + sum(rate(${read.metric}{${read.sel()}}[${w}])), 1e-9) * 100`,
            name: 'Cache hit %',
          },
        ]
      },
      interpret: (series) => {
        const values = series[0]?.points.filter((p) => p.v !== null).map((p) => p.v as number) ?? []
        if (values.length === 0) return noData('cache statistics')
        const low = Math.min(...values)
        if (low < 90)
          return {
            severity: 'warning',
            headline: `Buffer cache hit ratio dropped to ${fmtPercent(low)}.`,
            detail:
              'Below about 95% the database is reading from disk to answer queries. Usually means the working set outgrew shared memory, or a query is scanning a large table.',
          }
        return { severity: 'ok', headline: `Buffer cache hit ratio stayed at or above ${fmtPercent(low)}.` }
      },
    },
    {
      id: 'server-transactions',
      title: 'Transactions at the database',
      question: 'What load is the server actually seeing?',
      viz: 'timeseries',
      unit: 'rps',
      requires: ['dbserver.transactions'],
      build: (ctx) => {
        const t = ctx.s('dbserver.transactions')
        const db = t.label('database')
        return [
          {
            expr: db
              ? `topk(6, sum by (${db}) (rate(${t.metric}{${t.sel()}}[${ctx.rateWindow}])))`
              : `sum(rate(${t.metric}{${t.sel()}}[${ctx.rateWindow}]))`,
            legendLabels: db ? [db] : undefined,
            name: db ? undefined : 'Transactions/sec',
          },
        ]
      },
    },
    {
      id: 'server-deadlocks',
      title: 'Deadlocks',
      question: 'Are transactions fighting each other?',
      viz: 'stat',
      unit: 'short',
      statLabel: 'deadlocks in window',
      requires: ['dbserver.deadlocks'],
      build: (ctx) => {
        const d = ctx.s('dbserver.deadlocks')
        return [
          { expr: `sum(increase(${d.metric}{${d.sel()}}[${ctx.windowDuration}]))`, name: 'Deadlocks' },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('deadlock data')
        if (v >= 1)
          return {
            severity: 'serious',
            headline: `${Math.round(v)} deadlock(s) in this window.`,
            detail:
              'The database had to kill a transaction to break a cycle. That transaction failed. Deadlocks usually mean two code paths take the same locks in different orders.',
          }
        return { severity: 'ok', headline: 'No deadlocks.' }
      },
    },
  ],
}

function blank() {
  return { name: '', labels: {}, points: [] }
}
