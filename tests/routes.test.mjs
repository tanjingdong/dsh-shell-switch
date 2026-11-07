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

test('state treats jobs, a waiting inbox and approvals as busy', () => {
  const busy = (activity) => JSON.parse(createHandoffRoutes({
    now: () => 1, random: () => 'n', spawnLauncher: () => 1, readActivity: () => activity,
  }).handle('GET', '/dsh-switch/state', headers, loop).body).busy
  assert.equal(busy({ agents: 0, jobs: 2, inbox: false, approvals: 0 }), true)
  assert.equal(busy({ agents: 0, jobs: 0, inbox: true, approvals: 0 }), true)
  assert.equal(busy({ agents: 0, jobs: 0, inbox: false, approvals: 1 }), true)
  assert.equal(busy({ agents: 0, jobs: 0, inbox: false, approvals: 0 }), false)
})

test('a LAN address is allowed while a public host name is not', () => {
  const routes = createHandoffRoutes({ now: () => 1000, random: () => 'n1', spawnLauncher: () => 1, readActivity: () => ({ agents: 0, jobs: 0 }) })
  for (const host of ['127.0.0.1:3080', 'localhost:3080', '192.168.0.106:3080', '10.147.20.214:3080', '100.100.0.3:3080', '172.16.5.4:3080']) {
    assert.equal(routes.handle('GET', '/dsh-switch/state', { host }, loop).status, 200, host)
  }
  for (const host of ['evil.example:3080', '8.8.8.8:3080', '203.0.113.9:3080']) {
    assert.equal(routes.handle('GET', '/dsh-switch/state', { host }, loop).status, 403, host)
  }
})

test('state names the running shell so the panel can say "already there"', async () => {
  const routes = createHandoffRoutes({
    now: () => 1, random: () => 'n', spawnLauncher: () => 1,
    readActivity: () => ({ agents: 0, jobs: 0 }),
    readCurrent: async () => 'client',
  })
  const res = await routes.handle('GET', '/dsh-switch/state', headers, loop)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).current, 'client')
})

test('state omits the shell when the host cannot detect it', async () => {
  const routes = createHandoffRoutes({
    now: () => 1, random: () => 'n', spawnLauncher: () => 1,
    readActivity: () => ({ agents: 0, jobs: 0 }),
  })
  const res = routes.handle('GET', '/dsh-switch/state', headers, loop)
  assert.equal(JSON.parse(res.body).current, undefined)
})

test('the config route reads, saves a valid config and refuses an invalid one', async () => {
  let saved = null
  const routes = createHandoffRoutes({
    now: () => 1, random: () => 'n', spawnLauncher: () => 1, readActivity: () => ({ agents: 0, jobs: 0 }),
    readConfig: async () => ({ report: { clipboard: true, dialog: true, webhook: false }, webhook: { url: '', template: '{"text":"{target}"}' } }),
    writeConfig: async (config) => { saved = config; return config },
  })
  const read = await routes.handle('GET', '/dsh-switch/report-config', headers, loop)
  assert.equal(read.status, 200)
  assert.match(read.body, /clipboard/)

  const good = await routes.handle('POST', '/dsh-switch/report-config', headers, loop, JSON.stringify({ report: { clipboard: false } }))
  assert.equal(good.status, 200)
  assert.equal(saved.report.clipboard, false)

  const bad = await routes.handle('POST', '/dsh-switch/report-config', headers, loop, JSON.stringify({ webhook: { url: 'ftp://x', template: '{oops' } }))
  assert.equal(bad.status, 400)
  assert.match(bad.body, /http/)
})

test('the config routes refuse a non-loopback caller', async () => {
  const routes = createHandoffRoutes({ now: () => 1, random: () => 'n', spawnLauncher: () => 1, readConfig: async () => ({}), writeConfig: async () => ({}) })
  const res = await routes.handle('GET', '/dsh-switch/report-config', headers, { remoteAddress: '10.0.0.2' })
  assert.equal(res.status, 403)
})

test('the test route reports the webhook status', async () => {
  const routes = createHandoffRoutes({
    now: () => 1, random: () => 'n', spawnLauncher: () => 1,
    sendTest: async () => ({ ok: true, status: 204 }),
  })
  const res = await routes.handle('POST', '/dsh-switch/report-test', headers, loop, '{}')
  assert.equal(res.status, 200)
  assert.match(res.body, /204/)
})

test('a failing test send is reported as 502', async () => {
  const routes = createHandoffRoutes({
    now: () => 1, random: () => 'n', spawnLauncher: () => 1,
    sendTest: async () => ({ ok: false, error: 'ECONNREFUSED' }),
  })
  const res = await routes.handle('POST', '/dsh-switch/report-test', headers, loop, '{}')
  assert.equal(res.status, 502)
  assert.match(res.body, /ECONNREFUSED/)
})

test('a failing launcher spawn becomes 500 instead of throwing', () => {
  const routes = createHandoffRoutes({ now: () => 1000, random: () => 'n1', spawnLauncher: () => { throw new Error('nope') }, readActivity: () => ({ agents: 0, jobs: 0 }) })
  routes.handle('GET', '/dsh-switch/state', headers, loop)
  const res = routes.handle('POST', '/dsh-switch/handoff', headers, loop, JSON.stringify({ target: 'web', nonce: 'n1' }))
  assert.equal(res.status, 500)
})
