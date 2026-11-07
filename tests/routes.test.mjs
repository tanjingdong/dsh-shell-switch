import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandoffRoutes } from '../plugin/routes.mjs'

const loop = { remoteAddress: '127.0.0.1' }
const headers = { host: '127.0.0.1:3080' }

test('state mints a nonce and a non-loopback caller is refused', () => {
  const routes = createHandoffRoutes({ now: () => 1000, random: () => 'n1', spawnLauncher: () => 1, readActivity: () => ({ agents: 1, jobs: 0 }) })
  const ok = routes.handle('GET', '/dsh-switch/state', headers, loop)
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.body)
  assert.equal(body.nonce, 'n1')
  assert.equal(body.busy, true)
  assert.equal(routes.handle('GET', '/dsh-switch/state', headers, { remoteAddress: '10.0.0.2' }).status, 403)
  assert.equal(routes.handle('GET', '/dsh-switch/state', { host: 'evil.example:3080' }, loop).status, 403)
})

test('handoff accepts a fresh nonce once and refuses reuse', () => {
  const calls = []
  const routes = createHandoffRoutes({ now: () => 1000, random: () => 'n1', spawnLauncher: (t) => calls.push(t), readActivity: () => ({ agents: 0, jobs: 0 }) })
  routes.handle('GET', '/dsh-switch/state', headers, loop)
  const first = routes.handle('POST', '/dsh-switch/handoff', headers, loop, JSON.stringify({ target: 'web', nonce: 'n1' }))
  assert.equal(first.status, 202)
  assert.deepEqual(calls, ['web'])
  const again = routes.handle('POST', '/dsh-switch/handoff', headers, loop, JSON.stringify({ target: 'web', nonce: 'n1' }))
  assert.equal(again.status, 403)
})

test('a failing launcher spawn becomes 500 instead of throwing', () => {
  const routes = createHandoffRoutes({ now: () => 1000, random: () => 'n1', spawnLauncher: () => { throw new Error('nope') }, readActivity: () => ({ agents: 0, jobs: 0 }) })
  routes.handle('GET', '/dsh-switch/state', headers, loop)
  const res = routes.handle('POST', '/dsh-switch/handoff', headers, loop, JSON.stringify({ target: 'web', nonce: 'n1' }))
  assert.equal(res.status, 500)
})
