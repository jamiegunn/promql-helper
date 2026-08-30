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
import { buildCapabilityReport } from './capabilities.ts'
import {
  PortUnavailable,
  describePortOwner,
  explainPortConflict,
  isPortFree,
  takeOverPort,
} from './port.ts'
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

app.get('/api/capabilities', async (c) => {
  try {
    return c.json(await buildCapabilityReport())
  } catch (err) {
    const { error, status } = fail(err)
    return c.json({ error }, status as 500)
  }
})

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

/**
 * Binds the port, but explains itself first if something else already has it.
 * A raw EADDRINUSE stack trace tells you nothing about which process to stop.
 */
async function start(): Promise<void> {
  if (!(await isPortFree(config.port))) {
    if (!config.takeoverPort) {
      console.error(explainPortConflict(config.port, describePortOwner(config.port)))
      process.exit(1)
    }

    try {
      const stopped = await takeOverPort(config.port)
      console.log(`\n  Stopped the server already on port ${config.port} (PID ${stopped.pid}).`)
    } catch (err) {
      if (err instanceof PortUnavailable) {
        console.error(explainPortConflict(err.port, err.owner, err.detail))
        process.exit(1)
      }
      throw err
    }
  }

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    // In dev the UI is served by Vite, which steps to the next free port if
    // 5173 is taken — so point at the port Vite actually reports rather than
    // assuming, and let the API port speak for itself.
    console.log(`\n  PromQL Helper`)
    console.log(
      `  Prometheus  ${config.prometheusUrl}${config.hasToken ? '  (bearer token set)' : '  (no token)'}`,
    )
    console.log(`  API         http://localhost:${info.port}`)
    console.log(
      config.isProduction
        ? `  Open        http://localhost:${info.port}\n`
        : `  Open        the URL Vite prints below (5173 unless it is taken)\n`,
    )
  })
}

start().catch((err: unknown) => {
  console.error(`\n  Could not start: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
