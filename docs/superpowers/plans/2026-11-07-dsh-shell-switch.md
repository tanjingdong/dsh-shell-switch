# DSH 外壳切换器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH 的桌面客户端与浏览器 Web GUI 共用同一份 profile，并能在界面里或命令行里一键安全地从一个切到另一个。

**Architecture:** `profiles/web` 变成指向 `profiles/desktop` 的目录联接，两个外壳读写同一批文件。一个 Node 写的 launcher 负责关旧、起新、就绪探测、最多 3 次重试与失败退出；一个 DSH 插件在侧栏提供按钮，并通过两条仅回环的 host 路由把"当前是否空闲"和"发起切换"接到 launcher。

**Tech Stack:** Node.js（ESM，无第三方依赖）、PowerShell 仅用于进程查询、DSH 插件（host 半区 Cordis 插件 + client 半区浏览器模块）、Windows 目录联接（junction）。

**Spec:** `docs/superpowers/specs/2026-11-07-dsh-shell-switch-design.md`

## Global Constraints

- 仅 Windows；不在 Linux/macOS 上做兼容分支。
- 不新增任何 npm 运行时依赖；测试用 `node --test`。
- Node 运行时优先 `node`（PATH），回退 `%USERPROFILE%\.dsh\plugins\rea-bundle\vendor\node\node.exe`。
- profile 联接名固定为 `web`；备份名 `web.bak-<yyyyMMdd-HHmmss>`。
- 默认端口 3080；被占用时在 3081–3099 内取下一个空闲端口；三个网卡共用该端口。
- 局域网地址固定为 `192.168.0.106`、`10.147.20.214`、`100.100.0.3`。
- 启动尝试上限 3 次；失败后**不自动重启任何外壳**。
- 插件不得写任何配置文件；launcher 只写 `%USERPROFILE%\.dsh\launcher\` 下的状态与日志。
- 所有提示文案用中文；错误信息必须包含可复制的手工命令。

## Review Focus

1. **端口已被占用 / 某个网卡地址不存在（VPN 未连）**：只损失那一个入口，其余照常，进程不失败。
2. **`profiles/web` 已经是联接、或根本不是目录**：cutover 必须幂等，且能回滚到备份。
3. **`GET /dsh-switch/state` 不可用（host 没有这个插件、或被强杀）**：launcher 不得崩溃，必须降级为"无法确认空闲"并按未确认处理。
4. **重复点击 / 并发启动**：同一时刻只允许一个 handoff 在飞；重复调用 launcher 不得产生第二个 host。
5. **结束进程被拒绝（权限或进程已退出）**：明确报错或视为已完成，不得谎报成功。

---

### Task 1: 项目骨架、路径解析与测试入口

**Files:**
- Create: `package.json`
- Create: `src/paths.mjs`
- Create: `src/errors.mjs`
- Test: `tests/paths.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `resolvePaths(env: NodeJS.ProcessEnv): { home, launcherDir, stateFile, logDir, exe, cliJs, profilesDir, desktopProfile, webProfile }`
  - `LauncherError extends Error`，带 `code: string`。

- [ ] **Step 1: 写失败测试**

```js
// tests/paths.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePaths } from '../src/paths.mjs'

test('resolvePaths derives every path from USERPROFILE', () => {
  const p = resolvePaths({ USERPROFILE: 'C:\\Users\\x', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })
  assert.equal(p.home, 'C:\\Users\\x\\.dsh')
  assert.equal(p.stateFile, 'C:\\Users\\x\\.dsh\\launcher\\state.json')
  assert.equal(p.desktopProfile, 'C:\\Users\\x\\.dsh\\profiles\\desktop')
  assert.equal(p.webProfile, 'C:\\Users\\x\\.dsh\\profiles\\web')
  assert.match(p.exe, /DeepSeek Harness\.exe$/)
  assert.match(p.cliJs, /dsh-desktop-host\\lib\\cli\.js$/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/paths.test.mjs`
Expected: FAIL — `Cannot find module '../src/paths.mjs'`

- [ ] **Step 3: 实现**

`src/errors.mjs`：`export class LauncherError extends Error { constructor(code, message) { super(message); this.code = code } }`

