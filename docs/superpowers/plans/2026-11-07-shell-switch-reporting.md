# 外壳切换可配置上报 Implementation Plan（A2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让切换成功后的上报（剪贴板 / 弹窗 / 网络）各自可开关，配置在插件页的行配置页里填写并保存到本地 JSON，launcher 切换时读取并分发。

**Architecture:** 浏览器半侧注册 `plugins.row.config`（键 `dsh-shell-switch#dsh-shell-switch`）得到插件页的「配置」入口；表单通过宿主的两条回环路由读写 `%USERPROFILE%\.dsh\launcher\report-config.json`。launcher 在切换成功后读同一个文件，按三个开关分发上报，任何通道失败都不影响切换结果。

**Tech Stack:** Node.js（ESM，无第三方依赖）、DSH 客户端插件 API（`ctx.slots`）、`node --test`。

**Spec:** `docs/superpowers/specs/2026-11-07-shell-switch-reporting-design.md`

## Global Constraints

- 仅 Windows；不新增任何 npm 依赖；宿主侧不 import `@deepseek-ai/*`。
- 配置命名空间不做：不声明 `Config`、不使用 `configForms`。
- 行 id 固定 `dsh-shell-switch`；注册键 `dsh-shell-switch#dsh-shell-switch`。
- 配置文件固定 `%USERPROFILE%\.dsh\launcher\report-config.json`。
- 默认值：`report.clipboard=true`、`report.dialog=true`、`report.webhook=false`、`webhook.url=""`、`webhook.template="{\"text\":\"DSH 外壳已切换到 {target}：{url}\""}`。
- 占位符只有 `{url}` `{token}` `{port}` `{target}` `{time}`；未知 `{...}` 原样保留。
- webhook：仅 POST，`content-type: application/json`，5 秒超时，不重试。
- 上报绝不阻断切换；失败只写 launcher 日志。
- 配置读写路由沿用现有回环守卫（`127.0.0.1`/`::1` + host 头校验）。
- 所有提示文案用中文。

## Review Focus

- 配置文件缺失/损坏（首次安装、手动删除）→ 用默认值继续，切换不受影响。
- webhook 不可达、超时或返回非 2xx → 切换照常成功，另外两个通道照常执行。
- 用户把模板改坏（多余逗号、缺引号）→ 保存时拒绝；若文件被手改坏，该次网络上报记失败，不发坏 JSON。
- 切换到客户端时没有 token：`{url}`、`{token}` 渲染成空串，不出现 `undefined`/`[object Object]`。
- 保存非法 URL 或非法模板 → 拒绝并提示，不允许写进文件。

---

### Task 1: 探针——行配置页能否挂上

**Files:**
- Modify: `plugin/client.js`
- Test: `tests/client.test.mjs`

**Interfaces:**
- Consumes: 现有 `slots.register`／`slots.inject`（client.js 已在用）。
- Produces: 注册 `{ name: 'plugins.row.config', key: 'dsh-shell-switch#dsh-shell-switch' }`，渲染函数在 `view === 'page'` 时返回占位内容、`view === 'summary'` 时返回摘要文本。

- [ ] **Step 1: 写失败的注册测试**

```js
test('the bundle registers a row config page for its own row', () => {
  const registrations = registerTree(loadBundle())   // 见 tests/client.test.mjs 的 vm 夹具
  const row = registrations.find((r) => r.name === 'plugins.row.config')
  assert.ok(row, 'must register into plugins.row.config')
  assert.equal(row.key, 'dsh-shell-switch#dsh-shell-switch')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/client.test.mjs`
Expected: FAIL — 未找到 `plugins.row.config`

- [ ] **Step 3: 实现探针注册**

`apply(ctx)` 里追加 `ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-shell-switch#dsh-shell-switch' }, ({ view }) => view === 'summary' ? '外壳切换' : h('div', null, '设置占位')))`；把 `inject` 保持 `["slots"]`，不新增依赖。

