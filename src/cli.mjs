import path from 'node:path'
import readline from 'node:readline/promises'
import { LauncherError } from './errors.mjs'
import { createLogger } from './log.mjs'
import { assertInstalled, resolvePaths } from './paths.mjs'
import { reservePort } from './ports.mjs'
import { readState, writeState } from './state.mjs'
import { fetchBusy, currentHostPort, detectCurrent, startClient, status, stopEverything, switchTo } from './launcher.mjs'
import { reportSwitch, sendWebhook } from './report.mjs'
import { readReportConfig, reportConfigFile } from './report-config.mjs'
import { copyToClipboard, showUrlDialog, startWeb } from './web.mjs'

const COMMANDS = ['menu', 'client', 'web', 'status', 'stop']

/** Parse argv into a command plus the force and immediate flags. */
export function parseArgs(argv = []) {
  let force = false
  let now = false
  const positional = []
  for (const arg of argv) {
    if (arg === '--force') force = true
    else if (arg === '--now') now = true
    else positional.push(arg)
  }
  const command = positional[0] ?? 'menu'
  if (!COMMANDS.includes(command)) {
    throw new LauncherError('bad-args', `未知命令：${command}。可用：${COMMANDS.join(' / ')}`)
  }
  return { command, force, now }
}

/** What to warn before stopping the desktop client, if anything. */
export function stopNotice(current, now = false) {
  if (current !== 'client') return null
  if (now) return '正在立即结束桌面客户端：未保存的内容会丢失'
  return '正在关闭桌面客户端：未保存的内容可能丢失；要立即结束请加 --now'
}

/** Say so instead of finishing silently when the target is already running. */
export function noopNotice(current) {
  if (!current) return null
  return `当前已经是${current === 'client' ? '桌面客户端' : '浏览器 Web'}，无需切换`
}

/** One status line, including the token url when the state recorded one. */
export function statusLine(info = {}) {
  const current = info.current ?? '没有外壳在运行'
  const port = info.port ? `（端口 ${info.port}）` : ''
  const url = info.url ? `\n地址：${info.url}` : ''
  return `当前：${current}${port}${url}`
}

/**
 * The web shell always starts on 3080 when it can. Reusing the desktop host's
 * random port would change the browser origin, which drops the web app's
 * storage and re-shows its first-run notice.
 */
export function preferredPortFor(target, state) {
  if (target === 'web') return 3080
  return state?.port ?? 3080
}

/**
 * Report a finished switch through the channels the user enabled.
 * A report failure is logged and never changes the switch result.
 */
export async function runReport({ paths, info, deps = {} } = {}) {
  const log = deps.log ?? (() => {})
  const read = deps.read ?? ((file) => readReportConfig(file))
  const report = deps.report ?? ((args) => reportSwitch(args))
  try {
    const config = deps.config ?? await read(reportConfigFile(paths))
    return await report({
      config,
      info,
      copy: deps.copy ?? (({ url }) => copyToClipboard({
        url, logFile: path.join(paths.logDir, 'url-clipboard.log'),
      })),
      dialog: deps.dialog ?? (({ url }) => showUrlDialog({
        url, logFile: path.join(paths.logDir, 'url-dialog.log'),
      })),
      send: deps.send ?? ((args) => sendWebhook(args)),
      log,
    })
  } catch (error) {
    log(`[report] 上报失败：${error?.message ?? error}`)
    return null
  }
}

/** The no-argument menu. */
export function renderMenu() {
  return [
    'DSH 外壳切换器',
    '',
    '  1) 启动桌面客户端',
    '  2) 启动浏览器 Web',
    '  3) 查看当前状态',
    '  4) 停止当前外壳',
    '',
    '选择 [1-4]：',
  ].join('\n')
}

async function promptChoice() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = (await rl.question(renderMenu())).trim()
      if ({ 1: 'client', 2: 'web', 3: 'status', 4: 'stop' }[answer]) {
        return { 1: 'client', 2: 'web', 3: 'status', 4: 'stop' }[answer]
      }
    }
  } finally {
    rl.close()
  }
}

async function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