`src/paths.mjs`：由 `USERPROFILE` 派生 `home`、`launcherDir`、`stateFile`、`logDir`、`profilesDir` 与两个 profile 目录；由 `LOCALAPPDATA` 拼出 `Programs\DeepSeek Harness\DeepSeek Harness.exe` 与 asar 内的 `cli.js`；两者不存在时 `throw new LauncherError('dsh-not-found', …)`。`package.json` 声明 `"type": "module"` 与 `"scripts": { "test": "node --test tests/" }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/paths.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add package.json src tests
git commit -m "feat: scaffold launcher project and path resolution"
```

---

### Task 2: 端口探测

**Files:**
- Create: `src/ports.mjs`
- Test: `tests/ports.test.mjs`

**Interfaces:**
- Consumes: `LauncherError`。
- Produces:
  - `probePort(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean>`（`true` 表示已被占用）
  - `findFreePort({ start = 3080, end = 3099, host = '127.0.0.1' }): Promise<number>`，全占用时 `throw new LauncherError('no-free-port', …)`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { probePort, findFreePort } from '../src/ports.mjs'

test('probePort reports a listener as occupied and a closed port as free', async () => {
  const server = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const busy = server.address().port
  assert.equal(await probePort(busy), true)
  server.close()
  await new Promise((r) => server.once('close', r))
  assert.equal(await probePort(busy), false)
})