- [ ] **Step 4: 跑测试**

Run: `node --test tests/client.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plugin/client.js tests/client.test.mjs
git commit -m "probe: register a row config page for the bundle"
```

- [ ] **Step 6: 真机验收（用户确认后才能继续）**

重启客户端 → 侧栏 → 插件 → `dsh-shell-switch` 行 → 应出现「配置」，点开显示「设置占位」。
Expected: 控件与页面都出现。不出现就停下，回退 B（⇄ 弹层内设置页）。

---

### Task 2: 配置模型与文件读写

**Files:**
- Create: `src/report-config.mjs`
- Test: `tests/report-config.test.mjs`

**Interfaces:**
- Produces:
  - `DEFAULT_REPORT_CONFIG`
  - `reportConfigFile(paths) -> string`
  - `normalizeReportConfig(raw) -> config`（合并默认值、丢弃未知键）
  - `validateReportConfig(config) -> string[]`（空数组＝合法，每项是中文原因）
  - `readReportConfig(file) -> Promise<config>`（缺失/损坏回退默认）
  - `writeReportConfig(file, config) -> Promise<void>`（`.tmp` + rename）

- [ ] **Step 1: 写失败测试**

```js
test('a missing or corrupt config file falls back to the defaults', async () => {
  assert.deepEqual(await readReportConfig(join(root, 'nope.json')), DEFAULT_REPORT_CONFIG)
  await writeFile(join(root, 'bad.json'), '{oops')
  assert.deepEqual(await readReportConfig(join(root, 'bad.json')), DEFAULT_REPORT_CONFIG)
})

test('validation rejects a non-http url and a non-JSON template', () => {
  assert.deepEqual(validateReportConfig(DEFAULT_REPORT_CONFIG), [])
  assert.match(validateReportConfig({ ...DEFAULT_REPORT_CONFIG, webhook: { url: 'ftp://x', template: '{}' } }).join(), /http/)
  assert.match(validateReportConfig({ ...DEFAULT_REPORT_CONFIG, webhook: { url: '', template: '{oops' } }).join(), /JSON/)
})

test('the file is written atomically and round-trips', async () => {
  await writeReportConfig(file, { ...DEFAULT_REPORT_CONFIG, report: { clipboard: false, dialog: true, webhook: false } })
  assert.equal((await readReportConfig(file)).report.clipboard, false)
})
```

- [ ] **Step 2: 运行确认失败** → `Cannot find module`

- [ ] **Step 3: 实现**：`normalizeReportConfig` 逐字段默认值覆盖；`validateReportConfig` 检查 url 为空或 `^https?://`，模板 `JSON.parse` 试解析。

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: 提交**

```bash
git add src/report-config.mjs tests/report-config.test.mjs
git commit -m "feat: add the report config model and file"
```

---

### Task 3: 模板渲染、webhook 与三通道分发

**Files:**
- Modify: `src/web.mjs`（拆出 `copyToClipboard`，保留 `showUrlDialog` 只弹窗）
- Create: `src/report.mjs`
- Test: `tests/report.test.mjs`

**Interfaces:**
- Consumes: `normalizeReportConfig`（Task 2）。
- Produces:
  - `renderTemplate(template, values) -> string`
  - `buildWebhookBody(config, info) -> string`（渲染后必须合法 JSON，否则抛 `LauncherError('bad-template')`）
  - `sendWebhook({ url, body, fetchImpl, timeoutMs }) -> Promise<{ ok, status?, error? }>`
  - `reportSwitch({ config, info, copy, dialog, send, log }) -> Promise<{ clipboard, dialog, webhook }>`（`'sent'|'skipped'|'failed'`）

- [ ] **Step 1: 写失败测试**

