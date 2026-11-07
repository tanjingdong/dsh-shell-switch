import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROCESS_QUERY, collectDescendants, isDesktopHost, isElectronShell, isRelayProcess,
  isWebHost, killTree, listListeningPorts, listProcesses, relayScriptFile,
} from '../src/procs.mjs'

const paths = {
  desktopProfile: 'C:\\u\\.dsh\\profiles\\desktop',
  webProfile: 'C:\\u\\.dsh\\profiles\\web',
  exe: 'C:\\l\\DeepSeek Harness.exe',
}

test('the process query forces UTF-8 before reading command lines', () => {
  assert.match(PROCESS_QUERY, /OutputEncoding/)
  assert.match(PROCESS_QUERY, /Get-CimInstance/)
})

test('isDesktopHost matches only the Electron host command line', () => {
  assert.equal(isDesktopHost({ commandLine: 'x "…\\dsh-desktop-host\\lib\\index.js" "C:\\u\\.dsh\\profiles\\desktop"' }, paths), true)
  assert.equal(isDesktopHost({ commandLine: 'x cli.js web --profile web' }, paths), false)
  assert.equal(isDesktopHost({ commandLine: 'x "…\\dsh-desktop-host\\lib\\index.js" "C:/u/.dsh/profiles/desktop"' }, paths), true)
})

test('isWebHost accepts the explicit and the default profile form', () => {
  assert.equal(isWebHost({ commandLine: 'x "...\\cli.js" web --host 127.0.0.1 --port 3080' }, paths), true)
  assert.equal(isWebHost({ commandLine: 'x "...\\cli.js" --profile web web' }, paths), true)
  assert.equal(isWebHost({ commandLine: 'x "…\\dsh-desktop-host\\lib\\index.js" "…\\profiles\\desktop"' }, paths), false)
})

test('isElectronShell matches the app executable but never the desktop host', () => {
  assert.equal(isElectronShell({ commandLine: '"C:\\l\\DeepSeek Harness.exe" --no-sandbox' }, paths), true)
  assert.equal(isElectronShell({ commandLine: 'C:/l/DeepSeek Harness.exe' }, paths), true)
  assert.equal(isElectronShell({
    commandLine: '"C:\\l\\DeepSeek Harness.exe" --expose-internals dsh-desktop-host "C:\\u\\.dsh\\profiles\\desktop"',
  }, paths), false)
  assert.equal(isElectronShell({ commandLine: 'C:\\l\\node.exe other.js' }, paths), false)
})

test('listListeningPorts reads the listening ports owned by one pid', async () => {
  const seen = []
  const run = async (args) => { seen.push(args); return { stdout: '27180\r\n27181\r\n' } }
  assert.deepEqual(await listListeningPorts(4321, { run }), [27180, 27181])
  assert.match(seen[0].join(' '), /4321/)
})

test('the process query carries parent pids so a tree can be walked', () => {
  assert.match(PROCESS_QUERY, /ParentProcessId/)
  assert.match(PROCESS_QUERY, /ProcessId/)
})

test('listProcesses keeps the parent pid', async () => {
  const run = async () => ({ stdout: JSON.stringify({ ProcessId: 7, ParentProcessId: 3, Name: 'a.exe', CommandLine: 'x' }) })
  assert.deepEqual(await listProcesses(run), [{ pid: 7, parentPid: 3, name: 'a.exe', commandLine: 'x' }])
})

test('collectDescendants walks the tree and never returns a protected pid', () => {
  const processes = [
    { pid: 1, parentPid: 0 }, { pid: 2, parentPid: 1 }, { pid: 3, parentPid: 2 }, { pid: 4, parentPid: 1 },
  ]
  assert.deepEqual(collectDescendants([1], processes), [1, 2, 4, 3])
  assert.deepEqual(collectDescendants([1], processes, { protect: [2] }), [1, 4])
})

test('killTree can end one process without a tree kill', async () => {
  const calls = []
  const list = async () => [{ pid: 1 }]
  const kill = async (pid, mode, options) => { calls.push([mode, options]) }
  await assert.rejects(killTree(1, { force: true, timeoutMs: 0, list, kill, tree: false }), /无法结束进程/)
  assert.deepEqual(calls, [['graceful', { tree: false }], ['force', { tree: false }]])
})

test('isRelayProcess matches only the real relay script path', () => {
  assert.equal(isRelayProcess({ commandLine: `"C:\\n\\node.exe" "${relayScriptFile}" --target-port 1` }), true)
  assert.equal(isRelayProcess({ commandLine: 'node -e "log(src/relay.mjs)"' }), false)
  assert.equal(isRelayProcess({ commandLine: 'node mcp-server.js' }), false)
})

test('listProcesses tolerates a single-object JSON payload', async () => {
  const run = async () => ({ stdout: JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'a.exe', CommandLine: 'x' }) })
  assert.deepEqual(await listProcesses(run), [{ pid: 7, parentPid: 1, name: 'a.exe', commandLine: 'x' }])
})

test('listProcesses throws instead of pretending nothing is running', async () => {
  const run = async () => ({ stdout: '', error: new Error('powershell blocked') })
  await assert.rejects(listProcesses(run), /无法读取进程列表/)
})

test('killTree reports forced only when the process survives and force is allowed', async () => {
  const calls = []
  const list = async () => [{ pid: 1 }]
  const kill = async (pid, mode) => { calls.push(mode) }
  assert.deepEqual(await killTree(1, { force: false, timeoutMs: 0, list, kill }), { killed: false, forced: false })
  assert.deepEqual(calls, ['graceful'])
})

test('killTree returns killed without force when the process disappears', async () => {
  const list = async () => []
  const calls = []
  const kill = async (pid, mode) => { calls.push(mode) }
  assert.deepEqual(await killTree(9, { force: false, timeoutMs: 0, list, kill }), { killed: true, forced: false })
  assert.deepEqual(calls, ['graceful'])
})

test('killTree throws rather than claiming a refused kill succeeded', async () => {
  const list = async () => [{ pid: 3 }]
  const kill = async () => ({ error: new Error('access denied') })
  await assert.rejects(killTree(3, { force: true, timeoutMs: 0, list, kill }), /无法结束进程/)
})
