import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildWebArgs, extractTokenUrl, waitReady, startWeb } from '../src/web.mjs'

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

test('startWeb parses the token url, starts the relay and opens the browser', async () => {
  let opened = null
  let relayArgs = null
  const child = fakeChild(['dsh web: http://127.0.0.1:3080/?token=abc'])
  const result = await startWeb({
    paths: { cliJs: 'c', exe: 'e' },
    port: 3080,
    addresses: ['1.2.3.4'],
    spawnProcess: () => child,
    waitReady: async () => true,
    relayFactory: async (options) => { relayArgs = options; return { results: [], close: async () => {} } },
    openBrowser: (url) => { opened = url },
  })
  assert.equal(result.url, 'http://127.0.0.1:3080/?token=abc')
  assert.equal(opened, result.url)
  assert.equal(result.pid, 123)
  assert.equal(relayArgs.targetPort, 3080)
})
