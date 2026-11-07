import { execFile } from 'node:child_process'

export const SHORTCUT_NAME = 'DSH 外壳切换.lnk'

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
    'Write-Output $path',
  ].join('; ')
}

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
  return stdout.trim()
}
