import { spawn } from 'node:child_process'
import { LauncherError } from './errors.mjs'
import {
  collectDescendants, isDesktopHost, isElectronShell, isRelayProcess, isWebHost, killTree,
  listListeningPorts, listProcesses,
} from './procs.mjs'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Which shell currently owns the desktop profile, if any. */
export async function detectCurrent({ paths, list = listProcesses } = {}) {
  let processes
  try {
    processes = await list()
  } catch (error) {
    // A failed query is not "nothing is running"; switching on that guess
    // would start a second host on top of a live one.
    throw new LauncherError(
      'process-query-failed',
      `无法读取进程列表，无法判断当前外壳：${error?.message ?? error}。`
      + '可在任务管理器里确认后重试，或用 --force 明确指定目标',
    )
  }
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
 * an Electron window, so both must go. Every process is ended by pid, never by
 * tree: the launcher itself is a descendant of the shell it is ending, and a
 * `taskkill /T` would kill the switch halfway through.
 */
export async function stopShell({
  current, paths, list = listProcesses, kill = killTree, timeoutMs = 10000,
  protect = [process.pid],
}) {
  const processes = await list()
  const targets = current === 'client'
    ? [
      ...processes.filter((process) => isDesktopHost(process, paths)),
      ...processes.filter((process) => isElectronShell(process, paths)),
    ]
    : processes.filter((process) => isWebHost(process, paths))
  const targetIds = new Set(targets.map((target) => Number(target.pid)))
  const blocked = new Set(protect.map(Number))
  const killed = []
  const done = new Set()

  const end = async (pid, options) => {
    if (blocked.has(pid) || done.has(pid)) return
    done.add(pid)
    await kill(pid, options)
    killed.push(pid)
  }

  for (const target of targets) {
    const pid = Number(target.pid)
    // Support processes first, so a dying parent cannot orphan them.
    const children = collectDescendants([pid], processes, { protect })
      .filter((child) => child !== pid && !targetIds.has(child))
    for (const child of children.reverse()) {
      await end(child, { force: true, timeoutMs: 0, tree: false })
    }
    await end(pid, { force: true, timeoutMs, tree: false })
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

/**
 * Start the Electron window. `ELECTRON_RUN_AS_NODE` is stripped: when a web
 * host spawned the launcher it inherits that flag, and passing it on makes the
 * app start as node, print nothing, and exit — no window, no host.
 */
export function spawnShell({ paths, spawnImpl = spawn, env = process.env } = {}) {
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  const child = spawnImpl(paths.exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: clean,
  })
  child.unref?.()
  return child
}

/**
 * Start the desktop client and only report success once its host is listening.
 * A window that never comes up is a failure, not a success.
 */
export async function startClient({ paths, spawnShell: spawnImpl = spawnShell, wait = waitForClient }) {
  const shellPid = spawnImpl({ paths }).pid
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
    pickPort, relayPid,
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
    if (relayPid) {
      // The relay of the shell we are leaving would keep the LAN ports bound
      // to a dead port; it holds no user data, so there is nothing to wait for.
      await kill(relayPid, { force: true, timeoutMs: 0, tree: false }).catch(() => {})
    }
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
export async function stopEverything({
  paths, state, current, list = listProcesses, kill = killTree, timeoutMs = 10000,
}) {
  const processes = await list()
  const cached = async () => processes
  const running = current ?? await detectCurrent({ paths, list: cached })
  const killed = running
    ? await stopShell({ current: running, paths, list: cached, kill, timeoutMs })
    : []

  // A relay can outlive its state record: a failed switch, or a launcher that
  // died mid-way, leaves one holding the LAN ports with nothing pointing at it.
  const strays = processes
    .filter((process) => isRelayProcess(process))
    .map((process) => process.pid)
    .filter((pid) => !killed.includes(pid) && pid !== state?.relayPid)
  for (const pid of strays) {
    await kill(pid, { force: true, timeoutMs: 0, tree: false }).catch(() => {})
    killed.push(pid)
  }

  if (state?.relayPid && !killed.includes(state.relayPid)) {
    // The relay holds no user data; there is nothing to wait for.
    await kill(state.relayPid, { force: true, timeoutMs: 0, tree: false }).catch(() => {})
    killed.push(state.relayPid)
  }
  return { current: running ?? null, killed }
}

/**
 * The port the running shell listens on. The desktop client does not always
 * have a recorded port, so ask its host process for one.
 */
export async function currentHostPort({ paths, state, list = listProcesses, ports = listListeningPorts }) {
  if (state?.port) return state.port
  try {
    const processes = await list()
    const host = processes.find((process) => (
      isDesktopHost(process, paths) || isWebHost(process, paths)
    ))
    if (!host) return null
    const open = await ports(host.pid).catch(() => [])
    return open[0] ?? null
  } catch {
    return null
  }
}

/** Report what is running right now. */
export async function status({ paths, list = listProcesses, state }) {
  const current = await detectCurrent({ paths, list })
  return { current, pid: state?.pid ?? null, port: state?.port ?? null, url: state?.url ?? null }
}
