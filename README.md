# dsh-shell-switch

DSH 的 Windows 客户端和网页端，是运行在同一个服务上的两套不同的壳。本项目让你可以方便地在两者之间切换，并且**共享同一套 profile 与资源**——于是你可以随时在桌面上干完活、切到浏览器里继续（进而实现远程操控）。

仓库：<https://github.com/tanjingdong/dsh-shell-switch> · 仅支持 Windows · [The Unlicense](LICENSE)（公有领域）

## 它解决什么问题

DSH 的桌面客户端和 Web 版默认各用一套 profile，插件、设置、会话不共享；两者也不能同时稳定运行。手动切换要关进程、改目录、重启，还容易留下卡死的单实例窗口。

这个插件做了三件事：

1. 把 `%USERPROFILE%\.dsh\profiles\web` 变成指向 `profiles\desktop` 的**目录联接**，两个外壳从此读写同一份 profile；
2. 一个 launcher 负责"关旧壳 → 起新壳 → 确认真的起来了"，失败最多重试 3 次，并且**不会**在失败后自动拉起另一个外壳；
3. 一个侧栏按钮 + 配置页，把切换、上报方式、局域网发布都放进界面里。

## 环境要求

- Windows 10/11
- 已安装 DeepSeek Harness 桌面版（默认在 `%LOCALAPPDATA%\Programs\DeepSeek Harness`）
- 需要 `node`（PATH 里没有时会回退到 `%USERPROFILE%\.dsh\plugins\rea-bundle\vendor\node\node.exe`）

## 安装

**两个外壳都必须先关闭**（菜单第 4 项，或 `dsh-switch stop`）。

```powershell
# 1) 备份原 web 目录并建立联接；已有联接时是幂等的
node setup\cutover.mjs

# 2) 把插件装进 desktop profile，并用 --profile web --dump-config 验证
node setup\install.mjs
```

然后重启桌面客户端，侧栏底部会出现「⇄」按钮。

如果 `profiles\web` 还没有联接，**配置页顶部会直接提示并给出可复制的命令**；联接建立后这条提示自动消失。
插件不会自己去改 profile 布局——那是全局改动，只应该由你明确执行。

> 联接是**全局改动**：`profiles\web` 从此指向 `profiles\desktop`。想退回去见文末「回滚」。

## 使用

```powershell
dsh-switch              # 无参数：菜单
dsh-switch client       # 启动桌面客户端（确认 host 与监听端口都出现才算成功）
dsh-switch web          # 启动浏览器 Web（固定优先 3080，被占用才在 3081–3099 取空闲端口）
dsh-switch status       # 当前谁在跑（有地址时一并打印）
dsh-switch stop         # 停止当前外壳
dsh-switch stop --now   # 立即结束，不等待优雅退出
```

也可以双击桌面快捷方式（配置页里可以一键创建），跑完后窗口会等你按任意键再关闭。

## 配置

侧栏 → **插件** → `dsh-shell-switch` → **配置**。配置存在
`%USERPROFILE%\.dsh\launcher\report-config.json`，**保存即生效**。

### 切换成功后的上报（四个通道，各自独立开关）

| 通道 | 默认 | 说明 |
|---|---|---|
| 打开本地浏览器 | 开 | 打开带 token 的地址；关掉后启动器不再自己开浏览器 |
| 复制到剪贴板 | 开 | 把同一个地址放进剪贴板 |
| 弹窗 | 开 | 桌面弹窗显示地址 |
| 发送到网络 | 关 | 自填 API 地址 + JSON 模板，`POST`、5 秒超时、不重试 |

模板占位符：`{url}`（含 token 的完整地址）、`{token}`、`{port}`、`{target}`（`web` / `client`）、`{time}`（ISO）。未知的 `{...}` 原样保留，替换后必须仍是合法 JSON。

切到桌面客户端时没有浏览器地址，`{url}` 与 `{token}` 为空串。

企业微信机器人示例：

```json
{"msgtype":"text","text":{"content":"DSH 外壳已启动：{target}\n地址：{url}\n时间：{time}"}}
```

### 网络发布

- **本机网卡**：页面现场探测本机 IPv4 网卡，勾选即发布（relay 把网页端口转发到这些地址）；
- **手动添加地址**：给此刻没连上的网卡（VPN 断线等）预留；
- **只绑定回环**：勾上后不启动 relay，只有 `127.0.0.1` 能访问。

默认**不发布**任何网卡——网卡因机器而异，插件不预置任何地址。DSH 不允许监听 `0.0.0.0`，配置页也不接受。

## 日志与排查

全部在 `%USERPROFILE%\.dsh\launcher\logs\`：

| 文件 | 内容 |
|---|---|
| `<时间戳>.log` | launcher 每次运行的输出；失败时终端会打印本次路径 |
| `web-host-<端口>.log` | Web host 自己的 stdout/stderr（含 token 地址），每次启动覆盖 |
| `url-dialog.log` / `url-clipboard.log` | 弹窗与剪贴板那个 PowerShell 的输出 |

常见问题：

- **配置页 `读取配置失败（403）`**：你正通过局域网地址访问，而宿主是旧版本（旧代码只允许回环 `Host`）。重启外壳即可；新版允许回环与私网 IPv4，仍然拒绝公网域名（防 DNS rebinding）。
- **配置页 404**：宿主没加载到新路由，同样是旧进程——重启外壳。
- **切到已在运行的外壳"没反应"**：面板会明确提示「当前已经是 X，不需要切换」。
- **`client-not-ready`**：桌面客户端没在 20 秒内出现 host 与监听端口，多半是上一个实例没退干净；`dsh-switch stop --now` 后重试。
- **快捷方式双击后窗口一闪而过**：请用配置页创建的快捷方式（它指向 `dsh-switch-menu.cmd`），它会在结束时等你按键。

## 安全

- 带 token 的地址等同于本次登录凭证。**发送到网络**会把它交给对方，默认关闭；只填你信任的接口。
- 插件的 HTTP 路由只接受回环与私网 IPv4 的 `Host`，公网域名一律拒绝。
- `cutover` 改的是全局 profile 布局，会影响你其它 DSH 用法——务必读一遍上面的说明。

## 回滚

```powershell
node setup\cutover.mjs --revert "C:\Users\<你>\.dsh\profiles\web.bak-<时间戳>"
```

移除插件（两个外壳都关着）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
& $exe --expose-internals $cli plugin --profile desktop remove dsh-shell-switch
```

## 开发

```powershell
npm test        # 161 项单元测试，node --test
```

结构：`index.mjs`（插件宿主半侧：路由、上报接线）、`client.js`（浏览器半侧：侧栏面板 + 配置页）、
`src/`（launcher、relay、进程、配置、上报等纯 Node 模块）、`setup/`（环境切换与安装）、`tests/`。

## 许可证

[The Unlicense](LICENSE)——公有领域，作者谭靖东。可自由使用、修改、再发布，无需署名。
