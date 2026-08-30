/**
 * Synthetic exporters for local development.
 *
 * Serves Prometheus text-format metrics that look like a real Java service
 * (Micrometer), a Redis exporter, a Postgres exporter, cAdvisor and
 * kube-state-metrics. Paired with `scripts/prometheus.yml` and a real
 * Prometheus in Docker, this exercises the whole app against a genuine PromQL
 * engine rather than a mock.
 *
 * A few problems are deliberately baked in — a slow checkout endpoint, a
 * saturated connection pool, a Redis instance evicting keys — so the findings
 * engine has something to actually find.
 *
 *   npm run fixture
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.FIXTURE_PORT ?? 9101)

/** Fixed epoch so counters are monotonic across the process's life. */
const T0 = Math.floor(Date.now() / 1000)
const now = () => Math.floor(Date.now() / 1000) - T0 + 3600 // start "1h in" so ranges have data

/**
 * Closed-form integral of the rate a·(1 + m·sin(t/p)).
 *
 * Counters have to be monotonically non-decreasing or `rate()` reads them as
 * resets. Integrating analytically guarantees that — the derivative is
 * a·(1 + m·sin(…)), which stays positive for |m| < 1 — and keeps the exporter
 * stateless.
 */
function counter(a: number, m: number, p: number, t: number): number {
  return a * (t + m * p * (1 - Math.cos(t / p)))
}

/** Gauge oscillating around `base` by ±`amp`. */
function gauge(base: number, amp: number, period: number, t: number, phase = 0): number {
  return base + amp * Math.sin(t / period + phase)
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(6)
}

// ---------------------------------------------------------------------------
// The application: a Spring Boot service instrumented with Micrometer
// ---------------------------------------------------------------------------

const LE = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

interface Endpoint {
  uri: string
  method: string
  /** Requests per second at baseline. */
  rate: number
  /** Share of requests that return 500. */
  errorShare: number
  /** Cumulative share of requests at or below each bucket boundary. */
  cdf: number[]
}

const ENDPOINTS: Endpoint[] = [
  {
    uri: '/api/products',
    method: 'GET',
    rate: 120,
    errorShare: 0.001,
    cdf: [0.05, 0.3, 0.7, 0.9, 0.97, 0.995, 0.999, 1, 1, 1, 1],
  },
  {
    // The problem endpoint: a fat tail and a real error rate.
    uri: '/api/checkout',
    method: 'POST',
    rate: 18,
    errorShare: 0.035,
    cdf: [0, 0, 0.01, 0.05, 0.2, 0.5, 0.8, 0.9, 0.97, 0.995, 0.999],
  },
  {
    uri: '/api/cart',
    method: 'GET',
    rate: 45,
    errorShare: 0.002,
    cdf: [0.02, 0.2, 0.6, 0.85, 0.95, 0.99, 0.998, 1, 1, 1, 1],
  },
  {
    uri: '/actuator/health',
    method: 'GET',
    rate: 4,
    errorShare: 0,
    cdf: [0.8, 0.95, 0.99, 1, 1, 1, 1, 1, 1, 1, 1],
  },
]

/** Mean latency implied by a CDF, used to keep the _sum consistent. */
function meanLatency(cdf: number[]): number {
  let mean = 0
  let prev = 0
  for (let i = 0; i < LE.length; i++) {
    const share = cdf[i]! - prev
    // Midpoint of the bucket is close enough for a fixture.
    const lower = i === 0 ? 0 : LE[i - 1]!
    mean += share * ((lower + LE[i]!) / 2)
    prev = cdf[i]!
  }
  mean += (1 - prev) * 15 // the +Inf bucket
  return mean
}

