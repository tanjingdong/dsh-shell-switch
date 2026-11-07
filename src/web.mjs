import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

/**
 * Spawn the host detached, with its output going to a file and never to a
 * pipe. The launcher exits as soon as the switch is done: on Windows a
 * non-detached child is taken down with its parent, and a pipe would close
 * with the launcher too, so the host would die right after being reported up.
 */
export function spawnWebHost({ paths, args, logFile, spawnImpl = spawn, env = process.env }) {
  // Truncate: a reused port must not leave an old token url behind for
  // waitForToken to hand to the browser.
  const out = logFile ? fs.openSync(logFile, 'w') : 'ignore'
  try {
    const child = spawnImpl(paths.exe, ['--expose-internals', paths.cliJs, ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      detached: true,
      stdio: ['ignore', out, out],
    })
    child.unref?.()
    return child
  } finally {
    if (typeof out === 'number') fs.closeSync(out)
  }
}

/** Read the token url out of the host's log file. */
export async function waitForToken({
  file, timeoutMs = 15000, intervalMs = 100, read = (target) => fs.readFileSync(target, 'utf8'),
}) {
  const deadline = Date.now() + timeoutMs
  do {
    let text = ''
    try {
      text = read(file)
    } catch {
      text = ''
    }
    const url = extractTokenUrl(text)
    if (url) return url
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  } while (Date.now() < deadline)
  throw new LauncherError(
    'no-token-url',
    `web 没有在 ${timeoutMs}ms 内打印带 token 的地址（日志：${file}）`,
  )
}

/** The relay must outlive the launcher, so it runs as its own detached node process. */
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
 * the launcher's console, so put it where a human can copy it: clipboard plus
 * a dialog. The url travels through the environment, so no quoting bugs.
 */
const CLIPBOARD_SCRIPT = 'Add-Type -AssemblyName System.Windows.Forms; '
  + 'Set-Clipboard -Value $env:DSH_SWITCH_URL'

const DIALOG_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$u = $env:DSH_SWITCH_URL',
  '[void][System.Windows.Forms.MessageBox]::Show('
  + '"浏览器 Web 已启动。`n`n$u`n`n地址已复制到剪贴板，可直接粘贴到浏览器。", '
  + '"DSH 外壳切换", '
  + '[System.Windows.Forms.MessageBoxButtons]::OK, '
  + '[System.Windows.Forms.MessageBoxIcon]::Information)',
].join('; ')

/**
 * A bare detached powershell exits with code 0 and runs nothing, so the script
 * goes through cmd (which gives it a console) as an encoded command (which
 * needs no quoting), with the url passed in the environment.
 */
function runPowerShell({ script, url, spawnProcess = spawn, env = process.env, logFile }) {
  const out = logFile ? fs.openSync(logFile, 'a') : 'ignore'
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawnProcess(
      'cmd.exe',
      ['/c', 'powershell.exe', '-NoProfile', '-STA', '-EncodedCommand', encoded],
      {
        env: { ...env, DSH_SWITCH_URL: String(url ?? '') },
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
      },
    )
    child.unref?.()
    return { pid: child.pid }
  } finally {
    if (typeof out === 'number') fs.closeSync(out)
  }
}

/** Put the url on the clipboard; the dialog is a separate channel now. */
export function copyToClipboard({ url, spawnProcess = spawn, env = process.env, logFile } = {}) {
  return runPowerShell({ script: CLIPBOARD_SCRIPT, url, spawnProcess, env, logFile })
}

export function showUrlDialog({ url, spawnProcess = spawn, env = process.env, logFile } = {}) {
  return runPowerShell({ script: DIALOG_SCRIPT, url, spawnProcess, env, logFile })
}

/**
 * Start the web host and publish it through a separate relay process.
 * Every failure unwinds what this call already started.
 */
export async function startWeb({
  paths, port, addresses = [], logFile, spawnProcess = spawnWebHost, wait = waitReady,
  readLog, spawnRelay = defaultSpawnRelay, openBrowser = defaultOpen, kill = killTree,
  onSpawn = async () => {}, notifyUrl = async () => {}, tokenTimeoutMs = 15000, log = () => {},
}) {
  const webLog = logFile ?? path.join(paths.logDir ?? os.tmpdir(), `web-host-${port}.log`)
  const args = buildWebArgs({ port, addresses })
  const child = spawnProcess({ paths, args, logFile: webLog })
  let relayPid = null
  const failed = new Promise((resolve) => child.once('error', (error) => resolve({ error })))

  try {
    await onSpawn(child.pid)
    const outcome = await Promise.race([wait({ port }).then((ready) => ({ ready })), failed])
    if (outcome.error) {
      throw new LauncherError('spawn-failed', `无法启动 web：${outcome.error?.message ?? outcome.error}`)
    }
    if (!outcome.ready) {
      throw new LauncherError('start-timeout', `web 在端口 ${port} 上没有就绪（日志：${webLog}）`)
    }
    const url = await waitForToken({ file: webLog, timeoutMs: tokenTimeoutMs, read: readLog })
    relayPid = (await spawnRelay({ targetPort: port, listenPort: port, addresses, log }))?.pid ?? null
    log(`[web] 主机日志：${webLog}`)
    openBrowser(url)
    try {
      await notifyUrl({ url, relayPid, logFile: webLog })
    } catch (error) {
      // The url also lives in state and the log; a failed dialog must not
      // tear down a host that is already listening.
      log(`[web] 无法显示地址对话框：${error?.message ?? error}`)
    }
    return { pid: child.pid, port, url, relayPid, child, logFile: webLog }
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
