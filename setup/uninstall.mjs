import { assertInstalled, resolvePaths } from '../src/paths.mjs'
import { detectCurrent } from '../src/launcher.mjs'
import { runCli } from './run-cli.mjs'

/**
 * Remove the plugin from the desktop profile. The junction is left alone: it is
 * shared with everything else in the profile, so reverting it is a separate,
 * explicitly confirmed step.
 */
export async function uninstall({
  paths = resolvePaths(), exists, detect, run = runCli,
} = {}) {
  assertInstalled(paths, exists)
  const current = detect ? await detect() : await detectCurrent({ paths })
  if (current !== null) {
    throw new Error('请先关闭桌面客户端与 Web 外壳，再卸载插件')
  }
  const removed = await run(paths.exe, [
    '--expose-internals', paths.cliJs,
    'plugin', '--profile', 'desktop', 'remove', 'dsh-shell-switch',
  ])
  if (removed.code !== 0) throw new Error(`卸载失败（退出码 ${removed.code}）`)
  return true
}

if (process.argv[1]?.endsWith('uninstall.mjs')) {
  uninstall().then(() => process.stdout.write('插件已从 desktop profile 移除\n'))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1) })
}