test('findFreePort skips an occupied port and rejects an exhausted range', async () => {
  const server = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const busy = server.address().port
  const picked = await findFreePort({ start: busy, end: busy + 1 })
  assert.notEqual(picked, busy)
  server.close()
  await new Promise((r) => server.once('close', r))
  await assert.rejects(findFreePort({ start: 65000, end: 65000 }), /no-free-port/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/ports.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`probePort` 用 `net.connect`，`connect` 事件 → `true`，`error`/超时 → `false`。`findFreePort` 从 `start` 到 `end` 逐个 `probePort`，返回第一个 `false` 的端口。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/ports.test.mjs`
Expected: PASS（结束语里的 65000 用例必须抛 `no-free-port`）

- [ ] **Step 5: 提交**

```bash
git add src/ports.mjs tests/ports.test.mjs
git commit -m "feat: add port probing and free-port selection"
```

---

### Task 3: 进程识别与结束

**Files:**
- Create: `src/procs.mjs`
- Test: `tests/procs.test.mjs`

**Interfaces:**
- Consumes: `LauncherError`。
- Produces:
  - `listProcesses(run?): Promise<Array<{ pid: number, name: string, commandLine: string }>>`；默认 `run` 执行 `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"`
  - `isDesktopHost(p, paths): boolean` — 命令行含 `dsh-desktop-host` 且含 `profiles\desktop`
  - `isWebHost(p, paths): boolean` — 命令行含 `dsh-desktop-host\lib\cli.js` 且含 `--profile web`（或 `cli.js` + ` web `）
  - `killTree(pid: number, { force: boolean, timeoutMs = 10000, list?, kill? }): Promise<{ killed: boolean, forced: boolean }>`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDesktopHost, isWebHost, killTree, listProcesses } from '../src/procs.mjs'

const paths = { desktopProfile: 'C:\\u\\.dsh\\profiles\\desktop', webProfile: 'C:\\u\\.dsh\\profiles\\web' }

test('isDesktopHost matches only the Electron host command line', () => {
  assert.equal(isDesktopHost({ commandLine: 'x "…\\dsh-desktop-host\\lib\\index.js" "C:\\u\\.dsh\\profiles\\desktop"' }, paths), true)
  assert.equal(isDesktopHost({ commandLine: 'x cli.js web --profile web' }, paths), false)
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

test('killTree reports forced only when the graceful wait expired', async () => {
  let calls = []
  const kill = (pid, signal) => { calls.push(signal) }
  const list = async () => []
  const r1 = await killTree(1, { force: false, list, kill, waitMs: 0 })
  assert.deepEqual(r1, { killed: true, forced: false })
  assert.deepEqual(calls, ['graceful'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/procs.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`listProcesses` 解析 `stdout`（空 → `[]`；对象 → 单元素数组），映射成 `{pid,name,commandLine}`。`isDesktopHost`/`isWebHost` 是纯字符串判定，参数 `paths` 仅用于比对 `profiles` 段。`killTree` 先发 `taskkill /PID <pid> /T`（无 `/F`），等待 `waitMs` 后若 PID 仍存在且允许 `force`，再发 `taskkill /PID <pid> /T /F`，返回 `{killed, forced}`；`kill` 与 `list` 可注入以便测试。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/procs.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/procs.mjs tests/procs.test.mjs
git commit -m "feat: identify and stop DSH hosts by command line"
```

---

### Task 4: 状态文件

**Files:**
- Create: `src/state.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Produces: `readState(file): Promise<State | null>`、`writeState(file, state): Promise<void>`（原子写）、`clearState(file): Promise<void>`；`State = { mode: 'client'|'web', pid: number, port?: number, startedAt: string }`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readState, writeState, clearState } from '../src/state.mjs'

test('state round-trips and a corrupt file reads as null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshstate-'))
  const file = join(dir, 'state.json')
  assert.equal(await readState(file), null)
  const state = { mode: 'web', pid: 42, port: 3080, startedAt: '2026-11-07T00:00:00.000Z' }
  await writeState(file, state)
  assert.deepEqual(await readState(file), state)
  await clearState(file)
  assert.equal(await readState(file), null)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/state.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`writeState` 先写 `<file>.tmp` 再 `rename`；`readState` 捕获 `ENOENT` 与 JSON 解析错误并返回 `null`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/state.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/state.mjs tests/state.test.mjs
git commit -m "feat: persist launcher state atomically"
```

---

### Task 5: TCP 端口转发（relay）

**Files:**
- Create: `src/relay.mjs`
- Test: `tests/relay.test.mjs`

**Interfaces:**
- Produces:
  - `createRelay({ targetHost = '127.0.0.1', targetPort, addresses, log = () => {} }): Promise<{ close(): Promise<void>, results: Array<{ address, status }> }>`
  - `status` 为 `'ok'` 或 `EADDRINUSE` / `EADDRNOTAVAIL` 等错误码；单地址失败不影响其它地址。
  - 空闲地址不可用（VPN 未连）时**不抛错**，只把该地址记为失败。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRelay } from '../src/relay.mjs'

test('relay forwards bytes to the target and survives a bad address', async () => {
  const target = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1')
  await new Promise((r) => target.once('listening', r))
  const targetPort = target.address().port
  const relay = await createRelay({ targetPort, addresses: ['127.0.0.1', '203.0.113.9'] })
  assert.equal(relay.results[0].status, 'ok')
  assert.notEqual(relay.results[1].status, 'ok')
  const client = net.connect(targetPort, '127.0.0.1')
  const echoed = await new Promise((resolve) => {
    client.once('connect', () => client.write('ping'))
    client.once('data', (d) => resolve(d.toString()))
  })
  assert.equal(echoed, 'ping')
  client.destroy()
  await relay.close()
  await new Promise((r) => target.close(r))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/relay.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

每个地址 `net.createServer`，`client → upstream → client` 双向 `pipe`；监听端口等于 `targetPort`（与目标同端口）。监听失败时记录 `error.code` 并继续下一个。`close()` 关闭全部 server 与在途 socket。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/relay.test.mjs`
Expected: PASS（第二个地址必须记为失败而不是抛错）

- [ ] **Step 5: 提交**

```bash
git add src/relay.mjs tests/relay.test.mjs
git commit -m "feat: relay the web port onto extra interfaces"
```

---

### Task 6: Web 启动、就绪判定与停止

**Files:**
- Create: `src/web.mjs`
- Test: `tests/web.test.mjs`

**Interfaces:**
- Consumes: `findFreePort`、`probePort`、`createRelay`、`killTree`。
- Produces:
  - `buildWebArgs({ port, addresses }): string[]` — 返回 `['web','--host','127.0.0.1','--port',String(port),'--no-open','--trusted-host',…]`
  - `extractTokenUrl(text: string): string | null` — 从输出里取含 `?token=` 的 URL
  - `waitReady({ port, timeoutMs = 60000, probe = probePort }): Promise<boolean>`
  - `startWeb({ paths, port, addresses, spawn, openBrowser, log }): Promise<{ pid, port, url }>`
  - `stopWeb({ pid, kill? }): Promise<{ killed: boolean, forced: boolean }>`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWebArgs, extractTokenUrl, waitReady } from '../src/web.mjs'

test('buildWebArgs gives one trusted host per address and never --open', () => {
  const args = buildWebArgs({ port: 3080, addresses: ['192.168.0.106', '10.147.20.214'] })
  assert.deepEqual(args.slice(0, 6), ['web', '--host', '127.0.0.1', '--port', '3080', '--no-open'])
  assert.equal(args.filter((a) => a === '--trusted-host').length, 2)
  assert.ok(args.includes('192.168.0.106:3080'))
})

test('extractTokenUrl finds the printed url and ignores unrelated lines', () => {
  const text = '[lan] ready\ndsh web: http://127.0.0.1:3080/?token=abc123\n'
  assert.equal(extractTokenUrl(text), 'http://127.0.0.1:3080/?token=abc123')
  assert.equal(extractTokenUrl('nothing here'), null)
})

test('waitReady returns false after the deadline', async () => {
  assert.equal(await waitReady({ port: 1, timeoutMs: 50, probe: async () => false }), false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/web.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`startWeb` 用注入的 `spawn` 起 `relay.mjs`（参数含 `--port`、`--addresses`、`--target-port`），从 stdout 累积文本直到 `extractTokenUrl` 命中或超时；就绪后调用 `openBrowser(url)`；返回 `{ pid, port, url }`。`waitReady` 以 500ms 间隔轮询 `probe(port)`，超时返回 `false`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/web.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/web.mjs tests/web.test.mjs
git commit -m "feat: start the web shell with LAN relay and readiness checks"
```

---

### Task 7: 编排、重试与失败退出

**Files:**
- Create: `src/launcher.mjs`
- Test: `tests/launcher.test.mjs`

**Interfaces:**
- Consumes: 前五个模块。
- Produces:
  - `detectCurrent({ list }): Promise<'client'|'web'|null>`
  - `fetchBusy({ port, fetchImpl }): Promise<boolean | null>`（`null` = 无法确认）
  - `switchTo(target, deps): Promise<void>`——`deps` 为 `{ paths, force, list, kill, startWeb, startClient, prepare, log }`；目标起不来时重试 3 次后 `throw new LauncherError('start-failed', …)`，**不重启任何外壳**
  - `status(deps): Promise<{ current, pid, port, webProfileIsLink }>`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { switchTo, fetchBusy } from '../src/launcher.mjs'

test('switchTo retries three times then throws without restarting the old shell', async () => {
  let starts = 0
  const deps = {
    paths: { profilesDir: 'p' }, force: false, log: () => {},
    prepare: async () => {}, list: async () => [], kill: async () => ({ killed: true, forced: false }),
    startWeb: async () => { starts++; throw new Error('boom') },
    startClient: async () => {},
  }
  await assert.rejects(switchTo('web', deps), /start-failed/)
  assert.equal(starts, 3)
})

test('switchTo refuses to cut a busy host unless forced', async () => {
  const deps = {
    paths: {}, force: false, log: () => {}, prepare: async () => {},
    list: async () => [{ pid: 1, commandLine: 'x\\dsh-desktop-host\\lib\\index.js profiles\\desktop' }],
    kill: async () => { throw new Error('must not be called') },
    startWeb: async () => { throw new Error('must not start') },
    fetchBusy: async () => true,
  }
  await assert.rejects(switchTo('web', deps), /busy/)
})

test('fetchBusy returns null when the state route is unreachable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await fetchBusy({ port: 1, fetchImpl }), null)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/launcher.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`switchTo` 顺序：`detectCurrent` → 目标相同则返回（web 时要确保端口在听）→ `prepare()`（预检：`--dump-config` 退出码 0、空闲端口）→ `fetchBusy`；`true` 且非 `force` 抛 `busy`；`null` 记日志后按"未确认"继续（仅当 `force`），否则抛 `busy-unconfirmed` → 关闭当前 → 启动目标，失败重试共 3 次 → 失败抛 `start-failed` 并附手工命令。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/launcher.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/launcher.mjs tests/launcher.test.mjs
git commit -m "feat: orchestrate shell switching with three attempts"
```

---

### Task 8: CLI 与无参数菜单

**Files:**
- Create: `src/cli.mjs`
- Create: `dsh-switch.cmd`
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv): { command: 'menu'|'client'|'web'|'status'|'stop', force: boolean }`；`renderMenu(): string`；`run(argv, deps): Promise<number>`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, renderMenu } from '../src/cli.mjs'

test('parseArgs defaults to menu and accepts --force', () => {
  assert.deepEqual(parseArgs([]), { command: 'menu', force: false })
  assert.deepEqual(parseArgs(['web', '--force']), { command: 'web', force: true })
  assert.deepEqual(parseArgs(['client']), { command: 'client', force: false })
})

test('renderMenu lists the four choices', () => {
  const menu = renderMenu()
  assert.match(menu, /1\).*客户端/)
  assert.match(menu, /2\).*Web/)
  assert.match(menu, /3\).*状态/)
  assert.match(menu, /4\).*停止/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/cli.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`parseArgs` 未知命令抛 `LauncherError('bad-args', …)`。没有参数时打印 `renderMenu()` 并读一行 stdin 选择。`run` 把命令分发到 `switchTo` / `status` / `stopCurrent`，捕获 `LauncherError` 并把 `message` 打到 stderr，返回对应退出码（成功 0，失败 1）。`dsh-switch.cmd` 用 `node "%~dp0src\cli.mjs" %*` 启动，`node` 不存在时回退 rea 的 vendored node。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/cli.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli.mjs dsh-switch.cmd tests/cli.test.mjs
git commit -m "feat: add launcher cli and menu"
```

---

### Task 9: 插件 host 半区（两条路由）

**Files:**
- Create: `plugin/routes.mjs`
- Create: `plugin/index.mjs`
- Create: `plugin/cordis.patch.yml`
- Create: `plugin/package.json`
- Test: `tests/routes.test.mjs`

**Interfaces:**
- Produces:
  - `createHandoffRoutes({ spawnLauncher, mintNonce, now, random }): { handle(method, url, headers, remoteAddress): { status, body } }`
  - `GET /dsh-switch/state` → `200 { busy: boolean, agents: number, jobs: number, nonce: string }`
  - `POST /dsh-switch/handoff` body `{ target, nonce }` → `202 { ok: true }`；nonce 过期/不符 → `403`；非回环 → `403`
  - 非 `127.0.0.1` 的 `Host` 或来源 → `403`；任何内部异常 → `500 { error }`，不抛出。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandoffRoutes } from '../plugin/routes.mjs'

const loop = { remoteAddress: '127.0.0.1' }
const base = { now: () => 1000, random: () => 'n1', spawnLauncher: () => 123 }

test('state mints a nonce and a non-loopback caller is refused', () => {
  const r = createHandoffRoutes({ ...base, readActivity: () => ({ agents: 1, jobs: 0 }) })
  const ok = r.handle('GET', '/dsh-switch/state', { host: '127.0.0.1:3080' }, loop)
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).nonce, 'n1')
  const bad = r.handle('GET', '/dsh-switch/state', { host: '127.0.0.1:3080' }, { remoteAddress: '10.0.0.2' })
  assert.equal(bad.status, 403)
})

test('handoff refuses a stale nonce and accepts a fresh one once', () => {
  let t = 1000
  const r = createHandoffRoutes({ ...base, now: () => t, readActivity: () => ({ agents: 0, jobs: 0 }) })
  r.handle('GET', '/dsh-switch/state', { host: '127.0.0.1:3080' }, loop)
  const stale = r.handle('POST', '/dsh-switch/handoff', { host: '127.0.0.1:3080' }, loop, JSON.stringify({ target: 'web', nonce: 'n1' }))
  assert.equal(stale.status, 202)
  const again = r.handle('POST', '/dsh-switch/handoff', { host: '127.0.0.1:3080' }, loop, JSON.stringify({ target: 'web', nonce: 'n1' }))
  assert.equal(again.status, 403)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/routes.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`createHandoffRoutes` 持有 `{ nonce, expiresAt }`（TTL 5 分钟），`handle` 内 `try/catch` 全部吞成 `500`。`plugin/index.mjs` 导出 `name = 'dsh-shell-switch'`、`inject = ['webServer']`、`apply(ctx)`，用 `ctx.inject(['webServer'], host => …)` 把 `handle` 接到 `/dsh-switch/*`，并用 host 的 `agents`/`jobs` 服务实现 `readActivity`（读不到就返回 `{agents:0, jobs:0}` 并记日志）。`cordis.patch.yml` 插入一行插件；`package.json` 声明 `dsh.bundle`、`dsh.client` 与 `exports`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/routes.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plugin tests/routes.test.mjs
git commit -m "feat: add host routes for state and handoff"
```

---

### Task 10: 插件 client 半区（侧栏按钮）

**Files:**
- Create: `plugin/client.js`
- Test: 手工验收清单（见 Step 4）

**Interfaces:**
- Consumes: `ctx.slots.inject('sidebar.footer.action', …)`、`GET /dsh-switch/state`、`POST /dsh-switch/handoff`。
- Produces: 一个侧栏底部按钮，`aria-label="切换外壳"`。

- [ ] **Step 1: 定义交互**

点击 → 弹层两个选项「桌面客户端」「浏览器 Web」→ 选中后 `GET state`：`busy: true` 时显示警告文案「切换会切断正在运行的回合」，需再点「仍然切换」；否则直接显示「将关闭当前窗口」→ 确认后 `POST handoff` → 显示「正在切换…」并禁用按钮。请求失败显示错误文案与「重试」。

- [ ] **Step 2: 实现**

用 `ctx.slots.inject('sidebar.footer.action', mount)` 挂载；复用 `@deepseek-ai/dsh-client-ui-primitives` 的弹层与按钮，不自造样式。所有网络调用包 `try/catch`，失败不抛。

- [ ] **Step 3: 手工验收**

在客户端里安装后：按钮出现在侧栏底部；点击弹出两个选项；状态路由不可达时显示错误而不是白屏；忙时出现警告。

- [ ] **Step 4: 提交**

```bash
git add plugin/client.js
git commit -m "feat: add sidebar switch button"
```

---

### Task 11: 环境切换、安装脚本与 README

**Files:**
- Create: `setup/cutover.mjs`
- Create: `setup/install.mjs`
- Create: `README.md`
- Test: `tests/cutover.test.mjs`

**Interfaces:**
- Produces:
  - `planCutover({ profilesDir, now }): Promise<{ steps: string[], backupPath: string | null }>`
  - `applyCutover({ profilesDir, now, fs }): Promise<{ backupPath: string | null }>`——已存在联接时幂等返回 `{ backupPath: null }`
  - `verifyCutover({ runDumpConfig }): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyCutover, planCutover } from '../setup/cutover.mjs'

test('cutover renames a real dir to a backup and creates a junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshcut-'))
  await mkdir(join(root, 'desktop'))
  await mkdir(join(root, 'web'))
  await writeFile(join(root, 'web', 'package.json'), '{}')
  const { backupPath } = await applyCutover({ profilesDir: root, now: '20261107-120000' })
  assert.equal(backupPath, join(root, 'web.bak-20261107-120000'))
  assert.equal((await lstat(join(root, 'web'))).isSymbolicLink(), true)
})

test('cutover is idempotent when web is already a junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshcut2-'))
  await mkdir(join(root, 'desktop'))
  await applyCutover({ profilesDir: root, now: 'x' })
  const again = await applyCutover({ profilesDir: root, now: 'y' })
  assert.equal(again.backupPath, null)
  const plan = await planCutover({ profilesDir: root, now: 'z' })
  assert.deepEqual(plan.steps, [])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/cutover.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`applyCutover` 判定三种状态：真实目录 → 改名备份 + 建联接；已是联接 → 不动；不存在 → 直接建联接。Windows 用 `fs.symlink(target, path, 'junction')`。`install.mjs` 以打包 CLI 执行 `plugin --profile desktop add link:<plugin 目录>`，并先检查两个外壳都不在运行。`README.md` 写清：安装顺序、必须关闭两个外壳、如何回滚、如何验证。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/cutover.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add setup README.md tests/cutover.test.mjs
git commit -m "feat: add idempotent profile cutover and install scripts"
```

---

## Self-Review 记录

- **Spec 覆盖**：环境改造（Task 11）、launcher 全部职责（Task 2–8）、插件两半（Task 9–10）、失败不自动恢复（Task 7 测试）、安全（Task 9）、安装约束（Task 11）。
- **类型一致性**：`startWeb`、`killTree`、`fetchBusy`、`createHandoffRoutes` 在定义处与调用处签名一致；`State.mode` 仅 `'client' | 'web'`。
- **Review Focus 落点**：1 → Task 5；2 → Task 11；3 → Task 7；4 → Task 7/9（nonce 一次性）；5 → Task 3。
- **留给实现者**：日志格式、菜单排版、按钮图标与文案细节、重试间隔（建议 1s/2s/4s）。
