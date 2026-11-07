# 外壳切换：可配置的上报方式（设计稿）

日期：2026-11-07
状态：已批准（方案 A2）

## 意图

切换成功后，现在固定「复制到剪贴板 + 弹窗」。要做成三层可独立开关的上报，并且能在**插件页**里像内置「网页搜索」那样点进去填写：

1. 复制到剪贴板
2. 弹窗
3. 发送到网络（自填 API 地址 + 带占位符的 JSON 模板）

## 目标

- 三个通道各自可开关，互不影响。
- 配置在**插件页的行配置页**里编辑（入口与内置插件一致），值存在我们自己的 JSON 文件里。
- 关闭网络通道时，launcher 不发任何外部请求。
- 上报失败绝不阻断切换，也不谎报成功。

## 非目标

- 不做多套 webhook、不做鉴权头、不做重试队列。
- 不改动现有切换语义（端口、relay、进程清理）。
- 不把配置写进 Host 设置文档（见下方取舍）。

## 方案

**A2（选定）——借官方插件页入口，自管配置**：

- 浏览器半侧注册 `plugins.row.config`（键 `dsh-shell-switch#dsh-shell-switch`），插件页里那一行因此多出「配置」控件，点开是我们自己的表单。
- 表单通过宿主路由 `GET/POST /dsh-switch/report-config` 读写 `%USERPROFILE%\.dsh\launcher\report-config.json`（回环限制沿用现有两条路由）。
- launcher 与表单读同一个文件，**单一真源，无镜像**。

不做 A1 的原因（已实测）：A1 需要宿主导出 schemastery 的 `Config`，而第三方插件从仓库路径加载，`@deepseek-ai/schemastery` 只存在于 app.asar 内部的依赖树里，profile 也不为 `link:` 包安装依赖；宿主未开 `--preserve-symlinks`。要走 A1 只能 vendored 依赖或把它装进 profile 再动态 import，代价与收益不成比例。客户端 bundle 能 `require("react")` 是另一套机制（宿主注入的模块注册表），不适用于宿主侧 `Config`。

因为配置只有一份文件，**保存即生效**，launcher 下一次切换就能读到，无需重启。

## 配置模型

```json
{
  "report": { "clipboard": true, "dialog": true, "webhook": false },
  "webhook": {
    "url": "",
    "template": "{\"text\":\"DSH 外壳已切换到 {target}：{url}\"}"
  }
}
```

默认值：剪贴板开、弹窗开、网络关。

### 占位符

| 占位符 | 值 | 客户端切换时 |
|---|---|---|
| `{url}` | 带 token 的完整地址 | 空串 |
| `{token}` | 仅 token | 空串 |
| `{port}` | 端口 | 有 |
| `{target}` | `web` 或 `client` | 有 |
| `{time}` | ISO 时间戳 | 有 |

只替换上表；未知 `{...}` 原样保留；渲染后必须是合法 JSON，否则本次网络上报记为失败并写日志（不影响切换）。

## 界面

插件页 → `dsh-shell-switch` 行 → 「配置」→ 页面：

- 三个复选框：复制到剪贴板 / 弹窗 / 发送到网络
- 「API 地址」（`http(s)://`，网络通道关闭时禁用）
- 「JSON 模板」多行（同上）
- 占位符说明 + 一句安全提示（`{url}`/`{token}` 会把登录凭证交给该地址）
- 「保存」；校验失败时拒绝保存并显示原因
- 「发送测试」：用示例值渲染模板真实发一次，显示 HTTP 状态或错误

## 上报执行

新增 `src/report.mjs`，launcher 在切换成功后调用一次（两个方向）：

- `clipboard`：沿用现有 `cmd /c powershell` 的 `Set-Clipboard`
- `dialog`：现有 `showUrlDialog`
- `webhook`：`fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body, signal: AbortSignal.timeout(5000) })`

三通道各自 try/catch，失败只写日志；webhook 不重试。

## 安全

- 网络上报会把 token 交给第三方地址；默认关闭，地址为空不发，界面明确提示。
- 配置读写路由沿用回环限制（`127.0.0.1`/`::1` + host 头校验）。
- 模板明文存储，不引入密钥/凭据域。

## 风险与回退

- **风险**：`plugins.row.config` 槽位是否对第三方组合包开放需要实测（官方文档只给了组合包注册的示例，没写权限限制）。
- **探针**：第一个任务只做"注册 + 页面出现"的最小验证；不通就回退 B（在 ⇄ 弹层里加设置页），三通道、占位符、默认值、测试计划都不变。
- 配置读写复用现有两条回环路由的守卫，不新增攻击面。

## 测试

- `src/report-config.mjs`：默认值合并、文件缺失/损坏回退、原子写、URL 与模板校验。
- `src/report.mjs`：三开关各自调用/不调用；webhook 失败不影响其它通道；占位符替换与未知占位符保留；渲染后非 JSON 视为失败。
- `plugin/routes.mjs`：`GET/POST /dsh-switch/report-config` 与 `POST /dsh-switch/report-test`，非回环拒绝，非法配置 400。
- `plugin/client.js`：vm + 假 react 断言行配置页注册键、三个复选框、地址、模板、保存、测试按钮，以及"非法模板拒绝保存"。
