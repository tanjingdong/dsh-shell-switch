# DSH 外壳切换器（dsh-shell-switch）设计

日期：2026-11-07
状态：待批准

## 一、意图与为什么

一个人在一台 Windows 机器上使用 DSH 的两个外壳：Electron 桌面客户端，和浏览器里的 Web GUI。
两者本该共用同一份状态——插件、设置、会话——并且能随手从一边切到另一边。

现实是它们天然分叉：`desktop` profile 被 Electron 应用独占，CLI 拒绝加载；`web` 是另一份目录，
插件要在两边各装一次。用户上一轮试过"抄配置"，结论是那只是两份长得一样、实际各自独立的安装。

本设计要消除这个分叉，并给一个"点一下就切过去"的入口。

## 二、目标

1. **单一真实 profile**：`profiles/desktop` 是唯一实体；`profiles/web` 变成指向它的目录联接。
   插件、设置、模型、会话因此天然同一，不需要任何同步逻辑。
2. **一次只允许一个 host 存活**——这是硬不变量，不是优化项。
3. **界面内一键切换**：在 DSH 里点一个按钮，选择去 Client 还是 Web，确认后自动完成关闭与启动。
4. **切换失败不会把人卡住**：三次启动失败后停止尝试目标，**不自动拉起任何外壳**；
   launcher 无参数启动时给出交互菜单，用户可以一键改选另一侧——出路是"再点一次"，
   而不是一条可能同样失败、甚至自我循环的自动恢复路径。

## 三、非目标

- 不做公网隧道/中继；**局域网访问保留**（沿用现有三个地址与端口转发方式）。
- 不做会话热迁移：切换后落在会话列表，不自动重新打开刚才那条会话。
- 不双向同步任何东西（因为只有一个目录，没有可同步的第二份）。
- 不修改 DSH 程序本体：不动 `app.asar`、不改任何 profile 以外的程序文件。

## 四、反目标（即使"能跑"也算失败）

- 两个 host 同时打开同一 profile。
- 切换后两个外壳都起不来，且没有任何显而易见的手工出路。
- 启动器为了"自愈"而去拉起一个同样可能失败的外壳，形成重试循环。
- 未经提醒就切断正在跑的回合（可以切断，但必须先提示并二次确认）。

## 五、已验证的平台事实

| 事实 | 证据 |
|---|---|
| `profile "desktop" is managed exclusively by the Electron application` | `--profile desktop --dump-config` 退出码 1，原话 |
| 该检查是**按名字**的，不是按真实路径 | 建 junction `profiles\_probe_link` → `desktop` 后 `--profile _probe_link --dump-config` 退出码 0，1477 行，含 `superpowers-dsh`、`dsh-grill-me` |
| `--profile` 只接受裸名字 | 传绝对路径报 `dsh: invalid profile name` |
| 没有 `DSH_WEB_PATH`；只有 `DSH_HOME` | 对 `app.asar` 做字符串检索 |
| `dsh web` 默认自己打开浏览器 | `web --help`：`--no-open  do not open the Web UI in the default browser` |
| CLI stdout 可捕获 | 正确加引号后 `--help`/`--dump-config` 输出完整 |
| 会话与 workspace 存储是全局的 | `~/.dsh/sessions/`、`~/.dsh/storages/workspace.json` |
| 桌面客户端 host 进程特征 | 命令行含 `dsh-desktop-host`，profile 指向 `profiles\desktop` |
| 桌面 host 的端口是**临时端口** | 以 `--port 0` 启动；6990 只是本次 OS 分配，不可硬编码 |
| 桌面页面是 `dsh-app://app` | 相对 fetch 由协议处理器转发给 host 并注入凭据；它剥掉 Origin/Host/Sec-Fetch-Site |
| 桌面应用是单实例 | 再启动 exe 只会聚焦窗口，不会产生第二个 host |
| `agentRunning` 在本版本不存在 | app.asar 中 0 次；活跃状态在 host 的 `agents` 注册表 |
| 两个外壳今天就是并存的 | desktop host 27180 + web host 24076；不变量必须靠主动检测，不能靠端口 |
| 桌面外壳无外部退出路径 | 窗口 close 被拦截为托盘隐藏；没有 quit IPC / CLI / 协议动词 |

## 六、方案（已选定）

### A. 目录联接 + 外部 launcher + 界面按钮（选定）

`profiles/web` 做成指向 `profiles/desktop` 的 junction；CLI 以默认 profile（`web`）启动，
但读写的其实是同一份文件。界面上加一个按钮，点选目标后由一个**外部** launcher 执行关闭与启动。

**为什么选它**：它让"两端一致"从"同步出来的结果"变成"同一个目录"这个结构性事实；
没有同步逻辑，就没有同步失败、没有半同步状态。

### 被否的方案

- **B. 插件自裁**：host 半区自己 `process.exit()` 再拉起新的。进程一死没人兜底，
  会话 flush 与它赛跑，Electron 外壳会留下坏窗口。违反"不卡住"。
- **C. 常驻 supervisor**：恢复能力最强，但多一个常驻进程、开机自启、端口与管道，
  出问题时更难解释。与用户"不要不可知的复杂度"相悖。
