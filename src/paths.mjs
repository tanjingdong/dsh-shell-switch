import path from 'node:path'
import fs from 'node:fs'
import { LauncherError } from './errors.mjs'

/** Resolve every filesystem location the launcher needs. Pure: no existence checks. */
export function resolvePaths(env = process.env) {
  const user = env.USERPROFILE ?? ''
  const local = env.LOCALAPPDATA ?? path.join(user, 'AppData', 'Local')
  const home = path.join(user, '.dsh')
  const launcherDir = path.join(home, 'launcher')
  const profilesDir = path.join(home, 'profiles')
  const exe = path.join(local, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
  const cliJs = path.join(
    path.dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js',
  )
  return {
    user,
    home,
    launcherDir,
    stateFile: path.join(launcherDir, 'state.json'),
    logDir: path.join(launcherDir, 'logs'),
    profilesDir,
    desktopProfile: path.join(profilesDir, 'desktop'),
    webProfile: path.join(profilesDir, 'web'),
    exe,
    cliJs,
  }
}

/** Throw unless the DeepSeek Harness installation is where we expect it. */
export function assertInstalled(paths, exists = fs.existsSync) {
  if (!exists(paths.exe)) throw new LauncherError('dsh-not-found', `找不到 DeepSeek Harness：${paths.exe}`)
  if (!exists(paths.cliJs)) throw new LauncherError('dsh-not-found', `找不到 DSH CLI：${paths.cliJs}`)
  return paths
}
