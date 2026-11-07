import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildWebArgs, extractTokenUrl, showUrlDialog, spawnWebHost, waitForToken, waitReady,
  startWeb, stopWeb,
} from '../src/web.mjs'

const OK_LOG = 'dsh web: http://127.0.0.1:3080/?token=abc'
const readLogWith = (text) => () => text

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 123
  child.kill = () => {}
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

test('waitReady requires an HTTP answer, not only an accepted TCP connection', async () => {
  assert.equal(
    await waitReady({ port: 1, timeoutMs: 30, intervalMs: 1, probe: async () => true, httpProbe: async () => false }),
    false,
  )
  assert.equal(
    await waitReady({ port: 1, timeoutMs: 30, intervalMs: 1, probe: async () => true, httpProbe: async () => true }),
    true,
  )
})

test('waitReady probes HTTP only after TCP accepts', async () => {
  let httpCalls = 0
  await waitReady({
    port: 1, timeoutMs: 20, intervalMs: 1,
    probe: async () => false,
    httpProbe: async () => { httpCalls += 1; return true },
  })
  assert.equal(httpCalls, 0)
})

test('the host is spawned detached with its output in a file', () => {
  const calls = []
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options })
    return { pid: 5, unref: () => { calls[0].unrefed = true } }
  }
  spawnWebHost({
    paths: { exe: 'e.exe', cliJs: 'cli.js' },
    args: ['web', '--port', '3080'],
    logFile: join(tmpdir(), 'dsh-host-test.log'),
    spawnImpl,
  })
  const [call] = calls
  assert.equal(call.file, 'e.exe')
  assert.deepEqual(call.args.slice(0, 3), ['--expose-internals', 'cli.js', 'web'])
  assert.equal(call.options.stdio[0], 'ignore')
  // A numeric fd means the child owns a file handle; a pipe would die with us.
  assert.equal(typeof call.options.stdio[1], 'number')
  assert.equal(typeof call.options.stdio[2], 'number')
  // Detached: a non-detached child is killed when the launcher exits.
  assert.equal(call.options.detached, true)
  assert.equal(call.unrefed, true)
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1')
})

test('waitForToken reads the url out of the host log', async () => {
  let calls = 0
  const url = await waitForToken({
    file: 'host.log',
    timeoutMs: 50,
    intervalMs: 1,
    read: () => (++calls >= 2 ? OK_LOG : ''),
  })
  assert.equal(url, 'http://127.0.0.1:3080/?token=abc')
})

test('waitForToken gives up on a log that never carries a token', async () => {
  await assert.rejects(
    waitForToken({ file: 'host.log', timeoutMs: 10, intervalMs: 1, read: () => 'no token' }),
    (error) => error.code === 'no-token-url',
  )
})

test('startWeb records the pid before waiting, then relays and opens the browser', async () => {
  const order = []
  let opened = null
  let relayArgs = null
  let spawnOptions = null
  const child = fakeChild()
  const result = await startWeb({
    paths: { cliJs: 'c', exe: 'e', logDir: join(tmpdir(), 'dsh-host-logs') },
    port: 3080,
    addresses: ['1.2.3.4'],
    spawnProcess: (options) => { spawnOptions = options; return child },
    onSpawn: async (pid) => order.push(`spawn:${pid}`),
    wait: async () => { order.push('wait'); return true },
    readLog: readLogWith(OK_LOG),
    spawnRelay: async (options) => { relayArgs = options; order.push('relay'); return { pid: 4321 } },
    openBrowser: (url) => { opened = url; order.push('open') },
  })
  assert.equal(result.url, 'http://127.0.0.1:3080/?token=abc')
  assert.equal(opened, result.url)
  assert.equal(result.pid, 123)
  assert.equal(result.relayPid, 4321)
  assert.equal(relayArgs.targetPort, 3080)
  assert.deepEqual(relayArgs.addresses, ['1.2.3.4'])
  assert.match(String(spawnOptions.logFile), /web-host-3080\.log$/)
  assert.deepEqual(order, ['spawn:123', 'wait', 'relay', 'open'])
})

