import { LauncherError } from './errors.mjs'
import { isDesktopHost, isWebHost, killTree, listProcesses } from './procs.mjs'

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
    return body?.busy === true
  } catch {
    return null
  }
}

async function stopCurrent({ current, paths, list, kill }) {
  const processes = await list()
  const match = processes.find((process) => (
    current === 'client' ? isDesktopHost(process, paths) : isWebHost(process, paths)
  ))
  if (match) await kill(match.pid, { force: true })
}

/**
 * Switch shells. Three attempts at the target, then stop: never restart
 * the shell we just closed.
 */
export async function switchTo(target, deps) {
  const {
    paths, force = false, log = () => {}, list = listProcesses, kill = killTree,
    prepare = async () => {}, startWeb, startClient, busyProbe = fetchBusy, port,
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
    await stopCurrent({ current, paths, list, kill })
  }

  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await (target === 'web' ? startWeb() : startClient())
      return { switched: true, target }
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

/** Report what is running right now. */
export async function status({ paths, list = listProcesses, state }) {
  const current = await detectCurrent({ paths, list })
  return { current, pid: state?.pid ?? null, port: state?.port ?? null }
}
