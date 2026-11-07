import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertInstalled, resolvePaths } from '../src/paths.mjs'
import { detectCurrent } from '../src/launcher.mjs'

const PLUGIN_DIR = path.dirname(fileURLToPath(new URL('../plugin/index.mjs', import.meta.url)))

function run(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/** Install the plugin into the Electron-managed desktop profile. */
export async function install({ paths = resolvePaths() } = {}) {
  assertInstalled(paths)
  const current = await detectCurrent({ paths })
  if (current !== null) {
    throw new Error('请先关闭桌面客户端与 Web 外壳，再安装插件')
  }
  const code = await run(paths.exe, [
    '--expose-internals', paths.cliJs,
    'plugin', '--profile', 'desktop', 'add', `link:${PLUGIN_DIR}`,
  ])
  if (code !== 0) throw new Error(`安装失败（退出码 ${code}）`)
  const verify = await run(paths.exe, ['--expose-internals', paths.cliJs, '--profile', 'desktop', '--dump-config'])
  if (verify !== 0) throw new Error('安装后 --dump-config 失败，请检查 profile')
  return true
}

if (process.argv[1]?.endsWith('install.mjs')) {
  install().then(() => process.stdout.write('插件已安装进 desktop profile\n'))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1) })
}
