import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWizard } from '../setup/wizard.mjs'

const paths = {
  exe: 'e.exe',
  asar: 'a.asar',
  cliJs: 'cli.js',
  profilesDir: 'p',
  desktopProfile: 'p\\desktop',
  webProfile: 'p\\web',
}

function harness(overrides = {}) {
  const calls = []
  const asked = []
  const deps = {
    paths,
    exists: () => true,
    detect: async () => null,
    stop: async () => { calls.push('stop') },
    cutover: async () => { calls.push('cutover'); return { steps: ['create-junction'], backupPath: 'p\\web.bak-1' } },
    installPlugin: async () => { calls.push('install'); return true },
    uninstallPlugin: async () => { calls.push('uninstall'); return true },
    createShortcut: async () => { calls.push('shortcut'); return 'C:/Users/x/Desktop/DSH 外壳切换.lnk' },
    removeShortcut: async () => { calls.push('remove-shortcut'); return 'removed' },
    listBackups: async () => [],
    revert: async () => { calls.push('revert') },
    ask: async (question) => { asked.push(question); return '' },
    log: () => {},
    ...overrides,
  }
  return { deps, calls, asked }
}

test('a clean install cuts over, installs and creates the shortcut, asking nothing', async () => {
  const { deps, calls, asked } = harness()
  const result = await runWizard(deps)
  assert.deepEqual(calls, ['cutover', 'install', 'shortcut'])
  assert.deepEqual(result.steps, ['cutover', 'install', 'shortcut'])
  assert.equal(result.cancelled, false)
  assert.deepEqual(asked, [])
})

test('declining the stop prompt changes nothing', async () => {
  const { deps, calls } = harness({ detect: async () => 'web' })
  const result = await runWizard(deps)
  assert.equal(result.cancelled, true)
  assert.deepEqual(calls, [])
})

test('agreeing to stop ends the shell first, then installs', async () => {
  const { deps, calls, asked } = harness({ detect: async () => 'web', ask: async (q) => { asked.push(q); return 'y' } })
  const result = await runWizard(deps)
  assert.deepEqual(calls, ['stop', 'cutover', 'install', 'shortcut'])
  assert.equal(result.cancelled, false)
  assert.match(asked[0], /浏览器 Web/)
})

test('an existing desktop profile is required, and nothing runs without it', async () => {
  const { deps, calls } = harness({ exists: (target) => target !== paths.desktopProfile })
  await assert.rejects(runWizard(deps), /desktop/)
  assert.deepEqual(calls, [])
})

test('a missing DeepSeek Harness is reported before anything is touched', async () => {
  const { deps, calls } = harness({ exists: () => false })
  await assert.rejects(runWizard(deps), /DeepSeek Harness|app\.asar/)
  assert.deepEqual(calls, [])
})

test('uninstall removes the plugin and the shortcut it created', async () => {
  const { deps, calls, asked } = harness({ mode: 'uninstall', listBackups: async () => ['p\\web.bak-1'] })
  const result = await runWizard(deps)
  assert.deepEqual(calls, ['uninstall', 'remove-shortcut'])
  assert.equal(result.cancelled, false)
  assert.match(asked[0], /web\.bak-1/)
})

test('uninstall can also revert the junction', async () => {
  const { deps, calls } = harness({
    mode: 'uninstall', listBackups: async () => ['p\\web.bak-1', 'p\\web.bak-0'], ask: async () => 'y',
  })
  await runWizard(deps)
  assert.deepEqual(calls, ['uninstall', 'remove-shortcut', 'revert'])
})

test('uninstall with no backup says so instead of asking', async () => {
  const { deps, asked } = harness({ mode: 'uninstall', listBackups: async () => [] })
  await runWizard(deps)
  assert.deepEqual(asked, [])
})

test('a failed stop is not silently treated as stopped', async () => {
  const { deps, calls } = harness({
    detect: async () => 'client',
    ask: async () => 'y',
    stop: async () => { throw new Error('还在运行') },
  })
  await assert.rejects(runWizard(deps), /还在运行/)
  assert.deepEqual(calls, [])
})

test('the desktop shortcut is part of the install, not an optional extra', async () => {
  const { deps, calls } = harness()
  const result = await runWizard(deps)
  assert.ok(calls.includes('shortcut'))
  assert.ok(result.steps.includes('shortcut'))
})

test('a failed shortcut does not undo a finished install', async () => {
  const lines = []
  const { deps } = harness({
    createShortcut: async () => { throw new Error('powershell 被策略阻止') },
    log: (line) => lines.push(line),
  })
  const result = await runWizard(deps)
  assert.equal(result.cancelled, false)
  assert.ok(result.steps.includes('install'))
  assert.ok(!result.steps.includes('shortcut'))
  assert.ok(lines.some((line) => line.includes('快捷方式')), JSON.stringify(lines))
})

test('a failed shortcut removal does not abort the uninstall', async () => {
  const { deps, calls } = harness({
    mode: 'uninstall',
    removeShortcut: async () => { throw new Error('拒绝访问') },
  })
  const result = await runWizard(deps)
  assert.equal(result.cancelled, false)
  assert.deepEqual(calls, ['uninstall'])
})
