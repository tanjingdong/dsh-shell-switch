import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, renderMenu, switchWithConsent } from '../src/cli.mjs'

test('parseArgs defaults to menu and accepts --force', () => {
  assert.deepEqual(parseArgs([]), { command: 'menu', force: false })
  assert.deepEqual(parseArgs(['web', '--force']), { command: 'web', force: true })
  assert.deepEqual(parseArgs(['client']), { command: 'client', force: false })
  assert.throws(() => parseArgs(['nope']), (e) => e.code === 'bad-args')
})

test('renderMenu lists the four choices', () => {
  const menu = renderMenu()
  assert.match(menu, /1\).*客户端/)
  assert.match(menu, /2\).*Web/)
  assert.match(menu, /3\).*状态/)
  assert.match(menu, /4\).*停止/)
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