/**
 * Switch, and when the host is busy let an interactive caller confirm and
 * force. A command line caller never gets that prompt; it must pass --force.
 */
export async function switchWithConsent(target, deps, {
  interactive = false, confirm = null, switchToImpl = switchTo,
} = {}) {
  try {
    return await switchToImpl(target, deps)
  } catch (error) {
    const retriable = error?.code === 'busy' || error?.code === 'busy-unconfirmed'
    if (!interactive || !confirm || !retriable) throw error
    const proceed = await confirm(`${error.message}\n仍然切换？这可能切断正在运行的回合。[y/N]`)
    if (!proceed) throw error
    return await switchToImpl(target, { ...deps, force: true })
  }
}

/** Run one command and return the process exit code. */
export async function run(argv = process.argv.slice(2), overrides = {}) {
  const { command, force, now } = overrides.parsed ?? parseArgs(argv)
  const paths = overrides.paths ?? resolvePaths()
  assertInstalled(paths)
  const logger = overrides.logger ?? createLogger({ paths })
  const write = (message) => logger.log(message)
  const state = await readState(paths.stateFile)
  const resolved = command === 'menu' ? await promptChoice() : command

  if (resolved === 'status') {
    const info = await status({ paths, state })
    write(statusLine(info))
    return 0
  }

  if (resolved === 'stop') {
    const current = await detectCurrent({ paths })
    const notice = stopNotice(current, now)
    if (notice) write(notice)
    const result = await stopEverything({
      paths, state, current, timeoutMs: now ? 0 : 10000,
    })
    if (!result.current && result.killed.length === 0) {
      write('没有外壳在运行')
      return 0
    }
    await writeState(paths.stateFile, {
      ...state, mode: result.current, stoppedAt: new Date().toISOString(),
    })
    if (!result.current) {
      write('已结束残留的 relay 进程')
      return 0
    }
    write(result.killed.length > 0 ? '已停止' : '停止失败，进程仍然存在')
    return result.killed.length > 0 ? 0 : 1
  }

  const preferredPort = preferredPortFor(resolved, state)
  const busyPort = await currentHostPort({ paths, state })
  const runtimeConfig = await readReportConfig(reportConfigFile(paths))
  const publishAddresses = runtimeConfig.network.loopbackOnly
    ? []
    : runtimeConfig.network.addresses
  let startedUrl = ''

  const switched = await switchWithConsent(resolved, {
    paths, force, log: write,
    port: preferredPort,
    relayPid: state?.relayPid,
    pickPort: () => reservePort(preferredPort),
    prepare: async () => write('预检通过'),
    busyProbe: async () => (busyPort ? fetchBusy({ port: busyPort }) : null),
    startWeb: async ({ port }) => {
      const result = await startWeb({
        paths, port, addresses: publishAddresses, log: write,
        onSpawn: (pid) => writeState(paths.stateFile, {
          mode: 'web', pid, port, startedAt: new Date().toISOString(),
        }),
      })
      startedUrl = result.url
      await writeState(paths.stateFile, {
        mode: 'web', pid: result.pid, port: result.port, url: result.url,
        relayPid: result.relayPid, startedAt: new Date().toISOString(),
      })
      return result
    },
    startClient: async () => {
      const ready = await startClient({ paths })
      await writeState(paths.stateFile, {
        mode: 'client', pid: ready.pid, port: ready.port,
        shellPid: ready.shellPid, startedAt: new Date().toISOString(),
      })
      return ready
    },
  }, { interactive: command === 'menu', confirm: askYesNo })

  if (switched?.switched) {
    await runReport({
      paths,
      info: { target: resolved, port: switched.port ?? preferredPort, url: startedUrl },
      deps: { log: write, config: runtimeConfig },
    })
  } else {
    const notice = noopNotice(switched?.current)
    if (notice) write(notice)
  }
  return 0
}

if (process.argv[1]?.endsWith('cli.mjs')) {
  const logger = createLogger({ paths: resolvePaths() })
  run(process.argv.slice(2), { logger }).then((code) => process.exit(code)).catch((error) => {
    logger.error(`\n${error?.message ?? error}`)
    logger.error(`日志：${logger.file}`)
    process.exit(1)
  })
}
