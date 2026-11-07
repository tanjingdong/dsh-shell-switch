import { test } from 'node:test'
import assert from 'node:assert/strict'
import { switchTo, fetchBusy, detectCurrent, startClient, stopEverything, stopShell, waitForClient } from '../src/launcher.mjs'

const clientPaths = {
  desktopProfile: 'C:\\u\\.dsh\\profiles\\desktop',
  webProfile: 'C:\\u\\.dsh\\profiles\\web',
  exe: 'C:\\l\\DeepSeek Harness.exe',
}
const desktopHost = { pid: 11, commandLine: 'x\\dsh-desktop-host\\lib\\index.js C:\\u\\.dsh\\profiles\\desktop' }
const electronShell = { pid: 10, commandLine: '"C:\\l\\DeepSeek Harness.exe"' }

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

test('fetchBusy treats an unconfirmed state as unknown instead of idle', async () => {
  const unconfirmed = async () => ({ ok: true, json: async () => ({ busy: false, known: false }) })
  assert.equal(await fetchBusy({ port: 1, fetchImpl: unconfirmed }), null)
  const idle = async () => ({ ok: true, json: async () => ({ busy: false, known: true }) })
  assert.equal(await fetchBusy({ port: 1, fetchImpl: idle }), false)
  const busy = async () => ({ ok: true, json: async () => ({ busy: true, known: true }) })
  assert.equal(await fetchBusy({ port: 1, fetchImpl: busy }), true)
})

test('stopEverything stops a client the launcher never recorded a pid for', async () => {
  const killed = []
  const result = await stopEverything({
    paths: clientPaths,
    state: { mode: 'client', pid: 0 },
    list: async () => [electronShell, desktopHost],
    kill: async (pid) => { killed.push(pid) },
  })
  assert.equal(result.current, 'client')
  assert.deepEqual(killed, [11, 10])
})

test('stopEverything also ends the relay process recorded in the state', async () => {
  const killed = []
  const webHost = { pid: 20, commandLine: 'x\\cli.js web --host 127.0.0.1 --port 3080' }
  await stopEverything({
    paths: clientPaths,
    state: { mode: 'web', pid: 20, relayPid: 30 },
    list: async () => [webHost],
    kill: async (pid) => { killed.push(pid) },
  })
  assert.deepEqual(killed, [20, 30])
})

test('stopEverything reports nothing running when no shell is detected', async () => {
  const result = await stopEverything({ paths: clientPaths, state: null, list: async () => [], kill: async () => {} })
  assert.deepEqual(result, { current: null, killed: [] })
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

test('stopShell kills the desktop host and then the Electron shell around it', async () => {
  const killed = []
  const ids = await stopShell({
    current: 'client',
    paths: clientPaths,
    list: async () => [electronShell, desktopHost],
    kill: async (pid, options) => { killed.push([pid, options]) },
  })
  assert.deepEqual(ids, [11, 10])
  assert.deepEqual(killed.map(([pid]) => pid), [11, 10])
})

test('switchTo ends the shell too when leaving the desktop client', async () => {
  const killed = []
  await switchTo('web', {
    paths: clientPaths, force: true, log: () => {},
    list: async () => [electronShell, desktopHost],
    kill: async (pid) => { killed.push(pid) },
    startWeb: async () => {},
  })
  assert.deepEqual(killed, [11, 10])
})

test('startClient reports the shell pid only after the host listens', async () => {
  const result = await startClient({
    paths: clientPaths,
    spawnShell: () => 99,
    wait: async () => ({ pid: 11, port: 27180 }),
  })
  assert.deepEqual(result, { shellPid: 99, pid: 11, port: 27180 })
})

test('startClient surfaces a readiness failure instead of reporting success', async () => {
  await assert.rejects(
    startClient({ paths: clientPaths, spawnShell: () => 99, wait: async () => { throw new Error('no host') } }),
    /no host/,
  )
})

test('waitForClient waits until the desktop host listens and reports the port', async () => {
  let calls = 0
  const result = await waitForClient({
    paths: clientPaths,
    list: async () => { calls += 1; return calls >= 2 ? [desktopHost] : [] },
    ports: async () => [27180],
    intervalMs: 1,
  })
  assert.deepEqual(result, { pid: 11, port: 27180 })
})

test('waitForClient refuses to claim success when no host appears', async () => {
  await assert.rejects(
    waitForClient({ paths: clientPaths, list: async () => [], ports: async () => [], timeoutMs: 5, intervalMs: 1 }),
    (error) => error.code === 'client-not-ready',
  )
})

test('waitForClient waits for a listening port, not just the process', async () => {
  let polls = 0
  const result = await waitForClient({
    paths: clientPaths,
    list: async () => [desktopHost],
    ports: async () => { polls += 1; return polls >= 3 ? [27180] : [] },
    intervalMs: 1,
  })
  assert.equal(result.port, 27180)
  assert.ok(polls >= 3)
})

test('detectCurrent reports the shell that owns the profile', async () => {
  const paths = { desktopProfile: 'p\\desktop', webProfile: 'p\\web' }
  assert.equal(await detectCurrent({ paths, list: async () => [] }), null)
  assert.equal(await detectCurrent({
    paths,
    list: async () => [{ pid: 1, commandLine: 'x\\dsh-desktop-host\\lib\\index.js p\\desktop' }],
  }), 'client')
})
