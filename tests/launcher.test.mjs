import { test } from 'node:test'
import assert from 'node:assert/strict'
import { switchTo, fetchBusy, currentHostPort, detectCurrent, spawnShell, startClient, stopEverything, stopShell, waitForClient } from '../src/launcher.mjs'
import { relayScriptFile } from '../src/procs.mjs'

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

test('stopEverything ends a leftover relay even when no shell is running', async () => {
  const killed = []
  const result = await stopEverything({
    paths: clientPaths,
    state: { relayPid: 30 },
    list: async () => [],
    kill: async (pid, options) => { killed.push([pid, options]) },
  })
  assert.deepEqual(result, { current: null, killed: [30] })
  assert.deepEqual(killed, [[30, { force: true, timeoutMs: 0, tree: false }]])
})

test('stopEverything ends an orphan relay whose state record was lost', async () => {
  const killed = []
  const relay = {
    pid: 30,
    commandLine: `"C:\\n\\node.exe" "${relayScriptFile}" --target-port 3080`,
  }
  const result = await stopEverything({
    paths: clientPaths,
    state: null,
    list: async () => [relay],
    kill: async (pid, options) => { killed.push([pid, options]) },
  })
  assert.deepEqual(result, { current: null, killed: [30] })
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

test('spawnShell starts the GUI without the node mode inherited from a host', () => {
  let call = null
  spawnShell({
    paths: { exe: 'C:\\l\\DeepSeek Harness.exe' },
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: 'C:\\bin' },
    spawnImpl: (file, args, options) => {
      call = { file, args, options }
      return { pid: 9, unref: () => { call.unrefed = true } }
    },
  })
  assert.equal(call.file, 'C:\\l\\DeepSeek Harness.exe')
  assert.deepEqual(call.args, [])
  assert.equal(call.options.detached, true)
  // The launcher runs under ELECTRON_RUN_AS_NODE when a web host spawned it;
  // passing that on would start the app as node and no window would appear.
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(call.options.env.PATH, 'C:\\bin')
  assert.equal(call.unrefed, true)
})

test('startClient reports the shell pid only after the host listens', async () => {
  const result = await startClient({
    paths: clientPaths,
    spawnShell: () => ({ pid: 99 }),
    wait: async () => ({ pid: 11, port: 27180 }),
  })
  assert.deepEqual(result, { shellPid: 99, pid: 11, port: 27180 })
})

test('startClient surfaces a readiness failure instead of reporting success', async () => {
  await assert.rejects(
    startClient({ paths: clientPaths, spawnShell: () => ({ pid: 99 }), wait: async () => { throw new Error('no host') } }),
    /no host/,
  )
})

test('switchTo ends the relay of the shell it is leaving', async () => {
  const killed = []
  const webHost = { pid: 20, commandLine: 'x\\cli.js web --host 127.0.0.1 --port 3080' }
  await switchTo('client', {
    paths: clientPaths, force: true, log: () => {},
    list: async () => [webHost],
    kill: async (pid) => { killed.push(pid) },
    relayPid: 30,
    startClient: async () => {},
  })
  assert.deepEqual(killed, [20, 30])
})

test('a web host is ended at once, while the client keeps the graceful wait', async () => {
  const calls = []
  const webHost = { pid: 20, name: 'node.exe', commandLine: 'x\\cli.js web --host 127.0.0.1 --port 3080' }
  await stopShell({
    current: 'web', paths: clientPaths, list: async () => [webHost],
    kill: async (pid, options) => { calls.push([pid, options]) }, protect: [999], timeoutMs: 10000,
  })
  assert.equal(calls[0][1].timeoutMs, 0)

  const clientCalls = []
  await stopShell({
    current: 'client', paths: clientPaths, list: async () => [desktopHost, electronShell],
    kill: async (pid, options) => { clientCalls.push([pid, options]) }, protect: [999], timeoutMs: 10000,
  })
  assert.ok(clientCalls.every(([, options]) => options.timeoutMs === 10000))
})

test('stopShell never targets critical system processes that look like children', async () => {
  const killed = []
  const processes = [
    { pid: 10, parentPid: 0, name: 'DeepSeek Harness.exe', commandLine: '"C:\\l\\DeepSeek Harness.exe"' },
    { pid: 20, parentPid: 10, name: 'DeepSeek Harness.exe', commandLine: 'x\\dsh-desktop-host\\lib\\index.js C:\\u\\.dsh\\profiles\\desktop' },
    { pid: 22, parentPid: 20, name: 'winlogon.exe', commandLine: 'winlogon.exe' },
    { pid: 23, parentPid: 20, name: 'csrss.exe', commandLine: 'csrss.exe' },
    { pid: 24, parentPid: 20, name: 'dwm.exe', commandLine: 'dwm.exe' },
  ]
  await stopShell({
    current: 'client',
    paths: clientPaths,
    list: async () => processes,
    kill: async (pid) => { killed.push(pid) },
    protect: [999],
  })
  assert.deepEqual(killed, [20, 10])
})

test('an unkillable helper process does not abort stopping the shell', async () => {
  const killed = []
  const processes = [
    { pid: 10, parentPid: 0, name: 'DeepSeek Harness.exe', commandLine: '"C:\\l\\DeepSeek Harness.exe"' },
    { pid: 20, parentPid: 10, name: 'DeepSeek Harness.exe', commandLine: 'x\\dsh-desktop-host\\lib\\index.js C:\\u\\.dsh\\profiles\\desktop' },
    { pid: 25, parentPid: 20, name: 'conhost.exe', commandLine: 'conhost.exe' },
  ]
  const ids = await stopShell({
    current: 'client',
    paths: clientPaths,
    list: async () => processes,
    kill: async (pid) => {
      if (pid === 25) throw new Error('无法结束进程 25')
      killed.push(pid)
    },
    protect: [999],
  })
  assert.deepEqual(ids, [20, 10])
  assert.deepEqual(killed, [20, 10])
})

test('stopShell still fails loudly when the shell itself cannot be ended', async () => {
  await assert.rejects(
    stopShell({
      current: 'web',
      paths: clientPaths,
      list: async () => [{ pid: 20, parentPid: 0, name: 'node.exe', commandLine: 'x\\cli.js web --port 3080' }],
      kill: async () => { throw new Error('access denied') },
      protect: [999],
    }),
    /access denied/,
  )
})

test('stopShell never kills its own process while ending the shell tree', async () => {
  const killed = []
  const processes = [
    { pid: 10, parentPid: 0, commandLine: '"C:\\l\\DeepSeek Harness.exe"' },
    { pid: 20, parentPid: 10, commandLine: 'x\\dsh-desktop-host\\lib\\index.js C:\\u\\.dsh\\profiles\\desktop' },
    { pid: 21, parentPid: 20, commandLine: 'node src\\cli.mjs web --force' },
    { pid: 22, parentPid: 20, commandLine: 'node mcp-server.js' },
  ]
  const ids = await stopShell({
    current: 'client',
    paths: clientPaths,
    list: async () => processes,
    kill: async (pid, options) => { killed.push([pid, options]) },
    protect: [21],
  })
  assert.deepEqual(killed.map(([pid]) => pid), [22, 20, 10])
  assert.ok(killed.every(([, options]) => options.tree === false))
  assert.equal(ids.includes(21), false)
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

test('currentHostPort prefers the recorded port and otherwise asks the host pid', async () => {
  assert.equal(await currentHostPort({ paths: clientPaths, state: { port: 3080 } }), 3080)
  assert.equal(
    await currentHostPort({
      paths: clientPaths,
      state: null,
      list: async () => [desktopHost],
      ports: async () => [27180],
    }),
    27180,
  )
  assert.equal(
    await currentHostPort({ paths: clientPaths, state: null, list: async () => [], ports: async () => [] }),
    null,
  )
})

test('detectCurrent refuses to guess when the process list cannot be read', async () => {
  await assert.rejects(
    detectCurrent({ paths: clientPaths, list: async () => { throw new Error('powershell blocked') } }),
    (error) => error.code === 'process-query-failed',
  )
})

test('switchTo stops instead of starting when processes cannot be listed', async () => {
  let started = false
  await assert.rejects(switchTo('web', {
    paths: clientPaths,
    list: async () => { throw new Error('powershell blocked') },
    startWeb: async () => { started = true },
  }), (error) => error.code === 'process-query-failed')
  assert.equal(started, false)
})

test('switchTo does nothing when the target shell already runs', async () => {
  let started = false
  const result = await switchTo('web', {
    paths: clientPaths,
    list: async () => [{ pid: 20, commandLine: 'x\\cli.js web --host 127.0.0.1 --port 3080' }],
    startWeb: async () => { started = true },
  })
  assert.deepEqual(result, { switched: false, current: 'web' })
  assert.equal(started, false)
})

test('detectCurrent reports the shell that owns the profile', async () => {
  const paths = { desktopProfile: 'p\\desktop', webProfile: 'p\\web' }
  assert.equal(await detectCurrent({ paths, list: async () => [] }), null)
  assert.equal(await detectCurrent({
    paths,
    list: async () => [{ pid: 1, commandLine: 'x\\dsh-desktop-host\\lib\\index.js p\\desktop' }],
  }), 'client')
})
