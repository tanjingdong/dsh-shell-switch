import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LauncherError } from './errors.mjs'
import { probePort } from './ports.mjs'
import { killTree } from './procs.mjs'

const RELAY_SCRIPT = fileURLToPath(new URL('./relay.mjs', import.meta.url))

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

/** An HTTP answer at `/` means the host really serves, not just accepts TCP. */
export async function httpReady(port, fetchImpl = globalThis.fetch, timeoutMs = 2000) {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

/** Poll until the port accepts connections and answers HTTP. */
export async function waitReady({
  port, timeoutMs = 60000, probe = probePort, httpProbe = httpReady, intervalMs = 500,
}) {
  const deadline = Date.now() + timeoutMs
  do {
    if (await probe(port) && await httpProbe(port)) return true
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

/**
 * The relay must outlive the launcher, so it runs as its own detached node
 * process. `process.execPath` is the node already running this file.
 */
function defaultSpawnRelay({ targetPort, listenPort, addresses }) {
  const child = spawn(process.execPath, [
    RELAY_SCRIPT,
    '--target-port', String(targetPort),
    '--listen-port', String(listenPort),
    '--addresses', (addresses ?? []).join(','),
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return { pid: child.pid }
}

function defaultOpen(url) {
  spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
}

/**
 * The token url is the only way into the host, and the host is detached from
 * the launcher's console, so put it somewhere a human can copy it: clipboard
 * plus a dialog. The url travels through the environment, so no quoting bugs.
 */
const URL_DIALOG_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$u = $env:DSH_SWITCH_URL',
  'Set-Clipboard -Value $u',
  '[void][System.Windows.Forms.MessageBox]::Show('
  + '"浏览器 Web 已启动。`n`n$u`n`n地址已复制到剪贴板，可直接粘贴到浏览器。", '
  + '"DSH 外壳切换", '
  + '[System.Windows.Forms.MessageBoxButtons]::OK, '
  + '[System.Windows.Forms.MessageBoxIcon]::Information)',
].join('; ')

export function showUrlDialog({ url, spawnProcess = spawn, env = process.env } = {}) {
  const child = spawnProcess('powershell.exe', ['-NoProfile', '-Command', URL_DIALOG_SCRIPT], {
    env: { ...env, DSH_SWITCH_URL: String(url ?? '') },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { pid: child.pid }
}

function withTimeout(promise, ms, code) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LauncherError(code, '等待超时')), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Start the web host and publish it through a separate relay process.
 * Every failure unwinds what this call already started.
 */
export async function startWeb({
  paths, port, addresses = [], spawnProcess = defaultSpawn, wait = waitReady,
  spawnRelay = defaultSpawnRelay, openBrowser = defaultOpen, kill = killTree,
  onSpawn = async () => {}, notifyUrl = async () => {}, tokenTimeoutMs = 15000, log = () => {},
}) {
  const child = spawnProcess(paths, buildWebArgs({ port, addresses }))
  let relayPid = null
  let buffer = ''
  let resolveUrl
  const urlPromise = new Promise((resolve) => { resolveUrl = resolve })
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const url = extractTokenUrl(buffer)
    if (url) resolveUrl(url)
  })
  child.stderr.on('data', (chunk) => log(`[web] ${chunk.toString().trim()}`))
  const failed = new Promise((resolve) => child.once('error', (error) => resolve({ error })))

  try {
    await onSpawn(child.pid)
    const outcome = await Promise.race([wait({ port }).then((ready) => ({ ready })), failed])
    if (outcome.error) {
      throw new LauncherError('spawn-failed', `无法启动 web：${outcome.error?.message ?? outcome.error}`)
    }
    if (!outcome.ready) throw new LauncherError('start-timeout', `web 在端口 ${port} 上没有就绪`)
    const url = await withTimeout(urlPromise, tokenTimeoutMs, 'no-token-url')
    relayPid = (await spawnRelay({ targetPort: port, listenPort: port, addresses, log }))?.pid ?? null
    openBrowser(url)
    try {
      await notifyUrl({ url, relayPid })
    } catch (error) {
      // The url also lives in state and the log; a failed dialog must not
      // tear down a host that is already listening.
      log(`[web] 无法显示地址对话框：${error?.message ?? error}`)
    }
    return { pid: child.pid, port, url, relayPid, child }
  } catch (error) {
    if (relayPid) await kill(relayPid, { force: true }).catch(() => {})
    if (child.pid) await kill(child.pid, { force: true }).catch(() => {})
    throw error
  }
}

/** Stop the host: the relay first, then the host process tree. */
export async function stopWeb({ relayPid, pid, kill = killTree }) {
  const result = { killed: true, forced: false }
  if (relayPid) await kill(relayPid, { force: true }).catch(() => {})
  if (pid) return await kill(pid, { force: true })
  return result
}
