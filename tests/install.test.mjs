import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../setup/install.mjs'

const paths = { exe: 'e.exe', asar: 'a.asar', cliJs: 'cli.js', desktopProfile: 'p\\desktop', webProfile: 'p\\web' }
const exists = () => true

test('install verifies through the web profile and requires the plugin in the dump', async () => {
  const calls = []
  const run = async (file, args) => {
    calls.push(args.join(' '))
    return { code: 0, stdout: 'plugins: dsh-shell-switch' }
  }
  await install({ paths, exists, detect: async () => null, run })
  assert.match(calls[0], /plugin --profile desktop add link:/)
  assert.match(calls[1], /--profile web --dump-config/)
})

test('install fails when the plugin is missing from the dump', async () => {
  const run = async (file, args) => (
    args.includes('--dump-config')
      ? { code: 0, stdout: 'plugins: something-else' }
      : { code: 0, stdout: '' }
  )
  await assert.rejects(
    install({ paths, exists, detect: async () => null, run }),
    /没有出现在/,
  )
})

test('install fails when the verification command itself fails', async () => {
  const run = async (file, args) => (args.includes('--dump-config') ? { code: 2, stdout: '' } : { code: 0, stdout: '' })
  await assert.rejects(install({ paths, exists, detect: async () => null, run }), /dump-config 失败/)
})

test('install refuses to touch a profile while a shell is running', async () => {
  let ran = false
  await assert.rejects(
    install({ paths, exists, detect: async () => 'web', run: async () => { ran = true; return { code: 0, stdout: '' } } }),
    /先关闭/,
  )
  assert.equal(ran, false)
})
