import { getCatalog, escapeRegex, withSelector } from './catalog.ts'
import { instantQuery, labelNames } from './prom.ts'
import type { ResolvedSignal, SignalGap } from '../shared/types.ts'

/**
 * Canonical label roles. Every instrumentation library names its labels
 * differently — Micrometer calls the HTTP path `uri`, the Prometheus Java
 * client calls it `handler`, OpenTelemetry calls it `http_route`. Playbooks
 * ask for the *role* and the resolver supplies whatever this Prometheus
 * actually uses.
 */
export type LabelRole =
  | 'route'
  | 'status'
  | 'method'
  | 'outcome'
  | 'exception'
  | 'pod'
  | 'container'
  | 'namespace'
  | 'area'
  | 'gc'
  | 'state'
  | 'pool'
  | 'command'
  | 'database'
  | 'operation'
  | 'resource'

export interface SignalCandidate {
  /** Which instrumentation convention this is — surfaced to the user. */
  flavor: string
  metric: string
  labels?: Partial<Record<LabelRole, string>>
  /** Multiplier to bring raw values into the signal's canonical unit. */
  scale?: number
  /** Matchers this flavor always needs, e.g. `area="heap"`. */
  matchers?: string
  /** For status labels: the regex that identifies a server error. */
  errorPattern?: string
}

export interface SignalDef {
  id: string
  title: string
  kind: 'counter' | 'gauge' | 'histogram' | 'summary'
  /**
   * Which selector this signal is scoped by.
   *
   * - `target`     — the job the user picked. The app's own /metrics endpoint.
   * - `dependency` — a different job entirely: a Redis or Postgres exporter.
   * - `infra`      — cAdvisor and kube-state-metrics, which scrape under their
   *                  own jobs and are keyed by namespace/pod rather than by the
   *                  application's job, so they need an identity-derived
   *                  selector instead of `job=`.
   */
  scope: 'target' | 'dependency' | 'infra'
  /**
   * Signals in the same family must resolve to the same instrumentation
   * flavor, or their label names won't line up. Resolution picks the flavor
   * once per family from the first signal declared in it.
   */
  family?: string
  /** What the user would need to instrument to unlock this signal. */
  remedy: string
  candidates: SignalCandidate[]
}

/** A signal that was found, bound to the target the user selected. */
export interface Resolved extends ResolvedSignal {
  candidate: SignalCandidate
  /** Base label matchers for this signal's scope. */
  baseSelector: string
  scale: number
  /** Full selector body: base matchers + the candidate's own + anything extra. */
  sel(...extra: string[]): string
  /** Actual label name for a canonical role, if this flavor has one. */
  label(role: LabelRole): string | undefined
  /** `by (...)` clause for the given roles, skipping roles this flavor lacks. */
  by(...roles: LabelRole[]): string
  /** True if this flavor carries a label for every listed role. */
  has(...roles: LabelRole[]): boolean
}

export interface ResolutionResult {
  resolved: Map<string, Resolved>
  gaps: SignalGap[]
}

/**
 * Base label matchers per scope. `infra` is null when the application's series
 * carry no namespace/pod labels, which means container metrics cannot be tied
 * back to this target at all.
 */
