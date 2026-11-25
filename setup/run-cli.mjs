import { spawn } from 'node:child_process'

/**
 * Run the DSH CLI, capturing stdout so callers can inspect a dump. The app
 * executable is the only CLI entry the desktop build ships, so every setup
 * step goes through it with ELECTRON_RUN_AS_NODE set.
 */
export function runCli(file, args, { spawnFn = spawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    const child = spawnFn(file, args, {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    })
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.on('error', () => resolve({ code: 1, stdout }))
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout }))
  })
}
