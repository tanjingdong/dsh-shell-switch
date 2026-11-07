import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildWebArgs, extractTokenUrl, waitReady, startWeb, stopWeb } from '../src/web.mjs'

function fakeChild(lines) {
  const child = new EventEmitter()
  child.pid = 123
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  queueMicrotask(() => { for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`)) })
  return child
}

test('buildWebArgs gives one trusted host per address and never --open', () => {
  const args = buildWebArgs({ port: 3080, addresses: ['192.168.0.106', '10.147.20.214'] })
  assert.deepEqual(args.slice(0, 6), ['web', '--host', '127.0.0.1', '--port', '3080', '--no-open'])
  assert.equal(args.filter((a) => a === '--trusted-host').length, 2)
  assert.ok(args.includes('192.168.0.106:3080'))
})

test('extractTokenUrl finds the printed url and ignores unrelated lines', () => {
  assert.equal(extractTokenUrl('dsh web: http://127.0.0.1:3080/?token=abc123'), 'http://127.0.0.1:3080/?token=abc123')
  assert.equal(extractTokenUrl('nothing here'), null)
})

test('waitReady returns false after the deadline', async () => {
  assert.equal(await waitReady({ port: 1, timeoutMs: 30, probe: async () => false }), false)
})

test('startWeb records the pid before waiting, then relays and opens the browser', async () => {
  const order = []
  let opened = null
  let relayArgs = null
  const child = fakeChild(['dsh web: http://127.0.0.1:3080/?token=abc'])
  const result = await startWeb({
    paths: { cliJs: 'c', exe: 'e' },
    port: 3080,
    addresses: ['1.2.3.4'],
    spawnProcess: () => child,
    onSpawn: async (pid) => order.push(`spawn:${pid}`),
    wait: async () => { order.push('wait'); return true },
    spawnRelay: async (options) => { relayArgs = options; order.push('relay'); return { pid: 4321 } },
    openBrowser: (url) => { opened = url; order.push('open') },
  })
  assert.equal(result.url, 'http://127.0.0.1:3080/?token=abc')
  assert.equal(opened, result.url)
  assert.equal(result.pid, 123)
  assert.equal(result.relayPid, 4321)
  assert.equal(relayArgs.targetPort, 3080)
  assert.equal(relayArgs.listenPort, 3080)
  assert.deepEqual(relayArgs.addresses, ['1.2.3.4'])
  assert.deepEqual(order, ['spawn:123', 'wait', 'relay', 'open'])
})

test('startWeb kills the spawned host when the token url never arrives', async () => {
  const killed = []
  const child = fakeChild([])
  await assert.rejects(
    startWeb({
      paths: { cliJs: 'c', exe: 'e' },
      port: 3080,
      addresses: [],
      spawnProcess: () => child,
      wait: async () => true,
      kill: async (pid, options) => { killed.push([pid, options]) },
      tokenTimeoutMs: 20,
    }),
    (error) => error.code === 'no-token-url',
  )
  assert.deepEqual(killed, [[123, { force: true }]])
})

test('startWeb kills the host and the relay when the relay cannot start', async () => {
  const killed = []
  const child = fakeChild(['dsh web: http://127.0.0.1:3080/?token=abc'])
  await assert.rejects(
    startWeb({
      paths: { cliJs: 'c', exe: 'e' },
      port: 3080,
      addresses: ['1.2.3.4'],
      spawnProcess: () => child,
      wait: async () => true,
      spawnRelay: async () => { throw new Error('relay refused') },
      kill: async (pid, options) => { killed.push([pid, options]) },
    }),
    /relay refused/,
  )
  assert.deepEqual(killed, [[123, { force: true }]])
})

test('stopWeb kills the relay process before the host', async () => {
  const killed = []
  await stopWeb({
    relayPid: 4321,
    pid: 123,
    kill: async (pid, options) => { killed.push([pid, options]); return { killed: true, forced: true } },
  })
  assert.deepEqual(killed.map(([pid]) => pid), [4321, 123])
  assert.deepEqual(killed[0][1], { force: true })
})