export interface Selectors {
  target: string
  dependency: string
  infra: string | null
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const HTTP_SERVER_FLAVORS: {
  flavor: string
  base: string
  labels: Partial<Record<LabelRole, string>>
  scale?: number
  errorPattern: string
}[] = [
  {
    // Spring Boot / Micrometer — by far the most common Java setup.
    flavor: 'Micrometer',
    base: 'http_server_requests_seconds',
    labels: { route: 'uri', status: 'status', method: 'method', outcome: 'outcome', exception: 'exception' },
    errorPattern: '5..',
  },
  {
    // OpenTelemetry, current semantic conventions (stable since 1.23).
    flavor: 'OpenTelemetry',
    base: 'http_server_request_duration_seconds',
    labels: {
      route: 'http_route',
      status: 'http_response_status_code',
      method: 'http_request_method',
    },
    errorPattern: '5..',
  },
  {
    // OpenTelemetry, pre-stable conventions — still very widely deployed.
    flavor: 'OpenTelemetry (legacy)',
    base: 'http_server_duration_milliseconds',
    labels: { route: 'http_route', status: 'http_status_code', method: 'http_method' },
    scale: 0.001,
    errorPattern: '5..',
  },
  {
    // Prometheus client libraries (Go, Python, Java simpleclient).
    flavor: 'Prometheus client',
    base: 'http_request_duration_seconds',
    labels: { route: 'handler', status: 'code', method: 'method' },
    errorPattern: '5..',
  },
  {
    flavor: 'Prometheus client (alt)',
    base: 'http_server_requests',
    labels: { route: 'path', status: 'status', method: 'method' },
    errorPattern: '5..',
  },
]

/** Expands the HTTP flavor table into count / sum / bucket candidate lists. */
function httpCandidates(suffix: '_count' | '_sum' | '_bucket'): SignalCandidate[] {
  return HTTP_SERVER_FLAVORS.map((f) => ({
    flavor: f.flavor,
    metric: `${f.base}${suffix}`,
    labels: f.labels,
    scale: f.scale,
    errorPattern: f.errorPattern,
  }))
}

export const SIGNALS: SignalDef[] = [
  // -- HTTP / the RED signals ------------------------------------------------
  {
    id: 'http.requests.count',
    title: 'HTTP request count',
    kind: 'counter',
    scope: 'target',
    family: 'http',
    remedy:
      'Expose an HTTP server request counter. Spring Boot does this automatically via spring-boot-starter-actuator; for other stacks add the OpenTelemetry HTTP instrumentation.',
    candidates: [
      ...httpCandidates('_count'),
      {
        flavor: 'Generic counter',
        metric: 'http_requests_total',
        labels: { route: 'handler', status: 'code', method: 'method' },
        errorPattern: '5..',
      },
    ],
  },
  {
    id: 'http.latency.histogram',
    title: 'HTTP latency histogram',
    kind: 'histogram',
    scope: 'target',
    family: 'http',
    remedy:
      'Enable histogram buckets for HTTP requests. In Spring Boot: management.metrics.distribution.percentiles-histogram.http.server.requests=true. Without buckets, percentiles cannot be computed.',
    candidates: httpCandidates('_bucket'),
  },
  {
    id: 'http.latency.sum',
    title: 'HTTP latency total',
    kind: 'counter',
    scope: 'target',
    family: 'http',
    remedy: 'Expose the _sum companion of your HTTP request timer.',
    candidates: httpCandidates('_sum'),
  },

  // -- JVM -------------------------------------------------------------------
  {
    id: 'jvm.memory.used',
    title: 'JVM memory used',
    kind: 'gauge',
    scope: 'target',
    family: 'jvm-mem',
    remedy: 'Register the JVM memory metrics binder (Micrometer JvmMemoryMetrics, or the Java client DefaultExports).',
    candidates: [
      {
        flavor: 'Micrometer',
        metric: 'jvm_memory_used_bytes',
        labels: { area: 'area', pool: 'id' },
      },
      {
        flavor: 'Java client',
        metric: 'jvm_memory_bytes_used',
        labels: { area: 'area' },
      },
      {
        flavor: 'OpenTelemetry',
        metric: 'jvm_memory_used_bytes_total',
        labels: { area: 'jvm_memory_type', pool: 'jvm_memory_pool_name' },
      },
    ],
  },
  {
    id: 'jvm.memory.max',
    title: 'JVM memory limit',
    kind: 'gauge',
    scope: 'target',
    family: 'jvm-mem',
    remedy: 'Expose jvm_memory_max_bytes so heap usage can be shown as a percentage of the limit.',
    candidates: [
      { flavor: 'Micrometer', metric: 'jvm_memory_max_bytes', labels: { area: 'area', pool: 'id' } },
      { flavor: 'Java client', metric: 'jvm_memory_bytes_max', labels: { area: 'area' } },
      {
        flavor: 'OpenTelemetry',
        metric: 'jvm_memory_limit_bytes',
        labels: { area: 'jvm_memory_type', pool: 'jvm_memory_pool_name' },
      },
    ],
  },
  {
    id: 'jvm.gc.pause.count',
    title: 'GC pause count',
    kind: 'counter',
    scope: 'target',
    family: 'jvm-gc',
    remedy: 'Register the JVM GC metrics binder (Micrometer JvmGcMetrics).',
    candidates: [
      {
        flavor: 'Micrometer',
        metric: 'jvm_gc_pause_seconds_count',
        labels: { gc: 'gc', operation: 'action' },
      },
      { flavor: 'Java client', metric: 'jvm_gc_collection_seconds_count', labels: { gc: 'gc' } },
      { flavor: 'OpenTelemetry', metric: 'jvm_gc_duration_seconds_count', labels: { gc: 'jvm_gc_name' } },
    ],
  },
  {
    id: 'jvm.gc.pause.sum',
    title: 'GC pause total time',
    kind: 'counter',
    scope: 'target',
    family: 'jvm-gc',
    remedy: 'Expose the _sum companion of your GC pause timer.',
    candidates: [
      {
        flavor: 'Micrometer',
        metric: 'jvm_gc_pause_seconds_sum',
        labels: { gc: 'gc', operation: 'action' },
      },
      { flavor: 'Java client', metric: 'jvm_gc_collection_seconds_sum', labels: { gc: 'gc' } },
      { flavor: 'OpenTelemetry', metric: 'jvm_gc_duration_seconds_sum', labels: { gc: 'jvm_gc_name' } },
    ],
  },
  {
    id: 'jvm.threads.live',
    title: 'JVM live threads',
    kind: 'gauge',
    scope: 'target',
    remedy: 'Register the JVM thread metrics binder (Micrometer JvmThreadMetrics).',
    candidates: [
      { flavor: 'Micrometer', metric: 'jvm_threads_live_threads' },
      { flavor: 'Java client', metric: 'jvm_threads_current' },
      { flavor: 'OpenTelemetry', metric: 'jvm_thread_count' },
    ],
  },
  {
    id: 'jvm.threads.states',
    title: 'JVM threads by state',
    kind: 'gauge',
    scope: 'target',
    remedy: 'Expose jvm_threads_states_threads to see threads blocked or waiting.',
    candidates: [
      { flavor: 'Micrometer', metric: 'jvm_threads_states_threads', labels: { state: 'state' } },
      { flavor: 'Java client', metric: 'jvm_threads_state', labels: { state: 'state' } },
    ],
  },
  {
    id: 'process.cpu.ratio',
    title: 'Process CPU utilisation',
    kind: 'gauge',
    scope: 'target',
    remedy: 'Register the processor metrics binder (Micrometer ProcessorMetrics).',
    candidates: [
      { flavor: 'Micrometer', metric: 'process_cpu_usage' },
      { flavor: 'OpenTelemetry', metric: 'process_cpu_utilization_ratio' },
    ],
  },
  {
    id: 'process.cpu.seconds',
    title: 'Process CPU seconds',
    kind: 'counter',
    scope: 'target',
    remedy: 'Expose process_cpu_seconds_total — standard in every Prometheus client library.',
    candidates: [{ flavor: 'Prometheus client', metric: 'process_cpu_seconds_total' }],
  },
  {
    id: 'process.memory.rss',
    title: 'Process resident memory',
    kind: 'gauge',
    scope: 'target',
    remedy: 'Expose process_resident_memory_bytes — standard in every Prometheus client library.',
    candidates: [{ flavor: 'Prometheus client', metric: 'process_resident_memory_bytes' }],
  },

  // -- Container / Kubernetes resources --------------------------------------
  {
    id: 'container.cpu.usage',
    title: 'Container CPU usage',
    kind: 'counter',
    scope: 'infra',
    family: 'cadvisor',
    remedy: 'Scrape cAdvisor (bundled with the kubelet) to get per-container CPU.',
    candidates: [
      {
        flavor: 'cAdvisor',
        metric: 'container_cpu_usage_seconds_total',
        labels: { pod: 'pod', container: 'container', namespace: 'namespace' },
        // The pod-level rollup carries an empty container label; excluding it
        // stops every container being double-counted.
        matchers: 'container!="",container!="POD"',
      },
    ],
  },
  {
    id: 'container.cpu.throttled.periods',
    title: 'Throttled CPU periods',
    kind: 'counter',
    scope: 'infra',
    family: 'cadvisor',
    remedy: 'Scrape cAdvisor to see whether the CPU limit is throttling the container.',
    candidates: [
      {
        flavor: 'cAdvisor',
        metric: 'container_cpu_cfs_throttled_periods_total',
        labels: { pod: 'pod', container: 'container', namespace: 'namespace' },
        matchers: 'container!="",container!="POD"',
      },
    ],
  },
  {
    id: 'container.cpu.periods',
    title: 'Total CPU periods',
    kind: 'counter',
    scope: 'infra',
    family: 'cadvisor',
    remedy: 'Scrape cAdvisor to see the CPU scheduling period count.',
    candidates: [
      {
        flavor: 'cAdvisor',
        metric: 'container_cpu_cfs_periods_total',
        labels: { pod: 'pod', container: 'container', namespace: 'namespace' },
        matchers: 'container!="",container!="POD"',
      },
    ],
  },
  {
    id: 'container.memory.working_set',
    title: 'Container memory working set',
    kind: 'gauge',
    scope: 'infra',
    family: 'cadvisor',
    remedy: 'Scrape cAdvisor for container_memory_working_set_bytes — this is the number the OOM killer watches.',
    candidates: [
      {
        flavor: 'cAdvisor',
        metric: 'container_memory_working_set_bytes',
        labels: { pod: 'pod', container: 'container', namespace: 'namespace' },
        matchers: 'container!="",container!="POD"',
      },
    ],
  },
  {
    id: 'container.resource.limits',
    title: 'Container resource limits',
    kind: 'gauge',
    scope: 'infra',
    remedy: 'Deploy kube-state-metrics to learn the CPU and memory limits set on the pod spec.',
    candidates: [
      {
        flavor: 'kube-state-metrics',
        metric: 'kube_pod_container_resource_limits',
        labels: { pod: 'pod', container: 'container', namespace: 'namespace', resource: 'resource' },
      },
    ],
  },
  {
    id: 'container.restarts',
    title: 'Container restarts',
    kind: 'counter',
    scope: 'infra',
    remedy: 'Deploy kube-state-metrics to track container restart counts.',
    candidates: [
      {
        flavor: 'kube-state-metrics',
        metric: 'kube_pod_container_status_restarts_total',
        labels: { pod: 'pod', container: 'container', namespace: 'namespace' },
      },
    ],
  },

  // -- Database: application side (connection pool) --------------------------
  {
    id: 'db.pool.active',
    title: 'Active DB connections',
    kind: 'gauge',
    scope: 'target',
    family: 'db-pool',
    remedy:
      'Enable connection-pool metrics. HikariCP publishes these automatically when a MeterRegistry is on the classpath.',
    candidates: [
      { flavor: 'HikariCP', metric: 'hikaricp_connections_active', labels: { pool: 'pool' } },
      { flavor: 'Spring JDBC', metric: 'jdbc_connections_active', labels: { pool: 'name' } },
      { flavor: 'Tomcat JDBC', metric: 'tomcat_jdbc_connections_active', labels: { pool: 'pool' } },
    ],
  },
  {
    id: 'db.pool.max',
    title: 'DB connection pool size',
    kind: 'gauge',
    scope: 'target',
    family: 'db-pool',
    remedy: 'Expose the pool maximum so utilisation can be shown as a percentage.',
    candidates: [
      { flavor: 'HikariCP', metric: 'hikaricp_connections_max', labels: { pool: 'pool' } },
      { flavor: 'Spring JDBC', metric: 'jdbc_connections_max', labels: { pool: 'name' } },
      { flavor: 'Tomcat JDBC', metric: 'tomcat_jdbc_connections_max', labels: { pool: 'pool' } },
    ],
  },
  {
    id: 'db.pool.pending',
    title: 'Threads waiting for a DB connection',
    kind: 'gauge',
    scope: 'target',
    family: 'db-pool',
    remedy:
      'Expose hikaricp_connections_pending. This is the single clearest sign that the pool, not the database, is the bottleneck.',
    candidates: [
      { flavor: 'HikariCP', metric: 'hikaricp_connections_pending', labels: { pool: 'pool' } },
      { flavor: 'Tomcat JDBC', metric: 'tomcat_jdbc_connections_pending', labels: { pool: 'pool' } },
    ],
  },
  {
    id: 'db.pool.acquire.sum',
    title: 'Connection acquisition time',
    kind: 'counter',
    scope: 'target',
    family: 'db-pool',
    remedy: 'Expose hikaricp_connections_acquire_seconds_sum to measure how long threads wait for a connection.',
    candidates: [
      { flavor: 'HikariCP', metric: 'hikaricp_connections_acquire_seconds_sum', labels: { pool: 'pool' } },
    ],
  },
  {
    id: 'db.pool.acquire.count',
    title: 'Connection acquisition count',
    kind: 'counter',
    scope: 'target',
    family: 'db-pool',
    remedy: 'Expose hikaricp_connections_acquire_seconds_count.',
    candidates: [
      { flavor: 'HikariCP', metric: 'hikaricp_connections_acquire_seconds_count', labels: { pool: 'pool' } },
    ],
  },
  {
    id: 'db.pool.timeout',
    title: 'Connection timeouts',
    kind: 'counter',
    scope: 'target',
    family: 'db-pool',
    remedy: 'Expose hikaricp_connections_timeout_total to catch requests that gave up waiting for a connection.',
    candidates: [
      { flavor: 'HikariCP', metric: 'hikaricp_connections_timeout_total', labels: { pool: 'pool' } },
    ],
  },
  {
    id: 'db.query.sum',
    title: 'Application query time',
    kind: 'counter',
    scope: 'target',
    family: 'db-query',
    remedy:
      'Instrument your data-access layer. Spring Data Repositories, Hibernate statistics, or the OpenTelemetry JDBC agent all provide this.',
    candidates: [
      {
        flavor: 'Spring Data',
        metric: 'spring_data_repository_invocations_seconds_sum',
        labels: { operation: 'method', database: 'repository' },
      },
      {
        flavor: 'OpenTelemetry JDBC',
        metric: 'db_client_operation_duration_seconds_sum',
        labels: { operation: 'db_operation_name', database: 'db_namespace' },
      },
      {
        flavor: 'Hibernate',
        metric: 'hibernate_query_execution_total_seconds_sum',
        labels: { database: 'entityManagerFactory' },
      },
    ],
  },
  {
    id: 'db.query.count',
    title: 'Application query count',
    kind: 'counter',
    scope: 'target',
    family: 'db-query',
    remedy: 'Instrument your data-access layer to count queries.',
    candidates: [
      {
        flavor: 'Spring Data',
        metric: 'spring_data_repository_invocations_seconds_count',
        labels: { operation: 'method', database: 'repository' },
      },
      {
        flavor: 'OpenTelemetry JDBC',
        metric: 'db_client_operation_duration_seconds_count',
        labels: { operation: 'db_operation_name', database: 'db_namespace' },
      },
      {
        flavor: 'Hibernate',
        metric: 'hibernate_query_execution_total_seconds_count',
        labels: { database: 'entityManagerFactory' },
      },
    ],
  },

  // -- Database: server side -------------------------------------------------
  {
    id: 'dbserver.connections',
    title: 'Database server connections',
    kind: 'gauge',
    scope: 'dependency',
    family: 'dbserver',
    remedy: 'Run postgres_exporter or mysqld_exporter alongside the database.',
    candidates: [
      { flavor: 'postgres_exporter', metric: 'pg_stat_activity_count', labels: { database: 'datname', state: 'state' } },
      { flavor: 'mysqld_exporter', metric: 'mysql_global_status_threads_connected' },
    ],
  },
  {
    id: 'dbserver.connections.max',
    title: 'Database connection limit',
    kind: 'gauge',
    scope: 'dependency',
    family: 'dbserver',
    remedy: 'Expose the server max_connections setting via the exporter.',
    candidates: [
      { flavor: 'postgres_exporter', metric: 'pg_settings_max_connections' },
      { flavor: 'mysqld_exporter', metric: 'mysql_global_variables_max_connections' },
    ],
  },
  {
    id: 'dbserver.cache.hit',
    title: 'Database buffer cache hits',
    kind: 'counter',
    scope: 'dependency',
    family: 'dbserver',
    remedy: 'Expose buffer cache statistics via the exporter.',
    candidates: [
      { flavor: 'postgres_exporter', metric: 'pg_stat_database_blks_hit', labels: { database: 'datname' } },
      { flavor: 'mysqld_exporter', metric: 'mysql_global_status_innodb_buffer_pool_read_requests' },
    ],
  },
  {
    id: 'dbserver.cache.read',
    title: 'Database disk reads',
    kind: 'counter',
    scope: 'dependency',
    family: 'dbserver',
    remedy: 'Expose disk read statistics via the exporter.',
    candidates: [
      { flavor: 'postgres_exporter', metric: 'pg_stat_database_blks_read', labels: { database: 'datname' } },
      { flavor: 'mysqld_exporter', metric: 'mysql_global_status_innodb_buffer_pool_reads' },
    ],
  },
  {
    id: 'dbserver.transactions',
    title: 'Database transactions',
    kind: 'counter',
    scope: 'dependency',
    family: 'dbserver',
    remedy: 'Expose transaction counters via the exporter.',
    candidates: [
      { flavor: 'postgres_exporter', metric: 'pg_stat_database_xact_commit', labels: { database: 'datname' } },
      { flavor: 'mysqld_exporter', metric: 'mysql_global_status_queries' },
    ],
  },
  {
    id: 'dbserver.deadlocks',
    title: 'Database deadlocks',
    kind: 'counter',
    scope: 'dependency',
    family: 'dbserver',
    remedy: 'Expose deadlock counters via the exporter.',
    candidates: [
      { flavor: 'postgres_exporter', metric: 'pg_stat_database_deadlocks', labels: { database: 'datname' } },
      { flavor: 'mysqld_exporter', metric: 'mysql_global_status_innodb_deadlocks' },
    ],
  },

  // -- Redis: server side ----------------------------------------------------
  {
    id: 'redis.commands.total',
    title: 'Redis commands processed',
    kind: 'counter',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Run redis_exporter alongside Redis.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_commands_processed_total' }],
  },
  {
    id: 'redis.commands.by_command',
    title: 'Redis calls by command',
    kind: 'counter',
    scope: 'dependency',
    family: 'redis',
    remedy: 'redis_exporter exposes redis_commands_total when Redis command stats are enabled.',
    candidates: [
      { flavor: 'redis_exporter', metric: 'redis_commands_total', labels: { command: 'cmd' } },
    ],
  },
  {
    id: 'redis.commands.duration',
    title: 'Redis command time',
    kind: 'counter',
    scope: 'dependency',
    family: 'redis',
    remedy: 'redis_exporter exposes redis_commands_duration_seconds_total with command stats enabled.',
    candidates: [
      {
        flavor: 'redis_exporter',
        metric: 'redis_commands_duration_seconds_total',
        labels: { command: 'cmd' },
      },
    ],
  },
  {
    id: 'redis.clients',
    title: 'Redis connected clients',
    kind: 'gauge',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Run redis_exporter to see connected client counts.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_connected_clients' }],
  },
  {
    id: 'redis.blocked_clients',
    title: 'Redis blocked clients',
    kind: 'gauge',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Run redis_exporter to see clients blocked on BLPOP and friends.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_blocked_clients' }],
  },
  {
    id: 'redis.keyspace.hits',
    title: 'Redis keyspace hits',
    kind: 'counter',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Run redis_exporter to compute the cache hit ratio.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_keyspace_hits_total' }],
  },
  {
    id: 'redis.keyspace.misses',
    title: 'Redis keyspace misses',
    kind: 'counter',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Run redis_exporter to compute the cache hit ratio.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_keyspace_misses_total' }],
  },
  {
    id: 'redis.evictions',
    title: 'Redis evicted keys',
    kind: 'counter',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Run redis_exporter to detect keys being evicted under memory pressure.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_evicted_keys_total' }],
  },
  {
    id: 'redis.memory.used',
    title: 'Redis memory used',
    kind: 'gauge',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Run redis_exporter to track Redis memory.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_memory_used_bytes' }],
  },
  {
    id: 'redis.memory.max',
    title: 'Redis maxmemory',
    kind: 'gauge',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Set maxmemory in Redis so the exporter can report the limit.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_memory_max_bytes' }],
  },
  {
    id: 'redis.rejected',
    title: 'Redis rejected connections',
    kind: 'counter',
    scope: 'dependency',
    family: 'redis',
    remedy: 'Run redis_exporter to catch connections refused at the maxclients limit.',
    candidates: [{ flavor: 'redis_exporter', metric: 'redis_rejected_connections_total' }],
  },

  // -- Redis: application side ----------------------------------------------
  {
    id: 'redisclient.duration.sum',
    title: 'Redis client call time',
    kind: 'counter',
    scope: 'target',
    family: 'redis-client',
    remedy:
      'Enable Redis client metrics. Lettuce publishes these when command latency metrics are enabled on its client options.',
    candidates: [
      {
        flavor: 'Lettuce',
        metric: 'lettuce_command_completion_seconds_sum',
        labels: { command: 'command' },
      },
      {
        flavor: 'OpenTelemetry',
        metric: 'db_client_operation_duration_seconds_sum',
        labels: { command: 'db_operation_name' },
      },
    ],
  },
  {
    id: 'redisclient.duration.count',
    title: 'Redis client call count',
    kind: 'counter',
    scope: 'target',
    family: 'redis-client',
    remedy: 'Enable Redis client metrics on your Redis driver.',
    candidates: [
      {
        flavor: 'Lettuce',
        metric: 'lettuce_command_completion_seconds_count',
        labels: { command: 'command' },
      },
      {
        flavor: 'OpenTelemetry',
        metric: 'db_client_operation_duration_seconds_count',
        labels: { command: 'db_operation_name' },
      },
    ],
  },
]

const BY_ID = new Map(SIGNALS.map((s) => [s.id, s]))

export function getSignal(id: string): SignalDef {
  const signal = BY_ID.get(id)
  if (!signal) throw new Error(`Unknown signal id: ${id}`)
  return signal
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Works out which of the requested signals actually exist for this target, and
 * what they are called here.
 *
 * The expensive part is deliberately kept to a single instant query: every
 * candidate metric name that the catalog says exists somewhere is folded into
 * one `__name__=~"a|b|c"` matcher scoped to the target, so one round trip tells
 * us both which metrics are present *for this job* and how many series each
 * has. Checking names against the global catalog first keeps that regex small.
 */
export async function resolveSignals(
  signalIds: string[],
  selectors: Selectors,
  /**
   * Fetching live label names costs one request per resolved signal. Worth it
   * when running an investigation; wasted when merely deciding which
   * investigations are available, since availability is judged from the static
   * candidate definitions.
   */
  withLabels = true,
): Promise<ResolutionResult> {
  const catalog = await getCatalog()
  const defs = signalIds.map(getSignal)

  const present = new Map<string, number>()
  const gaps: SignalGap[] = []

  for (const scope of ['target', 'dependency', 'infra'] as const) {
    const scopeDefs = defs.filter((d) => d.scope === scope)
    if (scopeDefs.length === 0) continue

    const selector = selectors[scope]

    // An infra selector of null means we could not work out which pods belong
    // to this application. Resolving anyway would match every container in the
    // cluster, so treat these as gaps with an explanation instead.
    if (scope === 'infra' && selector === null) {
      for (const def of scopeDefs) {
        gaps.push({
          signalId: def.id,
          title: def.title,
          lookedFor: def.candidates.map((c) => c.metric),
          remedy:
            "This target's metrics carry no namespace or pod label, so they cannot be matched to container metrics. " +
            'Add Kubernetes service-discovery relabeling so the application series carry `namespace` and `pod`.',
        })
      }
      continue
    }

    // Only ask about names the catalog already knows — everything else is
    // guaranteed to return nothing and only inflates the regex.
    const names = [
      ...new Set(
        scopeDefs.flatMap((d) => d.candidates.map((c) => c.metric)).filter((n) => catalog.names.has(n)),
      ),
    ]
    if (names.length === 0) continue

    const nameMatcher = `__name__=~"${names.map(escapeRegex).join('|')}"`
    const expr = `count by (__name__) ({${withSelector(nameMatcher, selector ?? '')}})`

    const rows = await instantQuery(expr)
    for (const row of rows) {
      const name = row.metric.__name__
      if (name) present.set(name, row.value ?? 0)
    }
  }

  // Pick one flavor per family so sibling signals agree on label names.
  const familyFlavor = new Map<string, string>()
  for (const def of defs) {
    if (!def.family || familyFlavor.has(def.family)) continue
    const winner = def.candidates.find((c) => present.has(c.metric))
    if (winner) familyFlavor.set(def.family, winner.flavor)
  }

  const resolved = new Map<string, Resolved>()
  const needsLabels: { id: string; metric: string; selector: string }[] = []
  const alreadyGapped = new Set(gaps.map((g) => g.signalId))

  for (const def of defs) {
    if (alreadyGapped.has(def.id)) continue
    const wanted = def.family ? familyFlavor.get(def.family) : undefined
    const candidate =
      (wanted ? def.candidates.find((c) => c.flavor === wanted && present.has(c.metric)) : undefined) ??
      def.candidates.find((c) => present.has(c.metric))

    if (!candidate) {
      gaps.push({
        signalId: def.id,
        title: def.title,
        lookedFor: def.candidates.map((c) => c.metric),
        remedy: def.remedy,
      })
      continue
    }

    const baseSelector = selectors[def.scope] ?? ''
    resolved.set(def.id, makeResolved(def, candidate, baseSelector, present.get(candidate.metric) ?? 0, []))
    needsLabels.push({
      id: def.id,
      metric: candidate.metric,
      selector: withSelector(`__name__="${candidate.metric}"`, baseSelector),
    })
  }

  if (!withLabels) return { resolved, gaps }

  // Live label names per resolved metric. Cheap, parallel, and it lets the UI
  // show the user what they can break a query down by.
  const labelResults = await Promise.all(
    needsLabels.map(async (item) => {
      try {
        return { id: item.id, labels: await labelNames([`{${item.selector}}`]) }
      } catch {
        return { id: item.id, labels: [] as string[] }
      }
    }),
  )

  for (const { id, labels } of labelResults) {
    const entry = resolved.get(id)
    if (entry) entry.labels = labels.filter((l) => l !== '__name__').sort()
  }

  return { resolved, gaps }
}

function makeResolved(
  def: SignalDef,
  candidate: SignalCandidate,
  baseSelector: string,
  seriesCount: number,
  labels: string[],
): Resolved {
  return {
    signalId: def.id,
    title: def.title,
    metric: candidate.metric,
    flavor: candidate.flavor,
    labels,
    seriesCount,
    candidate,
    baseSelector,
    scale: candidate.scale ?? 1,
    sel(...extra: string[]) {
      return withSelector(baseSelector, candidate.matchers ?? '', ...extra)
    },
    label(role: LabelRole) {
      return candidate.labels?.[role]
    },
    by(...roles: LabelRole[]) {
      const names = roles.map((r) => candidate.labels?.[r]).filter((n): n is string => Boolean(n))
      return names.length ? `by (${names.join(', ')})` : ''
    },
    has(...roles: LabelRole[]) {
      return roles.every((r) => Boolean(candidate.labels?.[r]))
    },
  }
}