- **D. 先起后关**：结构上没有空窗，但有几秒两个 host 同开同一目录，
  会把"卡死"换成"静默丢数据"——更难发现。
- **E. 双 profile 同步**：即用户已否决的"分叉"方案；只在联接不可行时作为退路。

## 七、组件

### 7.1 环境改造（一次性）

1. 若 `profiles/web` 是真实目录：改名为 `web.bak-<时间戳>`。
2. 建目录联接 `profiles/web` → `profiles/desktop`（已验证免管理员可建）。
3. 校验：`dsh web --dump-config` 退出码 0，且输出含 `superpowers-dsh`。
4. 回滚：删联接，把备份改回 `web`。
5. 执行前提：**两个外壳都已关闭**——运行中的 host 持有目录句柄，Windows 上改名会失败。

### 7.2 launcher

`dsh-switch.cmd`（用户入口）+ `dsh-switch.ps1`（逻辑）。

命令：

```
dsh-switch            （无参数）交互菜单：Client / Web / 状态 / 停止
dsh-switch client     启动桌面客户端（必要时先关 web host）
dsh-switch web        启动 Web（必要时先关客户端）
dsh-switch status     当前谁在跑、端口、PID、profile 实体
dsh-switch stop       关掉当前 host
```

无参数菜单是本设计的一部分，不是附加便利：它让 launcher 自己成为桌面入口
（快捷方式指向它），因此在任一外壳起不来时，用户双击同一个图标就能改选另一侧。

职责：

- **状态**：`%USERPROFILE%\.dsh\launcher\state.json` 记 `{mode, pid, port, startedAt}`；
  另以进程命令行交叉验证，不单信状态文件。
- **身份检测**（不依赖端口）：客户端 = 命令行含 `dsh-desktop-host` 且 profile 为 `desktop` 的进程；
  web host = 状态文件 PID 存活，或命令行含 `cli.js` 且 profile 为 `web` 的进程。
  客户端 host 以 `--port 0` 启动、端口由 OS 分配，**不可硬编码**；需要端口时按 PID 查监听。
- **预检**（关闭任何东西之前）：cli.js 存在；`--dump-config` 退出码 0；目标端口空闲。
- **关闭 web host**：`taskkill /PID <pid> /T`（不带 `/F`），10 秒超时后强制。
- **关闭客户端**：外壳拦截窗口关闭（close → 最小化到托盘），也没有外部退出路径，
  所以 `WM_CLOSE` 无效。**先查 host 的活跃状态，确认空闲后直接强制结束整个进程树**，
  并在输出里说明「跳过 backend.close()，可能丢失最后一次未落盘的写入」。
- **端口**：优先 3080（与现状一致）；被占用时向上探测下一个空闲端口，三个网卡用同一个端口。
- **启动 web**：不直接起 `dsh web`，而是起 launcher 自带的 `relay.mjs`（把现有
  `~/.dsh/lan-web/serve.mjs` 的做法收进本项目，参数化地址与端口）：
  - 先以 `--host 127.0.0.1 --port <p> --no-open --trusted-host 192.168.0.106:<p>
    --trusted-host 10.147.20.214:<p> --trusted-host 100.100.0.3:<p>` 起 `dsh web`；
  - 再把同一端口 TCP 透传到这三个网卡地址（HTTP 与 WebSocket 一视同仁）；
  - 某个地址当前不存在（VPN 未连）时只损失那一个入口，记日志、不失败。
- **打开浏览器**：`--no-open` 时 host 不会自己开，launcher 从 relay 输出里取 `?token=` 那行 URL 并打开。
- **就绪判定**：web = 我们指定的端口可连且 `GET /` 返回任意 HTTP 响应；
  客户端 = `dsh-desktop-host` 进程出现且该 PID 有回环监听（不猜端口）。连接被拒才算失败。
- **重试**：每次失败先清理子进程，再重试；**上限 3 次**。
- **失败处理**：3 次仍失败 → 停止，不拉起任何外壳，输出三样东西：
  每次尝试的失败原因、当前状态（是否有 host 存活）、以及可直接复制的手工命令
  （`dsh-switch client` / `dsh-switch web`）。以非零码退出。
- **忙时拒停**：`stop` 与切换在 host 报告「有回合在跑」时默认拒绝，除非显式 `--force`。
- **日志**：`%USERPROFILE%\.dsh\launcher\logs\<时间戳>.log`。

### 7.3 插件 `dsh-shell-switch`

装在 `desktop` profile（因为 `web` 是它的联接，两个外壳都看得见）。

**host 半区**：

- `ctx.inject(['webServer'], …)` 挂两条仅回环路由：
  - `GET /dsh-switch/state`：**只读**，返回 `{busy, agents, jobs, approvals}`，
    数据来自 host 的 `agents` 注册表与 `jobs`，不自行推断。
  - `POST /dsh-switch/handoff`：校验一次性 nonce，spawn 脱离的 launcher，回 202。
