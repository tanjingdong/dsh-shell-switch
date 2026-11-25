import { execFile } from 'node:child_process'
import path from 'node:path'

export const SHORTCUT_NAME = 'DSH 外壳切换.lnk'

/**
 * What the desktop shortcut points at: the menu wrapper, not the bare launcher,
 * so a double click waits for a key before the window closes. The plugin root
 * is the package root, which is also where the launcher scripts live.
 */
export function shortcutSpec(root) {
  return { target: path.join(root, 'dsh-switch-menu.cmd'), dir: root }
}

/**
 * PowerShell that writes a .lnk into the user's real desktop folder
 * (`GetFolderPath` also follows a OneDrive-redirected Desktop). The target and
 * working directory travel through the environment, so no quoting bugs.
 */
export function shortcutScript() {
  return [
    // The desktop path usually contains non-ASCII text; without this the
    // captured stdout comes back in the console code page and mangles it.
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    `$path = Join-Path $desktop '${SHORTCUT_NAME}'`,
    '$shell = New-Object -ComObject WScript.Shell',
    '$link = $shell.CreateShortcut($path)',
    '$link.TargetPath = $env:DSH_SWITCH_TARGET',
    '$link.WorkingDirectory = $env:DSH_SWITCH_DIR',
    "$link.Arguments = ''",
    '$link.WindowStyle = 1',
    "$link.Description = 'DSH 外壳切换'",
    '$link.Save()',
    // Trusting Save() silently is how a missing shortcut goes unnoticed.
    'if (-not (Test-Path $path)) { Write-Error "快捷方式没有生成：$path"; exit 1 }',
    'Write-Output $path',
  ].join('; ')
}

/**
 * Delete the desktop shortcut, but only when it still points at our launcher:
 * a same-named shortcut the user made by hand must survive an uninstall.
 *
 * No `else` anywhere — the statements are joined with `;`, and `; else` is a
 * parse error in PowerShell.
 */
export const REMOVE_SCRIPT = [
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  `$path = Join-Path $desktop '${SHORTCUT_NAME}'`,
  'if (-not (Test-Path $path)) { Write-Output "missing"; exit 0 }',
  '$shell = New-Object -ComObject WScript.Shell',
  '$actual = $shell.CreateShortcut($path).TargetPath',
  'if ($actual -ieq $env:DSH_SWITCH_TARGET) { Remove-Item $path -Force; Write-Output "removed"; exit 0 }',
  'Write-Output "kept"',
].join('; ')

function defaultRun(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, windowsHide: true, timeout: 20000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout: String(stdout ?? '') })
    })
  })
}

/** Create (or overwrite) the desktop shortcut and return its path. */
export async function createDesktopShortcut({
  target, dir, run = defaultRun, env = process.env,
} = {}) {
  if (!target) throw new Error('缺少启动器路径')
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', shortcutScript()],
    { env: { ...env, DSH_SWITCH_TARGET: String(target), DSH_SWITCH_DIR: String(dir ?? '') } },
  )
  const created = stdout.trim().split(/\r?\n/).pop() ?? ''
  // A silent success that produced no file is worse than a loud failure.
  if (!/\.lnk$/i.test(created)) {
    throw new Error(`无法确认快捷方式已创建（PowerShell 输出：${created || '(空)'}）`)
  }
  return created
}

/** Remove the desktop shortcut; 'removed' | 'missing' | 'kept' (someone else's). */
export async function removeDesktopShortcut({
  target, run = defaultRun, env = process.env,
} = {}) {
  if (!target) throw new Error('缺少启动器路径')
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', REMOVE_SCRIPT],
    { env: { ...env, DSH_SWITCH_TARGET: String(target) } },
  )
  const status = String(stdout ?? '').trim().split(/\r?\n/).pop()
  return status === 'removed' || status === 'missing' ? status : 'kept'
}
