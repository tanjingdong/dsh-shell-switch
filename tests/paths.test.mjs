import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePaths } from '../src/paths.mjs'

test('resolvePaths derives every path from USERPROFILE', () => {
  const p = resolvePaths({ USERPROFILE: 'C:\\Users\\x', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })
  assert.equal(p.home, 'C:\\Users\\x\\.dsh')
  assert.equal(p.stateFile, 'C:\\Users\\x\\.dsh\\launcher\\state.json')
  assert.equal(p.desktopProfile, 'C:\\Users\\x\\.dsh\\profiles\\desktop')
  assert.equal(p.webProfile, 'C:\\Users\\x\\.dsh\\profiles\\web')
  assert.match(p.exe, /DeepSeek Harness\.exe$/)
  assert.match(p.cliJs, /dsh-desktop-host\\lib\\cli\.js$/)
})
