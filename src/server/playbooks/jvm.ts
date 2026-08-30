import type { Playbook } from './types.ts'
import { fmtBytes, fmtPercent, fmtSeconds, lastValue, mean, noData, peak, worstSeries } from './types.ts'

/**
 * "Is the JVM itself the problem?"
 *
 * When a Java service is slow, the cause is usually one of three things: it is
 * spending its time collecting garbage, it is out of heap, or its threads are
 * blocked. This playbook checks all three, because they look identical from
 * the outside — the requests are just slow — and completely different from
 * inside the runtime.
 */
export const jvm: Playbook = {
  id: 'jvm',
  title: 'JVM health',
  question: 'Is the Java runtime itself healthy?',
  summary:
    'Heap pressure, garbage-collection overhead and thread state — the three runtime problems that make a Java service slow without any single request looking wrong.',
  signals: [
    'jvm.memory.used',
    'jvm.memory.max',
    'jvm.gc.pause.count',
    'jvm.gc.pause.sum',
    'jvm.threads.live',
    'jvm.threads.states',
    'process.cpu.ratio',
  ],
  panels: [
    // -- Headline numbers ----------------------------------------------------
    {
      id: 'heap-percent-stat',
      title: 'Heap in use',
      question: 'How full is the heap?',
      viz: 'stat',
      unit: 'percent',
      statLabel: 'of maximum heap',
      requires: ['jvm.memory.used', 'jvm.memory.max'],
      when: (ctx) => ctx.s('jvm.memory.used').has('area'),
      build: (ctx) => {
        const used = ctx.s('jvm.memory.used')
        const max = ctx.s('jvm.memory.max')
        const areaU = used.label('area')!
        const areaM = max.label('area') ?? areaU
        return [
          {
            // Pools with no configured ceiling report max as -1; filtering to
            // positive values keeps them from cancelling out the real limit.
            expr:
              `sum(${used.metric}{${used.sel(`${areaU}="heap"`)}})` +
              ` / clamp_min(sum(${max.metric}{${max.sel(`${areaM}="heap"`)}} > 0), 1e-9) * 100`,
            name: 'Heap %',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('heap samples')
        if (v >= 90)
          return {
            severity: 'critical',
            headline: `The heap is ${fmtPercent(v)} full.`,
            detail:
              'Near the ceiling the collector runs constantly and reclaims very little. Check the GC overhead panel — if that is also high, the JVM is thrashing.',
          }
        if (v >= 75)
          return { severity: 'warning', headline: `The heap is ${fmtPercent(v)} full.` }
        return { severity: 'ok', headline: `The heap is ${fmtPercent(v)} full.` }
      },
    },
    {
      id: 'gc-overhead-stat',
      title: 'GC overhead',
      question: 'What share of wall-clock time goes to garbage collection?',
      viz: 'stat',
      unit: 'percent',
      statLabel: 'of time spent collecting',
      requires: ['jvm.gc.pause.sum'],
      build: (ctx) => {
        const s = ctx.s('jvm.gc.pause.sum')
        return [
          {
            // Seconds of pause accrued per second of wall clock, as a
            // percentage. Averaged across instances so one JVM does not skew it.
            expr: `avg(sum by (instance) (rate(${s.metric}{${s.sel()}}[${ctx.windowDuration}]))) * 100`,
            name: 'GC %',
          },
        ]
      },
      interpret: (series) => {
        const v = lastValue(series[0] ?? blank())
        if (v === null) return noData('GC samples')
        if (v >= 10)
          return {
            severity: 'critical',
            headline: `${fmtPercent(v)} of wall-clock time is spent in garbage collection.`,
            detail:
              'Above roughly 10% the JVM is thrashing: it collects, fails to free much, and immediately collects again. Usually means the heap is too small or something is holding references it should not.',
          }
        if (v >= 5)
          return {
            severity: 'warning',
            headline: `${fmtPercent(v)} of wall-clock time is spent in garbage collection.`,
            detail: 'Enough to show up as latency, particularly in the tail.',
          }
        return { severity: 'ok', headline: `${fmtPercent(v)} of time goes to garbage collection.` }
      },
    },
    {
      id: 'threads-stat',
      title: 'Live threads',
      question: 'How many threads is it running?',
      viz: 'stat',
      unit: 'short',
      statLabel: 'live threads',
      requires: ['jvm.threads.live'],
      build: (ctx) => {
        const t = ctx.s('jvm.threads.live')
        return [{ expr: `avg(${t.metric}{${t.sel()}})`, name: 'Threads' }]
      },
    },

    // -- Time series ---------------------------------------------------------
    {
      id: 'heap-over-time',
      title: 'Heap usage over time',
      question: 'Does the sawtooth come back down, or is the floor rising?',
      viz: 'timeseries',
      unit: 'percent',
      requires: ['jvm.memory.used', 'jvm.memory.max'],
      when: (ctx) => ctx.s('jvm.memory.used').has('area'),
      build: (ctx) => {
        const used = ctx.s('jvm.memory.used')
        const max = ctx.s('jvm.memory.max')
        const areaU = used.label('area')!
        const areaM = max.label('area') ?? areaU
        return [
          {
            expr:
              `sum by (instance) (${used.metric}{${used.sel(`${areaU}="heap"`)}})` +
              ` / clamp_min(sum by (instance) (${max.metric}{${max.sel(`${areaM}="heap"`)}} > 0), 1e-9) * 100`,
            legendLabels: ['instance'],
          },
        ]
      },
      interpret: (series) => {
        const p = peak(series)
        if (p === null) return noData('heap samples')

        // A healthy heap is a sawtooth: it fills, a collection frees it, it
        // fills again. A leak shows up as the *troughs* rising, not the peaks.
        let leaking = 0
        let checked = 0
        for (const s of series) {
          const values = s.points.filter((pt) => pt.v !== null).map((pt) => pt.v as number)
          if (values.length < 20) continue
          const slice = Math.floor(values.length / 5)
          const earlyMin = Math.min(...values.slice(0, slice))
          const lateMin = Math.min(...values.slice(-slice))
          checked++
          if (earlyMin > 0 && lateMin - earlyMin >= 15) leaking++
        }

        if (checked > 0 && leaking === checked)
          return {
            severity: 'warning',
            headline: `Heap usage after collection is climbing — the low point rose by more than 15 percentage points across the window.`,
            detail:
              'The collector is running but reclaiming less each time. That is what a memory leak looks like from the outside. Widen the range to confirm the trend.',
          }
        if (p >= 90)
          return {
            severity: 'warning',
            headline: `Heap peaked at ${fmtPercent(p)} of maximum.`,
            detail: 'The sawtooth is returning to a healthy floor, but the peaks are close to the ceiling.',
          }
        return { severity: 'ok', headline: `Heap peaked at ${fmtPercent(p)} and returns to a stable floor.` }
      },
    },
    {
      id: 'heap-by-pool',
      title: 'Memory by pool',
      question: 'Which memory pool is filling up?',
      viz: 'timeseries',
      unit: 'bytes',
      requires: ['jvm.memory.used'],
      when: (ctx) => ctx.s('jvm.memory.used').has('pool'),
      build: (ctx) => {
        const used = ctx.s('jvm.memory.used')
        const pool = used.label('pool')!
        return [
          { expr: `topk(8, sum by (${pool}) (${used.metric}{${used.sel()}}))`, legendLabels: [pool] },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst) return noData('memory pool samples')
        const name = worst.series.name.toLowerCase()
        if (name.includes('metaspace') && worst.value > 512 * 1024 * 1024)
          return {
            severity: 'warning',
            headline: `Metaspace has grown to ${fmtBytes(worst.value)}.`,
            detail:
              'Large or growing metaspace usually means classes are being generated or loaded repeatedly — dynamic proxies, scripting engines, or repeated redeploys in one JVM.',
          }
        return { severity: 'ok', headline: `${worst.series.name} is the largest pool at ${fmtBytes(worst.value)}.` }
      },
    },
    {
      id: 'gc-pause-time',
      title: 'Average GC pause',
      question: 'How long does a single collection stop the world for?',
      viz: 'timeseries',
      unit: 'seconds',
      requires: ['jvm.gc.pause.sum', 'jvm.gc.pause.count'],
      build: (ctx) => {
        const sum = ctx.s('jvm.gc.pause.sum')
        const count = ctx.s('jvm.gc.pause.count')
        const gc = sum.label('gc')
        const w = ctx.rateWindow
        const by = gc ? `by (${gc}) ` : ''
        return [
          {
            expr:
              `sum ${by}(rate(${sum.metric}{${sum.sel()}}[${w}]))` +
              ` / clamp_min(sum ${by}(rate(${count.metric}{${count.sel()}}[${w}])), 1e-9)`,
            legendLabels: gc ? [gc] : undefined,
            name: gc ? undefined : 'Average pause',
          },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst || worst.value === 0) return noData('GC pauses')
        if (worst.value >= 1)
          return {
            severity: 'critical',
            headline: `${worst.series.name} pauses averaged up to ${fmtSeconds(worst.value)}.`,
            detail:
              'A pause this long stops every request in flight. Any request unlucky enough to overlap it inherits the full pause as latency.',
          }
        if (worst.value >= 0.2)
          return {
            severity: 'warning',
            headline: `${worst.series.name} pauses averaged up to ${fmtSeconds(worst.value)}.`,
            detail: 'Long enough to be visible in p99 latency.',
          }
        return { severity: 'ok', headline: `Longest average pause was ${fmtSeconds(worst.value)}.` }
      },
    },
    {
      id: 'gc-frequency',
      title: 'Collection frequency',
      question: 'How often is it collecting?',
      viz: 'timeseries',
      unit: 'rps',
      requires: ['jvm.gc.pause.count'],
      build: (ctx) => {
        const count = ctx.s('jvm.gc.pause.count')
        const gc = count.label('gc')
        return [
          {
            expr: gc
              ? `sum by (${gc}) (rate(${count.metric}{${count.sel()}}[${ctx.rateWindow}]))`
              : `sum(rate(${count.metric}{${count.sel()}}[${ctx.rateWindow}]))`,
            legendLabels: gc ? [gc] : undefined,
            name: gc ? undefined : 'Collections/sec',
          },
        ]
      },
      interpret: (series) => {
        const worst = worstSeries(series)
        if (!worst) return noData('GC samples')
        if (worst.value >= 2)
          return {
            severity: 'warning',
            headline: `${worst.series.name} ran up to ${worst.value.toFixed(1)} times per second.`,
            detail:
              'Very frequent collection with a full heap is the thrashing pattern. Frequent collection with a healthy heap is usually just a high allocation rate, which is less alarming.',
          }
        return { severity: 'ok', headline: `Peak collection rate was ${worst.value.toFixed(2)}/sec.` }
      },
    },
    {
      id: 'threads-over-time',
      title: 'Threads over time',
      question: 'Is the thread count stable?',
      viz: 'timeseries',
      unit: 'short',
      requires: ['jvm.threads.live'],
      build: (ctx) => {
        const t = ctx.s('jvm.threads.live')
        return [{ expr: `sum by (instance) (${t.metric}{${t.sel()}})`, legendLabels: ['instance'] }]
      },
      interpret: (series) => {
        const p = peak(series)
        const avg = mean(series)
        if (p === null || avg === null) return noData('thread samples')
        if (avg > 0 && p / avg >= 2)
          return {
            severity: 'warning',
            headline: `Thread count peaked at ${p.toFixed(0)}, roughly double its average of ${avg.toFixed(0)}.`,
            detail:
              'A thread pool that grows sharply usually means work is arriving faster than it can be finished — often because threads are blocked on something downstream.',
          }
        return { severity: 'ok', headline: `Thread count is stable around ${avg.toFixed(0)}.` }
      },
    },
    {
      id: 'threads-blocked',
      title: 'Blocked and waiting threads',
      question: 'Are threads stuck instead of working?',
      viz: 'timeseries',
      unit: 'short',
      requires: ['jvm.threads.states'],
      build: (ctx) => {
        const t = ctx.s('jvm.threads.states')
        const state = t.label('state')!
        return [
          {
            expr: `sum by (${state}) (${t.metric}{${t.sel(`${state}=~"blocked|waiting|timed-waiting|timed_waiting"`)}})`,
            legendLabels: [state],
          },
        ]
      },
      when: (ctx) => ctx.s('jvm.threads.states').has('state'),
      interpret: (series) => {
        const blocked = series.find((s) => s.name.toLowerCase().includes('blocked'))
        const v = blocked ? peak([blocked]) : null
        if (v === null) return { severity: 'ok', headline: 'No threads were found in the BLOCKED state.' }
        if (v >= 10)
          return {
            severity: 'serious',
            headline: `Up to ${v.toFixed(0)} threads were BLOCKED waiting on a monitor.`,
            detail:
              'BLOCKED means contention on a synchronized block — threads queueing for a lock another thread holds. This serialises work that looks parallel.',
          }
        if (v >= 1)
          return {
            severity: 'warning',
            headline: `Up to ${v.toFixed(0)} threads were BLOCKED waiting on a monitor.`,
          }
        return { severity: 'ok', headline: 'No meaningful lock contention.' }
      },
    },
  ],
}

function blank() {
  return { name: '', labels: {}, points: [] }
}
