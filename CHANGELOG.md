# Changelog

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.1 — 2026-11-25

### 新增

- **一键安装**：解压后双击 `install.cmd` 即可。脚本自动定位 DeepSeek Harness、检查 profile、
  检测正在运行的外壳并询问是否停止、建立联接、安装插件并验证、**在桌面创建启动器快捷方式**；
  **不需要安装 Node.js**，没装 node 时会使用 DSH 自带的运行时。
- **一键卸载**：双击 `uninstall.cmd`，移除插件、删掉本插件创建的桌面快捷方式
  （同名但不是它建的会保留），并询问是否把 `web` 回滚成备份。
- `dsh-switch status --json`：给脚本用的机器可读输出。

### 说明

- 装配逻辑全部在 `setup/wizard.mjs`（普通 JavaScript），`install.cmd` / `uninstall.cmd`
  只负责挑运行时。最初的 PowerShell 版本已删除：Windows PowerShell 5.1 不等待 GUI 子进程，
  导致输出与退出码为空，且 `Test-Path` 看不进 `app.asar` 内部。

## 1.0.0 — 2026-11-08

首个公开版本。

### 功能

- **外壳切换**：`client` / `web` 双向切换，`status` 查看当前外壳与地址，`stop` 停止（`--now` 立即）。
- **共享 profile**：`profiles/web` 变成指向 `profiles/desktop` 的目录联接，两个外壳读写同一份插件、设置与会话；提供 `--revert` 回滚入口。
- **可靠性**：启动失败最多重试 3 次；每次尝试前重探端口；就绪探测同时要求 TCP 与 HTTP；客户端需确认 host 与监听端口都出现才算成功；结束外壳时按 pid 逐个处理并保护自身，永不触碰关键系统进程。
- **局域网发布**：独立 relay 进程把网页端口发布到勾选的本机网卡；「只绑定回环」可完全关闭发布；失败地址定期重试。
- **上报通道**（各自独立开关）：打开本地浏览器、复制到剪贴板、弹窗、发送到网络（自填 API 地址 + JSON 模板，占位符 `{url}` `{token}` `{port}` `{target}` `{time}`）。
- **配置页**：插件页 → `dsh-shell-switch` → 配置；现场探测本机网卡；保存即生效；「发送测试」可先验证接口。
- **桌面快捷方式**：一键在桌面创建启动器快捷方式，双击进入无参数菜单，结束时等待按键。
- **日志**：launcher、Web host、弹窗/剪贴板各自的日志文件，失败时终端直接给出路径。

### 已知限制

- 仅 Windows。
- 依赖 DSH 的内部插件约定（`plugins.row.config` 槽位、`webServer.register`），DSH 升级后可能需要同步调整。
- 结束桌面客户端时最多等待 10 秒优雅退出（可能有未保存内容）。
