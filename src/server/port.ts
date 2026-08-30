import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

/**
 * Port collision handling for the dev server.
 *
 * The default is to refuse and explain: binding is cheap to retry, but killing
 * somebody else's process is not, so taking a port away from another process is
 * always opt-in and never happens to a process we cannot positively identify as
 * our own.
 */

export interface PortOwner {
  pid: number
  /** Full command line, as reported by ps. */
  command: string
  /** True only if this is confidently another instance of this project's server. */
  isOurs: boolean
}

/** Probes a port the same way the HTTP server will bind it. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port)
  })
}

/**
 * Identifies whatever is listening on a port. Returns null when nothing is, or
 * when the platform gives us no way to look — Windows has no lsof, and an
 * unknown owner is treated the same as an unidentifiable one.
 */
export function describePortOwner(port: number): PortOwner | null {
  const pid = listenerPid(port)
  if (pid === null) return null

  const command = commandForPid(pid) ?? '(command unavailable)'
  return { pid, command, isOurs: looksLikeOurServer(command) }
}

function listenerPid(port: number): number | null {
  try {
    // -F p prints one `p<pid>` line per match, which avoids parsing lsof's
    // column output across versions.
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const match = /^p(\d+)/m.exec(out)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

function commandForPid(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * Deliberately strict. It must match this checkout's path *and* this entry
 * point, so a same-named server from a different clone is never a target.
 */
function looksLikeOurServer(command: string): boolean {
  return command.includes(process.cwd()) && /src[/\\]server[/\\]index\.ts/.test(command)
}

export class PortUnavailable extends Error {
  constructor(
    readonly port: number,
    readonly owner: PortOwner | null,
    readonly detail?: string,
  ) {
    super(`Port ${port} is already in use`)
    this.name = 'PortUnavailable'
  }
}

/**
 * Stops another instance of this server and waits for the port to come free.
 *
 * Refuses anything it cannot identify as ours. If the port is reclaimed by a
 * new process straight afterwards, that means a supervisor such as
 * `tsx watch` is restarting it, and the right fix is to stop that terminal
 * rather than to keep killing children.
 */
export async function takeOverPort(port: number): Promise<PortOwner> {
  const owner = describePortOwner(port)

  if (!owner) {
    throw new PortUnavailable(
      port,
      null,
      'Could not work out which process holds the port, so nothing was stopped.',
    )
  }

  if (!owner.isOurs) {
    throw new PortUnavailable(
      port,
      owner,
      'PORT_TAKEOVER only stops servers started from this directory, so it was left alone.',
    )
  }

  try {
    process.kill(owner.pid, 'SIGTERM')
  } catch {
    // Already gone between describing it and signalling it — fine either way.
  }

  if (await waitForFree(port, 4000)) {
    const usurper = describePortOwner(port)
    if (usurper) {
      throw new PortUnavailable(
        port,
        usurper,
        'The port was taken again immediately, so something is restarting the server — ' +
          'probably another `npm run dev`. Stop that terminal instead.',
      )
    }
    return owner
  }

  try {
    process.kill(owner.pid, 'SIGKILL')
  } catch {
    /* nothing left to kill */
  }

  if (!(await waitForFree(port, 2000))) {
    throw new PortUnavailable(port, owner, 'It did not release the port even after SIGKILL.')
  }

  return owner
}

async function waitForFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/** The message shown when the port is taken and takeover was not requested. */
export function explainPortConflict(port: number, owner: PortOwner | null, detail?: string): string {
  const lines: string[] = ['', `  Port ${port} is already in use.`, '']

  if (owner) {
    lines.push(`  Held by  PID ${owner.pid} — ${condenseCommand(owner.command)}`)
    lines.push(
      owner.isOurs
        ? '           another PromQL Helper server from this directory'
        : '           not a PromQL Helper server',
    )
  } else {
    lines.push('  Could not work out which process holds it.')
  }

  if (detail) {
    lines.push('', `  ${detail}`)
  }

  const options: [string, string][] = []
  if (owner?.isOurs) {
    options.push(['npm run dev:takeover', 'stop it and take the port'])
  }
  options.push([`PORT=${port + 1} npm run dev`, 'run this one alongside it, on its own port'])
  if (owner) {
    options.push([`kill ${owner.pid}`, 'stop it yourself'])
  }

  const width = Math.max(...options.map(([cmd]) => cmd.length))
  lines.push('', '  What you can do:', '')
  for (const [cmd, description] of options) {
    lines.push(`    ${cmd.padEnd(width + 4)}${description}`)
  }
  lines.push('')

  return lines.join('\n')
}

/**
 * Turns a full process command line into something worth reading. Node entry
 * points arrive buried behind an absolute interpreter path and a pile of
 * --require/--import flags, none of which identify the process.
 */
function condenseCommand(command: string): string {
  const tokens = command.split(/\s+/).filter(Boolean)
  const binary = tokens[0] ? tokens[0].split(/[/\\]/).pop() ?? tokens[0] : 'process'

  const entry = tokens
    .slice(1)
    .find((t) => !t.startsWith('-') && !t.includes('node_modules') && /\.(ts|mjs|cjs|js)$/.test(t))

  if (!entry) return truncate(command, 88)

  const relative = entry.startsWith(process.cwd())
    ? entry.slice(process.cwd().length).replace(/^[/\\]/, '')
    : entry

  return `${binary} ${relative}`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
