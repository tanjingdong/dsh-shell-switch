import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROCESS_QUERY, isDesktopHost, isWebHost, killTree, listProcesses } from '../src/procs.mjs'

const paths = { desktopProfile: 'C:\\u\\.dsh\\profiles\\desktop', webProfile: 'C:\\u\\.dsh\\profiles\\web' }

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

test('listProcesses tolerates a single-object JSON payload', async () => {
  const run = async () => ({ stdout: JSON.stringify({ ProcessId: 7, Name: 'a.exe', CommandLine: 'x' }) })
  assert.deepEqual(await listProcesses(run), [{ pid: 7, name: 'a.exe', commandLine: 'x' }])
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
