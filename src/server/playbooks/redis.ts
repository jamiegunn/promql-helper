import type { Playbook } from './types.ts'
import { fmtBytes, fmtPercent, fmtSeconds, fmtShort, lastValue, noData, peak, worstSeries } from './types.ts'

/**
 * "Is this app hammering Redis?"
 *
 * Redis is almost never slow on its own — it is single-threaded and fast. When
 * it looks slow, the usual causes are the application calling it far more than
 * it needs to, one expensive command blocking the event loop for everyone, or
 * memory pressure quietly evicting the keys the cache exists to hold.
 */
export const redis: Playbook = {
  id: 'redis',
  title: 'Redis pressure',
  question: 'Is this app hammering Redis?',
  summary:
    'Command throughput, cache hit ratio, evictions and client connections — plus how long the application itself thinks its Redis calls are taking.',
  signals: [
    'redis.commands.total',
    'redis.commands.by_command',
    'redis.commands.duration',
    'redis.clients',
    'redis.blocked_clients',
    'redis.keyspace.hits',
    'redis.keyspace.misses',
    'redis.evictions',
    'redis.memory.used',
    'redis.memory.max',
    'redis.rejected',
    'redisclient.duration.sum',
    'redisclient.duration.count',
  ],
  dependency: {
    label: 'Redis exporter',
    hint: 'Pick the job scraping redis_exporter. Without it, only the application-side view is available.',
    probeSignal: 'redis.commands.total',
  },
  panels: [
    // -- Headline numbers ----------------------------------------------------
    {
      id: 'ops-stat',
      title: 'Command throughput',
      question: 'How many commands per second is Redis handling?',
      viz: 'stat',
      unit: 'rps',
      statLabel: 'commands / sec',
      requires: ['redis.commands.total'],
      build: (ctx) => {
        const c = ctx.s('redis.commands.total')
        return [
          { expr: `sum(rate(${c.metric}{${c.sel()}}[${ctx.windowDuration}]))`, name: 'Commands/sec' },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('Redis commands')
        if (v >= 50_000)
          return {
            severity: 'warning',
            headline: `Redis is handling ${fmtShort(v)} commands/sec.`,
            detail:
              'Approaching the range where a single Redis instance becomes the bottleneck. Pipelining or batching cuts round trips without needing more capacity.',
          }
        return { severity: 'ok', headline: `Redis is handling ${fmtShort(v)} commands/sec.` }
      },
    },
    {
      id: 'hit-ratio-stat',
      title: 'Cache hit ratio',
      question: 'Is the cache actually caching?',
      viz: 'stat',
      unit: 'percent',
      statLabel: 'of lookups found the key',
      requires: ['redis.keyspace.hits', 'redis.keyspace.misses'],
      build: (ctx) => {
        const hits = ctx.s('redis.keyspace.hits')
        const misses = ctx.s('redis.keyspace.misses')
        const w = ctx.windowDuration
        return [
          {
            expr:
              `sum(rate(${hits.metric}{${hits.sel()}}[${w}]))` +
              ` / clamp_min(sum(rate(${hits.metric}{${hits.sel()}}[${w}])) + sum(rate(${misses.metric}{${misses.sel()}}[${w}])), 1e-9) * 100`,
            name: 'Hit ratio',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('keyspace lookups')
        if (v < 50)
          return {
            severity: 'serious',
            headline: `Only ${fmtPercent(v)} of lookups find their key.`,
            detail:
              'At this hit rate the cache is costing a network round trip and returning almost nothing. Either the TTL is too short, the key space is too large to keep hot, or the keys being read are not the keys being written.',
          }
        if (v < 80)
          return {
            severity: 'warning',
            headline: `${fmtPercent(v)} of lookups find their key.`,
            detail: 'Lower than a healthy cache. Worth checking TTLs and eviction.',
          }
        return { severity: 'ok', headline: `${fmtPercent(v)} of lookups find their key.` }
      },
    },
    {
      id: 'memory-stat',
      title: 'Redis memory',
      question: 'How full is Redis?',
      viz: 'stat',
      unit: 'percent',
      statLabel: 'of maxmemory in use',
      requires: ['redis.memory.used', 'redis.memory.max'],
      build: (ctx) => {
        const used = ctx.s('redis.memory.used')
        const max = ctx.s('redis.memory.max')
        return [
          {
            // maxmemory reports 0 when unset, which would divide to +Inf. The
            // `> 0` filter makes that case return nothing instead of nonsense.
            expr:
              `sum(${used.metric}{${used.sel()}})` +
              ` / clamp_min(sum(${max.metric}{${max.sel()}} > 0), 1e-9) * 100`,
            name: 'Memory %',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null)
          return {
            severity: 'unknown',
            headline: 'No maxmemory limit is configured on this Redis.',
            detail:
              'Without maxmemory, Redis will grow until the host runs out of memory and the kernel kills it. Setting a limit plus an eviction policy is almost always safer.',
          }
        if (v >= 90)
          return {
            severity: 'critical',
            headline: `Redis is at ${fmtPercent(v)} of its memory limit.`,
            detail: 'At the limit Redis starts evicting keys — or refusing writes, depending on the policy.',
          }
        if (v >= 75)
          return { severity: 'warning', headline: `Redis is at ${fmtPercent(v)} of its memory limit.` }
        return { severity: 'ok', headline: `Redis is at ${fmtPercent(v)} of its memory limit.` }
      },
    },

    // -- Time series ---------------------------------------------------------
    {
      id: 'ops-over-time',
      title: 'Commands over time',
      question: 'When is Redis busiest?',
      viz: 'timeseries',
      unit: 'rps',
      requires: ['redis.commands.total'],
      build: (ctx) => {
        const c = ctx.s('redis.commands.total')
        return [
          {
            expr: `sum by (instance) (rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}]))`,
            legendLabels: ['instance'],
          },
        ]
      },
    },
    {
      id: 'by-command',
      title: 'Calls by command',
      question: 'What is the app actually asking Redis to do?',
      viz: 'timeseries',
      unit: 'rps',
      requires: ['redis.commands.by_command'],
      build: (ctx) => {
        const c = ctx.s('redis.commands.by_command')
        const cmd = c.label('command')!
        return [
          {
            expr: `topk(8, sum by (${cmd}) (rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}])))`,
            legendLabels: [cmd],
          },
        ]
      },
      when: (ctx) => ctx.s('redis.commands.by_command').has('command'),
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst) return noData('command breakdown')

        // Commands that are O(n) over the whole keyspace and block the single
        // Redis thread while they run. Seeing these in production at any real
        // rate is nearly always a mistake.
        const dangerous = ['keys', 'flushall', 'flushdb', 'smembers', 'hgetall', 'sort']
        const offender = series.find((s) => dangerous.includes(s.name.toLowerCase().trim()))
        if (offender) {
          const rate = peak([offender]) ?? 0
          if (rate > 0.1)
            return {
              severity: 'serious',
              headline: `The application is calling ${offender.name.toUpperCase()} at up to ${rate.toFixed(1)}/sec.`,
              detail:
                'This command scans proportionally to the size of the data and blocks the single Redis thread while it runs — every other client waits behind it. SCAN, or a smaller-grained data model, avoids the stall.',
            }
        }
        return {
          severity: 'ok',
          headline: `${worst.series.name.toUpperCase()} is the most-used command at ${worst.value.toFixed(1)}/sec.`,
        }
      },
    },
    {
      id: 'command-latency',
      title: 'Time per command',
      question: 'Which command is slow inside Redis?',
      viz: 'timeseries',
      unit: 'seconds',
      requires: ['redis.commands.duration', 'redis.commands.by_command'],
      build: (ctx) => {
        const dur = ctx.s('redis.commands.duration')
        const count = ctx.s('redis.commands.by_command')
        const cmd = dur.label('command')!
        const w = ctx.rateWindow
        return [
          {
            expr:
              `topk(6, sum by (${cmd}) (rate(${dur.metric}{${dur.sel()}}[${w}]))` +
              ` / clamp_min(sum by (${cmd}) (rate(${count.metric}{${count.sel()}}[${w}])), 1e-9))`,
            legendLabels: [cmd],
          },
        ]
      },
      when: (ctx) => ctx.s('redis.commands.duration').has('command'),
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst || worst.value === 0) return noData('command timings')
        if (worst.value >= 0.01)
          return {
            severity: 'serious',
            headline: `${worst.series.name.toUpperCase()} averaged ${fmtSeconds(worst.value)} inside Redis.`,
            detail:
              'Redis commands are normally measured in microseconds. Milliseconds means the command is scanning a large structure — and while it does, it blocks every other client.',
          }
        return {
          severity: 'ok',
          headline: `Slowest command is ${worst.series.name.toUpperCase()} at ${fmtSeconds(worst.value)}.`,
        }
      },
    },
    {
      id: 'hit-ratio-over-time',
      title: 'Hit ratio over time',
      question: 'Did the cache stop working at some point?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['redis.keyspace.hits', 'redis.keyspace.misses'],
      build: (ctx) => {
        const hits = ctx.s('redis.keyspace.hits')
        const misses = ctx.s('redis.keyspace.misses')
        const w = ctx.rateWindow
        return [
          {
            expr:
              `sum(rate(${hits.metric}{${hits.sel()}}[${w}]))` +
              ` / clamp_min(sum(rate(${hits.metric}{${hits.sel()}}[${w}])) + sum(rate(${misses.metric}{${misses.sel()}}[${w}])), 1e-9) * 100`,
            name: 'Hit ratio',
          },
        ]
      },
    },
    {
      id: 'evictions',
      title: 'Evictions',
      question: 'Is Redis throwing away keys to make room?',
      viz: 'timeseries',
      unit: 'rps',
      requires: ['redis.evictions'],
      build: (ctx) => {
        const e = ctx.s('redis.evictions')
        return [
          { expr: `sum(rate(${e.metric}{${e.sel()}}[${ctx.rateWindow}]))`, name: 'Evictions/sec' },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('eviction data')
        if (p >= 100)
          return {
            severity: 'critical',
            headline: `Redis is evicting up to ${fmtShort(p)} keys/sec.`,
            detail:
              'Redis is out of memory and discarding keys to accept new ones. Every eviction is a future cache miss, which is why the hit ratio and eviction panels usually move together.',
          }
        if (p > 0)
          return {
            severity: 'warning',
            headline: `Redis is evicting up to ${p.toFixed(1)} keys/sec.`,
            detail: 'Memory pressure has started. Either raise maxmemory or shorten TTLs.',
          }
        return { severity: 'ok', headline: 'No keys are being evicted.' }
      },
    },
    {
      id: 'clients',
      title: 'Connected clients',
      question: 'How many connections is the app holding open?',
      viz: 'timeseries',
      unit: 'short',
      requires: ['redis.clients'],
      build: (ctx) => {
        const c = ctx.s('redis.clients')
        return [
          { expr: `sum by (instance) (${c.metric}{${c.sel()}})`, legendLabels: ['instance'] },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('client connection data')
        if (p >= 5000)
          return {
            severity: 'warning',
            headline: `Up to ${fmtShort(p)} clients were connected.`,
            detail:
              'Connection counts this high usually mean a client pool without an upper bound, or connections not being returned to the pool.',
          }
        return { severity: 'ok', headline: `Peak of ${p.toFixed(0)} connected clients.` }
      },
    },
    {
      id: 'blocked-clients',
      title: 'Blocked clients',
      question: 'Is anything waiting on a blocking command?',
      viz: 'timeseries',
      unit: 'short',
      requires: ['redis.blocked_clients'],
      build: (ctx) => {
        const b = ctx.s('redis.blocked_clients')
        return [{ expr: `sum(${b.metric}{${b.sel()}})`, name: 'Blocked clients' }]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('blocked client data')
        if (p >= 1)
          return {
            severity: 'warning',
            headline: `Up to ${p.toFixed(0)} client(s) were blocked on a command such as BLPOP.`,
            detail:
              'Expected if you use Redis as a queue. Unexpected otherwise, and worth tracing back to the caller.',
          }
        return { severity: 'ok', headline: 'No clients were blocked.' }
      },
    },
    {
      id: 'rejected',
      title: 'Rejected connections',
      question: 'Did Redis turn any connections away?',
      viz: 'stat',
      unit: 'short',
      statLabel: 'connections refused in window',
      requires: ['redis.rejected'],
      build: (ctx) => {
        const r = ctx.s('redis.rejected')
        return [
          { expr: `sum(increase(${r.metric}{${r.sel()}}[${ctx.windowDuration}]))`, name: 'Rejected' },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('rejection data')
        if (v >= 1)
          return {
            severity: 'critical',
            headline: `${Math.round(v)} connection(s) were refused by Redis.`,
            detail:
              'Redis hit its maxclients limit. Those attempts became application errors. Either the client pool is too large across all replicas, or connections are leaking.',
          }
        return { severity: 'ok', headline: 'No connections were refused.' }
      },
    },
    {
      id: 'memory-over-time',
      title: 'Redis memory over time',
      question: 'Is memory growing?',
      viz: 'timeseries',
      unit: 'bytes',
      requires: ['redis.memory.used'],
      build: (ctx) => {
        const m = ctx.s('redis.memory.used')
        return [{ expr: `sum by (instance) (${m.metric}{${m.sel()}})`, legendLabels: ['instance'] }]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('memory samples')
        return { severity: 'ok', headline: `Redis memory peaked at ${fmtBytes(p)}.` }
      },
    },

    // -- Application-side view -----------------------------------------------
    {
      id: 'client-latency',
      title: 'Redis latency as the application sees it',
      question: 'How long does a Redis call take from the app?',
      viz: 'timeseries',
      unit: 'seconds',
      requires: ['redisclient.duration.sum', 'redisclient.duration.count'],
      build: (ctx) => {
        const sum = ctx.s('redisclient.duration.sum')
        const count = ctx.s('redisclient.duration.count')
        const cmd = sum.label('command')
        const by = cmd ? `by (${cmd}) ` : ''
        const w = ctx.rateWindow
        return [
          {
            expr:
              `topk(6, sum ${by}(rate(${sum.metric}{${sum.sel()}}[${w}]))` +
              ` / clamp_min(sum ${by}(rate(${count.metric}{${count.sel()}}[${w}])), 1e-9))`,
            legendLabels: cmd ? [cmd] : undefined,
            name: cmd ? undefined : 'Average call time',
          },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst || worst.value === 0) return noData('client-side timings')
        if (worst.value >= 0.05)
          return {
            severity: 'serious',
            headline: `${worst.series.name} takes ${fmtSeconds(worst.value)} as measured from the application.`,
            detail:
              'If Redis reports the command itself as fast, the difference is network latency or time queued in the client. Compare against the "Time per command" panel above.',
          }
        return {
          severity: 'ok',
          headline: `Slowest call from the application is ${worst.series.name} at ${fmtSeconds(worst.value)}.`,
        }
      },
    },
    {
      id: 'client-call-rate',
      title: 'Redis calls from the application',
      question: 'How chatty is the app with Redis?',
      viz: 'timeseries',
      unit: 'rps',
      requires: ['redisclient.duration.count'],
      build: (ctx) => {
        const count = ctx.s('redisclient.duration.count')
        const cmd = count.label('command')
        return [
          {
            expr: cmd
              ? `topk(8, sum by (${cmd}) (rate(${count.metric}{${count.sel()}}[${ctx.rateWindow}])))`
              : `sum(rate(${count.metric}{${count.sel()}}[${ctx.rateWindow}]))`,
            legendLabels: cmd ? [cmd] : undefined,
            name: cmd ? undefined : 'Calls/sec',
          },
        ]
      },
      interpret: () => ({
        severity: 'ok',
        headline: 'Compare this against the HTTP request rate in Service health.',
        detail:
          'Many Redis calls per HTTP request means the app is making round trips in a loop. Batching with MGET or a pipeline collapses those into one.',
      }),
    },
  ],
}

function blank() {
  return { name: '', labels: {}, points: [] }
}
