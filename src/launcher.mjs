import { spawn } from 'node:child_process'
import { LauncherError } from './errors.mjs'
import {
  isDesktopHost, isElectronShell, isWebHost, killTree, listListeningPorts, listProcesses,
} from './procs.mjs'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Which shell currently owns the desktop profile, if any. */
export async function detectCurrent({ paths, list = listProcesses } = {}) {
  const processes = await list()
  if (processes.some((process) => isDesktopHost(process, paths))) return 'client'
  if (processes.some((process) => isWebHost(process, paths))) return 'web'
  return null
}

/** Ask the host whether a turn is running. null = cannot confirm. */
export async function fetchBusy({ port, fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  if (!port) return null
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/dsh-switch/state`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = await response.json()
    // An unreachable registry answers known:false; that is not "idle".
    if (body?.known === false) return null
    return body?.busy === true
  } catch {
    return null
  }
}

/**
 * End the shell that owns `current`. The desktop client is a host child inside
 * an Electron window, so both must go: killing only the host leaves a window
 * stuck on the fatal-recovery dialog and blocks the next client start.
 */
export async function stopShell({ current, paths, list = listProcesses, kill = killTree }) {
  const processes = await list()
  const targets = current === 'client'
    ? [
      ...processes.filter((process) => isDesktopHost(process, paths)),
      ...processes.filter((process) => isElectronShell(process, paths)),
    ]
    : processes.filter((process) => isWebHost(process, paths))
  const killed = []
  for (const target of targets) {
    await kill(target.pid, { force: true })
    killed.push(target.pid)
  }
  return killed
}

/** Poll until the desktop host exists and owns a listening port. */
export async function waitForClient({
  paths, list = listProcesses, ports = listListeningPorts, timeoutMs = 20000, intervalMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs
  do {
    const processes = await list()
    const host = processes.find((process) => isDesktopHost(process, paths))
    if (host) {
      const open = await ports(host.pid).catch(() => [])
      if (open.length > 0) return { pid: host.pid, port: open[0] }
    }
    if (Date.now() >= deadline) break
    await sleep(intervalMs)
  } while (Date.now() < deadline)
  throw new LauncherError(
    'client-not-ready',
    '桌面客户端没有在预期时间内就绪（未发现 dsh-desktop-host 或其监听端口）。'
    + '可手动打开客户端，或重新运行 dsh-switch client',
  )
}

function defaultSpawnShell(paths) {
  const child = spawn(paths.exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return child.pid
}

/**
 * Start the desktop client and only report success once its host is listening.
 * A window that never comes up is a failure, not a success.
 */
export async function startClient({ paths, spawnShell = defaultSpawnShell, wait = waitForClient }) {
  const shellPid = spawnShell(paths)
  const ready = await wait({ paths })
  return { shellPid, pid: ready.pid, port: ready.port }
}

/**
 * Switch shells. Three attempts at the target, then stop: never restart
 * the shell we just closed.
 */
export async function switchTo(target, deps) {
  const {
    paths, force = false, log = () => {}, list = listProcesses, kill = killTree,
    prepare = async () => {}, startWeb, startClient, busyProbe = fetchBusy, port,
    pickPort,
  } = deps

  const current = await detectCurrent({ paths, list })
  if (current === target) return { switched: false, current }

  await prepare()

  if (current) {
    const busy = await busyProbe({ port })
    if (busy === true && !force) {
      throw new LauncherError('busy', '当前有回合在运行；确认后加 --force，或等它跑完再切换')
    }
    if (busy === null && !force) {
      throw new LauncherError('busy-unconfirmed', '无法确认当前是否空闲（状态接口不可用）；确认后加 --force')
    }
    await stopShell({ current, paths, list, kill })
  }

  let lastError
  const choosePort = pickPort ?? (async () => port)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // A failed attempt must not leave its port behind: re-probe it first.
      const attemptPort = await choosePort()
      await (target === 'web' ? startWeb({ port: attemptPort }) : startClient({ port: attemptPort }))
      return { switched: true, target, port: attemptPort }
    } catch (error) {
      lastError = error
      log(`[switch] 第 ${attempt} 次启动失败：${error?.message ?? error}`)
    }
  }

  throw new LauncherError(
    'start-failed',
    `${target} 连续 3 次启动失败：${lastError?.message ?? lastError}\n`
    + '现在没有任何外壳在运行。可重试：dsh-switch web  或  dsh-switch client',
  )
}

/**
 * Stop whatever shell owns the machine right now, plus the relay the launcher
 * recorded. The process list is the source of truth: a client started before
 * pid recording existed still gets stopped.
 */
export async function stopEverything({ paths, state, list = listProcesses, kill = killTree }) {
  const current = await detectCurrent({ paths, list })
  if (!current) return { current: null, killed: [] }
  const killed = await stopShell({ current, paths, list, kill })
  if (state?.relayPid && !killed.includes(state.relayPid)) {
    await kill(state.relayPid, { force: true }).catch(() => {})
    killed.push(state.relayPid)
  }
  return { current, killed }
}

/** Report what is running right now. */
export async function status({ paths, list = listProcesses, state }) {
  const current = await detectCurrent({ paths, list })
  return { current, pid: state?.pid ?? null, port: state?.port ?? null }
}
