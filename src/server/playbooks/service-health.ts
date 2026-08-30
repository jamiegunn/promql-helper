import type { Playbook } from './types.ts'
import {
  fmtPercent,
  fmtSeconds,
  fractionAbove,
  lastValue,
  noData,
  scaled,
  worstSeries,
} from './types.ts'

/**
 * "Is this service serving happy users?"
 *
 * The RED method — Rate, Errors, Duration. These three numbers are what an
 * on-call engineer looks at first, because between them they describe the
 * experience the user is actually having, rather than how the machine feels.
 */
export const serviceHealth: Playbook = {
  id: 'service-health',
  title: 'Service health',
  question: 'Is this service serving happy users?',
  summary:
    'Traffic, failures and latency for the HTTP endpoints this service exposes — the three numbers that describe what users experience.',
  signals: ['http.requests.count', 'http.latency.histogram', 'http.latency.sum'],
  panels: [
    // -- Headline numbers ----------------------------------------------------
    {
      id: 'rps',
      title: 'Request rate',
      question: 'How much traffic is it taking?',
      viz: 'stat',
      unit: 'rps',
      statLabel: 'requests / sec',
      requires: ['http.requests.count'],
      build: (ctx) => {
        const r = ctx.s('http.requests.count')
        // The same rate window the traffic chart uses, so this number agrees
        // with where that line ends rather than reporting a window average.
        return [{ expr: `sum(rate(${r.metric}{${r.sel()}}[${ctx.rateWindow}]))`, name: 'Requests/sec' }]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? { name: '', labels: {}, points: [] })
        if (v === null || v === 0) return noData('traffic')
        return null
      },
    },
    {
      id: 'error-ratio',
      title: 'Failure rate',
      question: 'What share of requests are failing?',
      viz: 'stat',
      unit: 'percent',
      statLabel: 'of requests returned 5xx',
      requires: ['http.requests.count'],
      when: (ctx) => ctx.s('http.requests.count').has('status'),
      build: (ctx) => {
        const r = ctx.s('http.requests.count')
        const status = r.label('status')!
        const pattern = r.candidate.errorPattern ?? '5..'
        const w = ctx.windowDuration
        return [
          {
            expr:
              `sum(rate(${r.metric}{${r.sel(`${status}=~"${pattern}"`)}}[${w}]))` +
              ` / clamp_min(sum(rate(${r.metric}{${r.sel()}}[${w}])), 1e-9) * 100`,
            name: 'Error %',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? { name: '', labels: {}, points: [] })
        if (v === null) return noData('requests')
        if (v >= 5)
          return {
            severity: 'critical',
            headline: `${fmtPercent(v)} of requests are failing with a server error.`,
            detail: 'At this rate a meaningful share of users are seeing errors right now.',
          }
        if (v >= 1)
          return {
            severity: 'warning',
            headline: `${fmtPercent(v)} of requests are failing with a server error.`,
            detail: 'Above the 1% mark most teams treat as background noise. Check the failing routes below.',
          }
        if (v > 0)
          return {
            severity: 'ok',
            headline: `${fmtPercent(v)} of requests failed — within normal background error rates.`,
          }
        return { severity: 'ok', headline: 'No server errors in this window.' }
      },
    },
    {
      id: 'p99-stat',
      title: '99th percentile latency',
      question: 'How slow is it for the unluckiest 1% of requests?',
      viz: 'stat',
      unit: 'seconds',
      statLabel: 'p99 response time',
      requires: ['http.latency.histogram'],
      build: (ctx) => {
        const h = ctx.s('http.latency.histogram')
        return [
          {
            expr: scaled(
              `histogram_quantile(0.99, sum by (le) (rate(${h.metric}{${h.sel()}}[${ctx.windowDuration}])))`,
              h.scale,
            ),
            name: 'p99',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? { name: '', labels: {}, points: [] })
        if (v === null) return noData('latency samples')
        if (v >= 3)
          return {
            severity: 'critical',
            headline: `The slowest 1% of requests take over ${fmtSeconds(v)}.`,
            detail: 'Past about three seconds users abandon the page rather than wait.',
          }
        if (v >= 1)
          return {
            severity: 'warning',
            headline: `The slowest 1% of requests take ${fmtSeconds(v)}.`,
            detail: 'Noticeably sluggish. The slowest-endpoints panel below shows where it is going.',
          }
        return { severity: 'ok', headline: `p99 latency is ${fmtSeconds(v)}.` }
      },
    },

    // -- Time series ---------------------------------------------------------
    {
      id: 'throughput',
      title: 'Traffic over time',
      question: 'Is the load steady, spiking, or has it stopped?',
      viz: 'timeseries',
      unit: 'rps',
      requires: ['http.requests.count'],
      build: (ctx) => {
        const r = ctx.s('http.requests.count')
        const route = r.label('route')
        if (!route) {
          return [{ expr: `sum(rate(${r.metric}{${r.sel()}}[${ctx.rateWindow}]))`, name: 'All requests' }]
        }
        return [
          {
            // Top 8 keeps the chart inside the categorical palette; a ninth
            // series would have to reuse a hue and become ambiguous.
            expr: `topk(8, sum by (${route}) (rate(${r.metric}{${r.sel()}}[${ctx.rateWindow}])))`,
            legendLabels: [route],
          },
        ]
      },
      interpret: (series, ctx) => {
        const total = series.reduce((sum, s) => sum + (lastValue(s) ?? 0), 0)
        if (total === 0) return noData('traffic')
        const r = ctx.s('http.requests.count')
        return {
          severity: 'ok',
          headline: `Serving roughly ${total.toFixed(total < 10 ? 1 : 0)} requests/sec across ${series.length} ${r.label('route') ? 'endpoints' : 'series'}.`,
        }
      },
    },
    {
      id: 'errors-over-time',
      title: 'Failures over time',
      question: 'When did requests start failing, and on which endpoint?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['http.requests.count'],
      when: (ctx) => ctx.s('http.requests.count').has('status'),
      build: (ctx) => {
        const r = ctx.s('http.requests.count')
        const status = r.label('status')!
        const route = r.label('route')
        const pattern = r.candidate.errorPattern ?? '5..'
        const w = ctx.rateWindow

        if (!route) {
          return [
            {
              expr:
                `sum(rate(${r.metric}{${r.sel(`${status}=~"${pattern}"`)}}[${w}]))` +
                ` / clamp_min(sum(rate(${r.metric}{${r.sel()}}[${w}])), 1e-9) * 100`,
              name: 'Error %',
            },
          ]
        }
        return [
          {
            // Ratio per endpoint. clamp_min guards the divide-by-zero that
            // otherwise turns idle endpoints into NaN spikes.
            expr:
              `topk(6, sum by (${route}) (rate(${r.metric}{${r.sel(`${status}=~"${pattern}"`)}}[${w}]))` +
              ` / clamp_min(sum by (${route}) (rate(${r.metric}{${r.sel()}}[${w}])), 1e-9) * 100)`,
            legendLabels: [route],
          },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst || worst.value === 0)
          return { severity: 'ok', headline: 'No endpoint returned a server error in this window.' }
        const sustained = fractionAbove(series, 1)
        if (worst.value >= 5 && sustained > 0.1)
          return {
            severity: 'critical',
            headline: `${worst.series.name} peaked at ${fmtPercent(worst.value)} failures and has been elevated for much of the window.`,
            detail: 'A sustained failure rate on one endpoint usually points at a dependency it alone calls.',
          }
        if (worst.value >= 5)
          return {
            severity: 'warning',
            headline: `${worst.series.name} briefly spiked to ${fmtPercent(worst.value)} failures.`,
            detail: 'A short spike is often a deploy, a restart, or a dependency blip.',
          }
        return {
          severity: 'ok',
          headline: `Worst endpoint peaked at ${fmtPercent(worst.value)} failures.`,
        }
      },
    },
    {
      id: 'latency-percentiles',
      title: 'Response time percentiles',
      question: 'Is everyone slow, or only the tail?',
      viz: 'timeseries',
      unit: 'seconds',
      requires: ['http.latency.histogram'],
      build: (ctx) => {
        const h = ctx.s('http.latency.histogram')
        const w = ctx.rateWindow
        // Three quantiles on one axis — same unit, same scale, so the gap
        // between p50 and p99 reads directly as tail spread.
        return [0.5, 0.9, 0.99].map((q) => ({
          expr: scaled(
            `histogram_quantile(${q}, sum by (le) (rate(${h.metric}{${h.sel()}}[${w}])))`,
            h.scale,
          ),
          name: `p${q * 100}`,
        }))
      },
      interpret: (series) => {
        const p50 = series.find((s) => s.name === 'p50')
        const p99 = series.find((s) => s.name === 'p99')
        const a = p50 ? lastValue(p50) : null
        const b = p99 ? lastValue(p99) : null
        if (a === null || b === null) return noData('latency samples')
        const spread = a > 0 ? b / a : 0
        if (spread >= 20)
          return {
            severity: 'warning',
            headline: `The tail is ${spread.toFixed(0)}× the median — p50 ${fmtSeconds(a)} against p99 ${fmtSeconds(b)}.`,
            detail:
              'A spread that wide means most requests are fine and a specific subset is not. Look for one slow endpoint, one slow instance, or lock contention.',
          }
        return {
          severity: 'ok',
          headline: `Median ${fmtSeconds(a)}, p99 ${fmtSeconds(b)} — the tail tracks the median.`,
        }
      },
    },

    // -- Breakdowns ----------------------------------------------------------
    {
      id: 'slowest-endpoints',
      title: 'Slowest endpoints',
      question: 'Which endpoint is dragging the tail out?',
      viz: 'table',
      unit: 'seconds',
      requires: ['http.latency.histogram'],
      when: (ctx) => ctx.s('http.latency.histogram').has('route'),
      build: (ctx) => {
        const h = ctx.s('http.latency.histogram')
        const route = h.label('route')!
        return [
          {
            expr: scaled(
              `topk(8, histogram_quantile(0.99, sum by (le, ${route}) (rate(${h.metric}{${h.sel()}}[${ctx.windowDuration}]))))`,
              h.scale,
            ),
            legendLabels: [route],
          },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst) return noData('latency samples')
        return {
          severity: worst.value >= 3 ? 'serious' : worst.value >= 1 ? 'warning' : 'ok',
          headline: `${worst.series.name} is the slowest endpoint at ${fmtSeconds(worst.value)} (p99).`,
        }
      },
    },
    {
      id: 'failing-endpoints',
      title: 'Failing endpoints',
      question: 'Where are the errors coming from?',
      viz: 'table',
      unit: 'rps',
      requires: ['http.requests.count'],
      when: (ctx) => ctx.s('http.requests.count').has('status', 'route'),
      build: (ctx) => {
        const r = ctx.s('http.requests.count')
        const status = r.label('status')!
        const route = r.label('route')!
        const pattern = r.candidate.errorPattern ?? '5..'
        return [
          {
            expr: `topk(8, sum by (${route}, ${status}) (rate(${r.metric}{${r.sel(`${status}=~"${pattern}"`)}}[${ctx.windowDuration}])))`,
            legendLabels: [route, status],
          },
        ]
      },
      interpret: (series) => {
        if (series.length === 0)
          return { severity: 'ok', headline: 'Nothing returned a server error in this window.' }
        const worst = worstSeries(series)
        return {
          severity: 'warning',
          headline: worst
            ? `${worst.series.name} is the largest source of errors at ${worst.value.toFixed(2)}/sec.`
            : 'Errors are spread across several endpoints.',
        }
      },
    },
    {
      id: 'saturation-hint',
      title: 'Peak vs typical load',
      question: 'How far above its normal load did it get pushed?',
      viz: 'stat',
      unit: 'short',
      statLabel: '× normal traffic at peak',
      requires: ['http.requests.count'],
      build: (ctx) => {
        const r = ctx.s('http.requests.count')
        const w = ctx.windowDuration
        const inner = `sum(rate(${r.metric}{${r.sel()}}[${ctx.rateWindow}]))`
        return [
          {
            expr: `max_over_time((${inner})[${w}:${ctx.range.step}s]) / clamp_min(avg_over_time((${inner})[${w}:${ctx.range.step}s]), 1e-9)`,
            name: 'Peak / average',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? { name: '', labels: {}, points: [] })
        if (v === null || !Number.isFinite(v)) return noData('traffic')
        if (v >= 5)
          return {
            severity: 'warning',
            headline: `Peak traffic was ${v.toFixed(1)}× the average for this window.`,
            detail: 'Spiky load like this is worth capacity-planning against the peak, not the average.',
          }
        return { severity: 'ok', headline: `Peak traffic was ${v.toFixed(1)}× the average — fairly even load.` }
      },
    },
  ],
}
