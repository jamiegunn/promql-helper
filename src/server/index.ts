import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config } from './config.ts'
import { PrometheusError, buildInfo } from './prom.ts'
import {
  getCatalog,
  invalidateCatalog,
  listTargets,
  narrowingLabelsFor,
  narrowingValuesFor,
} from './catalog.ts'
import { offerInvestigations, runInvestigation } from './engine.ts'
import { TIME_RANGES } from '../shared/types.ts'
import type { ConnectionStatus, TargetFilter, TargetSelection, TimeRangeId } from '../shared/types.ts'

const app = new Hono()

/** Turns thrown errors into a shape the UI can render without guessing. */
function fail(err: unknown): { error: string; status: number } {
  if (err instanceof PrometheusError) return { error: err.message, status: err.status }
  return { error: err instanceof Error ? err.message : String(err), status: 500 }
}

app.get('/api/health', async (c) => {
  const status: ConnectionStatus = {
    connected: false,
    url: config.prometheusUrl,
    authenticated: config.hasToken,
  }
  try {
    const [info, catalog] = await Promise.all([buildInfo(), getCatalog()])
    status.connected = true
    status.version = info.version
    status.metricCount = catalog.names.size
  } catch (err) {
    status.error = fail(err).error
  }
  return c.json(status)
})

app.post('/api/refresh', async (c) => {
  invalidateCatalog()
  const catalog = await getCatalog(true)
  return c.json({ metricCount: catalog.names.size })
})

app.get('/api/ranges', (c) => c.json(TIME_RANGES))

app.get('/api/targets', async (c) => {
  try {
    return c.json(await listTargets())
  } catch (err) {
    const { error, status } = fail(err)
    return c.json({ error }, status as 500)
  }
})

app.get('/api/targets/:job/labels', async (c) => {
  try {
    return c.json(await narrowingLabelsFor(c.req.param('job')))
  } catch (err) {
    const { error, status } = fail(err)
    return c.json({ error }, status as 500)
  }
})

app.get('/api/targets/:job/labels/:label/values', async (c) => {
  try {
    // Prior filters arrive as JSON so a namespace choice can narrow the pod list.
    const raw = c.req.query('filters')
    const filters: TargetFilter[] = raw ? (JSON.parse(raw) as TargetFilter[]) : []
    const values = await narrowingValuesFor(c.req.param('job'), c.req.param('label'), filters)
    return c.json(values)
  } catch (err) {
    const { error, status } = fail(err)
    return c.json({ error }, status as 500)
  }
})

app.post('/api/investigations', async (c) => {
  try {
    const selection = (await c.req.json()) as TargetSelection
    if (!selection?.job) return c.json({ error: 'A job is required.' }, 400)
    return c.json(await offerInvestigations({ ...selection, filters: selection.filters ?? [] }))
  } catch (err) {
    const { error, status } = fail(err)
    return c.json({ error }, status as 500)
  }
})

app.post('/api/run', async (c) => {
  try {
    const body = (await c.req.json()) as {
      investigationId: string
      target: TargetSelection
      range: TimeRangeId
    }
    if (!body?.investigationId || !body?.target?.job) {
      return c.json({ error: 'investigationId and target.job are required.' }, 400)
    }
    const report = await runInvestigation(
      body.investigationId,
      { ...body.target, filters: body.target.filters ?? [] },
      body.range ?? '1h',
    )
    return c.json(report)
  } catch (err) {
    const { error, status } = fail(err)
    return c.json({ error }, status as 500)
  }
})

// In production the built frontend is served from the same origin, so there is
// no CORS surface and the bearer token never leaves this process.
const webRoot = resolve(process.cwd(), 'dist/web')
if (config.isProduction && existsSync(webRoot)) {
  app.use('/assets/*', serveStatic({ root: './dist/web' }))
  app.get('*', (c) => c.html(readFileSync(resolve(webRoot, 'index.html'), 'utf8')))
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const where = config.isProduction ? `http://localhost:${info.port}` : 'http://localhost:5173'
  console.log(`\n  PromQL Helper`)
  console.log(`  Prometheus  ${config.prometheusUrl}${config.hasToken ? '  (bearer token set)' : '  (no token)'}`)
  console.log(`  API         http://localhost:${info.port}`)
  console.log(`  Open        ${where}\n`)
})
