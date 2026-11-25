import { fileURLToPath } from 'node:url'
import { assertInstalled, resolvePaths } from '../src/paths.mjs'
import { detectCurrent } from '../src/launcher.mjs'
import { runCli } from './run-cli.mjs'

// One package now: the bundle lives at the repository root.
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Install the plugin into the desktop profile, then prove it lands where both
 * shells will read it. `web` is the shared profile after cutover, so dumping
 * `web` is the check that actually runs; `desktop` alone is not.
 */
export async function install({
  paths = resolvePaths(), exists, detect, run = runCli,
} = {}) {
  assertInstalled(paths, exists)
  const current = detect ? await detect() : await detectCurrent({ paths })
  if (current !== null) {
    throw new Error('请先关闭桌面客户端与 Web 外壳，再安装插件')
  }
  const added = await run(paths.exe, [
    '--expose-internals', paths.cliJs,
    'plugin', '--profile', 'desktop', 'add', `link:${PLUGIN_DIR}`,
  ])
  if (added.code !== 0) throw new Error(`安装失败（退出码 ${added.code}）`)
  const verify = await run(paths.exe, ['--expose-internals', paths.cliJs, '--profile', 'web', '--dump-config'])
  if (verify.code !== 0) throw new Error('安装后 --profile web --dump-config 失败，请检查 profile')
  if (!String(verify.stdout ?? '').includes('dsh-shell-switch')) {
    throw new Error('安装完成但插件没有出现在 web profile 的 --dump-config 中')
  }
  return true
}

if (process.argv[1]?.endsWith('install.mjs')) {
  install().then(() => process.stdout.write('插件已安装进 desktop profile\n'))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1) })
}
