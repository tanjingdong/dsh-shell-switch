import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopShortcut, shortcutScript, SHORTCUT_NAME } from '../src/shortcut.mjs'

test('the shortcut script creates a lnk in the real desktop folder', () => {
  const script = shortcutScript()
  assert.match(script, /WScript\.Shell/)
  assert.match(script, /UTF8Encoding/)
  assert.match(script, /GetFolderPath\('Desktop'\)/)
  assert.match(script, /CreateShortcut/)
  assert.match(script, /\$env:DSH_SWITCH_TARGET/)
  assert.match(script, /\$env:DSH_SWITCH_DIR/)
  assert.ok(script.includes(SHORTCUT_NAME))
})

test('creating the shortcut passes the target through the environment', async () => {
  const calls = []
  const run = async (file, args, options) => {
    calls.push({ file, args, options })
    return { stdout: 'C:\\Users\\x\\Desktop\\DSH 外壳切换.lnk' }
  }
  const result = await createDesktopShortcut({
    target: 'F:\\repo\\dsh-switch.cmd',
    dir: 'F:\\repo',
    run,
    env: {},
  })
  assert.equal(calls[0].file, 'powershell.exe')
  assert.equal(calls[0].options.env.DSH_SWITCH_TARGET, 'F:\\repo\\dsh-switch.cmd')
  assert.equal(calls[0].options.env.DSH_SWITCH_DIR, 'F:\\repo')
  assert.equal(result, 'C:\\Users\\x\\Desktop\\DSH 外壳切换.lnk')
})

test('a failing creation rejects with the PowerShell error', async () => {
  await assert.rejects(
    createDesktopShortcut({
      target: 't', dir: 'd', env: {},
      run: async () => { throw new Error('access denied') },
    }),
    /access denied/,
  )
})
