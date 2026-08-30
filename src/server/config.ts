import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Loads .env by hand rather than pulling in dotenv — we need exactly one file,
 * and process.env always wins so a real environment variable can override it.
 */
function loadDotEnv(): void {
  let raw: string
  try {
    raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
  } catch {
    return // no .env is fine — the environment may already carry the vars
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // Strip one layer of matching quotes, so tokens with `#` or spaces survive.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnv()

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      )
    }
  } catch {
    console.warn('[config] PROMETHEUS_HEADERS is not valid JSON — ignoring it.')
  }
  return {}
}

const url = (process.env.PROMETHEUS_URL ?? '').trim().replace(/\/+$/, '')

if (!url) {
  console.error(
    '\n  PROMETHEUS_URL is not set.\n\n' +
      '  Copy .env.example to .env and fill it in, or export the variables:\n\n' +
      '    export PROMETHEUS_URL=https://prometheus.example.com\n' +
      '    export PROMETHEUS_TOKEN=<bearer token>\n',
  )
  process.exit(1)
}

const token = (process.env.PROMETHEUS_TOKEN ?? '').trim()

if (process.env.PROMETHEUS_INSECURE === '1') {
  // Applies process-wide; the .env.example documents the tradeoff.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  console.warn('[config] TLS verification disabled (PROMETHEUS_INSECURE=1).')
}

export const config = {
  prometheusUrl: url,
  prometheusToken: token,
  hasToken: token.length > 0,
  extraHeaders: parseHeaders(process.env.PROMETHEUS_HEADERS),
  timeoutMs: Number(process.env.PROMETHEUS_TIMEOUT_MS ?? 30_000),
  catalogTtlMs: Number(process.env.CATALOG_TTL_SECONDS ?? 300) * 1000,
  port: Number(process.env.PORT ?? 8787),
  isProduction: process.env.NODE_ENV === 'production',
} as const
