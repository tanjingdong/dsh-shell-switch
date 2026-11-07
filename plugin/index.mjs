import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../src/log.mjs'
import { resolvePaths } from '../src/paths.mjs'
import { createHandoffRoutes } from './routes.mjs'

export const name = 'dsh-shell-switch'
export const inject = ['webServer']

const LAUNCHER_CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const LAUNCHER_CWD = path.dirname(path.dirname(LAUNCHER_CLI))

function vendoredNode(env) {
  const home = env.USERPROFILE
  return home ? path.join(home, '.dsh', 'plugins', 'rea-bundle', 'vendor', 'node', 'node.exe') : null
}

/** Prefer an explicit node, then rea's vendored node, then PATH. */
export function resolveNodeBinary({ env = process.env, exists = fs.existsSync } = {}) {
  const explicit = env.DSH_SWITCH_NODE
  if (explicit && exists(explicit)) return explicit
  const vendored = vendoredNode(env)
  if (vendored && exists(vendored)) return vendored
  return 'node'
}

/**
 * Spawn the launcher detached so it survives this host being closed. A spawn
 * failure used to vanish; it now lands in the launcher log with a manual
 * command the user can run.
 */
export function createLauncherSpawner({
  spawnFn = spawn, nodeBinary = 'node', cwd = LAUNCHER_CWD, log = () => {},
} = {}) {
  return (target) => {
    const child = spawnFn(nodeBinary, [LAUNCHER_CLI, target, '--force'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd,
    })
    child.on?.('error', (error) => {
      log(`[switch] 无法启动切换器（${nodeBinary}）：${error?.message ?? error}。可手动运行 dsh-switch ${target}`)
    })
    child.unref()
    return child.pid
  }
}

/** Count the work a switch would cut. null means "cannot confirm". */
export function readActivity(ctx) {
  try {
    const get = (key) => (typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key])
    const registry = get('agents')
    const list = registry && typeof registry.list === 'function' ? registry.list() : null
    if (!Array.isArray(list)) return null
    const count = (value) => {
      if (!value) return 0
      const items = typeof value.list === 'function' ? value.list() : value
      return Array.isArray(items) ? items.length : 0
    }
    const inbox = get('inbox') ?? {}
    return {
      agents: list.filter((entry) => entry?.status === 'running').length,
      jobs: count(get('jobs')),
      inbox: Boolean(inbox?.nextTurn || inbox?.nextStep),
      approvals: count(inbox?.approvals),
    }
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
  const logger = createLogger({ paths: resolvePaths() })
  const spawnLauncher = createLauncherSpawner({
    nodeBinary: resolveNodeBinary(),
    log: logger.log,
  })
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
