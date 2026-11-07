import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertInstalled, resolvePaths } from '../src/paths.mjs'

const env = { USERPROFILE: 'C:\\Users\\x', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }

test('resolvePaths derives every path from USERPROFILE', () => {
  const p = resolvePaths(env)
  assert.equal(p.home, 'C:\\Users\\x\\.dsh')
  assert.equal(p.stateFile, 'C:\\Users\\x\\.dsh\\launcher\\state.json')
  assert.equal(p.desktopProfile, 'C:\\Users\\x\\.dsh\\profiles\\desktop')
  assert.equal(p.webProfile, 'C:\\Users\\x\\.dsh\\profiles\\web')
  assert.match(p.exe, /DeepSeek Harness\.exe$/)
  assert.match(p.asar, /resources\\app\.asar$/)
  assert.match(p.cliJs, /app\.asar\\dsh\\node_modules\\.*cli\.js$/)
})

test('DSH_HOME relocates the whole home', () => {
  const p = resolvePaths({ ...env, DSH_HOME: 'D:\\dshhome' })
  assert.equal(p.stateFile, 'D:\\dshhome\\launcher\\state.json')
})

test('assertInstalled accepts the executable plus the archive, not a path inside it', () => {
  const p = resolvePaths(env)
  const present = new Set([p.exe, p.asar])
  assert.doesNotThrow(() => assertInstalled(p, (target) => present.has(target)))
  assert.throws(() => assertInstalled(p, (target) => target === p.exe), (e) => e.code === 'dsh-not-found')
})
