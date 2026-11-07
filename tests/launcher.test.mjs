import { test } from 'node:test'
import assert from 'node:assert/strict'
import { switchTo, fetchBusy, detectCurrent } from '../src/launcher.mjs'

test('switchTo retries three times then throws without restarting the old shell', async () => {
  let starts = 0
  const deps = {
    paths: { desktopProfile: 'p\\desktop', webProfile: 'p\\web' },
    force: false, log: () => {},
    prepare: async () => {}, list: async () => [], kill: async () => ({ killed: true, forced: false }),
    startWeb: async () => { starts += 1; throw new Error('boom') },
    startClient: async () => {},
  }
  await assert.rejects(switchTo('web', deps), (e) => e.code === 'start-failed')
  assert.equal(starts, 3)
})

test('switchTo refuses to cut a busy host unless forced', async () => {
  const deps = {
    paths: { desktopProfile: 'p\\desktop', webProfile: 'p\\web' },
    force: false, log: () => {}, prepare: async () => {},
    list: async () => [{ pid: 1, commandLine: 'x\\dsh-desktop-host\\lib\\index.js p\\desktop' }],
    kill: async () => { throw new Error('must not be called') },
    startWeb: async () => { throw new Error('must not start') },
    busyProbe: async () => true,
  }
  await assert.rejects(switchTo('web', deps), (e) => e.code === 'busy')
})

test('switchTo refuses when activity cannot be confirmed and force is absent', async () => {
  const deps = {
    paths: { desktopProfile: 'p\\desktop', webProfile: 'p\\web' },
    force: false, log: () => {}, prepare: async () => {},
    list: async () => [{ pid: 1, commandLine: 'x\\dsh-desktop-host\\lib\\index.js p\\desktop' }],
    kill: async () => { throw new Error('must not be called') },
    startWeb: async () => {},
    busyProbe: async () => null,
  }
  await assert.rejects(switchTo('web', deps), (e) => e.code === 'busy-unconfirmed')
})

test('fetchBusy returns null when the state route is unreachable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await fetchBusy({ port: 1, fetchImpl }), null)
})

test('switchTo re-picks the port before every attempt', async () => {
  const ports = []
  let next = 3080
  const deps = {
    paths: {}, force: false, log: () => {}, prepare: async () => {},
    list: async () => [], kill: async () => ({ killed: true, forced: false }),
    pickPort: async () => next++,
    startWeb: async ({ port }) => { ports.push(port); throw new Error('boom') },
  }
  await assert.rejects(switchTo('web', deps), (error) => error.code === 'start-failed')
  assert.deepEqual(ports, [3080, 3081, 3082])
})

test('detectCurrent reports the shell that owns the profile', async () => {
  const paths = { desktopProfile: 'p\\desktop', webProfile: 'p\\web' }
  assert.equal(await detectCurrent({ paths, list: async () => [] }), null)
  assert.equal(await detectCurrent({
    paths,
    list: async () => [{ pid: 1, commandLine: 'x\\dsh-desktop-host\\lib\\index.js p\\desktop' }],
  }), 'client')
})