test('startWeb kills the spawned host when the token url never arrives', async () => {
  const killed = []
  await assert.rejects(
    startWeb({
      paths: { cliJs: 'c', exe: 'e' },
      port: 3080,
      addresses: [],
      spawnProcess: () => fakeChild(),
      wait: async () => true,
      readLog: readLogWith('nothing'),
      kill: async (pid, options) => { killed.push([pid, options]) },
      tokenTimeoutMs: 20,
    }),
    (error) => error.code === 'no-token-url',
  )
  assert.deepEqual(killed, [[123, { force: true }]])
})

test('startWeb kills the host and the relay when the relay cannot start', async () => {
  const killed = []
  await assert.rejects(
    startWeb({
      paths: { cliJs: 'c', exe: 'e' },
      port: 3080,
      addresses: ['1.2.3.4'],
      spawnProcess: () => fakeChild(),
      wait: async () => true,
      readLog: readLogWith(OK_LOG),
      spawnRelay: async () => { throw new Error('relay refused') },
      kill: async (pid, options) => { killed.push([pid, options]) },
    }),
    /relay refused/,
  )
  assert.deepEqual(killed, [[123, { force: true }]])
})

test('startWeb hands the token url to the notifier after opening it', async () => {
  const order = []
  await startWeb({
    paths: { cliJs: 'c', exe: 'e' },
    port: 3080,
    addresses: [],
    spawnProcess: () => fakeChild(),
    wait: async () => true,
    readLog: readLogWith(OK_LOG),
    spawnRelay: async () => ({ pid: 1 }),
    openBrowser: () => order.push('open'),
    notifyUrl: ({ url }) => { order.push(`notify:${url}`) },
  })
  assert.deepEqual(order, ['open', 'notify:http://127.0.0.1:3080/?token=abc'])
})

test('a failing url dialog never tears down a host that is already up', async () => {
  const result = await startWeb({
    paths: { cliJs: 'c', exe: 'e' },
    port: 3080,
    addresses: [],
    spawnProcess: () => fakeChild(),
    wait: async () => true,
    readLog: readLogWith(OK_LOG),
    spawnRelay: async () => ({ pid: 1 }),
    openBrowser: () => {},
    notifyUrl: async () => { throw new Error('no dialog') },
  })
  assert.equal(result.port, 3080)
  assert.equal(result.relayPid, 1)
})

test('showUrlDialog runs the script through cmd so a detached powershell executes', () => {
  let call = null
  const child = { pid: 12, unref: () => {} }
  showUrlDialog({
    url: 'http://127.0.0.1:3080/?token=abc',
    env: {},
    logFile: join(tmpdir(), 'dsh-dialog-test.log'),
    spawnProcess: (file, args, options) => {
      call = { file, args, options }
      return child
    },
  })
  // A bare detached powershell silently does nothing; cmd gives it a console.
  assert.equal(call.file, 'cmd.exe')
  assert.deepEqual(call.args.slice(0, 3), ['/c', 'powershell.exe', '-NoProfile'])
  assert.ok(call.args.includes('-EncodedCommand'))
  const encoded = call.args[call.args.indexOf('-EncodedCommand') + 1]
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.match(script, /Set-Clipboard/)
  assert.match(script, /MessageBox/)
  assert.equal(call.options.env.DSH_SWITCH_URL, 'http://127.0.0.1:3080/?token=abc')
  assert.equal(call.options.detached, true)
  // The dialog must not inherit a pipe from the launcher either.
  assert.equal(typeof call.options.stdio[1], 'number')
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

test('a dead relay address only loses that entry point', async () => {
  const result = await startWeb({
    paths: { cliJs: 'c', exe: 'e' },
    port: 3080,
    addresses: ['203.0.113.9'],
    spawnProcess: () => fakeChild(),
    wait: async () => true,
    readLog: readLogWith(OK_LOG),
    spawnRelay: async () => ({
      pid: 4321,
      results: [{ address: '203.0.113.9', status: 'ENOTFOUND' }],
    }),
    openBrowser: () => {},
  })
  assert.equal(result.port, 3080)
  assert.equal(result.relayPid, 4321)
})
