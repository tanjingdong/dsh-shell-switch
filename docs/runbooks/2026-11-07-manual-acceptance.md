# 手工验收手册（2026-11-07）

本轮代码已全部提交、`npm test` 84 项全绿，但**真实切换、插件安装、侧栏按钮**只能在你自己机器上验收。
这份手册按顺序做即可；每步都有命令、期望输出、不通过时怎么办。

> ⚠️ 第 2 步会关掉你正在看的 Web 页面（就是现在这个对话所在的 3080）。
> 先把本文看完，或者把它留在桌面客户端里打开再动手。后续步骤都在普通 PowerShell 窗口里跑。

约定：

```powershell
cd F:\DSH-default-workspace\dsh-shell-switch
```

下文 `dsh-switch` 指 `.\dsh-switch.cmd`（等价于 `node src\cli.mjs`）。

---

## 0. 先看当前实际状态（只读，安全）

```powershell
.\dsh-switch.cmd status
Get-ChildItem "$env:USERPROFILE\.dsh\launcher"
```

我在这台机器上已观察到：

- 桌面 host **27180**（监听 6990）和 Web host **24076**（监听 3080）**同时在跑** —— 这本身违反了"同一时间只有一个 host"的约定，必须先收干净。
- `status` 会显示 `当前：client`，因为检测顺序里客户端优先；这是正常的，不代表 Web 没在跑。
- `%USERPROFILE%\.dsh\launcher\state.json` **目前不存在**（launcher 还没成功启动过一次）。所以 `stop` 现在完全依赖进程列表，这正是本轮 I3 修的地方。

---

## 1. 关掉两个外壳

第 1 次 `stop` 关客户端，第 2 次 `stop` 关 Web（因为检测优先客户端）：

```powershell
.\dsh-switch.cmd stop          # 关桌面客户端：host + Electron 外壳一起结束
.\dsh-switch.cmd stop          # 再跑一次，关掉 Web host
.\dsh-switch.cmd status        # 期望：当前：没有外壳在运行
```

- 停止客户端时会先提示「未保存的内容可能丢失」；想立刻结束用 `stop --now`。
- **不通过**：如果第二次 `stop` 仍显示 client/web，打开任务管理器确认 `dsh-desktop-host`、`DeepSeek Harness.exe`、`cli.js web` 三类进程是否真的没了，把 `status` 的输出和日志路径发我。

页面在这里会断开，正常。

---

## 2. 建立 profile 联接

```powershell
node setup\cutover.mjs
```

期望输出之一：

- `已建立联接并验证；原目录备份为 C:\Users\谭靖东\.dsh\profiles\web.bak-<时间戳>`
- 或 `web 已经是联接，无需改动`

**把这个备份路径记下来**，第 10 步回滚要用。

- 若提示「请先关闭桌面客户端与 Web 外壳」→ 回第 1 步，说明还有 host 活着。
- 若提示「desktop profile 不存在」→ 说明桌面客户端从没正常启动过，先 `.\dsh-switch.cmd client` 一次再重来。
- 注意：联接之后 `profiles\web` 就是 `profiles\desktop`。**你以前只在 Web 里装过的东西现在留在 `web.bak-*` 备份目录里**，不会自动合并；需要的话得重新装到 desktop profile。

可以自查：

```powershell
(Get-Item "$env:USERPROFILE\.dsh\profiles\web").LinkType   # 期望：Junction
(Get-Item "$env:USERPROFILE\.dsh\profiles\web").Target     # 期望：...\profiles\desktop
```

---

## 3. 安装插件

两个外壳必须都是关的。

```powershell
node setup\install.mjs
```

期望：`插件已安装进 desktop profile`。

它内部做了三件事：`plugin --profile desktop add link:<仓库>\plugin`、`--profile web --dump-config`（必须退出码 0）、并且**断言 dump 里出现 `dsh-shell-switch`**。所以这一步通过就说明插件确实落在两个外壳都会读的地方。

- 不通过：「安装失败（退出码 N）」→ 把 N 和日志发我；「没有出现在 … dump-config 中」→ 说明 profile 路径不对，先看 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里有没有 `dsh-shell-switch`。

---

## 4. 起桌面客户端并看侧栏

```powershell
.\dsh-switch.cmd client
```

期望：

- Electron 窗口出现；
- `%USERPROFILE%\.dsh\launcher\state.json` 出现，含 `"mode": "client"`、`"pid"`（host）、`"port"`（我这边实测桌面 host 的监听端口是 **6990**）、`"shellPid"`；
- `.\dsh-switch.cmd status` 显示 `当前：client（端口 6990）`。

验收点（本轮 I5/C7 的核心）：**现在不是"窗口弹出来就算成功"，而是 host 出现且它真的拥有监听端口才算**。做满 20 秒 × 3 次仍不满足会报 `client-not-ready`。

