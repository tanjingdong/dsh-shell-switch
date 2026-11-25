import fs from 'node:fs'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { assertInstalled, resolvePaths } from '../src/paths.mjs'
import { detectCurrent, stopEverything } from '../src/launcher.mjs'
import { readState } from '../src/state.mjs'
import { createDesktopShortcut, removeDesktopShortcut, shortcutSpec } from '../src/shortcut.mjs'
import { applyCutover, revertCutover } from './cutover.mjs'
import { install } from './install.mjs'
import { uninstall } from './uninstall.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const LABEL = { client: '桌面客户端', web: '浏览器 Web' }

/** Backup folders left by previous cutovers, newest first. */
function findBackups(profilesDir) {
  try {
    return fs.readdirSync(profilesDir)
      .filter((name) => /^web\.bak-/.test(name))
      .sort()
      .reverse()
      .map((name) => `${profilesDir}\\${name}`)
  } catch {
    return []
  }
}

/**
 * The guided install/uninstall. Everything happens through the modules the
 * launcher already uses, so there is one implementation of each step and no
 * PowerShell in the path: Windows PowerShell 5.1 does not wait for GUI child
 * processes, which silently produced empty output and empty exit codes.
 */
export async function runWizard({
  mode = 'install',
  paths = resolvePaths(),
  exists = fs.existsSync,
  detect,
  stop,
  cutover = applyCutover,
  installPlugin = install,
  uninstallPlugin = uninstall,
  createShortcut = () => createDesktopShortcut(shortcutSpec(ROOT)),
  removeShortcut = () => removeDesktopShortcut({ target: shortcutSpec(ROOT).target }),
  listBackups,
  revert = revertCutover,
  ask,
  log = () => {},
} = {}) {
  assertInstalled(paths, exists)
  if (!exists(paths.desktopProfile)) {
    throw new Error(`还没有 desktop profile：${paths.desktopProfile}\n请先启动一次桌面客户端，关掉它之后再运行。`)
  }

  const probe = detect ?? (() => detectCurrent({ paths }))
  const stopShell = stop ?? (async ({ current }) => {
    const state = await readState(paths.stateFile)
    return stopEverything({ paths, state, current })
  })
  const backups = listBackups ?? (() => findBackups(paths.profilesDir))

  const steps = []
  const current = await probe()
  if (current) {
    const label = LABEL[current] ?? current
    const answer = await ask(`检测到「${label}」正在运行，${mode === 'install' ? '安装' : '卸载'}前需要先停止它。现在停止吗？(y/N) `)
    if (!/^y/i.test(String(answer ?? '').trim())) {
      log('已取消，没有做任何改动。')
      return { cancelled: true, steps }
    }
    // A failed stop must abort: installing over a live shell corrupts the profile.
    await stopShell({ paths, current })
    steps.push('stop')
    log('已停止外壳。')
  }

  if (mode === 'uninstall') {
    await uninstallPlugin({ paths })
    steps.push('uninstall')
    log('插件已从 desktop profile 移除。')

    try {
      const removal = await removeShortcut()
      if (removal === 'removed') log('桌面快捷方式已删除。')
      else if (removal === 'kept') log('桌面上的同名快捷方式不是本插件创建的，已保留。')
    } catch (error) {
      log(`未能处理桌面快捷方式（${error?.message ?? error}）。`)
    }

    const found = await backups()
    if (found.length === 0) {
      log('没有找到联接备份，保留现状（web 仍指向 desktop）。')
      return { cancelled: false, steps }
    }
    const name = found[0].split(/[\\/]/).pop()
    const answer = await ask(`发现联接备份「${name}」。要把 web 回滚成这个备份吗？(y/N) `)
    if (/^y/i.test(String(answer ?? '').trim())) {
      await revert({ profilesDir: paths.profilesDir, backupPath: found[0] })
      steps.push('revert')
      log(`已回滚到 ${name}。`)
    } else {
      log('保留联接。')
    }
    return { cancelled: false, steps }
  }

  const plan = await cutover({ profilesDir: paths.profilesDir })
  steps.push('cutover')
  log(plan.steps.length === 0
    ? 'web 已经是联接，无需改动。'
    : `已建立联接并验证；原目录备份为 ${plan.backupPath ?? '(无)'}`)

  await installPlugin({ paths })
  steps.push('install')
  log('插件已安装进 desktop profile。')

  // Part of the fixed flow, but a shortcut failure must not undo a finished
  // install: the plugin works, and the settings page can create it later.
  try {
    const created = await createShortcut()
    steps.push('shortcut')
    log(`已在桌面创建快捷方式：${created}`)
  } catch (error) {
    log(`未能创建桌面快捷方式（${error?.message ?? error}）。安装已完成，可在插件配置页里再创建。`)
  }
  return { cancelled: false, steps }
}

/** Ask on the console; returns '' when stdin closes, so piping stays safe. */
async function defaultAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } catch {
    return ''
  } finally {
    rl.close()
  }
}

function waitForEnter() {
  if (!process.stdin.isTTY) return Promise.resolve()
  return defaultAsk('\n按回车键关闭此窗口')
}

if (process.argv[1]?.endsWith('wizard.mjs')) {
  const mode = process.argv.includes('--uninstall') ? 'uninstall' : 'install'
  const say = (line) => process.stdout.write(`${line}\n`)
  runWizard({ mode, ask: defaultAsk, log: say })
    .then(async (result) => {
      if (result.cancelled) return waitForEnter()
      say('')
      say(mode === 'uninstall' ? '卸载完成。插件目录还在，可以直接删除。' : '安装完成。现在启动桌面客户端，侧栏底部应该出现切换按钮。')
      if (mode === 'install') say('  .\\dsh-switch.cmd client')
      return waitForEnter()
    })
    .catch(async (error) => {
      process.stderr.write(`\n未完成：${error?.message ?? error}\n`)
      await waitForEnter()
      process.exit(1)
    })
}
