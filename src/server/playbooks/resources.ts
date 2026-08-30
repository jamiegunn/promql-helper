import type { Playbook } from './types.ts'
import { fmtBytes, fmtPercent, lastValue, mean, noData, peak, worstSeries } from './types.ts'

/**
 * "How much does this thing actually cost to run?"
 *
 * CPU and memory over time, plus the percentile summary — because a service
 * that averages half a core but peaks at three is a very different sizing
 * problem from one that sits flat at one and a half, and the average alone
 * cannot tell you which you have.
 */
export const resources: Playbook = {
  id: 'resources',
  title: 'CPU & memory',
  question: 'How much CPU and memory does it use, and how spiky is it?',
  summary:
    'Compute usage over time with a percentile breakdown, checked against the limits configured on the pod — including whether those limits are throttling it.',
  signals: [
    'container.cpu.usage',
    'container.cpu.throttled.periods',
    'container.cpu.periods',
    'container.memory.working_set',
    'container.resource.limits',
    'container.restarts',
    'process.cpu.seconds',
    'process.memory.rss',
  ],
  panels: [
    // -- Headline numbers ----------------------------------------------------
    {
      id: 'cpu-typical',
      title: 'Typical CPU',
      question: 'What does it use on an average day?',
      viz: 'stat',
      unit: 'cores',
      statLabel: 'cores, median over window',
      requires: ['container.cpu.usage'],
      build: (ctx) => {
        const c = ctx.s('container.cpu.usage')
        const inner = `sum(rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}]))`
        return [
          {
            expr: `quantile_over_time(0.5, (${inner})[${ctx.windowDuration}:${ctx.range.step}s])`,
            name: 'p50 cores',
          },
        ]
      },
    },
    {
      id: 'cpu-peak',
      title: 'Peak CPU',
      question: 'What does it use at its worst?',
      viz: 'stat',
      unit: 'cores',
      statLabel: 'cores, p99 over window',
      requires: ['container.cpu.usage'],
      build: (ctx) => {
        const c = ctx.s('container.cpu.usage')
        const inner = `sum(rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}]))`
        return [
          {
            expr: `quantile_over_time(0.99, (${inner})[${ctx.windowDuration}:${ctx.range.step}s])`,
            name: 'p99 cores',
          },
        ]
      },
    },
    {
      id: 'memory-current',
      title: 'Memory in use',
      question: 'How much memory is it holding right now?',
      viz: 'stat',
      unit: 'bytes',
      statLabel: 'working set',
      requires: ['container.memory.working_set'],
      build: (ctx) => {
        const m = ctx.s('container.memory.working_set')
        return [{ expr: `sum(${m.metric}{${m.sel()}})`, name: 'Working set' }]
      },
    },

    // -- The percentile answer the sizing question actually needs ------------
    {
      id: 'cpu-percentiles',
      title: 'CPU percentiles',
      question: 'How spiky is the CPU usage across this window?',
      viz: 'table',
      unit: 'cores',
      requires: ['container.cpu.usage'],
      build: (ctx) => {
        const c = ctx.s('container.cpu.usage')
        const inner = `sum(rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}]))`
        const sub = `(${inner})[${ctx.windowDuration}:${ctx.range.step}s]`
        return [
          { expr: `quantile_over_time(0.50, ${sub})`, name: 'p50 (median)' },
          { expr: `quantile_over_time(0.90, ${sub})`, name: 'p90' },
          { expr: `quantile_over_time(0.95, ${sub})`, name: 'p95' },
          { expr: `quantile_over_time(0.99, ${sub})`, name: 'p99' },
          { expr: `max_over_time(${sub})`, name: 'Peak' },
        ]
      },
      interpret: (series) => {
        const p50 = lastValue(series.find((s) => s.name === 'p50 (median)') ?? blank())
        const peakV = lastValue(series.find((s) => s.name === 'Peak') ?? blank())
        if (p50 === null || peakV === null) return noData('CPU samples')
        if (p50 <= 0) return noData('CPU usage')
        const ratio = peakV / p50
        if (ratio >= 4)
          return {
            severity: 'warning',
            headline: `Peak CPU is ${ratio.toFixed(1)}× the median — ${peakV.toFixed(2)} cores against ${p50.toFixed(2)}.`,
            detail:
              'Bursty workloads get throttled if the CPU limit is set near the median. Size the limit against p95 or above, or remove it and rely on requests.',
          }
        return {
          severity: 'ok',
          headline: `CPU is fairly even — median ${p50.toFixed(2)} cores, peaking at ${peakV.toFixed(2)}.`,
        }
      },
    },

    // -- Time series ---------------------------------------------------------
    {
      id: 'cpu-over-time',
      title: 'CPU over time',
      question: 'When does it work hardest?',
      viz: 'timeseries',
      unit: 'cores',
      requires: ['container.cpu.usage'],
      build: (ctx) => {
        const c = ctx.s('container.cpu.usage')
        const pod = c.label('pod')
        if (!pod) return [{ expr: `sum(rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}]))`, name: 'CPU cores' }]
        return [
          {
            expr: `topk(8, sum by (${pod}) (rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}])))`,
            legendLabels: [pod],
          },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst) return noData('CPU samples')
        const avg = mean(series)
        if (series.length > 1 && avg !== null && avg > 0 && worst.value / avg >= 3)
          return {
            severity: 'warning',
            headline: `Load is uneven across replicas — ${worst.series.name} peaked at ${worst.value.toFixed(2)} cores against a ${avg.toFixed(2)} average.`,
            detail:
              'One replica doing far more work than its peers usually means sticky sessions, an unbalanced hash ring, or a stuck load balancer.',
          }
        return { severity: 'ok', headline: `Busiest replica peaked at ${worst.value.toFixed(2)} cores.` }
      },
    },
    {
      id: 'cpu-vs-limit',
      title: 'CPU against its limit',
      question: 'How close is it to the ceiling it was given?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['container.cpu.usage', 'container.resource.limits'],
      build: (ctx) => {
        const c = ctx.s('container.cpu.usage')
        const l = ctx.s('container.resource.limits')
        return [
          {
            expr:
              `sum(rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}]))` +
              ` / clamp_min(sum(${l.metric}{${l.sel('resource="cpu"')}}), 1e-9) * 100`,
            name: '% of CPU limit',
          },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('CPU limit data')
        if (p >= 95)
          return {
            severity: 'critical',
            headline: `CPU reached ${fmtPercent(p)} of the configured limit.`,
            detail: 'At the limit the kernel throttles the container — see the throttling panel.',
          }
        if (p >= 80)
          return {
            severity: 'warning',
            headline: `CPU peaked at ${fmtPercent(p)} of the configured limit.`,
            detail: 'Little headroom left for a traffic spike.',
          }
        if (p < 20)
          return {
            severity: 'ok',
            headline: `CPU peaked at only ${fmtPercent(p)} of the limit — the limit is generously oversized.`,
            detail: 'Worth right-sizing if you are scheduling against these limits.',
          }
        return { severity: 'ok', headline: `CPU peaked at ${fmtPercent(p)} of the configured limit.` }
      },
    },
    {
      id: 'cpu-throttling',
      title: 'CPU throttling',
      question: 'Is the CPU limit actively slowing it down?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['container.cpu.throttled.periods', 'container.cpu.periods'],
      build: (ctx) => {
        const t = ctx.s('container.cpu.throttled.periods')
        const p = ctx.s('container.cpu.periods')
        const w = ctx.rateWindow
        return [
          {
            // Share of scheduling periods in which the kernel ran out of quota
            // and parked the container. This is the metric that explains
            // latency the CPU graph alone cannot.
            expr:
              `sum(rate(${t.metric}{${t.sel()}}[${w}]))` +
              ` / clamp_min(sum(rate(${p.metric}{${p.sel()}}[${w}])), 1e-9) * 100`,
            name: '% of periods throttled',
          },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('throttling data')
        if (p >= 25)
          return {
            severity: 'critical',
            headline: `The container was throttled in up to ${fmtPercent(p)} of scheduling periods.`,
            detail:
              'This is almost certainly showing up as latency. Raise the CPU limit — throttling can hurt response times badly even when average CPU looks low.',
          }
        if (p >= 5)
          return {
            severity: 'warning',
            headline: `The container was throttled in up to ${fmtPercent(p)} of scheduling periods.`,
            detail: 'Enough to add latency during bursts.',
          }
        return { severity: 'ok', headline: 'Effectively no CPU throttling in this window.' }
      },
    },
    {
      id: 'memory-over-time',
      title: 'Memory over time',
      question: 'Is memory stable, or climbing?',
      viz: 'timeseries',
      unit: 'bytes',
      requires: ['container.memory.working_set'],
      build: (ctx) => {
        const m = ctx.s('container.memory.working_set')
        const pod = m.label('pod')
        if (!pod) return [{ expr: `sum(${m.metric}{${m.sel()}})`, name: 'Working set' }]
        return [
          { expr: `topk(8, sum by (${pod}) (${m.metric}{${m.sel()}}))`, legendLabels: [pod] },
        ]
      },
      interpret: (series) => {
        // A steady climb across the whole window is the shape of a leak. Compare
        // the first and last tenth of the samples rather than fitting a line —
        // it is robust enough for a heuristic and easy to explain.
        let growing = 0
        let checked = 0
        for (const s of series) {
          const values = s.points.filter((p) => p.v !== null).map((p) => p.v as number)
          if (values.length < 10) continue
          const slice = Math.max(1, Math.floor(values.length / 10))
          const head = values.slice(0, slice).reduce((a, b) => a + b, 0) / slice
          const tail = values.slice(-slice).reduce((a, b) => a + b, 0) / slice
          checked++
          if (head > 0 && tail / head >= 1.25) growing++
        }
        const p = peak(series)
        if (p === null) return noData('memory samples')
        if (checked > 0 && growing === checked)
          return {
            severity: 'warning',
            headline: `Memory climbed steadily across the window on every replica, reaching ${fmtBytes(p)}.`,
            detail:
              'A monotonic climb over hours is the classic shape of a leak. Widen the time range — if it keeps climbing until a restart, that confirms it.',
          }
        return { severity: 'ok', headline: `Memory peaked at ${fmtBytes(p)} and is not trending up.` }
      },
    },
    {
      id: 'memory-vs-limit',
      title: 'Memory against its limit',
      question: 'How close is it to being OOM-killed?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['container.memory.working_set', 'container.resource.limits'],
      build: (ctx) => {
        const m = ctx.s('container.memory.working_set')
        const l = ctx.s('container.resource.limits')
        return [
          {
            expr:
              `sum(${m.metric}{${m.sel()}})` +
              ` / clamp_min(sum(${l.metric}{${l.sel('resource="memory"')}}), 1e-9) * 100`,
            name: '% of memory limit',
          },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('memory limit data')
        if (p >= 90)
          return {
            severity: 'critical',
            headline: `Memory reached ${fmtPercent(p)} of the limit.`,
            detail:
              'Unlike CPU, exceeding a memory limit is not throttled — the container is killed outright. Check the restart panel.',
          }
        if (p >= 75)
          return {
            severity: 'warning',
            headline: `Memory peaked at ${fmtPercent(p)} of the limit.`,
          }
        return { severity: 'ok', headline: `Memory peaked at ${fmtPercent(p)} of the limit.` }
      },
    },
    {
      id: 'restarts',
      title: 'Restarts',
      question: 'Has it been crashing?',
      viz: 'stat',
      unit: 'short',
      statLabel: 'container restarts in window',
      requires: ['container.restarts'],
      build: (ctx) => {
        const r = ctx.s('container.restarts')
        return [
          { expr: `sum(increase(${r.metric}{${r.sel()}}[${ctx.windowDuration}]))`, name: 'Restarts' },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('restart data')
        const n = Math.round(v)
        if (n >= 3)
          return {
            severity: 'critical',
            headline: `${n} container restarts in this window.`,
            detail:
              'Repeated restarts mean crashes or failed health checks. If memory was near its limit, these are likely OOM kills.',
          }
        if (n >= 1)
          return { severity: 'warning', headline: `${n} container restart${n === 1 ? '' : 's'} in this window.` }
        return { severity: 'ok', headline: 'No restarts in this window.' }
      },
    },

    // -- Fallbacks when there are no container metrics -----------------------
    {
      id: 'process-cpu',
      title: 'Process CPU over time',
      question: 'How much CPU is the process itself burning?',
      viz: 'timeseries',
      unit: 'cores',
      requires: ['process.cpu.seconds'],
      // Only worth showing when cAdvisor is unavailable; otherwise the
      // container panels say the same thing with limits attached.
      when: (ctx) => !ctx.signals.has('container.cpu.usage'),
      build: (ctx) => {
        const c = ctx.s('process.cpu.seconds')
        return [
          {
            expr: `sum by (instance) (rate(${c.metric}{${c.sel()}}[${ctx.rateWindow}]))`,
            legendLabels: ['instance'],
          },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('CPU samples')
        return {
          severity: 'ok',
          headline: `Peak process CPU was ${p.toFixed(2)} cores.`,
          detail:
            'This is the process view. Container limits and throttling are not visible here — scrape cAdvisor to see those.',
        }
      },
    },
    {
      id: 'process-memory',
      title: 'Process memory over time',
      question: 'How much memory is the process holding?',
      viz: 'timeseries',
      unit: 'bytes',
      requires: ['process.memory.rss'],
      when: (ctx) => !ctx.signals.has('container.memory.working_set'),
      build: (ctx) => {
        const m = ctx.s('process.memory.rss')
        return [{ expr: `sum by (instance) (${m.metric}{${m.sel()}})`, legendLabels: ['instance'] }]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('memory samples')
        return { severity: 'ok', headline: `Peak resident memory was ${fmtBytes(p)}.` }
      },
    },
  ],
}

/** Placeholder used when a named series is missing, so lastValue stays total. */
function blank() {
  return { name: '', labels: {}, points: [] }
}
