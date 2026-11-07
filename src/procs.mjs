import { execFile } from 'node:child_process'

/** PowerShell 5.1 prints in the console code page; force UTF-8 before the query. */
export const PROCESS_QUERY = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); '
  + 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'

/** Run PowerShell and return its stdout plus any failure. */
export function defaultRun(args = ['-NoProfile', '-Command', PROCESS_QUERY]) {
  return new Promise((resolve) => {
    execFile('powershell.exe', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ stdout: stdout ?? '', error })
    })
  })
}

/** Every process as { pid, name, commandLine }. A read failure throws. */
export async function listProcesses(run = defaultRun) {
  const { stdout, error } = await run()
  const text = (stdout ?? '').replace(/^\uFEFF/, '').trim()
  if (text === '') {
    if (error) throw new Error(`无法读取进程列表：${error.message ?? error}`)
    return []
  }
  const parsed = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    name: String(row.Name ?? ''),
    commandLine: String(row.CommandLine ?? ''),
  }))
}

const normalize = (value) => String(value ?? '').replace(/\//g, '\\').toLowerCase()

/** The Electron app's own host: desktop profile, dsh-desktop-host entry. */
export function isDesktopHost(process, paths) {
  const cmd = normalize(process.commandLine)
  return cmd.includes('dsh-desktop-host') && cmd.includes(normalize(paths.desktopProfile))
}

/** The Electron window shell itself, as opposed to its desktop host child. */
export function isElectronShell(process, paths) {
  const cmd = normalize(process.commandLine)
  return cmd.includes(normalize(paths.exe)) && !cmd.includes('dsh-desktop-host')
}

const LISTEN_QUERY = (pid) => '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); '
  + `Get-NetTCPConnection -State Listen -OwningProcess ${Math.trunc(Number(pid))} -ErrorAction SilentlyContinue `
  + '| Select-Object -ExpandProperty LocalPort'

/** Listening TCP ports owned by one pid. Unreadable reads as none. */
export async function listListeningPorts(pid, { run = defaultRun } = {}) {
  const { stdout } = await run(['-NoProfile', '-Command', LISTEN_QUERY(pid)])
  return String(stdout ?? '')
    .replace(/^\uFEFF/, '')
    .split(/[\r\n]+/)
    .map((line) => Number(line.trim()))
    .filter((port) => Number.isInteger(port) && port > 0)
}

/** A CLI web host serving the web profile (explicit or default form). */
export function isWebHost(process, paths) {
  const cmd = normalize(process.commandLine)
  if (!cmd.includes('cli.js')) return false
  if (isDesktopHost(process, paths)) return false
  return /--profile\s+web\b/.test(cmd) || /cli\.js"?\s+web\b/.test(cmd)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultKill(pid, mode) {
  const args = ['/PID', String(pid), '/T']
  if (mode === 'force') args.push('/F')
  return new Promise((resolve) => {
    execFile('taskkill', args, { windowsHide: true }, (error) => resolve({ error }))
  })
}

/**
 * Ask the tree to exit, wait, then force only when allowed.
 * Truthful by construction: the result says whether the process is gone.
 */
export async function killTree(pid, {
  force = false, timeoutMs = 10000, list = listProcesses, kill = defaultKill,
} = {}) {
  const alive = async () => {
    try {
      return (await list()).some((process) => process.pid === pid)
    } catch {
      return true
    }
  }

  await kill(pid, 'graceful')
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    if (!(await alive())) return { killed: true, forced: false }
    await sleep(200)
  }
  if (!(await alive())) return { killed: true, forced: false }
  if (!force) return { killed: false, forced: false }

  const forced = await kill(pid, 'force')
  await sleep(300)
  const stillAlive = await alive()
  if (stillAlive) throw new Error(`无法结束进程 ${pid}${forced?.error ? `：${forced.error.message}` : ''}`)
  return { killed: true, forced: true }
}
