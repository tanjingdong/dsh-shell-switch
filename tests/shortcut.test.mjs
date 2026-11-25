import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDesktopShortcut, removeDesktopShortcut, shortcutScript, REMOVE_SCRIPT, SHORTCUT_NAME, shortcutSpec,
} from '../src/shortcut.mjs'

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

test('the shortcut points at the menu wrapper, which waits for a key', () => {
  const spec = shortcutSpec('F:\\repo')
  assert.equal(spec.target, 'F:\\repo\\dsh-switch-menu.cmd')
  assert.equal(spec.dir, 'F:\\repo')
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

test('the shortcut script verifies the file exists before reporting success', () => {
  const script = shortcutScript()
  assert.match(script, /Test-Path \$path/, 'creation must be verified')
  assert.match(script, /exit 1/, 'a missing file must fail loudly')
})

test('a silent non-creation is reported instead of accepted', async () => {
  await assert.rejects(
    createDesktopShortcut({ target: 't', dir: 'd', env: {}, run: async () => ({ stdout: '' }) }),
    /无法确认快捷方式已创建/,
  )
  await assert.rejects(
    createDesktopShortcut({ target: 't', dir: 'd', env: {}, run: async () => ({ stdout: 'True\r\n' }) }),
    /无法确认快捷方式已创建/,
  )
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

test('the removal script only deletes a shortcut that points at us', () => {
  assert.match(REMOVE_SCRIPT, /-ieq \$env:DSH_SWITCH_TARGET/)
  assert.match(REMOVE_SCRIPT, /Remove-Item/)
  assert.match(REMOVE_SCRIPT, /UTF8Encoding/)
  assert.ok(REMOVE_SCRIPT.includes(SHORTCUT_NAME))
  // Statements are joined with ';', so a following `else` would not parse.
  assert.ok(!/;\s*else\b/i.test(REMOVE_SCRIPT), 'joined statements cannot carry an else')
})

test('removal reports what happened instead of guessing', async () => {
  const runWith = (stdout) => async () => ({ stdout })
  assert.equal(await removeDesktopShortcut({ target: 't', run: runWith('removed\r\n') }), 'removed')
  assert.equal(await removeDesktopShortcut({ target: 't', run: runWith('missing\r\n') }), 'missing')
  assert.equal(await removeDesktopShortcut({ target: 't', run: runWith('kept\r\n') }), 'kept')
  assert.equal(await removeDesktopShortcut({ target: 't', run: runWith('garbage\r\n') }), 'kept')
})