- 任何异常都必须吞掉并返回错误码；绝不让异常冒进宿主。
- 只读路由存在的理由：本版本没有 `agentRunning`（app.asar 里 0 次），活跃状态只在
  host 的 `agents` 注册表；而 CLI 路径没有界面，必须靠它才能"忙时拒停"。

**client 半区**：

- 用 `ctx.slots.inject('sidebar.footer.action', …)` 在侧栏底部加图标（与"远程访问""更新器"同席位）。
- 点击 → 弹出两个选项（Client / Web）。
- 选择后 `GET /dsh-switch/state`：有在跑的回合 → 明确警告"切换会切断它"，需二次确认；
  有待答审批/提问 → 单独提示。
- 有在跑的回合 → 明确警告"切换会切断它"，需二次确认。
- 确认 → POST handoff → 界面显示"正在切换…"直到进程被关闭。
- 一次只允许一个 handoff 在飞，期间按钮禁用。

### 7.4 安装与切换

- 插件目录形如 `dsh-shell-switch/`（host `index.mjs` + `client.js` + `cordis.patch.yml` + `package.json`）。
- 安装必须走打包的 CLI（`dsh-desktop-host/lib/cli.js`，带 `manageDesktopProfile: true`），
  或平台提供的 `plugin_manager install_bundle`；**必须在两个外壳都关闭时执行**。
  它会写 `profiles/desktop/package.json` 与 `node_modules`，而那是 app 的地盘。
- app 启动不会重置 `dsh.profile.bundles`（只补缺失文件），外部加进去的 bundle 能存活。
- 环境切换（`web` → 联接）同样是一个**一次性、幂等**脚本，由用户在两外壳关闭时执行；
  智能体只能验证 `--dump-config` 与回滚，不能闭环验证启动（见风险 5）。

## 八、关键流程

```
点击按钮 → 选目标 → GET /dsh-switch/state → 确认
   → POST /dsh-switch/handoff {target, nonce}
   → host spawn launcher（脱离）
   → launcher: 预检 → 关闭当前 host → 启动目标 → 就绪(≤3)
        ├─ 成功 → 打开/保持窗口
        └─ 失败 3 次 → 停止，不拉起任何外壳 → 报错 + 手工命令

无界面路径：`dsh-switch web` 同样先查 state，忙则拒绝（除非 --force）。
失败后用户的实际出路：双击 launcher（无参数菜单）→ 选另一侧。
```

## 九、安全

- 两条路由都仅回环可达：来源地址与 `Host` 都必须是本机。
- `POST /dsh-switch/handoff` 另需一次性 nonce（host 签发，client 先经 `GET state` 取用）。
- **不把 `Origin`/`Sec-Fetch-Site` 当硬性条件**：桌面页面是 `dsh-app://app`，
  Electron 协议处理器会剥掉这些头（并对其它 origin 直接 403），要求它们会让主方向永远 403；
  仅当这些头存在时（Web 外壳）才校验。
- launcher 只停止它能识别出身份的进程（命令行匹配），绝不按端口盲杀。
- 插件不得写任何配置文件、不得改 profile 内容。

## 十、已知风险与边界

1. **绕过了 Electron 的独占守卫**。守卫为什么存在未知；最可能是避免两个写者。
   若将来 DSH 改成按真实路径校验，联接会直接失败（响亮失败，不是静默损坏）。
2. **安装插件要写 app 的地盘**。app 的插件管理器有自己的记账，可能在下一次启动时
   与外部写入冲突。缓解：安装时客户端必须关闭，安装后立刻用 `--dump-config` 验证。
3. **客户端只能强制结束**：外壳拦截窗口关闭且没有外部退出路径，`WM_CLOSE` 无效；
   跳过 `backend.close()` 可能丢失最后一次未落盘的写入。缓解：只在 `state` 报告空闲时才切，
   并在输出里明说这次跳过了正常关闭。
4. **入口唯一性无法用代码保证**：手动运行 `dsh web`、或继续使用 `lan-web`，都会起第二个 host。
   缓解：把快捷方式指向 launcher，并让 launcher 在启动前主动检测并清理。
5. **真机启动验证无法在智能体会话内完成**（会关闭会话本身）。
   缓解：首次运行由用户执行，launcher 把每次尝试的日志留在 logs 目录。
6. 若 app 有 profile 列表，`web` 这个联接可能出现在列表里。
7. **失败后不自动恢复是刻意的**：自动拉起另一个外壳可能同样失败，甚至自我循环。
   代价是失败后必须由人手再点一次（双击 launcher 选另一侧），换来的是不会陷入循环。
8. **旧的 `~/.dsh/lan-web` 不再被使用**：launcher 用自带的 relay。若有人再运行旧的 `start.cmd`，
   它会起第二个 web host。缓解：在 README 里说明，或把旧入口改成提示。

## 十一、留给实现者的选择

- 空闲端口的选择策略（固定 3080 优先，还是每次探测）。
- 重试间隔与总时长。
- 无参数菜单的呈现方式（编号选择 / 方向键）、选项顺序与默认项。
- 按钮文案、图标、Modal 的具体形态（复用官方 primitives）。
- 状态文件与日志的具体格式。
- 恢复原外壳时的提示措辞。
