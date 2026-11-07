# 复审遗留项（2026-11-07）

已修复并验证：C1（安装检查读 asar）、C2（PowerShell UTF-8，真机识别 27180/24076）、C4（kill 不许谎报）、C5（`__ModuleLoader__` 包装）。

## 本轮（第二轮）已修完

C3、C6、C7 与 I1–I15 全部处理，每一项都是先写失败测试再实现；`npm test` 84 项全绿。
下面保留复审原文作为对照，条目行内的「修：」即本轮落点。

- C3：`src/relay.mjs` 成为独立 CLI，`spawn` 成脱离进程，`relayPid` 写入 state，`stop` 时结束。
- C6：`startWeb` 任何失败都会杀掉已起的 host 与 relay；`switchTo` 每次尝试前经 `pickPort`/`reservePort` 重探端口；`onSpawn` 在等待就绪前写 pid。
- C7：`stopShell` 同时结束 `dsh-desktop-host` 与 Electron 外壳；`startClient`/`waitForClient` 只有 host 出现且拥有监听端口才返回。
- I1 `known:false` → `null`；I2 占用时 `reservePort` 换端口；I3 `stopEverything` 以进程列表为准并清 relay；I4 `switchWithConsent` 菜单确认后带 force，且 `currentHostPort` 可从 host pid 查监听端口；I5 同 C7；I6 `createLauncherSpawner` 挂 error 并写日志、`resolveNodeBinary` 有 vendored node 回退；I7 忙碌判定加入 jobs、inbox、审批；I8 用 `--profile web --dump-config` 断言插件出现；I9 `verifyCutover` + 联接目标校验 + `--revert` 入口 + 外壳未关时拒绝；I10 `src/log.mjs` tee 到 `logs/<时间戳>.log` 并在失败信息里给路径；I11 `detectCurrent` 读失败抛 `process-query-failed` 并拒绝切换；I12 就绪探测加 `GET /`；I13 relay 定期重试失败地址（unref）；I14 `stop --now` 立即模式 + 数据丢失提示；I15 修 `wait` 注入键并补齐五类 Review Focus 测试。

以下按复审原文整理。

## Critical

### C3 relay 随 launcher 进程退出而消失
`src/web.mjs:74` 在进程内建 relay，`src/cli.mjs` 随即 `process.exit`。三个局域网地址实际不可用。
修：把 `src/relay.mjs` 做成独立 CLI（`--target-port/--listen-port/--addresses`），`spawn` 成脱离进程；PID 写进 state，`stop` 时结束。

### C6 重试不清理，可能留下活 host 并报"现在没有外壳在运行"
`src/launcher.mjs:61-70`、`src/web.mjs:68-73`。token 超时时不杀子进程；下一次尝试对着旧 host 判就绪。
修：每次尝试 try/finally 杀子进程 + 关 relay；尝试前重新探测端口；等就绪前把子进程 pid 写进 state。

### C7 强杀 host 不关 Electron 外壳，切回来起不了新 host
`src/launcher.mjs:27-33` 只杀 host pid；外壳弹出致命恢复对话框，且应用是单实例，`startClient` 只聚焦旧窗口却报成功。
修：找到 Electron 主进程并结束整棵树；客户端启动后轮询确认 `dsh-desktop-host` 与其监听端口出现，否则抛错。

## Important

- **I1** `fetchBusy` 忽略 `known:false`（`src/launcher.mjs:13-25`）→ 读不到状态被当成空闲。`body.known === false` 时返回 `null`。
- **I2** 端口被占只打印"换一个"却仍用旧端口（`src/cli.mjs:87-90`）→ 占用时改调 `findFreePort`。
- **I3** `dsh-switch stop` 停不了 launcher 起的客户端（`src/cli.mjs:79-84`，pid 写 0）→ 用 `listProcesses()` 查。
- **I4** 菜单无法 client→web（没有 `--force` 入口）→ 菜单确认后传 force；或实现 PID→监听端口查询。
- **I5** 客户端"启动成功"未验证（`src/cli.mjs:102-106`）→ 轮询确认 host 进程与监听。
- **I6** UI spawn 无错误处理、无 node 回退、输出被丢弃（`plugin/index.mjs:16-25`）→ 挂 `error` 事件、写日志。
- **I7** 忙碌判定不含 jobs/审批提问（`plugin/index.mjs:28-37`）→ 读 `jobs`，加入 `inbox.nextTurn/nextStep` 与待答审批。
- **I8** 安装后用 `--profile desktop --dump-config` 验证必然失败（`setup/install.mjs:28-29`）→ 改用 `--profile web --dump-config` 并断言插件出现。
- **I9** cutover 不校验联接目标、无 `verifyCutover`、无回滚入口、不检查两外壳已关（`setup/cutover.mjs:19-49`）。
- **I10** 从不写日志文件（`src/paths.mjs:22` 定义未用）→ 所有输出 tee 到 `logs/<时间戳>.log`，失败信息里给出路径。
- **I11** PowerShell 失败与"没有进程"不可区分（`src/procs.mjs`）→ 已部分修复（读失败抛错），`detectCurrent` 需据此拒绝切换。
- **I12** 就绪只探测 TCP，不发 HTTP（`src/web.mjs:21-29`）→ 加一次 `GET /`。
- **I13** VPN 网卡后起来就永久丢失（`src/relay.mjs`）→ 定期重试失败地址（unref）。
- **I14** 客户端关闭仍走 10s 优雅等待且无数据丢失提示（`src/procs.mjs:58-78`）→ 加立即模式 + 提示文案。
- **I15** `tests/web.test.mjs:40` 注入键名写错（`waitReady` 应为 `wait`），断言靠本机 3080 恰好监听而通过；五类 Review Focus 仍缺测试。

## 复审给的建议顺序

1. C1/C2（已完成）
2. C5（已完成）
3. C3 + C6（relay 生命周期与失败清理，同一批改动）
4. C7 + I5（客户端启停的真实性）
5. I1/I2/I3/I8/I12（小而独立的正确性）
6. I6/I7/I10（可观测性与忙碌判定）
7. I9/I13/I14/I15（setup 与补测）