function appMetrics(replica: number): string {
  const t = now()
  const out: string[] = []
  // Replicas get slightly different load, which makes the "uneven replicas"
  // heuristic in the resources playbook something we can actually see.
  const skew = replica === 1 ? 1.35 : 0.75

  out.push('# HELP http_server_requests_seconds Duration of HTTP server request handling')
  out.push('# TYPE http_server_requests_seconds histogram')

  for (const ep of ENDPOINTS) {
    for (const status of ['200', '500'] as const) {
      const share = status === '500' ? ep.errorShare : 1 - ep.errorShare
      if (share <= 0) continue
      const total = counter(ep.rate * skew * share, 0.35, 900, t)
      const tags = `exception="none",method="${ep.method}",outcome="${status === '500' ? 'SERVER_ERROR' : 'SUCCESS'}",status="${status}",uri="${ep.uri}"`

      for (let i = 0; i < LE.length; i++) {
        out.push(
          `http_server_requests_seconds_bucket{${tags},le="${LE[i]!}"} ${fmt(Math.floor(total * ep.cdf[i]!))}`,
        )
      }
      out.push(`http_server_requests_seconds_bucket{${tags},le="+Inf"} ${fmt(Math.floor(total))}`)
      out.push(`http_server_requests_seconds_count{${tags}} ${fmt(Math.floor(total))}`)
      out.push(`http_server_requests_seconds_sum{${tags}} ${fmt(total * meanLatency(ep.cdf))}`)
    }
  }

  // -- JVM ------------------------------------------------------------------
  const heapMax = 2 * 1024 ** 3
  // Sawtooth: fills and drops, with the floor creeping up slightly so the leak
  // heuristic has a realistic shape to look at.
  const sawtooth = ((t % 240) / 240) * 0.55 + 0.25 + Math.min(0.1, t / 200_000)
  const heapUsed = heapMax * sawtooth * (replica === 1 ? 1.05 : 0.95)

  out.push('# HELP jvm_memory_used_bytes The amount of used memory')
  out.push('# TYPE jvm_memory_used_bytes gauge')
  out.push(`jvm_memory_used_bytes{area="heap",id="G1 Eden Space"} ${fmt(heapUsed * 0.6)}`)
  out.push(`jvm_memory_used_bytes{area="heap",id="G1 Old Gen"} ${fmt(heapUsed * 0.35)}`)
  out.push(`jvm_memory_used_bytes{area="heap",id="G1 Survivor Space"} ${fmt(heapUsed * 0.05)}`)
  out.push(`jvm_memory_used_bytes{area="nonheap",id="Metaspace"} ${fmt(gauge(180e6, 8e6, 600, t))}`)
  out.push(`jvm_memory_used_bytes{area="nonheap",id="CodeCache"} ${fmt(gauge(64e6, 4e6, 700, t))}`)

  out.push('# TYPE jvm_memory_max_bytes gauge')
  out.push(`jvm_memory_max_bytes{area="heap",id="G1 Eden Space"} ${fmt(heapMax * 0.6)}`)
  out.push(`jvm_memory_max_bytes{area="heap",id="G1 Old Gen"} ${fmt(heapMax * 0.35)}`)
  out.push(`jvm_memory_max_bytes{area="heap",id="G1 Survivor Space"} ${fmt(heapMax * 0.05)}`)
  out.push(`jvm_memory_max_bytes{area="nonheap",id="Metaspace"} -1`)
  out.push(`jvm_memory_max_bytes{area="nonheap",id="CodeCache"} ${fmt(256e6)}`)

  out.push('# HELP jvm_gc_pause_seconds Time spent in GC pause')
  out.push('# TYPE jvm_gc_pause_seconds summary')
  const youngCount = counter(0.9, 0.3, 500, t)
  const oldCount = counter(0.02, 0.5, 800, t)
  out.push(`jvm_gc_pause_seconds_count{action="end of minor GC",gc="G1 Young Generation"} ${fmt(Math.floor(youngCount))}`)
  out.push(`jvm_gc_pause_seconds_sum{action="end of minor GC",gc="G1 Young Generation"} ${fmt(youngCount * 0.022)}`)
  out.push(`jvm_gc_pause_seconds_count{action="end of major GC",gc="G1 Old Generation"} ${fmt(Math.floor(oldCount))}`)
  out.push(`jvm_gc_pause_seconds_sum{action="end of major GC",gc="G1 Old Generation"} ${fmt(oldCount * 0.31)}`)

  out.push('# TYPE jvm_threads_live_threads gauge')
  out.push(`jvm_threads_live_threads ${fmt(Math.round(gauge(84, 18, 400, t) * skew))}`)
  out.push('# TYPE jvm_threads_states_threads gauge')
  out.push(`jvm_threads_states_threads{state="runnable"} ${fmt(Math.round(gauge(28, 8, 300, t)))}`)
  out.push(`jvm_threads_states_threads{state="waiting"} ${fmt(Math.round(gauge(40, 10, 500, t)))}`)
  out.push(`jvm_threads_states_threads{state="timed-waiting"} ${fmt(Math.round(gauge(14, 4, 450, t)))}`)
  out.push(`jvm_threads_states_threads{state="blocked"} ${fmt(Math.round(Math.max(0, gauge(6, 7, 350, t))))}`)

  // -- HikariCP: a pool under real pressure ---------------------------------
  const poolMax = 10
  const active = Math.min(poolMax, Math.max(0, gauge(8.2, 2.2, 420, t)))
  out.push('# TYPE hikaricp_connections_active gauge')
  out.push(`hikaricp_connections_active{pool="HikariPool-1"} ${fmt(Math.round(active))}`)
  out.push('# TYPE hikaricp_connections_max gauge')
  out.push(`hikaricp_connections_max{pool="HikariPool-1"} ${poolMax}`)
  out.push('# TYPE hikaricp_connections_idle gauge')
  out.push(`hikaricp_connections_idle{pool="HikariPool-1"} ${fmt(Math.max(0, Math.round(poolMax - active)))}`)
  out.push('# TYPE hikaricp_connections_pending gauge')
  // Threads queue whenever the pool tops out.
  out.push(
    `hikaricp_connections_pending{pool="HikariPool-1"} ${fmt(Math.max(0, Math.round(gauge(2.5, 5, 420, t))))}`,
  )
  const acquireCount = counter(60 * skew, 0.3, 600, t)
  out.push('# TYPE hikaricp_connections_acquire_seconds summary')
  out.push(`hikaricp_connections_acquire_seconds_count{pool="HikariPool-1"} ${fmt(Math.floor(acquireCount))}`)
  out.push(`hikaricp_connections_acquire_seconds_sum{pool="HikariPool-1"} ${fmt(acquireCount * 0.042)}`)
  out.push('# TYPE hikaricp_connections_timeout_total counter')
  out.push(`hikaricp_connections_timeout_total{pool="HikariPool-1"} ${fmt(Math.floor(counter(0.004, 0.8, 900, t)))}`)

  // -- Spring Data repositories ---------------------------------------------
  out.push('# TYPE spring_data_repository_invocations_seconds summary')
  for (const [repo, rate, mean] of [
    ['ProductRepository', 140, 0.004],
    ['OrderRepository', 40, 0.09],
    ['CustomerRepository', 22, 0.012],
  ] as const) {
    const n = counter(rate * skew, 0.3, 700, t)
    out.push(
      `spring_data_repository_invocations_seconds_count{method="findAll",repository="${repo}"} ${fmt(Math.floor(n))}`,
    )
    out.push(
      `spring_data_repository_invocations_seconds_sum{method="findAll",repository="${repo}"} ${fmt(n * mean)}`,
    )
  }

  // -- Lettuce (the Redis client) -------------------------------------------
  out.push('# TYPE lettuce_command_completion_seconds summary')
  for (const [cmd, rate, mean] of [
    ['GET', 320, 0.0009],
    ['SET', 90, 0.0011],
    ['HGETALL', 24, 0.021],
    ['MGET', 30, 0.0016],
  ] as const) {
    const n = counter(rate * skew, 0.35, 650, t)
    out.push(`lettuce_command_completion_seconds_count{command="${cmd}"} ${fmt(Math.floor(n))}`)
    out.push(`lettuce_command_completion_seconds_sum{command="${cmd}"} ${fmt(n * mean)}`)
  }

  // -- Process --------------------------------------------------------------
  out.push('# TYPE process_cpu_seconds_total counter')
  out.push(`process_cpu_seconds_total ${fmt(counter(0.62 * skew, 0.4, 800, t))}`)
  out.push('# TYPE process_resident_memory_bytes gauge')
  out.push(`process_resident_memory_bytes ${fmt(gauge(2.6e9, 1.4e8, 900, t) * skew)}`)
  out.push('# TYPE process_cpu_usage gauge')
  out.push(`process_cpu_usage ${fmt(Math.min(1, Math.max(0, gauge(0.31, 0.16, 800, t) * skew)))}`)

  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// redis_exporter
// ---------------------------------------------------------------------------

function redisMetrics(): string {
  const t = now()
  const out: string[] = []

  out.push('# TYPE redis_commands_processed_total counter')
  out.push(`redis_commands_processed_total ${fmt(counter(940, 0.35, 650, t))}`)

  out.push('# TYPE redis_commands_total counter')
  out.push('# TYPE redis_commands_duration_seconds_total counter')
  for (const [cmd, rate, mean] of [
    ['get', 520, 0.00008],
    ['set', 150, 0.00011],
    ['mget', 60, 0.00019],
    ['expire', 90, 0.00006],
    // The expensive one — blocks the single Redis thread while it runs.
    ['hgetall', 38, 0.0164],
    ['ttl', 80, 0.00005],
  ] as const) {
    const n = counter(rate, 0.35, 650, t)
    out.push(`redis_commands_total{cmd="${cmd}"} ${fmt(Math.floor(n))}`)
    out.push(`redis_commands_duration_seconds_total{cmd="${cmd}"} ${fmt(n * mean)}`)
  }

  // Hit ratio around 62% — low enough that the cache is barely earning its keep.
  out.push('# TYPE redis_keyspace_hits_total counter')
  out.push(`redis_keyspace_hits_total ${fmt(counter(430, 0.3, 700, t))}`)
  out.push('# TYPE redis_keyspace_misses_total counter')
  out.push(`redis_keyspace_misses_total ${fmt(counter(260, 0.4, 500, t))}`)

  out.push('# TYPE redis_evicted_keys_total counter')
  out.push(`redis_evicted_keys_total ${fmt(counter(11, 0.9, 400, t))}`)

  out.push('# TYPE redis_connected_clients gauge')
  out.push(`redis_connected_clients ${fmt(Math.round(gauge(180, 40, 600, t)))}`)
  out.push('# TYPE redis_blocked_clients gauge')
  out.push(`redis_blocked_clients ${fmt(Math.max(0, Math.round(gauge(0.4, 1.4, 380, t))))}`)
  out.push('# TYPE redis_rejected_connections_total counter')
  out.push(`redis_rejected_connections_total 0`)

  const maxMemory = 4 * 1024 ** 3
  out.push('# TYPE redis_memory_used_bytes gauge')
  out.push(`redis_memory_used_bytes ${fmt(gauge(maxMemory * 0.87, maxMemory * 0.04, 900, t))}`)
  out.push('# TYPE redis_memory_max_bytes gauge')
  out.push(`redis_memory_max_bytes ${maxMemory}`)
  out.push('# TYPE redis_up gauge')
  out.push('redis_up 1')

  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// postgres_exporter
// ---------------------------------------------------------------------------

function postgresMetrics(): string {
  const t = now()
  const out: string[] = []

  out.push('# TYPE pg_stat_activity_count gauge')
  out.push(`pg_stat_activity_count{datname="shop",state="active"} ${fmt(Math.round(gauge(28, 12, 500, t)))}`)
  out.push(`pg_stat_activity_count{datname="shop",state="idle"} ${fmt(Math.round(gauge(41, 9, 700, t)))}`)
  out.push('# TYPE pg_settings_max_connections gauge')
  out.push('pg_settings_max_connections 100')

  out.push('# TYPE pg_stat_database_blks_hit counter')
  out.push(`pg_stat_database_blks_hit{datname="shop"} ${fmt(counter(48_000, 0.3, 600, t))}`)
  out.push('# TYPE pg_stat_database_blks_read counter')
  out.push(`pg_stat_database_blks_read{datname="shop"} ${fmt(counter(900, 0.5, 450, t))}`)

  out.push('# TYPE pg_stat_database_xact_commit counter')
  out.push(`pg_stat_database_xact_commit{datname="shop"} ${fmt(counter(210, 0.35, 650, t))}`)
  out.push('# TYPE pg_stat_database_deadlocks counter')
  out.push(`pg_stat_database_deadlocks{datname="shop"} ${fmt(Math.floor(counter(0.0015, 0.9, 900, t)))}`)
  out.push('# TYPE pg_up gauge')
  out.push('pg_up 1')

  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// cAdvisor + kube-state-metrics
// ---------------------------------------------------------------------------

const PODS = [
  { pod: 'checkout-api-7d4f9b6c8-hk2mn', skew: 1.35 },
  { pod: 'checkout-api-7d4f9b6c8-x9wqp', skew: 0.75 },
]

function cadvisorMetrics(): string {
  const t = now()
  const out: string[] = []

  out.push('# TYPE container_cpu_usage_seconds_total counter')
  out.push('# TYPE container_cpu_cfs_periods_total counter')
  out.push('# TYPE container_cpu_cfs_throttled_periods_total counter')
  out.push('# TYPE container_memory_working_set_bytes gauge')

  for (const { pod, skew } of PODS) {
    const l = `container="checkout-api",namespace="shop",pod="${pod}"`
    out.push(`container_cpu_usage_seconds_total{${l}} ${fmt(counter(0.72 * skew, 0.45, 800, t))}`)
    out.push(`container_cpu_cfs_periods_total{${l}} ${fmt(counter(10, 0, 1, t))}`)
    // The busier replica gets throttled against its 1-core limit.
    out.push(
      `container_cpu_cfs_throttled_periods_total{${l}} ${fmt(counter(skew > 1 ? 1.6 : 0.05, 0.6, 800, t))}`,
    )
    out.push(`container_memory_working_set_bytes{${l}} ${fmt(gauge(3.1e9, 2.2e8, 900, t) * skew)}`)

    // The pod-level rollup cAdvisor also emits, which the signal registry
    // filters out with container!="" — included so that filter gets exercised.
    const podLevel = `container="",namespace="shop",pod="${pod}"`
    out.push(`container_cpu_usage_seconds_total{${podLevel}} ${fmt(counter(0.8 * skew, 0.45, 800, t))}`)
    out.push(`container_memory_working_set_bytes{${podLevel}} ${fmt(gauge(3.3e9, 2.2e8, 900, t) * skew)}`)
  }

  return out.join('\n') + '\n'
}

function kubeStateMetrics(): string {
  const t = now()
  const out: string[] = []

  out.push('# TYPE kube_pod_container_resource_limits gauge')
  out.push('# TYPE kube_pod_container_status_restarts_total counter')

  for (const { pod } of PODS) {
    const l = `container="checkout-api",namespace="shop",pod="${pod}"`
    out.push(`kube_pod_container_resource_limits{${l},resource="cpu",unit="core"} 1`)
    out.push(`kube_pod_container_resource_limits{${l},resource="memory",unit="byte"} ${4 * 1024 ** 3}`)
    out.push(`kube_pod_container_status_restarts_total{${l}} ${fmt(Math.floor(counter(0.0008, 0.5, 900, t)))}`)
  }

  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------

const ROUTES: Record<string, () => string> = {
  '/metrics/app/1': () => appMetrics(1),
  '/metrics/app/2': () => appMetrics(2),
  '/metrics/redis': redisMetrics,
  '/metrics/postgres': postgresMetrics,
  '/metrics/cadvisor': cadvisorMetrics,
  '/metrics/kube-state': kubeStateMetrics,
}

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const handler = ROUTES[path]

  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end(`Not found.\n\nAvailable:\n${Object.keys(ROUTES).map((r) => `  ${r}`).join('\n')}\n`)
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
  res.end(handler())
}).listen(PORT, () => {
  console.log(`  Fixture exporters on http://localhost:${PORT}`)
  for (const route of Object.keys(ROUTES)) console.log(`    ${route}`)
})