```js
test('renderTemplate replaces only the known placeholders', () => {
  assert.equal(renderTemplate('{"u":"{url}","x":"{nope}"}', { url: 'http://h/?token=t' }),
    '{"u":"http://h/?token=t","x":"{nope}"}')
})

test('a client switch renders empty url and token, never undefined', () => {
  const body = buildWebhookBody(config, { target: 'client', port: 4162, time: 'T' })
  assert.ok(!body.includes('undefined'))
  assert.deepEqual(JSON.parse(body), { text: 'DSH 外壳已切换到 client：' })
})

test('each channel runs only when its switch is on', async () => {
  const calls = []
  await reportSwitch({ config: onlyClipboard, info, copy: async () => calls.push('copy'), dialog: async () => calls.push('dialog'), send: async () => calls.push('send') })
  assert.deepEqual(calls, ['copy'])
})

test('a failing channel does not stop the others', async () => {
  const calls = []
  const result = await reportSwitch({ config: allOn, info, copy: async () => { throw new Error('boom') }, dialog: async () => calls.push('dialog'), send: async () => calls.push('send') })
  assert.deepEqual(calls, ['dialog', 'send'])
  assert.equal(result.clipboard, 'failed')
})

test('a failing webhook reports failure without throwing', async () => {
  const result = await sendWebhook({ url: 'http://x', body: '{}', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(result.ok, false)
})
```

- [ ] **Step 2: 运行确认失败** → `reportSwitch is not a function`

- [ ] **Step 3: 实现**：`renderTemplate` 逐 key `replaceAll`；`sendWebhook` 捕获异常；`reportSwitch` 三通道各自 try/catch；`copyToClipboard` 复用现有 `cmd /c powershell -EncodedCommand` 路径，只保留 `Set-Clipboard`。

- [ ] **Step 4: 跑测试** → `node --test tests/report.test.mjs tests/web.test.mjs` PASS

- [ ] **Step 5: 提交**

```bash
git add src/web.mjs src/report.mjs tests
git commit -m "feat: render and dispatch the three report channels"
```

---

### Task 4: 宿主路由（读、写、测试发送）

**Files:**
- Modify: `plugin/routes.mjs`
- Test: `tests/routes.test.mjs`

**Interfaces:**
- Consumes: `readReportConfig`/`writeReportConfig`/`validateReportConfig`（Task 2）、`buildWebhookBody`/`sendWebhook`（Task 3）。
- Produces: `createHandoffRoutes({ ..., readConfig, writeConfig, now })` 支持：
  - `GET /dsh-switch/report-config` → `200 config`
  - `POST /dsh-switch/report-config` → 合法则 `200 config`，非法 `400 {errors}`
  - `POST /dsh-switch/report-test` → `200 {ok,status}` / `502 {ok:false,error}`

- [ ] **Step 1: 写失败测试**

```js
test('the config route saves a valid config and refuses an invalid one', async () => {
  let saved = null
  const routes = createHandoffRoutes({ readConfig: async () => DEFAULT_REPORT_CONFIG, writeConfig: async (c) => { saved = c }, now: () => 1, random: () => 'n', spawnLauncher: () => 1, readActivity: () => ({ agents: 0, jobs: 0 }) })
  assert.equal(routes.handle('GET', '/dsh-switch/report-config', headers, loop).status, 200)
  assert.equal(routes.handle('POST', '/dsh-switch/report-config', headers, loop, JSON.stringify(DEFAULT_REPORT_CONFIG)).status, 200)
  assert.ok(saved)
  const bad = routes.handle('POST', '/dsh-switch/report-config', headers, loop, JSON.stringify({ webhook: { url: 'ftp://x', template: '{oops' } }))
  assert.equal(bad.status, 400)
})

test('the test route reports the webhook status', async () => {
  const routes = createHandoffRoutes({ sendTest: async () => ({ ok: true, status: 204 }), ...base })
  const res = routes.handle('POST', '/dsh-switch/report-test', headers, loop, '{}')
  assert.equal(res.status, 200)
  assert.match(res.body, /204/)
})
```

- [ ] **Step 2: 运行确认失败** → 404 / 无 readConfig

