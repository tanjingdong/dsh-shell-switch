import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRelay, parseRelayArgs, runRelayCli } from '../src/relay.mjs'

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

test('relay forwards bytes to the target and survives a bad address', async () => {
  const echo = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1')
  await once(echo, 'listening')
  const targetPort = echo.address().port
  const relay = await createRelay({ targetPort, addresses: ['127.0.0.1', '203.0.113.9'], listenPort: 0 })
  const ok = relay.results.find((r) => r.status === 'ok')
  assert.ok(ok, 'loopback address must listen')
  assert.notEqual(relay.results.find((r) => r.address === '203.0.113.9').status, 'ok')
  const client = net.connect(ok.port, '127.0.0.1')
  const echoed = await new Promise((resolve) => {
    client.once('connect', () => client.write('ping'))
    client.once('data', (d) => resolve(d.toString()))
  })
  assert.equal(echoed, 'ping')
  client.destroy()
  await relay.close()
  echo.close()
  await once(echo, 'close')
})

test('parseRelayArgs reads the ports and the address list', () => {
  assert.deepEqual(
    parseRelayArgs(['--target-port', '3080', '--listen-port', '3081', '--addresses', '10.0.0.1, 10.0.0.2']),
    { targetPort: 3080, listenPort: 3081, addresses: ['10.0.0.1', '10.0.0.2'] },
  )
})

test('parseRelayArgs refuses to start without a target port', () => {
  assert.throws(() => parseRelayArgs(['--listen-port', '1']), (error) => error.code === 'bad-relay-args')
  assert.throws(() => parseRelayArgs(['--nope']), (error) => error.code === 'bad-relay-args')
})

test('the relay cli hands the parsed options to the factory', async () => {
  let seen = null
  const relay = await runRelayCli(
    ['--target-port', '3080', '--listen-port', '3090', '--addresses', '1.2.3.4'],
    { relayFactory: async (options) => { seen = options; return { results: [], close: async () => {} } } },
  )
  assert.equal(seen.targetPort, 3080)
  assert.equal(seen.listenPort, 3090)
  assert.deepEqual(seen.addresses, ['1.2.3.4'])
  assert.ok(relay)
})
