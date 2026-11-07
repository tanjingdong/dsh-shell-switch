import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, preferredPortFor, renderMenu, statusLine, stopNotice, switchWithConsent } from '../src/cli.mjs'

test('parseArgs defaults to menu and accepts --force and --now', () => {
  assert.deepEqual(parseArgs([]), { command: 'menu', force: false, now: false })
  assert.deepEqual(parseArgs(['web', '--force']), { command: 'web', force: true, now: false })
  assert.deepEqual(parseArgs(['client']), { command: 'client', force: false, now: false })
  assert.deepEqual(parseArgs(['stop', '--now']), { command: 'stop', force: false, now: true })
  assert.throws(() => parseArgs(['nope']), (e) => e.code === 'bad-args')
})

test('stopNotice warns about unsaved work and offers the immediate mode', () => {
  assert.equal(stopNotice('web', false), null)
  assert.match(stopNotice('client', false), /未保存/)
  assert.match(stopNotice('client', false), /--now/)
  assert.match(stopNotice('client', true), /立即/)
})

test('renderMenu lists the four choices', () => {
  const menu = renderMenu()
  assert.match(menu, /1\).*客户端/)
  assert.match(menu, /2\).*Web/)
  assert.match(menu, /3\).*状态/)
  assert.match(menu, /4\).*停止/)
})

test('the web shell always prefers the stable 3080 port', () => {
  // Reusing the desktop host's random port changes the browser origin, which
  // drops the web app's storage and re-shows its first-run notice.
  assert.equal(preferredPortFor('web', { port: 14730 }), 3080)
  assert.equal(preferredPortFor('client', { port: 14730 }), 14730)
  assert.equal(preferredPortFor('client', null), 3080)
})

test('statusLine prints the token url so it can be copied later', () => {
  assert.equal(
    statusLine({ current: 'web', port: 3080, url: 'http://127.0.0.1:3080/?token=a' }),
    '当前：web（端口 3080）\n地址：http://127.0.0.1:3080/?token=a',
  )
  assert.equal(statusLine({ current: null, port: null, url: null }), '当前：没有外壳在运行')
})

test('the menu retries a busy switch with force only after confirmation', async () => {
  const calls = []
  const busy = () => Object.assign(new Error('当前有回合在运行'), { code: 'busy' })
  const switchToImpl = async (target, deps) => {
    calls.push({ target, force: deps.force })
    if (!deps.force) throw busy()
    return { switched: true, target }
  }
  const result = await switchWithConsent('web', { force: false }, {
    interactive: true,
    confirm: async () => true,
    switchToImpl,
  })
  assert.deepEqual(result, { switched: true, target: 'web' })
  assert.deepEqual(calls, [{ target: 'web', force: false }, { target: 'web', force: true }])
})

test('declining the busy confirmation leaves the current shell alone', async () => {
  const calls = []
  const switchToImpl = async (target, deps) => {
    calls.push(deps.force)
    throw Object.assign(new Error('当前有回合在运行'), { code: 'busy' })
  }
  await assert.rejects(
    switchWithConsent('web', { force: false }, { interactive: true, confirm: async () => false, switchToImpl }),
    (error) => error.code === 'busy',
  )
  assert.deepEqual(calls, [false])
})

test('a non-interactive busy switch never silently forces', async () => {
  let asked = false
  await assert.rejects(
    switchWithConsent('web', { force: false }, {
      interactive: false,
      confirm: async () => { asked = true; return true },
      switchToImpl: async () => { throw Object.assign(new Error('x'), { code: 'busy' }) },
    }),
    (error) => error.code === 'busy',
  )
  assert.equal(asked, false)
})

test('an unrelated failure is not turned into a confirmation prompt', async () => {
  let asked = false
  await assert.rejects(
    switchWithConsent('web', { force: false }, {
      interactive: true,
      confirm: async () => { asked = true; return true },
      switchToImpl: async () => { throw Object.assign(new Error('boom'), { code: 'start-failed' }) },
    }),
    (error) => error.code === 'start-failed',
  )
  assert.equal(asked, false)
})
