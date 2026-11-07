# 发布就绪评估（2026-11-08）

> **阶段 1 进展（同日）**：单包重构完成（仓库根即 bundle，`plugin/` 已并入根）、元数据 / `LICENSE` / CI / README 重写已落地。
> 仍缺：GitHub 仓库地址与署名（`repository`/`homepage`/`bugs` 字段待填）、真实推送。
> 迁移注意：旧 profile 里的 `link:` 指向已删除的 `plugin/`，升级后必须重跑 `node setup\install.mjs` 再重启外壳。

结论：功能面已经闭环（157 项测试全绿，真机验收完成），但**发布面还差四类东西**：打包形态、元数据与许可、兼容性护栏、面向陌生人的文档。前三类是阻断项，不解决就发不出去或一发就坏。

## 一、功能面：还缺什么

按对用户价值排。

1. **打包形态与插件市场不兼容（阻断项）**
   `plugin/package.json` 是 bundle 包，但它的代码 `import '../src/*.mjs'`——npm 包不能跨包引用，`private: true` 也禁止发布。仓库根另有独立 `package.json`（只跑测试），与 bundle 分离。
   参考同生态的 `superpowers-dsh`：一个 bundle = 仓库根的单包，`main` 指向入口、`cordis.patch.yml` 在根、用 `files` 白名单。
   可选做法：把 `plugin/*` 上移到根，或把 `src/` 收进 `plugin/`。目标只有一个——bundle 目录自成一体。

2. **安装/卸载没有面向用户的一步到位**
   现在要：关掉两个外壳 → `node setup\cutover.mjs` → `node setup\install.mjs`。市场装完插件后，用户仍必须自己跑 cutover 才能让 web 与 desktop 共享 profile，否则插件装了也不生效。
   建议：`dsh-switch setup` 一条命令完成"检查外壳关闭 → 建联接 → 装插件 → 校验"，失败可回滚；配套 `dsh-switch uninstall`。

3. **没有 DSH 兼容性护栏**
   我们依赖一批内部约定：`plugins.row.config` 槽位、`webServer.register({kind:'exact'})`、`ctx.inject` 回调返回值语义（曾因此挂掉全部路由）、`%USERPROFILE%\.dsh\launcher` 路径、宿主以 `--expose-internals` 启动。
   建议：仿 `superpowers-dsh` 的 `check-dsh-compat.mjs`，读 DSH 版本并探测关键 API，`dsh-switch doctor` 直接报红。

4. **没有自我诊断命令**
   `dsh-switch doctor` 应能回答：安装路径存在吗、app.asar 在吗、profile 是联接吗、插件在 `--dump-config` 里吗、端口被占了吗、有没有残留 relay/host、日志在哪。
   这次的 403、404、快捷方式关窗三个问题，都属于"如果有 doctor 用户能自己定位"的类型。

5. **首次使用引导**
   新用户不知道要"建联接 + 装插件 + 重启客户端"。`setup` 的提示或首启引导能替代大部分 README 阅读。

6. **语言与平台**
   提示文案全中文。若要面向国际市场，需要 i18n 或英文文案，至少 README.en.md。仅 Windows 支持需在 `os` 字段与 README 顶部显式声明。

## 二、开源发布：缺什么

1. **LICENSE 缺失**（阻断项）。建议 MIT，与 DSH 生态一致。
2. **package.json 元数据缺失**：根与插件都没有 `description`、`license`、`repository`、`homepage`、`bugs`、`keywords`、`publishConfig`、`files`、`engines`、`os`，而且都是 `private: true`。
3. **CHANGELOG.md / CONTRIBUTING.md / SECURITY.md**。SECURITY 尤其要写：网络上报会把 token 交给对方，默认关闭；路由只绑回环与私网，拒绝公网域名（防 DNS rebinding）。
4. **README 需要面向陌生人重写**：一张截图或 GIF、三步安装、支持的 DSH 版本、FAQ（403、快捷方式关窗、端口占用）、故障排查表。现在的 README 是写给已经熟悉项目的人看的。
5. **CI 缺失**：GitHub Actions `windows-latest` 跑 `npm test`；可选覆盖率门槛。
6. **GitHub 模板**：issue / PR 模板（可选但规范）。
7. **仓库清理**：`_t.err` / `_t.out` 已删，`.gitignore` 收紧为 `_*`；**尚未配置 git remote**，一次提交都没推过。
8. **版本与节奏**：0.1.0 → 0.1.x 私测 → 0.2.0 公开；发布说明写清"仅 Windows"。
9. **测试面**：157 项单元测试扎实，但缺 `.cmd` 包装、快捷方式（COM 校验）、真实切换的 E2E。发布前至少保留一份 Windows 冒烟清单。

## 三、建议的最小发布路线

- **阶段 1（阻断项）**：单包重构 → 元数据 + LICENSE → CI → README 重写 → 打 tag 推 GitHub。
- **阶段 2（可用性）**：`dsh-switch setup` / `doctor` / 兼容检查 / CHANGELOG → 市场私测。
- **阶段 3**：公开。

## 四、风险清单

- **DSH 内部 API 漂移**：槽位名、路由注册、`ctx.inject` 语义都属于内部约定，升级可能静默回归——这正是阶段 2 要补护栏的原因。
- **token 外发能力**会被社区审阅：默认关闭、界面提示、SECURITY.md 三者必须齐。
- **cutover 是全局副作用**：它把 `profiles/web` 改成指向 `profiles/desktop` 的联接，会影响用户其它 DSH 用法。README 必须显眼说明并给出回滚命令（`setup/cutover.mjs --revert <备份>`）。