- 不通过：
  - 报 `client-not-ready` 且任务管理器里已有 `DeepSeek Harness.exe` → 大概率是单实例残留，先 `.\dsh-switch.cmd stop --now` 再试；
  - `spawn-failed` → 检查 `paths.exe`（默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`）是否存在。

窗口起来后：**侧栏底部应出现「⇄」按钮**，点开有「桌面客户端 / 浏览器 Web」两项。

- 没有按钮 → 插件没被客户端加载：确认第 3 步通过、然后**完全退出客户端再重开**（不是最小化）；仍没有就把日志发我。

---

## 5. 验收 客户端 → Web

在桌面客户端里点「⇄」→「浏览器 Web」：

- 若提示「有回合正在运行」或「无法确认是否空闲」→ 点「仍然切换」。这是预期行为：我实测桌面 host 的 6990 上 `/dsh-switch/state` 返回 **404**（桌面 host 没挂这条路由），所以忙碌检查会降级为"无法确认"，界面必须先问你一次。
- 期望：桌面窗口关闭；浏览器自动打开带 `?token=` 的地址；`status` 显示 `当前：web（端口 3080）`。
- `state.json` 里应出现 `"relayPid"`；`Get-CimInstance Win32_Process | Where-Object CommandLine -like '*relay.mjs*'` 能看到一个独立 node 进程。**这个 relay 进程必须比 launcher 活得久**（C3）。

三个局域网入口（token 从浏览器地址栏复制）：

| 地址 | 我这边对应网卡 | 判据 |
|---|---|---|
| `http://192.168.0.106:3080/?token=…` | 以太网 | 同网段手机/另一台机应能打开 |
| `http://10.147.20.214:3080/?token=…` | ZeroTier | 只有在 ZeroTier 网络里的设备能开 |
| `http://100.100.0.3:3080/?token=…` | wt0（Tailscale） | 只有在 Tailscale 网络里的设备能开 |

这三个 IP 与你这台机器的实际网卡一致，所以我预期三条都能绑上。若某条打不开，只损失那一个入口，本机 3080 不受影响（Review Focus 1）。改地址表在 `src/cli.mjs` 的 `LAN_ADDRESSES`。

---

## 6. 验收 Web → 客户端

在浏览器页面里点「⇄」→「桌面客户端」→「仍然切换」。

期望：桌面窗口出现，旧页面断开；`status` 回到 `当前：client（端口 6990）`；上一个 relay 进程已消失。

---

## 7. 验收 stop

```powershell
.\dsh-switch.cmd stop          # 关客户端，先提示未保存内容可能丢失
.\dsh-switch.cmd stop --now    # 立即结束，不等待优雅退出
.\dsh-switch.cmd stop          # 关 Web（会顺带结束 relay）
.\dsh-switch.cmd status        # 期望：当前：没有外壳在运行
```

停止后会先立刻打印 `正在停止浏览器 Web…`（或 `正在停止桌面客户端…`），再打印**停了什么、几个进程、它们的 pid**，例如：

- `已停止桌面客户端（结束 2 个进程：11、10）`
- `已停止浏览器 Web（结束 2 个进程：20、30）`
- `没有外壳在运行`
- `已结束残留的 relay 进程（pid 30）`
- `浏览器 Web的进程已经不在了，无需停止`

- 自查 relay 真的没了：三个局域网地址用 `Test-NetConnection 192.168.0.106 -Port 3080` 应连不上。

---

## 8. 验收端口被占用

先占住 3080（例如另开一个 `dsh web --port 3080`，或随便起个监听 3080 的服务），然后：

```powershell
.\dsh-switch.cmd web
```

期望：自动选 3081–3099 里的空闲端口，`state.json` 的 `port` 是新端口，三个局域网入口也用新端口；旧端口上的服务不受影响。

---

## 9. 每一步都要看日志

所有输出都会 tee 到 `%USERPROFILE%\.dsh\launcher\logs\<yyyyMMdd-HHmmss>.log`；失败时 stderr 末尾会打印「日志：<路径>」。

失败时请把**那一次的日志文件**连同终端输出一起发我。错误码对照：

| 错误码 | 含义 | 你怎么做 |
|---|---|---|
| `busy` | 当前有回合在跑 | 等它跑完，或确认后加 `--force` |
| `busy-unconfirmed` | 状态接口不可用，无法确认空闲 | 菜单会问你；命令行加 `--force` |
| `process-query-failed` | 读不到进程列表 | 别硬切；检查 PowerShell 是否被策略挡了，或加 `--force` 明确目标 |
| `start-failed` | 连续 3 次启动失败 | 外壳已全关；按提示重开另一侧 |
| `start-timeout` | web 在端口上没就绪 | 多半是端口被别的程序抢了 |
| `no-token-url` | 15 秒内没打印带 token 的地址 | 看日志里 `[web]` 开头的行 |
| `client-not-ready` | 客户端 host/端口没出现 | 见第 4 步 |
| `spawn-failed` | 起 web 进程失败 | 检查安装路径 |
| `no-free-port` | 3080–3099 全被占 | 腾一个端口 |

---

## 10. 回滚（任一验收失败都能退回去）

两个外壳都先关掉，然后：

```powershell
# 0) 先确认备份真的在（必须是 True，否则不要往下走）
Test-Path "C:\Users\谭靖东\.dsh\profiles\web.bak-<时间戳>"

# 1) 撤掉联接，把备份目录改回 profiles\web
node setup\cutover.mjs --revert "C:\Users\谭靖东\.dsh\profiles\web.bak-<时间戳>"

# 2) 移除插件（plugin 子命令把参数转发给 pnpm，remove 是 pnpm 的移除）
$env:ELECTRON_RUN_AS_NODE = '1'
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
& $exe --expose-internals $cli plugin --profile desktop remove dsh-shell-switch
```

我实测过 `plugin --help`：它接受 `add <pkg>` / `remove <pkg>` / `why <pkg>` 这类 pnpm 参数，所以上面的 `remove` 就是正确写法；插件包名是 `dsh-shell-switch`（见 `plugin\package.json`）。

回滚后重启桌面客户端即可回到原状；`%USERPROFILE%\.dsh\launcher`（state 与 logs）可以直接删，不影响 profile。

---

## 11. 回给我什么

按这四项发我，我就能定位是代码问题还是环境问题：

1. 失败的**那一步编号**与终端完整输出（含「日志：…」路径）；
2. 对应的 `logs\<时间戳>.log` 文件；
3. `%USERPROFILE%\.dsh\launcher\state.json`（如果有）；
4. 第 4 步侧栏按钮是否出现（C5 一直没做真机验收）。
