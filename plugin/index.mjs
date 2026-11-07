import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHandoffRoutes } from './routes.mjs'

export const name = 'dsh-shell-switch'
export const inject = ['webServer']

const LAUNCHER_CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

function nodeBinary() {
  return process.env.DSH_SWITCH_NODE || 'node'
}

/** Spawn the launcher detached so it survives this host being closed. */
function spawnLauncher(target) {
  const child = spawn(nodeBinary(), [LAUNCHER_CLI, target, '--force'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd: path.dirname(path.dirname(LAUNCHER_CLI)),
  })
  child.unref()
  return child.pid
}

/** Best-effort activity read; null means "cannot confirm". */
function readActivity(ctx) {
  try {
    const registry = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents
    const list = registry && typeof registry.list === 'function' ? registry.list() : null
    if (!Array.isArray(list)) return null
    return { agents: list.filter((entry) => entry?.status === 'running').length, jobs: 0 }
  } catch {
    return null
  }
}

function send(res, result) {
  res.statusCode = result.status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(result.body)
}

export function apply(ctx) {
  const routes = createHandoffRoutes({
    spawnLauncher,
    readActivity: () => readActivity(ctx),
  })

  const mount = (host) => {
    const server = host?.webServer
    if (!server || typeof server.register !== 'function' || typeof host.effect !== 'function') return
    const handler = (req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 8192) req.destroy()
      })
      req.on('end', () => {
        const remote = { remoteAddress: req.socket?.remoteAddress }
        send(res, routes.handle(req.method, req.url, req.headers, remote, body))
      })
      req.on('error', () => send(res, { status: 500, body: JSON.stringify({ error: 'request-error' }) }))
    }
    host.effect(() => server.register({ kind: 'exact', path: '/dsh-switch/state', handler }))
    host.effect(() => server.register({ kind: 'exact', path: '/dsh-switch/handoff', handler }))
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], mount)
      return
    } catch {
      /* fall through */
    }
  }
  if (ctx.webServer) mount(ctx)
}
