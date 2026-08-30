import { config } from './config.ts'
import type { Series, SeriesPoint } from '../shared/types.ts'

/** Prometheus wraps every response in this envelope. */
interface PromEnvelope<T> {
  status: 'success' | 'error'
  data: T
  errorType?: string
  error?: string
  warnings?: string[]
}

type PromValue = [number, string]

interface PromVectorSample {
  metric: Record<string, string>
  value: PromValue
}

interface PromMatrixSample {
  metric: Record<string, string>
  values: PromValue[]
}

export class PrometheusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly expr?: string,
  ) {
    super(message)
    this.name = 'PrometheusError'
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...config.extraHeaders,
  }
  if (config.hasToken) headers.Authorization = `Bearer ${config.prometheusToken}`
  return headers
}

/**
 * All Prometheus traffic funnels through here.
 *
 * Query endpoints are POSTed, because generated PromQL routinely exceeds what
 * proxies allow in a URL. The rest must be GET — Prometheus returns 405 for a
 * POST to `/api/v1/label/<name>/values`, `/api/v1/metadata` or the status
 * endpoints, which accept GET only.
 */
async function request<T>(
  path: string,
  params: Record<string, string | string[]>,
  method: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const v of value) body.append(key, v)
    else body.append(key, value)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  const query = body.toString()
  const url =
    method === 'GET'
      ? `${config.prometheusUrl}${path}${query ? `?${query}` : ''}`
      : `${config.prometheusUrl}${path}`

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers:
        method === 'POST'
          ? { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }
          : authHeaders(),
      body: method === 'POST' ? body : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const hint =
      reason.includes('aborted') || reason.includes('abort')
        ? `timed out after ${config.timeoutMs}ms`
        : reason
    throw new PrometheusError(`Could not reach Prometheus at ${config.prometheusUrl} — ${hint}`, 502)
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    throw new PrometheusError(
      config.hasToken
        ? `Prometheus rejected the bearer token (HTTP ${response.status}). Check PROMETHEUS_TOKEN.`
        : `Prometheus requires authentication (HTTP ${response.status}) but PROMETHEUS_TOKEN is not set.`,
      response.status,
    )
  }

  const text = await response.text()
  let payload: PromEnvelope<T>
  try {
    payload = JSON.parse(text) as PromEnvelope<T>
  } catch {
    throw new PrometheusError(
      `Prometheus returned a non-JSON response (HTTP ${response.status}). ` +
        `Is PROMETHEUS_URL pointing at the API root rather than a UI path? ` +
        `First 200 chars: ${text.slice(0, 200)}`,
      response.status,
    )
  }

  if (payload.status !== 'success') {
    throw new PrometheusError(
      payload.error ?? `Prometheus error (${payload.errorType ?? 'unknown'})`,
      response.status,
      typeof params.query === 'string' ? params.query : undefined,
    )
  }

  return payload.data
}

/** Instant query. Returns one sample per matching series. */
export async function instantQuery(
  expr: string,
  at?: number,
): Promise<{ metric: Record<string, string>; value: number | null }[]> {
  const params: Record<string, string> = { query: expr }
  if (at !== undefined) params.time = String(at)

  const data = await request<{ resultType: string; result: PromVectorSample[] }>(
    '/api/v1/query',
    params,
  )
  if (data.resultType !== 'vector' && data.resultType !== 'scalar') return []

  return data.result.map((sample) => ({
    metric: sample.metric,
    value: parseSample(sample.value[1]),
  }))
}

/** Range query. Returns one Series per matching series, gaps preserved as null. */
export async function rangeQuery(
  expr: string,
  start: number,
  end: number,
  step: number,
): Promise<{ metric: Record<string, string>; points: SeriesPoint[] }[]> {
  const data = await request<{ resultType: string; result: PromMatrixSample[] }>(
    '/api/v1/query_range',
    {
      query: expr,
      start: String(start),
      end: String(end),
      step: String(step),
    },
  )
  if (data.resultType !== 'matrix') return []

  return data.result.map((sample) => ({
    metric: sample.metric,
    points: sample.values.map(([t, v]) => ({ t, v: parseSample(v) })),
  }))
}

/**
 * Prometheus serialises NaN/Inf as strings. They mean "no value here" for our
 * purposes — a gap the chart should break across, not a zero it should plot.
 */
function parseSample(raw: string): number | null {
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Every metric name known to this Prometheus. */
export async function metricNames(): Promise<string[]> {
  return request<string[]>('/api/v1/label/__name__/values', {}, 'GET')
}

/** Values of a single label, optionally restricted to matching series. */
export async function labelValues(label: string, match?: string[]): Promise<string[]> {
  const params: Record<string, string | string[]> = {}
  if (match?.length) params['match[]'] = match
  return request<string[]>(`/api/v1/label/${encodeURIComponent(label)}/values`, params, 'GET')
}

/** Label names carried by the series matching a selector. */
export async function labelNames(match?: string[]): Promise<string[]> {
  const params: Record<string, string | string[]> = {}
  if (match?.length) params['match[]'] = match
  return request<string[]>('/api/v1/labels', params)
}

export interface MetricMetadata {
  type: string
  help: string
  unit: string
}

/** HELP and TYPE for every metric, as reported by the scraped targets. */
export async function metadata(): Promise<Record<string, MetricMetadata[]>> {
  return request<Record<string, MetricMetadata[]>>('/api/v1/metadata', {}, 'GET')
}

export async function buildInfo(): Promise<{ version?: string }> {
  try {
    return await request<{ version?: string }>('/api/v1/status/buildinfo', {}, 'GET')
  } catch {
    // Not every Prometheus-compatible backend implements buildinfo; a missing
    // version is cosmetic, so degrade instead of failing the health check.
    return {}
  }
}

/** Turns Prometheus label maps into the Series shape the UI consumes. */
export function toSeries(
  raw: { metric: Record<string, string>; points: SeriesPoint[] }[],
  legend: (labels: Record<string, string>) => string,
): Series[] {
  return raw.map((item) => ({
    name: legend(item.metric) || '(unlabelled)',
    labels: item.metric,
    points: item.points,
  }))
}
