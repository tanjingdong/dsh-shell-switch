import readline from 'node:readline/promises'
import { LauncherError } from './errors.mjs'
import { assertInstalled, resolvePaths } from './paths.mjs'
import { reservePort } from './ports.mjs'
import { killTree } from './procs.mjs'
import { readState, writeState } from './state.mjs'
import { fetchBusy, status, switchTo } from './launcher.mjs'
import { startWeb } from './web.mjs'

const COMMANDS = ['menu', 'client', 'web', 'status', 'stop']

const LAN_ADDRESSES = ['192.168.0.106', '10.147.20.214', '100.100.0.3']

/** Parse argv into a command plus the force flag. */
export function parseArgs(argv = []) {
  let force = false
  const positional = []
  for (const arg of argv) {
    if (arg === '--force') force = true
    else positional.push(arg)
  }
  const command = positional[0] ?? 'menu'
  if (!COMMANDS.includes(command)) {
    throw new LauncherError('bad-args', `未知命令：${command}。可用：${COMMANDS.join(' / ')}`)
  }
  return { command, force }
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

function log(message) {
  process.stdout.write(`${message}\n`)
}

/** Run one command and return the process exit code. */
export async function run(argv = process.argv.slice(2), overrides = {}) {
  const { command, force } = overrides.parsed ?? parseArgs(argv)
  const paths = overrides.paths ?? resolvePaths()
  assertInstalled(paths)
  const state = await readState(paths.stateFile)
  const resolved = command === 'menu' ? await promptChoice() : command

  if (resolved === 'status') {
    const info = await status({ paths, state })
    log(`当前：${info.current ?? '没有外壳在运行'}${info.port ? `（端口 ${info.port}）` : ''}`)
    return 0
  }

  if (resolved === 'stop') {
    const info = await status({ paths, state })
    if (!info.current) {
      log('没有外壳在运行')
      return 0
    }
    const pid = state?.pid ?? info.pid
    if (!pid) throw new LauncherError('no-pid', '找不到要停止的进程')
    if (state?.relayPid) await killTree(state.relayPid, { force: true }).catch(() => {})
    const result = await killTree(pid, { force: true })
    await writeState(paths.stateFile, { ...state, mode: info.current, stoppedAt: new Date().toISOString() })
    log(result.killed ? '已停止' : '停止失败，进程仍然存在')
    return result.killed ? 0 : 1
  }

  const preferredPort = state?.port ?? 3080

  await switchTo(resolved, {
    paths, force, log,
    port: preferredPort,
    pickPort: () => reservePort(preferredPort),
    prepare: async () => log('预检通过'),
    busyProbe: async ({ port: busyPort }) => (busyPort ? fetchBusy({ port: busyPort }) : null),
    startWeb: async ({ port }) => {
      const result = await startWeb({
        paths, port, addresses: LAN_ADDRESSES, log,
        onSpawn: (pid) => writeState(paths.stateFile, {
          mode: 'web', pid, port, startedAt: new Date().toISOString(),
        }),
      })
      await writeState(paths.stateFile, {
        mode: 'web', pid: result.pid, port: result.port,
        relayPid: result.relayPid, startedAt: new Date().toISOString(),
      })
      return result
    },
    startClient: async () => {
      const { spawn } = await import('node:child_process')
      spawn(paths.exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      await writeState(paths.stateFile, { mode: 'client', pid: 0, startedAt: new Date().toISOString() })
    },
  })
  return 0
}

if (process.argv[1]?.endsWith('cli.mjs')) {
  run().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`\n${error?.message ?? error}\n`)
    process.exit(1)
  })
}
