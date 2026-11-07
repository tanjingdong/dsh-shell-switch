import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createLauncherSpawner, createMount, mountRoutes, readActivity, resolveNodeBinary, shortcutSpec } from '../index.mjs'

test('readActivity counts running agents, jobs and waiting approvals', () => {
  const registry = {
    agents: { list: () => [{ status: 'running' }, { status: 'idle' }] },
    jobs: { list: () => [{}, {}] },
    inbox: { nextTurn: false, nextStep: true, approvals: [{ id: 1 }] },
  }
  const activity = readActivity({ get: (key) => registry[key] })
  assert.deepEqual(activity, { agents: 1, jobs: 2, inbox: true, approvals: 1 })
})

test('readActivity refuses to guess when the agent registry cannot be read', () => {
  assert.equal(readActivity({ get: () => null }), null)
  assert.equal(readActivity({}), null)
  assert.equal(readActivity({ get: () => { throw new Error('no registry') } }), null)
})

test('resolveNodeBinary prefers an explicit node, then the vendored one, then PATH', () => {
  assert.equal(
    resolveNodeBinary({ env: { USERPROFILE: 'C:\\u' }, exists: (file) => file.includes('vendor') }),
    'C:\\u\\.dsh\\plugins\\rea-bundle\\vendor\\node\\node.exe',
  )
  assert.equal(resolveNodeBinary({ env: {}, exists: () => false }), 'node')
  assert.equal(
    resolveNodeBinary({ env: { DSH_SWITCH_NODE: 'C:\\n\\node.exe' }, exists: (file) => file === 'C:\\n\\node.exe' }),
    'C:\\n\\node.exe',
  )
})

test('every route the client calls is mounted on the host web server', () => {
  const registered = []
  const host = {
    webServer: { register: (options) => { registered.push(options.path); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
  }
  assert.equal(mountRoutes(host, { handle: () => ({ status: 200, body: '{}' }) }), true)
  for (const path of [
    '/dsh-switch/state',
    '/dsh-switch/handoff',
    '/dsh-switch/report-config',
    '/dsh-switch/interfaces',
    '/dsh-switch/report-test',
    '/dsh-switch/shortcut',
  ]) {
    assert.ok(registered.includes(path), `missing route ${path}: ${JSON.stringify(registered)}`)
  }
})

test('the inject callback returns nothing so its routes survive', () => {
  const host = {
    webServer: { register: () => () => {} },
    effect: (fn) => { fn(); return () => {} },
  }
  // Cordis treats a callback's return value as a disposer; returning anything
  // here removes every route right after it is registered.
  assert.equal(createMount({ handle: () => ({}) })(host), undefined)
})

test('the desktop shortcut points at the menu wrapper that waits for a key', () => {
  const spec = shortcutSpec('F:\\repo')
  assert.equal(spec.target, 'F:\\repo\\dsh-switch-menu.cmd')
  assert.equal(spec.dir, 'F:\\repo')
})

test('mountRoutes reports when the host has no web server', () => {
  assert.equal(mountRoutes({}, { handle: () => ({}) }), false)
})

test('the launcher spawner logs a spawn failure instead of losing it', () => {
  const child = new EventEmitter()
  child.pid = 7
  child.unref = () => {}
  const lines = []
  const spawnLauncher = createLauncherSpawner({
    spawnFn: () => child, nodeBinary: 'node', cwd: 'c', log: (line) => lines.push(line),
  })
  assert.equal(spawnLauncher('web'), 7)
  child.emit('error', new Error('ENOENT'))
  assert.match(lines[0], /ENOENT/)
})
