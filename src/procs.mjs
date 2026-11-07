import { execFile } from 'node:child_process'

const PS_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'

/** Run PowerShell and return its stdout. */
export function defaultRun(args = ['-NoProfile', '-Command', PS_QUERY]) {
  return new Promise((resolve) => {
    execFile('powershell.exe', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ stdout: stdout ?? '', error })
    })
  })
}

/** Every process as { pid, name, commandLine }. Empty output yields []. */
export async function listProcesses(run = defaultRun) {
  const { stdout } = await run()
  const text = (stdout ?? '').replace(/^\uFEFF/, '').trim()
  if (text === '') return []
  const parsed = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    name: String(row.Name ?? ''),
    commandLine: String(row.CommandLine ?? ''),
  }))
}

/** The Electron app's own host: desktop profile, dsh-desktop-host entry. */
export function isDesktopHost(process, paths) {
  const cmd = String(process.commandLine ?? '').toLowerCase()
  return cmd.includes('dsh-desktop-host') && cmd.includes(String(paths.desktopProfile).toLowerCase())
}

/** A CLI web host serving the web profile (explicit or default form). */
export function isWebHost(process, paths) {
  const cmd = String(process.commandLine ?? '').toLowerCase()
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
    execFile('taskkill', args, { windowsHide: true }, () => resolve())
  })
}

/**
 * Ask the tree to exit, wait, then force only when allowed.
 * Never reports forced unless the force signal was actually sent.
 */
export async function killTree(pid, {
  force = false, timeoutMs = 10000, list = listProcesses, kill = defaultKill,
} = {}) {
  await kill(pid, 'graceful')
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const alive = async () => {
    try {
      return (await list()).some((p) => p.pid === pid)
    } catch {
      return true
    }
  }
  while (Date.now() < deadline) {
    if (!(await alive())) return { killed: true, forced: false }
    await sleep(200)
  }
  if (!(await alive())) return { killed: true, forced: false }
  if (!force) return { killed: false, forced: false }
  await kill(pid, 'force')
  await sleep(300)
  return { killed: true, forced: true }
}
