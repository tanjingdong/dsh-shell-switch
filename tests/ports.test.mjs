import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { probePort, findFreePort, reservePort } from '../src/ports.mjs'

async function withServer(fn) {
  const server = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(server.address().port)
  } finally {
    server.close()
    await new Promise((r) => server.once('close', r))
  }
}

test('probePort reports a listener as occupied and a closed port as free', async () => {
  const busy = await withServer((port) => port)
  assert.equal(await probePort(busy), false)
  await withServer(async (port) => {
    assert.equal(await probePort(port), true)
  })
})

test('findFreePort skips an occupied port and rejects an exhausted range', async () => {
  await withServer(async (busy) => {
    const picked = await findFreePort({ start: busy, end: busy + 1 })
    assert.notEqual(picked, busy)
    await assert.rejects(findFreePort({ start: busy, end: busy }), (e) => e.code === 'no-free-port')
  })
})

test('reservePort keeps the preferred port when free and picks another when taken', async () => {
  assert.equal(await reservePort(3080, { probe: async () => false }), 3080)
  assert.equal(
    await reservePort(3080, { probe: async () => true, find: async ({ start }) => start + 1 }),
    3081,
  )
  assert.equal(await reservePort(null, { find: async ({ start }) => start }), 3080)
})