- [ ] **Step 3: 实现**：路由内沿用 `isLoopbackAddress` + host 头校验；写之前 `normalize` + `validate`；测试发送把示例值（`target:'web'`,`port:3080`,`url` 用示例地址）交给 `sendTest`。

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: 提交**

```bash
git add plugin/routes.mjs tests/routes.test.mjs
git commit -m "feat: read and write report settings over loopback routes"
```

---

### Task 5: launcher 切换成功后上报

**Files:**
- Modify: `src/cli.mjs`
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Consumes: `readReportConfig`（Task 2）、`reportSwitch`（Task 3）。
- Produces: `runReport({ paths, info, deps }) -> Promise<{clipboard,dialog,webhook}>`；`run()` 在 `switchWithConsent` 成功返回后调用一次。

- [ ] **Step 1: 写失败测试**

```js
test('a successful switch reports once with the resolved config', async () => {
  const seen = []
  await runReport({ paths: fakePaths, info: { target: 'web', port: 3080, url: 'http://h/?token=t' }, deps: { read: async () => DEFAULT_REPORT_CONFIG, report: async (args) => seen.push(args) } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].info.url, 'http://h/?token=t')
})
```

- [ ] **Step 2: 运行确认失败** → `runReport` 不存在

- [ ] **Step 3: 实现**：`run()` 在 `switchWithConsent` 返回 `{switched:true,...}` 后调用 `runReport`；`info` 取 `{ target: resolved, port, url }`（client 无 url）。

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli.mjs tests/cli.test.mjs
git commit -m "feat: report after a successful switch"
```

---

### Task 6: 插件页表单

**Files:**
- Modify: `plugin/client.js`
- Test: `tests/client.test.mjs`

**Interfaces:**
- Consumes: Task 1 的注册结构、Task 4 的路由。
- Produces: `ConfigForm` 组件：三个复选框、API 地址、JSON 模板、保存、发送测试；用 `fetch('/dsh-switch/report-config')` 读写。

- [ ] **Step 1: 写失败测试**

```js
test('the page renders the three channels and the webhook fields', () => {
  const texts = textsOf(renderPage(loadBundle(), DEFAULT_REPORT_CONFIG))
  for (const t of ['复制到剪贴板', '弹窗', '发送到网络', 'API 地址', 'JSON 模板', '保存', '发送测试']) assert.ok(texts.includes(t), t)
})

test('saving an invalid template is refused before any request', async () => {
  const calls = []
  const page = mountPage(loadBundle(), { fetchImpl: async (url, init) => { calls.push([url, init]); return { ok: true, json: async () => ({}) } } })
  page.setTemplate('{oops')
  await page.save()
  assert.deepEqual(calls, [])
  assert.match(page.notice(), /JSON/)
})
```

- [ ] **Step 2: 运行确认失败** → 缺标签

- [ ] **Step 3: 实现**：页面加载时 `GET` 配置填表；保存前本地校验（URL 前缀、`JSON.parse`），通过后 `POST`；测试发送 `POST /dsh-switch/report-test` 并显示状态。

- [ ] **Step 4: 跑测试** → PASS

- [ ] **Step 5: 提交**

```bash
git add plugin/client.js tests/client.test.mjs
git commit -m "feat: edit report settings on the plugin page"
```

---

### Task 7: 真机验收

- [ ] **Step 1: 重启客户端**，插件页 → 行 → 「配置」
- [ ] **Step 2: 默认值**：剪贴板开、弹窗开、网络关
- [ ] **Step 3: 关掉弹窗**后切换一次 → 不弹窗，剪贴板仍更新
- [ ] **Step 4: 填本地 echo 地址**（例如 `node -e` 起一个收 POST 的 server）→ 「发送测试」拿到 2xx
- [ ] **Step 5: 模板改成 `{oops`** → 保存被拒绝并提示
- [ ] **Step 6: 切换一次** → 日志里出现上报结果，webhook 收到 POST
