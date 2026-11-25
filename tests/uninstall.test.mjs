import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uninstall } from '../setup/uninstall.mjs'

const paths = { exe: 'e.exe', asar: 'a.asar', cliJs: 'cli.js', desktopProfile: 'p\\desktop', webProfile: 'p\\web' }
const exists = () => true

test('uninstall removes the plugin from the desktop profile', async () => {
  const calls = []
  const run = async (file, args) => { calls.push(args.join(' ')); return { code: 0, stdout: '' } }
  await uninstall({ paths, exists, detect: async () => null, run })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /plugin --profile desktop remove dsh-shell-switch/)
})

test('uninstall refuses to touch a profile while a shell is running', async () => {
  let ran = false
  await assert.rejects(
    uninstall({ paths, exists, detect: async () => 'client', run: async () => { ran = true; return { code: 0, stdout: '' } } }),
    /先关闭/,
  )
  assert.equal(ran, false)
})

test('uninstall reports the exit code when the CLI refuses', async () => {
  const run = async () => ({ code: 3, stdout: '' })
  await assert.rejects(uninstall({ paths, exists, detect: async () => null, run }), /退出码 3/)
})

test('uninstall leaves the junction alone, because it is shared', async () => {
  const run = async () => ({ code: 0, stdout: '' })
  const keep = await uninstall({ paths, exists, detect: async () => null, run })
  assert.equal(keep, true)
})
