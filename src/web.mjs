import { spawn } from 'node:child_process'
import { LauncherError } from './errors.mjs'
import { probePort } from './ports.mjs'
import { createRelay } from './relay.mjs'

/** CLI arguments for the web profile, one trusted host per extra address. */
export function buildWebArgs({ port, addresses = [], host = '127.0.0.1' }) {
  return [
    'web', '--host', host, '--port', String(port), '--no-open',
    ...addresses.flatMap((address) => ['--trusted-host', `${address}:${port}`]),
  ]
}

/** The tokenised url the host prints once it listens. */
export function extractTokenUrl(text) {
  const match = /https?:\/\/[^\s"'<>]*\?token=[^\s"'<>]+/.exec(String(text ?? ''))
  return match ? match[0] : null
}

/** Poll until the port accepts connections. */
export async function waitReady({ port, timeoutMs = 60000, probe = probePort, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs
  do {
    if (await probe(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  } while (Date.now() < deadline)
  return false
}

function defaultSpawn(paths, args) {
  return spawn(paths.exe, ['--expose-internals', paths.cliJs, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function defaultOpen(url) {
  spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
}

function withTimeout(promise, ms, code) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LauncherError(code, '等待超时')), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Start the web host, publish it on the extra addresses, open the browser. */
export async function startWeb({
  paths, port, addresses = [], spawnProcess = defaultSpawn, wait = waitReady,
  relayFactory = createRelay, openBrowser = defaultOpen, log = () => {},
}) {
  const child = spawnProcess(paths, buildWebArgs({ port, addresses }))
  let buffer = ''
  let resolveUrl
  const urlPromise = new Promise((resolve) => { resolveUrl = resolve })
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const url = extractTokenUrl(buffer)
    if (url) resolveUrl(url)
  })
  child.stderr.on('data', (chunk) => log(`[web] ${chunk.toString().trim()}`))

  const ready = await wait({ port })
  if (!ready) {
    child.kill()
    throw new LauncherError('start-timeout', `web 在端口 ${port} 上没有就绪`)
  }
  const url = await withTimeout(urlPromise, 15000, 'no-token-url')
  const relay = await relayFactory({ targetPort: port, addresses, log })
  openBrowser(url)
  return { pid: child.pid, port, url, relay, child }
}

/** Stop the host: close the relay first, then the process tree. */
export async function stopWeb({ relay, pid, kill }) {
  if (relay) await relay.close()
  if (pid && kill) return await kill(pid, { force: true })
  return { killed: true, forced: false }
}
