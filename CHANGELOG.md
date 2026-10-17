# FocusLocker 更新日志

版本号采用语义化版本规范（Semantic Versioning 2.0.0），格式为“主版本号.次版本号.修订版本号”（MAJOR.MINOR.PATCH），各段含义如下：

- 主版本号（MAJOR）：包含不兼容变更，例如配置格式、IPC 协议、快捷键语义或主要交互流程的破坏性调整。
- 次版本号（MINOR）：在保持向后兼容的前提下新增功能、新增配置项或新增模块。
- 修订版本号（PATCH）：在保持向后兼容的前提下修复缺陷、调整文案与样式、进行性能优化或小幅重构。

本文档与 GitHub Releases 页面保持同步。如仅需了解最新版本内容，请直接阅读最近版本对应的章节。

---

## [1.4.0-fix] - 2026-08-27 · 卸载清理计划任务与注册表自启动项

对应标签：v1.4.0-fix

### 1.26 卸载时彻底停用计划任务与自启动注册表项

**问题**：FocusLocker 在首次启动时通过 `main.js` 的 `ensureWatchdog()` 与 Electron `setLoginItemSettings` 注册了下列计划任务 / 自启动项：

| 类型 | 名称 | 触发条件 | 指向文件 |
| --- | --- | --- | --- |
| 计划任务 | `FocusLocker` | ONLOGON（登录时） | `FocusLocker.exe` |
| 计划任务 | `FocusLockerGuard` | 每分钟 | `guard.vbs`（看门狗 vbs，守护主进程） |
| 计划任务 | `FocusLockerGuardProc` | 每分钟 | `guard-proc.vbs`（同进程的另一条触发链） |
| HKCU Run | `FocusLocker` | 登录时 | `FocusLocker.exe` |

应用本体通过 `before-quit` 仅会清理 `FocusLockerGuard` / `FocusLockerGuardProc` 两条看门狗任务，但卸载器（`build/installer.nsh` 的 `customUnInstall`）此前只删除了快捷方式，导致：

1. 用户在系统「任务计划程序」看到 3 条 FocusLocker 任务残留；
2. 卸载后每分钟仍触发 `guard.vbs` / `guard-proc.vbs`，但 `FocusLocker.exe` 已被删 → 任务执行报错「系统找不到指定的文件」；
3. 每次登录还可能被 `FocusLocker` 自启动任务 / `HKCU\...\Run\FocusLocker` 拉起一个不存在的进程并报错；
4. 由于 Electron `setLoginItemSettings` 还会写 `HKCU\...\Explorer\StartupApproved\Run\FocusLocker` 的「快速启动」批准位，仅删计划任务也会留下「下次登录试启动」的痕迹。

**修复**（仅 `build/installer.nsh`）：

```nsh
!macro customUnInstall
  ; 1. 先停掉自启动计划任务，避免登录时再拉起已删除的 exe
 nsExec::ExecToLog 'schtasks /Delete /TN "FocusLocker" /F'
  ; 2. 看门狗任务优雅退出时会自己清，但卸载不走 before-quit，必须在此兜底
  nsExec::ExecToLog 'schtasks /Delete /TN "FocusLockerGuard" /F'
  nsExec::ExecToLog 'schtasks /Delete /TN "FocusLockerGuardProc" /F'
  ; 3. 顺手清掉 Electron setLoginItemSettings 写的两个注册表自启动项
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FocusLocker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "FocusLocker"
  ; 4. 原有的快捷方式清理保持不变
  Delete "$SMPROGRAMS\FocusLocker\正常模式.lnk"
  Delete "$SMPROGRAMS\FocusLocker\快速模式.lnk"
  Delete "$SMPROGRAMS\FocusLocker\测试模式.lnk"
  RMDir "$SMPROGRAMS\FocusLocker"
  Delete "$DESKTOP\FocusLocker.lnk"
!macroend
```

**修复要点**：

- `nsExec::ExecToLog` 在 schtasks 返回非 0（任务不存在、旧残留已清）时**不会中断卸载**，所以即使老用户机上本来就没有 3 条任务、或已手动清过，升级都安全；
- 自启动任务 `FocusLocker` 只在**卸载**这一刻删，未放进 `before-quit`——否则正常退出后自动启动会失效（用户重启不会再拉起 FocusLocker）；
- 看门狗任务在 `before-quit` 中已删，卸载时再删一次只是兜底（双重保险）；
- `DeleteRegValue` 即使目标值不存在也不会报错，幂等。

**验证**：

- 重新构建 `dist-build26/FocusLocker Setup 1.4.0.exe`（版本号置为 `1.4.0-fix`，NSIS 编译通过，耗时约 47s）；
- 卸载后用 `schtasks /Query /FO LIST | findstr /I focuslocker` 与 `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v FocusLocker` 检查，均无残留；
- 「任务计划程序」UI 中 FocusLocker 树节点在卸载后自动消失。

### 1.27 致谢本轮贡献者

- **CN_HiTimes01**（GitHub: [@CN_HiTimes01](https://github.com/CN_HiTimes01) / UMAsky001）— 协助完成本轮卸载残留问题排查与回归验证。

+ @CN_HiTimes01

> 这次的 fix 版本不引入新功能、不改 UI、不动 IPC 与 IPC 协议，因此所有 v1.4.0 已有的接口与行为保持向前兼容；从 1.4.0 升级到 1.4.0-fix 不会触发数据迁移、配置格式变化或快捷键语义变化。

---

## [1.4.0] - 2026-08-25 · 查看验证码 · 图标统一 Lucide · 性能与暗色优化正式发布

对应标签：v1.4.0

### 版本概述

本版本将 1.3.2 累积的新功能与优化正式提升为 MINOR 版本发布（全部向后兼容）：

- **新功能 · 生产模式「查看验证码」**（源自 1.3.2 §1.13）：生产模式下 dock 新增按钮，一键临时关闭强制置顶 45 秒便于查看验证码，到点自动恢复并提示；
- **新功能 · 图标统一 Lucide**（源自 1.3.2 §1.14）：全部 45 个 SVG `<symbol>` 统一替换为 Lucide 开源图标集，风格一致、141 处 `<use>` 引用零改动；
- **性能与体积优化**（源自 1.3.2 §1.9）：启动 IPC 并行化、CDN 库本地化（marked / highlight.js / KaTeX 落本地 `assets/vendor`）、移除死依赖；
- **暗色模式重设计**（源自 1.3.2 §1.11）：整体提亮、拉开背景层次，卡片 / 面板 / 悬浮态清晰可辨；
- **通知中心滚动修复**（源自 1.3.2 §1.12）、**悬浮横幅角落偏好修复**（源自 1.3.2 §1.10）、**冗余代码清理**（源自 1.3.2 §1.8）。
- **新功能 · 数据一键导出 / 导入**（§1.15）：设置页新增「数据备份与迁移」区块，可勾选导出 / 导入网站设置、专注与通知设置、登录 Cookie、自定义环境音（连同音频文件本体）、文件库、Todos、使用统计、浏览器扩展、用户样式、用户脚本；导出为单个 zip（含 `manifest.json` 描述数据集），导入按勾选还原并提示重启生效。

详细实现与根因分析见 [1.3.2] 章节（1.8–1.14）与 §1.15。

### 1.15 数据一键导出 / 导入（设置页「数据备份与迁移」）

**需求**：在设置页提供一键导出全部用户数据、并支持按需勾选数据集导出的能力，同时提供导入恢复。

**数据集定义**（`main/backup.js` 的 `DATASETS`）：

| Key | 内容 | 存储位置 |
| --- | --- | --- |
| `website` | 网站设置（网站 / 时段 / 每日任务） | `config.json`（userData） |
| `settings` | 专注与通知设置（含快捷键） | `focus-settings.json`（userData） |
| `cookie` | 登录 Cookie | 走 `browserViewSession.cookies` API（导出为 `cookies.json`，跨机可用） |
| `sounds` | 自定义环境音 | `custom-sounds.json` / `ambient-covers.json` + 音频文件本体（`sounds-media/`，按用户选项） |
| `files` | 文件库 | `files/` 目录 + `uploaded-files.json` |
| `todos` | 待办 Todos | `todos/` 目录 |
| `stats` | 使用统计 | `focus-stats.json` / `site-stats.json` |
| `extensions` | 浏览器扩展 | `extensions/` 目录 + `extensions-settings.json` |
| `userstyles` | 用户样式 | `userstyles/` 目录 |
| `userscripts` | 用户脚本 | `baseDir/userscripts/` 目录 |

**导出流程**：渲染进程收集勾选的 key → 主进程 `export-all-data` 用 JSZip 打包为 zip（含 `manifest.json` 描述导出项与时间戳）→ 弹出保存对话框写盘。

**导入流程**：主进程 `import-all-data` 读取用户选择的 zip → 按 `manifest.keys` 逐项还原文件 / 目录 → Cookie 走 `cookies.set` 写回 session → 环境音音频本体还原到 `custom-sounds-media/` 并重写 JSON 中的绝对路径 → 安全剥离导入配置里的 `lockSessionRanges`（防止他人配置直接触发锁屏绕过）；完成后提示用户重启生效。

**设计取舍**：环境音默认连同音频本体导出（跨机完整，代价是 zip 可能很大，提供开关）；导入后提示手动重启而非自动重启（避免运行中覆盖正在使用的文件）。

### 1.16 查看验证码 · 收纳进设置面板 + 每次启动限用 2 次

**需求**：将「查看验证码」入口收纳至设置面板（而非仅 dock 常驻按钮），并限制每次应用启动仅可使用 2 次。

**UI 收纳**：在设置页「验证码解锁」设置项下方新增「查看验证码」区块（`.vc-block`），含功能说明、剩余次数 `<b id="vcQuota">` 与「查看验证码」按钮；dock 按钮保留为生产模式快捷入口。

**配额限制（每次启动 2 次）**：配额变量 `verifyCodeQuota` 置于主进程内存（随应用启动重置，overlay 窗口 reload 不清零），默认 `MAX_VERIFY_CODE_PER_LAUNCH = 2`；新增 IPC `get-verify-code-quota`（返回剩余次数）与 `consume-verify-code`（>0 时减一并返回 `{ok, remaining}`，否则 `{ok:false, remaining}`）；preload 暴露 `getVerifyCodeQuota` / `consumeVerifyCode`。`viewVerificationCode()` 点击时先 `consumeVerifyCode()`，配额耗尽则提示「本次启动查看验证码次数已用完（上限 2 次）」并禁用按钮；启动流程与每次使用后调用 `refreshVcQuota()` 同步剩余次数与按钮禁用态。

### 1.17 查看验证码 · 移除 dock 按钮并取消生产模式限制 · 通知中心高度随面板联动

**查看验证码入口收敛（§1.16 延续）**：移除 dock 常驻按钮 `#verifyCodeBtn` 及其专属 CSS（含 `.is-test-mode #verifyCodeBtn` 强制隐藏）与生产模式显隐逻辑；「查看验证码」仅保留设置面板 `.vc-block` 入口，且在**生产 / 测试模式均可用**（主进程 `set-always-on-top` 无测试模式拦截，renderer 入口无模式门槛）。设置按钮增加 `.vc-label` 以承载倒计时文案。

**通知中心高度随面板联动（修复）**：原 popup 模式高度收口仅将 `max-height` 清为整屏 `calc(100vh - 6.5vh)`，且每秒 `tickNotifyLive` 会再次清空，导致通知中心高度不随铃铛 / 面板位置变化、贴近底部的按钮还会溢出视口。修复：
- `positionNotifyNearBell()` 在定位后按「按钮下方可用空间」设置 `max-height = max(160, vh - top - 12)`，使高度随按钮 / 面板位置自适应、不再整屏溢出；
- 新增 `repositionNotifyCenter()` 统一「重新收口 +（popup）重新定位」，接入窗口 `resize`、`updatePanelOpenClass()`（面板开合）、`tickNotifyLive()`（每秒实时跟随），并对铃铛所在 `#agentPanel` 加 `ResizeObserver` 监听面板尺寸变化；
- drag(pinned) 模式维持固定 0.95 视口高度不变。

### 1.18 数据导出卡死修复（cookies.get 永久挂起 + 保存对话框被 overlay 遮挡）

**症状**：设置页点击「导出选中数据」后，界面永久停在「正在导出数据…」，保存对话框不出现，导出无法完成。

**根因**：`main/backup.js` 的 `buildBackupZip()` 在导出 Cookie 时调用 `await browserViewSession.cookies.get({})`。当用户会话存储（quota/cookie 数据库，终端日志可见 `quota_database Could not open the quota database`、`service_worker_storage Database IO error`）处于异常/损坏状态时，该 Chromium API 会**无限期挂起**——既不 resolve 也不 reject，故任何 `try/catch` 都拦不住；而主进程 handler 又是「先打包再弹保存对话框」，于是对话框永远到不了，renderer 死等。

**修复**：
- `main/backup.js` 新增 `raceWithTimeout()` 超时兜底（flushStore 3s、cookies.get 5s）；会话存储异常时该项自动跳过（仅丢失 Cookie 导出，其余数据正常导出），不再卡死；
- `main.js` 导出 handler 改为「**先弹保存对话框、再打包写盘**」，且对话框父窗口由 `overlayWin`（alwaysOnTop 屏幕保护级）改为 `null`，避免保存框被全屏置顶的 overlay 遮挡导致无法点击；
- 导入对话框同样去掉 `overlayWin` 父级（改 `null`），规避同类遮挡；
- renderer `exportAllData()` 增加 90s 兜底提示，主进程万一异常也能恢复界面，不再永久显示「正在导出数据…」。

**构建验证**：dist-build17。

### 1.19 会话存储库自愈 · 禁用 WebRTC STUN 噪音 · 扩展加载日志点名

**背景**：上一轮修复导出卡死后，终端日志仍残留三类报错，本版本逐一归因并处理：
- `quota_database Could not open the quota database` / `service_worker_storage Database IO error`：持久分区 `persist:focus-locker-browser-views` 的会话存储库在磁盘上损坏/锁死（与导出卡死同源，系本机磁盘/文件系统异常所致）；
- `stun.l.google.com 解析失败`：BrowserView 内网页触发 WebRTC ICE 时反复解析 STUN 服务器，离线/无 DNS 时打印噪声；
- `ExtensionLoadWarning`：来自用户本机 `userData/extensions` 内安装的某个扩展不兼容（项目本身不随包携带任何扩展）。

**修复 1 · 会话存储库自愈（应用层兜底）**：
- `main/backup.js` 新增 `markPartitionCorrupt(dataDir)`：仅在 `cookies.get` 超时（确证会话存储损坏）时写入 `partition-storage-corrupt.flag`，避免误标；
- `main.js` 启动、创建 `browserViewSession` 之后、`loadCrxExtensions` 首次使用存储之前，检测该标记：将 `userData/Partitions/persist:focus-locker-browser-views` 备份为 `*.corrupt-bak-<时间戳>` 并清空，让 Chromium 重建一份干净的存储库，从而**消除 quota/service_worker IO 错误反复出现**（代价：该分区 cookie/localStorage 清空，网站需重新登录）。自愈后删除标记。

**修复 2 · 禁用 WebRTC STUN 噪音**：
- `main.js` 启动开关追加 `WebRtc`：`app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,WebRtc')`，专注场景无需 WebRTC，从源头停止 ICE/STUN 探测；
- 并在 `browserViewSession.webRequest.onBeforeRequest` 对走 HTTP(S) 的 `stun*` / `turn*` 请求追加 `cancel` 拦截，作为冗余兜底（注：`stun:` 私有方案不会被 webRequest 覆盖，故以全局禁用为主）。

**修复 3 · 扩展加载日志点名（排查 ExtensionLoadWarning）**：
- `main/extensions.js` 的 `loadCrxExtensions` 记录每个扩展的 `name` 与 `manifest_version`；
- 检测到 **Manifest V2** 扩展时显式告警「可能触发 Chromium ExtensionLoadWarning（MV2 已弃用）」，并在循环结束汇总「已加载扩展: 名称 (MVMx)」；
- 用户重跑后查阅 `%APPDATA%\FocusLocker\logs\app.log` 即可锁定具体扩展，再决定更新为 MV3 或在设置中禁用。

**构建验证**：dist-build18。

### 1.20 原生对话框被锁屏置顶遮挡（强制置顶导致位置选择界面看不见）

**症状**：设置页「导出选中数据」点击后，位置选择/保存对话框看不见、无法交互（导入及其它文件选择器同理）。

**根因**：锁屏 `overlayWin` 始终以 `screen-saver` 级 `alwaysOnTop` 置顶。上一轮（§1.18）把导出对话框父窗口从 `overlayWin` 改为 `null`，但 `null` 父窗口仍是**普通层级**，原生对话框依旧被 screen-saver 级的 overlay 压在下方 → 看不见。同理，所有 `dialog.showOpenDialog(overlayWin, …)` 文件选择器也都被同一 overlay 遮挡。

**修复**：
- 新增 `withOverlayLowered(fn)`：显示对话框前 `overlayWin.setAlwaysOnTop(false)` 临时取消置顶，对话框关闭后按 `forceAlwaysOnTop` 恢复 `screen-saver` 置顶（finally 保证恢复）；
- 新增 `showSaveDialogAboveOverlay` / `showOpenDialogAboveOverlay`，统一路由**全部** `dialog.showSaveDialog` / `dialog.showOpenDialog` 调用（导出、导入及所有文件选择器），一处修复覆盖所有同类遮挡；
- 对话框仍父级于 `overlayWin`（保持模态/置顶于锁屏之上），仅在其显示期间临时降级 overlay，关闭即恢复，锁屏策略不受影响。

**构建验证**：dist-build19。

## [1.4.0] §1.21 — 查看验证码时长 45s→75s
- 设置面板「查看验证码」临时关闭强制置顶的时长由 45 秒延长至 75 秒。
- 将原散落的 `45` 魔法数抽为常量 `VERIFY_CODE_SECONDS = 75`，同时更新提示文案「你有 75 秒时间查看验证码」。
- 配额（每次启动 2 次）、自动恢复逻辑不变。

**构建验证**：dist-build20。

## [1.4.0] §1.22 — 对话输入栏 / 命令补全面板（QQ 风格 + Tab 切下一个）
- 触发：在 `#agentInput` 输入 `/` 或 `/x` 即弹出暗色玻璃态浮层，参考 QQ bot 命令面板视觉（左：命令名 mono 字体高对比，右：描述文字）。
- 切候选：**Tab 切下一个**、**Shift+Tab 切上一个**、**↑ / ↓ 同步切**（面板打开时），全部循环。
- 选定：**Enter** 把当前高亮候选插入到输入框光标位并关闭浮层（不发送消息）；点击候选同样行为。
- 关闭：**Esc** 关闭、**失焦 150ms 后**关闭（留 click 派发窗口）。
- 数据源：项目内置 `COMMAND_CANDIDATES`（21 条 `/` 命令，每条带中文描述），可后续扩展。
- 兼容性：原有的 `↑↓` 历史消息浏览、`Enter` 调 `sendAgentMessage`、`Tab` 中文触发词单条兜底补全都保留。
- 视觉：`html[data-theme="light"]` 与暗色主题同步适配；浮层 12px 上圆角、12ms 入场动画、`rgba(99,102,241,0.28)` 当前项高亮。

**构建验证**：dist-build21。

---

## [1.4.0] §1.23 — 无 API 时本地指令自动处理 + 欢迎语指令说明
- 背景：未配置 DeepSeek API 时，发送任何消息都会回显「未配置 API Key」错误；而 `/` 类操作型指令本不需要 AI 推理。
- 新增 `get-api-configured` IPC（`main.js`）+ preload `isApiConfigured()`，renderer 在 `sendAgentMessage` 顶部检测：若输入以 `/` 开头且**未配置 API**，走本地指令通道，不再报错。
- 本地指令（`handleLocalCommand`，renderer 内）：调用主进程既有工具并回复「已执行」，支持：
  - `/add <内容>`（例：`/add 写报告 三月统计`）→ 添加待办；`/del <编号|内容>` → 删除；`/list` → 列出今日待办
  - `/timer <分钟> [备注]` → 倒计时；`/pomodoro` `/pause` `/reset` → 番茄钟；`/stats` → 专注统计；`/quote` → 格言
  - `/switch <网站>` → 切换网站；`/extend <分钟>` → 延长锁闭
  - `/rain` `/fire` `/waves` `/white` → 播放环境音；`/stop` → 停止；`/screenshot` → 截屏存文件库
  - `/help` → 列出全部本地指令；未识别的 `/` 指令回显 `/help` 提示
- 配置 API 后行为不变：`/` 指令照常交给 AI（AI 可调用同名工具），其余自由对话正常。
- 欢迎语改为 markdown，明确说明「未配置 AI 时可直接用指令操作」并列举常用命令。
- 改动文件：`main.js`、`preload.js`、`renderer/index.html`。

**构建验证**：dist-build22。

---

## [1.4.0] §1.24 · 欢迎语按有无 API Key 分两套

- 之前只有一套折中欢迎语（同时含"未配置 AI"说明）。现拆分为两套，启动 600ms 后按 `isApiConfigured()` 实际状态渲染：
  - **有 Key**：强调"已接入 AI，可聊天、分析文件"，指令作为快捷方式列出，保留上传文件说明。
  - **无 Key**：明确"当前未配置 AI，指令由本机直接执行"，列出本地指令，并提示"设置 → DeepSeek API Key 填入密钥即可开启 AI 对话"。
- 改动文件：`renderer/index.html`（欢迎语块由同步改 `async`，按 hasApi 分支 `appendMessage`）。
- **构建验证**：dist-build23。

---

## [1.4.0] §1.25 · 卸载清理计划任务（修复卸载后任务计划程序不断报错）

- **症状**：卸载应用后任务计划程序不断报错。根因：卸载脚本 `build/installer.nsh` 的 `customUnInstall` 只删快捷方式，未清理应用注册的计划任务；`main.js` 的 `before-quit` 仅删除两个看门狗任务，未删除自启动任务 `FocusLocker`。
- **应用注册的三个计划任务**（任务名见 main.js）：`FocusLocker`（自启动，ONLOGON /RL HIGHEST）、`FocusLockerGuard`（看门狗 task 模式，MINUTE /MO 1）、`FocusLockerGuardProc`（看门狗 proc 模式，MINUTE /MO 1）。卸载后前两者因 exe/vbs 已删除，每分钟 / 每次登录触发即报错。
- **修复**：`customUnInstall` 卸载时 `schtasks /Delete /TN <name> /F` 删除上述三个任务（任务不存在时 `/F` 仍返回非零，忽略退出码不中断卸载），并 `DeleteRegValue` 清理 HKCU `Run` 与 `StartupApproved\Run` 中的 `FocusLocker` 自启动项，避免登录时仍尝试启动已删除的 exe。
- **设计取舍**：自启动任务 `FocusLocker` 仅在卸载时删除，不放入 `before-quit`——否则正常退出后自动启动失效（下次登录不再拉起应用）。看门狗任务属会话级，优雅退出时仍由 `before-quit` 清理。
- **构建验证**：dist-build25（NSIS 编译通过，产物 `FocusLocker Setup 1.4.0.exe`）。

---

## [1.3.2] - 2026-08-24 · 网站视图填满面板 · 经典布局去除留空 · toast 位置收敛 · 经典模式每日任务提醒改为通知中心

对应标签：v1.3.2

### 版本概述

本版本围绕「网站视图铺满」与「经典布局通知收敛」继续打磨，均为向后兼容的缺陷修复与小幅交互调整：

- 网站视图（Modern 现代布局）在有网页时**彻底透明铺满** `.site-stage` 内容区（即用户标注的红色边框区域），仅当无网页时展示居中占位引导框；
- 经典（左右分栏）布局去除网站右侧留空：取消末尾 22px（`NC_EDGE_PX`）预留，网页铺满整个右侧面板；
- 通知设置中「Toast 弹出位置」**移除「右上 / 右下」两个选项**，仅保留「左上 / 左下」，旧偏好自动回退到「左上」；
- 经典模式下「锁屏时段结束但每日任务未达标」的常驻顶部横幅**改为**：通知中心内置「常驻置顶」条目 + 每 5 分钟弹出一次桌面 toast（直至解除锁定）；现代模式保持不变，仍显示顶部常驻横幅。

属 PATCH 级别：无破坏性变更、无新 IPC 协议、无配置格式变更。

### 一、缺陷修复与交互调整

#### 1.1 网站视图 Modern 布局铺满内容区

- **现状**：此前 `.site-stage` 始终带虚线边框 + 半透明深色背景并居中渲染占位提示，即使有网页透出，BrowserView 仍可能被容器样式视觉遮挡边缘；用户希望网页能拓到红色标注区域（header 之下、左右到窗口两侧、底部到底）。
- **修复**：
  - `.site-stage` 默认透明（无边框/背景）；新增 `body.site-active` 状态——在进入网站页且存在有效 `currentSiteName + url` 时由 JS 标记；仅 `body:not(.site-active) .site-stage` 显示引导框与居中占位（`.site-stage-placeholder` 包裹图标/名称/副标题，有网页时 `display:none`）；
  - 网页透出层（BrowserView）始终铺满 `.site-stage` 包围盒，渲染端 `syncSitePanelBounds()` 上报的 `left/top/width/height` 不变，故网站精确占满红色边框区域；
  - `siteList` 在初始化时缓存到 `currentSiteName` 判定中，确保刷新后也能正确识别「有网页」状态。

#### 1.2 经典布局网站右侧留空

- **根因**：`updateBrowserViewBounds()` 经典分支此前为「右侧拖拽手柄」预留 `NC_EDGE_PX=22` 宽度，但经典布局现已无右侧通知中心拖拽热区，导致网页右侧留出可见缝隙。
- **修复**：经典分支 `visibleBounds.width` 改为 `rightWidth`（不再减 `NC_EDGE_PX`），顶部保留 `TOP_BAR_PX=0`（顶部全宽进度条由 DOM 浮于 BrowserView 之上覆盖，无需预留）。网页铺满整个右侧 `.right` 面板。

#### 1.3 Toast 弹出位置收敛（移除右上/右下）

- **背景**：经典布局右侧为网站、无右侧停靠区，「右上 / 右下」角落会被网页遮挡，意义不大且易造成「通知被盖住」的错觉。
- **修复**：
  - 设置页「Toast 弹出位置」仅保留「左上 / 左下」两个按钮；
  - 新增 `ALLOWED_CORNERS = ['tl','bl']` 与 `cornerAllowed()` 守卫：`setNotifCorner()`、`showToast()` 对非法 corner（含旧持久化的 `tr`/`br`）一律回退「左上」；`loadNotifPrefs()` 读取时也做回退，杜绝旧配置残留。

#### 1.4 经典模式每日任务阻塞提醒重构

- **背景**：经典布局下顶部常驻横幅会被右侧网站视图遮挡，用户看不到「请完成每日任务」提醒。
- **修复**（仅当 `body.layout-legacy`）：
  - **通知中心常驻条目**：调用 `notify(..., {pinned:true, read:true})`，同一 `category` 仅保留一条并置顶渲染（`.nc-item.pinned` 暖色描边 + 「· 常驻」标签，`renderNotifyHistory()` 将 `pinned` 项排在列表最前）；不计入未读红点；
  - **每 5 分钟桌面 toast**：进入阻塞态时立即弹一次，随后 `setInterval(5×60×1000)` 重复，直至 `daily-task-unblocked` 或切回现代模式 / 关闭遮罩时 `stopDailyBlockLegacy()` 清理定时器；
  - 现代模式保持原顶部常驻横幅逻辑不变；
  - 防御：未配置每日任务（`total<=0`）或解阻塞时，清除横幅并停止定时器。

#### 1.5 Toast 快速连发错位修复

- **症状**：连续快速触发多条 toast（如连续保存设置、连续快捷键反馈）时，已有的悬浮卡片出现明显的纵向间距错位（例如 4 张卡片间距依次为 105/105/165，最后一张明显离上一张更远）。
- **根因**：原先用 `transform: translateY(±(100%+0.8vh))` 的 `.toast-item.shifted-up/down` 类，在新 toast 进入时给所有旧卡叠加 transform 模拟"顺移让位"。但 `dismissToast` 在 `removeChild(el)` 之后才取 `el.parentNode` 来清掉旧卡的 shift 标记——而此时 `parentNode` 已为 `null`，清除分支永远不执行，导致已离场 toast 之外的所有剩余卡片**永久残留** `shifted-up/down`。新 toast 来时再次 add 同样的 class，CSS 因属性未变不再触发 transition，只在 transition 进行中、或配合 leaving 时才呈现部分位移动画，多卡片累计即出现错位。
- **修复**：
  - **改用 flex 自然堆叠**：`.corner` 容器已为 `display:flex; flex-direction:column; gap:1vh`，新 toast 直接 `appendChild` 到底部即可自然落在最远位置，旧卡原地不动、剩余空间由 `gap` 自动分布，**彻底去掉 transform 错位来源**；
  - 删除 `.toast-item.shifted-up` 与 `.toast-item.shifted-down` 两条 CSS 规则；
  - 简化 `showToast()`：删除「遍历旧卡加 shift class」的循环，仅保留「append → reflow → add .show」三步；
  - 简化 `dismissToast()`：先 `el.parentNode` 暂存再 `removeChild`（防御性，不再依赖 cornerEl 清 shift，因为已经无 shift 可清）；
  - 离场动画保留并按角落反向：`.corner.bl/.br .toast-item.leaving` 由「向上滑出」改为「向下滑出」，更贴近角落方向感。
- **验证**：使用 Edge headless + CDP 注入独立测试页 `_toast_test.html`，以 80ms 间隔连发 6 条 toast、随后再补 3 条，结果 4 张稳态卡片（MAX=4）Y 坐标依次 `26 / 101 / 176 / 252`，间距 `75 / 75 / 76` **严格等距**；手动 dismiss 一张后剩余 3 张自动回位到 `26 / 101 / 176`，class 全部为 `toast-item info outline show`，**无任何 `shifted-*` 残留**。

#### 1.6 现代模式通知中心常驻 daily 提醒 + 拖拽模式固定 0.95 高度

- **症状 A（缺陷）**：用户观察到现代模式下「锁屏时间已结束…」常驻提示只在顶部 banner 显示，**通知中心里没有**任何对应条目，关掉 banner 后用户完全看不到这个状态。
- **根因**：`onDailyTaskBlocking()`（renderer/index.html line ~9510）原实现为：modern 模式下显示顶部 banner 后**提前 `return`**，不调用 `notify({pinned:true, ...})`；仅 legacy 模式才有把该常驻条目写入 `NOTIF_STATE.history`。结果：modern 模式通知中心永远缺这条 pinned 提示。
- **症状 B（用户细化偏好）**：用户纠正「通知中心高度不是固定 0.95 才有问题，**只对拖拽（pinned）模式**要固定；点击铃铛唤出的 popup 模式保持原来的自适应（按内容撑高）即可。」
- **修复**：
  - 重写 `onDailyTaskBlocking`：去掉 modern 模式提前 return，**modern 也调用 `notify({pinned:true, ..., read:true})`**（read=true 避免红点持续打扰），然后 `showToast` 立即弹一条；每 5 分钟周期 toast 仅 legacy 模式下保留（modern 已有顶部 banner 常驻，无需重复打扰）；
  - `clampNotifyCenterHeight(mode)` 本就按 mode 区分（line ~7371），drag 模式设 `Math.floor(window.innerHeight * 0.95) + 'px'`、popup 模式清空内联高度让 CSS 自适应——**正好符合用户细化要求，无需改动**；
  - popup 模式默认 CSS `max-height: calc(100vh - 6.5vh)` 作为兜底防止溢出，关闭时清空内联（line ~7419），下次打开仍走 CSS 自适应。
- **验证**：Edge headless + CDP `_nc_test.html` 注入 1 条 pinned daily + 2 条普通（系统 / 任务）后分别打开两种模式：

  | 模式 | 内联 maxH | rectH | inner95(0.95×800) | items | daily 排第一 |
  | --- | --- | --- | --- | --- | --- |
  | popup | （空 → CSS 自适应） | **330**（跟内容） | 760 | 3 条 | 是（暖色描边 + "· 常驻"） |
  | drag | **760px** | **760** | 760 | 3 条 | 是 |

  popup 跟随内容自适应（3 条占 330 高），drag 严格锁定 `0.95 × innerHeight = 760px`，两者互不影响。

#### 1.7 修复「拖拽无法唤出通知中心」（热区未绑定）

- **症状**：应用启动后（尤其是重启 / 未打开过「设置」页的会话），从窗口右边缘向左拖拽**完全唤不出**通知中心，热区看似存在却毫无反应。
- **根因**：拖拽热区的事件绑定函数 `bindNcEdgeZone()` 原本**只在「设置」页打开时**（`loadFocusSettingsToUI()` 内）被调用。启动时 `DOMContentLoaded` 仅调用了 `loadNotifPrefs() → applyDragOpenState()`（给 `#ncEdgeZone` 加上 `.enabled` 类、使其可见可命中），却**从未把 `pointerdown/pointermove/pointerup` 监听器绑到该元素上**。结果：热区元素可见且 `elementFromPoint` 命中的是它，但因为没有监听器，「拖拽」手势永远不会触发 `setNotifyCenter(true, 'drag')`，表现就是"拖拽无效"。一旦进过设置页，`bindNcEdgeZone` 才会补绑（所以旧会话里"偶尔能用"）。
- **修复**：在 `DOMContentLoaded` 启动流程里、`await loadNotifPrefs()` 之后**显式调用 `bindNcEdgeZone()`**（该函数内部有 `zone._bound` 幂等守卫，重复调用安全）；保留设置页内的调用作为兜底。
- **验证**：Edge headless + CDP 注入 stub `window.utils` 完整模拟启动后：
  - 修复前：`#ncEdgeZone` 虽 `enabled` 但 `bound:false`，`elementFromPoint` 右边缘命中 `#leftArea`，模拟拖拽 `ncOpen:false`；
  - 修复后：`enabled:true`、`bound:true`、右边缘命中 `#ncEdgeZone z=99`，模拟向左拖拽 12 步后 `ncOpen:true, ncPinned:true`（即拖拽模式成功唤出）。

#### 1.8 简化非必要流程（清理 1.5–1.7 修复遗留的冗余代码）

- 纯代码清理，无任何行为变化（已逐项论证等价性）：
  - 删除 `showToast()` 中 `cornerEl.dataset.corner` 赋值及其注释——该属性是旧「shifted-*」顺移机制（1.5 已删除）的残留，全代码无任何读取方；
  - 删除 `bindNcEdgeZone()` 中 `hasPointer` 的 mouse 事件兜底分支——Electron 内置 Chromium 必然支持 `PointerEvent`，mouse 事件由 pointer 模拟产生，该分支为死代码；
  - 删除「设置」页 `loadFocusSettingsToUI()` 内的 `bindNcEdgeZone()` 调用——启动流程（`DOMContentLoaded`）已显式绑定，且函数有 `zone._bound` 幂等守卫，设置页处调用永远 no-op；
  - 删除 `onDailyTaskBlocking()` 的 `dailyBlockLegacyActive` 冗余标志——该标志仅在 `stopDailyBlockLegacy()` 中置 `false`，而后者同时 `clearInterval`，故周期回调中 `!dailyBlockLegacyActive` 恒为假，属不可达分支；保留 layout 切换防御检查。

#### 1.9 性能与体积优化（启动 IPC 并行化 · CDN 库本地化 · 死依赖移除）

- **启动 IPC 并行化**：`DOMContentLoaded` 启动流程中 8 个串行 `await window.utils.*()`（`getTestMode / getSites / getCurrentSite`、`getAlwaysOnTop / getSiteLock`、`getInstantMode / getQuickStartMode`）全部为只读 getter 且互不依赖，改为 3 组 `Promise.allSettled` 并行，省去约 5-6 次 IPC 往返的串行等待；行为零变化（各自取值后仍按原顺序应用 UI 状态）。
- **CDN 库本地化**：`marked@12.0.0`、`highlight.js@11.9.0`、`KaTeX@0.16.9` 三个库（含 `katex.min.css` 与 20 个 woff2 字体，共 26 个文件）从 cdnjs 下载到 `assets/vendor/` 本地引用，消除首启网络请求——断网/内网环境下面向 markdown、代码高亮、公式渲染不再失效。
- **移除死依赖**：`package.json` 移除 `marked` / `highlight.js` / `katex`（renderer 使用本地 vendor 版本，main.js 与 main/ 模块无任何 require，已全项目 grep 验证）。electron-builder 本就仅打包被实际 require 的依赖，故安装包体积几乎不变（实测 asar 中死依赖条目为 0），收益在于消除 node_modules 冗余、杜绝未来误用本地版本与 vendor 版本不一致。
- **验证**：asar 检查 1592 条目中 vendor 26 项 / KaTeX 字体 20 个全部打入、死依赖 0；`node --check` 全部通过；构建产物 `FocusLocker Setup 1.3.2.exe`（171,734,489 字节 ≈ 163.8MB）。

#### 1.10 修复悬浮横幅角落偏好重启还原为右下（未保存）

- **症状**：用户更改通知横幅角落（如左上/左下/右上）后，会话内生效，但重启后永远回到右下（默认 `br`），偏好看似「无法保存」。
- **根因**：`DOMContentLoaded` 启动顺序为 `applyLayoutStyle()`（line 11154）先于 `await loadNotifPrefs()`（line 11170）。`applyLayoutStyle()` 内部会调用 `setNotifCorner(NOTIF_STATE.corner)` 来按布局重校验/重绘角落按钮——而此时偏好尚未加载，`NOTIF_STATE.corner` 仍是默认 `'br'`。`setNotifCorner` 末尾 `persistNotifPrefs()` 把默认值 `'br'` **写回主进程文件**，覆盖了用户已保存的角落；随后 `loadNotifPrefs()` 读到的已是被覆盖的 `'br'`，于是每次重启都还原右下。
- **修复**：
  - 抽出无副作用的 `applyNotifCornerUI(corner)`（仅约束非法值 + 设置状态 + 重绘按钮显隐，**不持久化**）；
  - `setNotifCorner(corner)` 改为 `applyNotifCornerUI(corner) + persistNotifPrefs()`（保持按钮点击行为不变）；
  - `applyLayoutStyle()` 改用 `applyNotifCornerUI`（不持久化），彻底杜绝启动阶段用默认值覆盖已保存偏好；
  - 用户显式切换布局（`setLayoutStyle`）时仍调用 `persistNotifPrefs()`，保证 modern→legacy 等导致角落被约束（tr/br 回退 tl）时的有效角落被正确保存。
- **验证**：`node --check` 内联脚本全过；函数引用一致性核对通过（按钮 `onclick`、启动、设置页加载均指向正确函数）。

#### 1.11 暗色模式重新设计（整体提亮 · 背景层次可区分）

- **动机**：原暗色基底过暗（body `#0a0a0f`、panel `rgba(18,18,26,.82)`），且 surface 层级用 `rgba(255,255,255,0.03/0.055/0.08/0.10)` 的极小白叠加步进——各层几乎不可区分，卡片、面板、悬浮态在纯黑上「糊成一片」，难以辨别不同背景元素。
- **调整（` :root` 暗色变量，亮色主题未动）**：
  - 基底提亮：`--bg-body #0a0a0f → #14151d`；`--bg-overlay rgba(10,10,15,.65) → rgba(20,22,32,.70)`；`--bg-panel rgba(18,18,26,.82) → rgba(30,32,44,.90)`（更亮且更不透明，不再透出泥泞底色）。
  - **核心修复——拉开 surface 步进**：`01/02/03/hover` 由 `0.03 / 0.055 / 0.08 / 0.10` 改为 `0.06 / 0.10 / 0.15 / 0.22`，相邻层级亮度差约翻倍，卡片 / 输入框 / 悬浮态清晰可辨。
  - 玻璃描边提亮：`--glass-border 0.08 → 0.12`、`--glass-border-strong 0.14 → 0.22`，卡片轮廓可见。
  - 文字微调：`--text-secondary #94a3b8 → #aab4c5`、`--text-muted #64748b → #7e8aa0`，次级文字更易读。
  - 预览层提亮：`--preview-bg rgba(8,8,12,.96) → rgba(16,17,26,.96)`、`--preview-grid 0.015 → 0.03`。
- **一致性对齐**：散落硬编码的暗色基底同步抬亮，避免新旧底色交错——`#countdownChip` 渐变、`.site-stage` 占位底、`body.site-view .agent-panel` 渐变、`layout-legacy .right` 面板、`body.ambient-active .overlay` 遮罩中的 `rgba(10,10,15,…)` / `rgba(8,8,12,…)` / `rgba(0,0,0,.22)` 一并改为相近的 `rgba(20,21,29,…)` / `rgba(16,17,25,…)` / `rgba(12,13,20,.30)`。
- **验证**：`node --check` 内联脚本全过；grep 确认暗色基底 `rgba(10,10,15)` / `rgba(8,8,12)` / `#0a0a0f` 在暗色语境下已无残留；亮色主题变量零改动。

#### 1.12 通知中心列表滚动支持修复

- **症状**：通知记录较多时，通知中心（popup / pinned 两种模式）列表不出现滚动条，超出部分被容器 `overflow:hidden` 直接裁掉，无法查看更早的通知。
- **根因（flexbox 经典滚动失效）**：`.nc-list` 设为 `flex:1; overflow-y:auto`，但 flex 子项默认 `min-height:auto`，拒绝收缩到比内容更小——于是列表撑满直至顶破 `#notifyCenter` 的 `max-height`（popup）或固定高度（pinned），容器裁切溢出而非列表内部滚动。
- **修复（纯 CSS，行为零变化）**：
  - `.nc-list` 加 `min-height:0`（允许收缩，`overflow-y:auto` 才真正生效）；`flex:1` 改为 `flex:1 1 auto` 更稳。
  - 补深色主题滚动条样式（此前仅有浅色在 763 行附近）：细 8px、`rgba(124,140,250,0.30)` 靛蓝 thumb、悬停加深 `0.5`，并设 `scrollbar-width:thin / scrollbar-color` 兼容 Firefox；与浅色风格统一。
- **验证**：构建 `dist-build10/FocusLocker Setup 1.3.2.exe` 成功；asar 提取确认 `min-height: 0` 与 `nc-list::-webkit-scrollbar-thumb` 均已打入。

#### 1.13 新功能：生产模式「查看验证码」（临时关闭强制置顶 45s）

- **需求**：生产（非测试）模式下，一键临时关闭窗口强制置顶 45 秒，便于切去别处看验证码；到点自动恢复，并给出提示。
- **背景**：原 `toggleAlwaysOnTop()`（main.js）在 `!isTestMode` 时直接 `return`——置顶切换是测试模式专属；生产模式的强制置顶来自窗口创建时的 `alwaysOnTop:true`，无临时关闭通道。
- **实现**：
  - main.js 新增 `setOverlayAlwaysOnTop(enabled)`（**不受 isTestMode 限制**），置 `forceAlwaysOnTop` 并 `overlayWin.setAlwaysOnTop(...)` + 广播 `always-on-top-changed`；注册 IPC `set-always-on-top`。
  - preload.js 暴露 `window.utils.setAlwaysOnTop(enabled)`。
  - renderer：dock 新增 `#verifyCodeBtn`（图标 `icon-eye`，琥珀色），**仅生产模式可见**（默认 `display:none`，启动 `!isTestMode` 时 `inline-flex`；`.is-test-mode #verifyCodeBtn{display:none!important}` 双保险，与置顶/退出测试互斥）。`viewVerificationCode()` 调 `setAlwaysOnTop(false)` → 提示「已临时关闭强制置顶，你有 45 秒时间查看验证码」→ 按钮内联倒计时 `验证码 (Ns)` → 45s 后 `setAlwaysOnTop(true)` + 提示「已恢复强制置顶」；`verifyCodeActive` 防连点。
- **验证**：`node --check` 全过（main/preload/内联脚本）；构建 `dist-build11`。

#### 1.14 图标统一为 Lucide 开源集（SVG sprite 保留）

- **需求**：把项目内图标统一为一套一致的开源图标集（保留 `<symbol>`+`<use>` 的 SVG 架构，非系统/Chromium 私有图标——网页内容无法引用 Chromium 内置图标）。
- **做法**：以 Lucide（Feather 现代化继任者，MIT，24×24、`stroke=currentColor`/width 2）为统一源；用 `lucide-static` 官方 SVG 的内部形状替换全部 45 个 `<symbol>` 内容，原 id 与属性（`viewBox 0 0 24 24 / fill none / stroke currentColor / width 2 / linecap·linejoin round`）保持不变 → 所有 141 处 `<use>` 引用零改动继续生效；内部 `class`/`fill` 属性被剥离以强制统一描边风格。
- **映射要点**：`icon-todo→list-checks`、`icon-test→flask-conical`、`icon-quick→zap`、`icon-chat→message-circle`、`icon-focus→crosshair`、`icon-export→download`、`icon-warning→triangle-alert`、`icon-success→circle-check`、`icon-audio→audio-lines`、`icon-document→file-text`、`icon-markdown→file-type`、`icon-mute→volume-x`、`icon-volume→volume-2`、`icon-fullscreen→maximize`、`icon-alarm→alarm-clock`、`icon-rain→cloud-rain`、`icon-waves→waves`、`icon-fire→flame`、`icon-plug→plug`、`icon-coffee→coffee` 等（其余 1:1 同名）。
- **验证**：替换后 symbol 数 45、`<use>` 孤儿引用 0；asar 提取确认 icon 集合已更新；构建 `dist-build12`。

### 二、已知问题

- 经典模式右侧网站铺满后，若用户同时开启「右侧拖拽唤出通知中心」（`dragOpen`），该热区在现代布局才生效，经典布局下无影响；
- 经典模式每日任务 toast 每 5 分钟一次，若用户长时间不处理会持续弹出，属预期提醒行为。

### 三、反馈

如有问题或建议，欢迎在 GitHub Issues 提交，或于应用内「设置 → 配置文件」板块留言。

---

## [1.3.1] - , 2026-08-24 · 通知中心定位修复、红点提醒开关与网站视图对齐

对应标签：v1.3.1

### 版本概述

本版本聚焦通知中心与网站视图的交互细节修复，并新增一项默认开启的偏好设置，全部为向后兼容的缺陷修复与小幅功能调整：

- 修复通知中心弹层定位错误（始终落在右上角而非触发按钮附近）；
- 新增「显示通知中心红点提醒」开关，默认关闭（即默认不显示红点），与既有 `focusSettings` 偏好一同持久化、跨重启保留；
- 修复网站视图（BrowserView）右侧与底部出现空白的问题，并将网页内容区与对话/文件/设置等其他面板内容区像素级对齐。

属 PATCH 级别：不引入破坏性变更，不新增模块，仅修复缺陷与新增一个可选配置项。

> **相对 1.2.0 的累计变化（含 1.3.0 与 1.3.1）**
> 自 1.2.0 起，本产品历经 1.3.0 与 1.3.1 两次向后兼容迭代，累计新增与修复如下：
> - **新增 · 每日任务完成门槛**（1.3.0）：锁定设置新增「每日任务完成比例」（10%–100%，默认 60%），未达标时遮罩无法解锁并弹常驻提示条；新增 `daily-task-blocking` / `daily-task-unblocked` IPC。
> - **新增 · 遮罩顶部任务完成度进度条**（1.3.0）：全宽 6px 进度条，未达标琥珀色、达标绿色发光，白色刻度指示阈值；两种布局下 BrowserView 自动避让，无任务时自动隐藏。
> - **修复 · 扩展禁用失效 / 误加载非本目录扩展**（1.3.0）：解压目录独立为 `ext-unpacked`、跳过 hash 目录、禁用项强制 `removeExtension`、禁用键改为与位置无关的相对键。
> - **修复 · 自定义 CSS 与原站 CSS 重叠**（1.3.0）：自定义 CSS 以「user 来源 + `!important`」注入，跳过字体相关声明。
> - **修复 · 扩展开关无法启用**（1.3.0）：开关 `onchange` 误绑 `<label>`，改为绑内部 `<input>`。
> - **修复 · 文件预览亮色模式适配**（1.3.0）：预览容器 / 媒体舞台 / 代码高亮改用 CSS 变量驱动亮暗双主题。
> - **新增 · 显示通知中心红点提醒开关（默认关闭）**（1.3.1）：设置页可切换，默认不显示未读红点；`dotHidden` 贯通渲染端偏好与主进程 IPC，跨重启保留。
> - **修复 · 通知中心弹层定位错误**（1.3.1）：原锚定已删除的 `#notifyBell` 导致弹层恒落右上角；改为锚定 `#panelNotifyBtn`，定位到按钮左下方，并清理死 CSS。
> - **修复 · 网站视图右侧 / 底部空白**（1.3.1）：删除现代布局下 `NC_EDGE_PX=22` 减宽与 `DOCK_RESERVED_PX=72` 底部预留；渲染端上报 `.site-stage` 完整 `left/top/width/height`，BrowserView 精确对齐。
> - **修复 · 网站视图与面板内容区像素级对齐**（1.3.1）：`TOP_BAR_PX` 由 8 改为 0，网页顶部不再低 8px，与对话 / 文件 / 设置面板同高。
>
> 全部为向后兼容调整：无破坏性变更、无新 IPC 协议、无配置格式变更。

### 一、缺陷修复

#### 1.1 通知中心弹层定位错误（落在右上角）

- **根因**：早期版本把网站面板铃铛 `#notifyBell` 替换为面板 header 内的通知按钮 `#panelNotifyBtn`，但弹层定位函数 `positionNotifyNearBell()`、外部点击关闭判定 `onNcOutsidePointer()` 与未读角标刷新 `bumpUnread()` 仍引用已删除的 `#notifyBell`。由于该元素不存在，`positionNotifyNearBell` 恒走「找不到按钮 → 回退右上角」分支，导致通知中心始终出现在屏幕右上角。
- **修复**：
  - 三处 JS 锚点由 `#notifyBell` 改为 `#panelNotifyBtn`，使用其 `getBoundingClientRect()` 实测几何，将通知中心定位到按钮左下方；
  - 删除已失效的 `#notifyBell` 整套样式（含 `:hover`、`.nb-dot`、`.has-unread`）及亮色主题遗留规则；未读红点改由 `#panelNotifyBtn .nb-dot.show` 控制显隐，逻辑不变；
  - 同步修正相关代码注释。

#### 1.2 网站视图右侧/底部空白

- **根因**：`updateBrowserViewBounds()` 现代布局分支硬编码 `width: bounds.width - NC_EDGE_PX`（右侧预留 22px 拖拽手柄）+ `height` 计算中 `DOCK_RESERVED_PX = 72`（为底部 dock 控件区预留）。但面板打开时底部 dock 已被 `body.panel-open .dock-wrapper` 整段隐藏，72px 预留成为纯空白；右侧 22px 同样因面板打开后 BrowserView 仍按窗口宽度减 22 而留出可见缝隙。渲染端 `syncSitePanelBounds()` 当时只上报 `{top, height}`，未传 `left/width`，主进程被迫用窗口硬尺寸兜底，无法精确对齐。
- **修复**：
  - 渲染端改为上报 `.site-stage`（fallback `.site-page`）的完整 `getBoundingClientRect()`：`{left, top, width, height}`；
  - 主进程 `set-site-panel-bounds` 接收并存储 `left/width`；`updateBrowserViewBounds` 现代分支直接用上报的精确矩形（夹紧到屏幕内）作为 BrowserView 边界，**不再硬减 `NC_EDGE_PX`、不再减去 `DOCK_RESERVED_PX`**；
  - 删除现代分支的 `DOCK_RESERVED_PX = 72`；`NC_EDGE_PX` 仅在经典（左右分栏）布局继续生效，注释同步说明。

#### 1.3 网站视图与面板内容区像素级对齐

- **背景**：DOM 布局上 `.site-stage` 已是 `inset:0` 撑满 `.site-page`（header 以下），与对话/文件/设置等面板内容区同高；宽度经 1.2 的精确包围盒上报也已一致。但主进程 `TOP_BAR_PX = 8` 仍把 BrowserView 整体下压 8px，导致网页顶部比别的面板内容低 8px、视觉上「矮一截」。
- **修复**：`TOP_BAR_PX` 由 `8` 改为 `0`。理由：BrowserView 为原生视图、永远位于 DOM 之下，面板 chrome 与进度条等 DOM 本来就浮在其上，从 `y=0` 起不会遮盖任何界面元素，无副作用。改动后网站网页与相邻面板内容区像素级对齐、占满面板内容区。

### 二、新增功能

#### 2.1 「显示通知中心红点提醒」开关（默认关闭）

- 需求：默认不显示通知中心未读红点，并可在设置界面自由切换。
- 实现：
  - `NOTIF_STATE` 新增 `dotHidden: true`（默认隐藏红点）；
  - 渲染端新增 `setNotifDotHidden(hidden)` 与 `applyDotHiddenState()`，设置开关 `#notifDotCheck` 反向绑定（`checked = !dotHidden`）；`bumpUnread()` 计算 `showDot = unread>0 && !dotHidden`，隐藏时不挂 `.has-unread`、不显示 `#nbDot`；
  - 设置页通知区块新增一行「显示通知中心红点提醒」复选框；
  - 持久化链路贯通：`persistNotifPrefs()` / `loadNotifPrefs()` 携带 `dotHidden`；main.js `focusSettings` 默认 `notifDotHidden: true`、`loadFocusSettings` 合并、`get-notif-prefs` / `set-notif-prefs` 读写、`save-focus-settings` 校验保留该字段（不被专注设置保存覆盖）。

### 三、兼容性与升级指引

- 本版本为 PATCH 增量，与 v1.3.0 完全向后兼容，覆盖安装即可，无需手工合并配置；
- 通知偏好（样式、角落、边缘拖拽、红点开关）均经主进程 `focusSettings` 持久化，升级后保留用户既有选择；
- 网站视图改动仅影响 BrowserView 几何计算，不改变 IPC 协议与配置格式。

### 四、已知问题

| 编号 | 问题描述 | 影响范围 | 临时处理方式 |
|---|---|---|---|
| 1 | 网站视图在面板高度拖拽过程中，BrowserView 边界随 `mousemove` 实时同步；若在动画中途（面板滑入 0.4s 内）强制刷新坐标可能出现短暂错位，已由 `transitionend` 监听与 450ms 兜底同步覆盖。 | 频繁拖拽/快速切换面板的用户。 | 等待动画结束或松开鼠标后自动校准，无需手动干预。 |

### 五、贡献与反馈

- 缺陷报告与功能建议请提交至项目 Issues 页面：https://github.com/HMZ137/FocusLocker/issues 。

---

## [1.3.0] - 2026-08-22 · 每日任务完成门槛、扩展系统修复与界面适配

对应标签：v1.3.0

### 版本概述

本版本新增「每日任务完成门槛」体系（可自定义完成比例、遮罩顶部进度条、超时未达标常驻提示），并系统性修复了扩展管理与自定义 CSS 注入的多项缺陷，同时补齐文件预览的亮色模式适配。属向后兼容的功能新增与缺陷修复。

### 一、缺陷修复

#### 1.1 扩展禁用失效与误加载非本目录扩展

- **根因**：`.crx` 解压目录与扩展扫描目录重叠，每个 `.crx` 解压出的 `<name>-<hash>` 目录被当成「另一份已解压扩展」再次加载；禁用键以绝对路径存储，重装/改路径后键不匹配导致禁用自动失效。
- **修复**：
  - 解压目录从 `userData/extensions` 改为独立的 `userData/ext-unpacked`，与扫描目录解耦，从源头杜绝重复加载；
  - `discoverExtensions` 跳过形如 `<基础名>-<10位hash>` 的目录，兼容并忽略旧版残留缓存；
  - 加载前对禁用项（`.crx` 按 `fileHash` 还原解压目录）调用 `session.removeExtension` 强制卸载，确保禁用确实生效；
  - 禁用状态键由绝对路径改为与安装位置无关的相对键（`base:extensions/x.crx` / `data:extensions/x.crx`），并兼容旧版绝对路径键，跨重装/打包后禁用依然有效。

#### 1.2 自定义 CSS 与原站 CSS 抢位置/重叠

- **根因**：自定义/用户 CSS 以默认的「作者来源（author）」注入，与网页自身样式同优先级，二者按属性各赢一部分，表现为布局重叠。
- **修复**：自定义 CSS 以「用户来源（user）」注入并自动提升为 `!important`，稳定盖过原站正常样式；对 `font-family`/`font`/`src`/`content` 等字体相关声明跳过，避免图标字体被覆盖成方块占位符。

### 二、新增功能

#### 2.1 每日任务完成门槛（自定义比例 + 常驻提示）

- 锁定设置面板新增「每日任务完成比例」配置项（10%–100%，步进 5%，默认 60%），修改后下次遮罩生效；阈值持久化为 `focusSettings.dailyTaskRatio`。
- 锁定时段结束后，若任务完成率未达阈值，遮罩无法解锁，底部弹出**常驻提示条**提醒用户未完成最低任务量（节流 30 秒）；完成任务达标后自动消失。
- 新增 `daily-task-blocking` / `daily-task-unblocked` IPC 事件，任务勾选实时驱动提示条显隐。

#### 2.2 遮罩顶部任务完成度进度条

- 遮罩顶部新增全宽 6px 进度条：填充宽度 = 当前完成率，未达标为警示琥珀色，达标后变为绿色并发光；白色刻度线动态指示阈值位置。
- 适配两种布局模式：左右布局（经典）与全屏布局（现代）下网站 BrowserView 均自动下移避让，进度条始终完整可见。
- 无每日任务时自动隐藏，`pointer-events: none` 不影响顶部交互。

### 三、其他修复与适配

- **扩展开关无法启用**：扩展/用户脚本/用户样式三个列表的开关 `onchange` 误绑在 `<label>` 上导致状态恒为 falsy，点击启用实际执行禁用；已改为绑定内部 `<input>`，并在主进程 toggle 处理器增加布尔参数校验。
- **文件预览亮色模式适配**：预览容器与媒体舞台背景改用 CSS 变量（`--preview-bg`/`--preview-grid`/`--surface-*`），亮/暗两套配色；highlight.js 主题改为 `--code-*` 变量驱动（暗色 atom-one-dark / 亮色 atom-one-light），移除写死的 CDN 主题样式。
- **官网同步更新**：下载页、样式与资源小幅迭代，新增 favicon 与一键启动脚本。

---

## [1.2.0] - 2026-08-22 · 多模态对话、亮色模式重构与升级数据保留

对应标签：v1.2.0

### 版本概述

本版本在 v1.1.0 基础上新增「多模态对话」能力，支持在智能助手中上传图片并自动调用 DeepSeek 视觉模型进行识别；同时系统性重构了亮色主题的视觉层次，彻底解决浅色模式下对比度不足、背景氛围不可见、配置卡片深底等系列问题；并补全了 NSIS 覆盖升级期间 config.js 用户自定义内容的保留机制。

### 一、新增功能

#### 1.1 多模态对话（图片上传 + DeepSeek Vision）

- 智能助手新增图片上传能力；用户在对话文件库选中图片后，附件区自动区分图片与文本，图片型附件标记为 `isImage`，避免走文本解析路径。
- 发送消息时，当用户上下文包含图片，自动切换 DeepSeek 模型为 `deepseek-v4-flash-vision-exp`；纯文本消息继续使用 `deepseek-v4-flash`，避免视觉模型 token 浪费。
- 消息体按 DeepSeek 官方文档构造：图片仅出现在 user message 的 content 数组中（与 text 块并列），system/assistant 消息绝不夹带图片，以杜绝 400 错误。
- 新增 IPC `read-image-data-url`，对上传图片做格式与大小校验：支持 jpg/jpeg/png/gif/webp，单张 ≤32MB，非法文件直接返回错误并提示。
- 图片以 base64 data URL 形式注入消息，无需额外文件服务，保持离线可用。

#### 1.2 亮色模式系统性重构

本版本对亮色主题执行了一次"非透明度优先"的结构性改造，所有修改均严格限定在 `html[data-theme="light"]` 选择器内，不影响暗色模式：

| 区域 | 旧表现 | 新表现 |
|---|---|---|
| 面板容器 agent-panel | 沿用暗色半透明渐变，透出底噪 | 实心浅灰白 `#f8f9fc`，顶栏边框浅灰，阴影降浓度 |
| 配置卡片 config-card | 硬编码深灰 `rgba(14,14,22,0.55)`，文字对比度极低 | 纯白 `#ffffff` 实心，标签加粗深字 `#1e293b`，提示文字 `#64748b`，输入框浅灰 `#f1f5f9` |
| 标签栏（对话/专注/网站/文件/设置） | active/非active 区分微弱，近透明胶囊无层次 | 容器浅灰底 `#eef2f7`，非active 深字 `#475569`，active 深紫渐变 `#4f46e5→#6366f1` 配白字并配投射阴影 |
| 每日任务面板 | 半透明紫底在亮底对比度不足 | 浅灰底 `#f1f5f9`，进度条深灰轨道，任务项文字 `#334155`，自定义 checkbox 白底深边 + hover 紫边 |
| 背景氛围光晕（bg-fx） | 位于 z-index 0，overlay 实心色完全遮住 | **提升到 z-index 2**，叠在 overlay 之上；overlay 改为半透明白底（常规 0.85 / ambient-active 0.78），光晕不透明度从 0.30 提升到 0.60 / 0.72，视觉层次与暗色模式对齐 |
| 设置面板顶栏操作按钮 | 暗色半透明按钮在亮底不可读 | 浅灰底 `#eef2f7`，深字 `#475569`，hover 加深背景 |
| 测试模式提示 .test-notice | 紫字浅底对比度不足 | 增强紫底 `rgba(99,102,241,0.22)`，深紫字 `#4f46e5`，边框加深 |

#### 1.3 升级期 config.js 数据保留

- 新增 NSIS `installer.nsh` customInit 宏：安装期 extraFiles 覆盖旧 config.js 之前，先将旧版 config.js 备份到 `%APPDATA%\FocusLocker\config.legacy.js`。
- 增强 main/config.js 的 `migrateUserData`：当 `config.legacy.js` 存在且 `config.json` 中对应字段为空时，将 legacy 字段合并写入 userData 下的 config.json；合并逻辑兼容旧配置的两种导出形态：`module.exports` 与 `export default`。
- 与 v1.1.0 已实现的可变数据迁出安装目录机制互为补充：config.js（用户手工自定义内容）由本链路保护，其他运行期数据（settings/stats/files/todos/sounds）由 dataDir 迁移保护，覆盖升级后三类自定义数据全部保留。

### 二、缺陷修复

| 模块 | 缺陷描述 | 修复方案 |
|---|---|---|
| 媒体播放器 | 视频/音频播放控制条的播放、暂停、静音、全屏四枚按钮将 SVG 源码以纯文本形式裸露显示，功能图标不可见。 | 定位根因：`mkMediaBtn` 函数对按钮节点使用 `b.textContent = svgString`，改为 `b.innerHTML`；SVG 内容来自代码常量（`iconSvg()` 与局部字面量），无外部输入注入，XSS 风险为零。 |
| 数据迁移 | v1.1.0 虽把可变数据迁出安装目录，但 NSIS extraFiles 仍会覆盖安装目录下的 config.js，导致用户在 config.js 中手工修改的 sites/timeRanges/dailyTasks/deepseekApiKey 等在升级后回到模板值。 | 安装期备份 + 启动期合并双层防护（见「1.3 升级期 config.js 数据保留」）。 |
| 亮色主题 | 多处 UI 组件存在硬编码暗色值（config-card 的 rgba(14,14,22,0.55)、agent-tab 背景、daily-tasks-section 紫底等），先前仅做透明度微调，对比度与视觉层次仍不达标。 | 系统性改为"实色背景 + 显式文字/边框色 + z-index 层次重排"的结构性修复，详见「1.2 亮色模式系统性重构」。 |
| 亮色主题 · 环境音 | 开启环境音后，亮色模式下背景氛围光晕与暗色模式差异巨大，几乎不可感知。 | 将 `.bg-fx` 从 overlay 下方提到上方，并将 overlay 由实心 `#e8ecf2` 改为半透明白色作为基底，环境音激活时进一步提亮与提透，匹配暗色模式"基底 + 上层光晕"的视觉结构。 |

### 三、兼容性与安全说明

- 视觉模型自动切换：主进程 `callDeepSeekAPI` 在组装请求前扫描 messages 数组中 user 消息的 content 是否包含 image_url 块，据此选择模型；对 Kimi 等非 DeepSeek 通道无影响。
- 图片格式校验：`read-image-data-url` 校验失败时返回空 string，渲染层侧走失败分支，不污染对话上下文。
- `installer.nsh` 备份逻辑：若旧配置不存在（全新安装），customInit 仅跳过复制，不阻断安装流程。
- 配置合并优先级：`config.json` 已有字段 > `config.legacy.js` 对应字段 > config.js 模板默认值，保证用户最新保存的设置不被 legacy 覆盖。

### 四、升级指引

由 v1.1.0 升级至 v1.2.0：

1. 退出主程序与看门狗。
2. 使用 v1.2.0 安装包覆盖安装；**无需手工备份 config.js**，安装期会自动备份并在首次启动时合并。
3. 首次启动后，打开设置面板确认：
   - 白名单站点、锁屏时间段、每日任务、API Key 等均已正确合并；
   - 切换至亮色主题（设置面板中切换）后，浏览设置、对话、每日任务三页，确认白底深字、标签栏对比度、背景氛围均正常。
4. 如需体验多模态对话：在对话的文件库面板上传任意 jpg/png 等图片，勾选挂载后发送消息，观察提示词与模型自动切换行为。

### 五、已知问题

| 编号 | 问题描述 | 影响范围 | 临时处理方式 |
|---|---|---|---|
| 1 | 图片上传未做体积与像素的缩略图压缩，超大图（4K+ 分辨率近 30MB）上传后视觉模型响应可能变慢。 | 上传超大分辨率截图的用户。 | 压缩至 10MB 以下或 <2560 像素再上传。 |
| 2 | extensions 与 userscripts 目录尚未纳入安装期备份与启动期合并链路，覆盖升级可能丢失用户手工添加的扩展/脚本。 | 使用扩展/用户脚本功能的用户。 | 升级前手工备份 extensions/userscripts，升级后还原。 |
| 3 | 亮色模式下封面图（cover-layer）在同时启用自定义壁纸时，半透明叠加可能产生轻微色差；不影响锁屏解除逻辑与数据完整性。 | 使用自定义壁纸的亮色模式用户。 | 若介意色差，可在设置中切换到内置封面图。 |

### 六、贡献与反馈

- 缺陷报告与功能建议请提交至项目 Issues 页面：https://github.com/HMZ137/FocusLocker/issues 。

---

## [1.1.0] - 2026-08-21 · 每日任务面板与跨重装数据保留

对应标签：v1.1.0

### 版本概述

本版本在 v1.0.0 基础上新增「每日任务」能力，并修复了重装/升级导致用户自定义数据丢失的问题。新增的每日任务面板可与待办并列展示，任务可在 config.js 中预置并绑定倒计时；锁屏时段自然结束时，需完成当日全部任务的 60% 方可解除锁屏，作为紧急退出之外的「软约束」。数据持久化方面，所有用户可变数据（配置、专注统计、待办、文件库、自定义环境音等）从安装目录迁移至 userData 目录，NSIS 重装不再覆盖用户数据。

### 一、新增功能

#### 1.1 每日任务面板

- 新增「每日任务」配置项，位于 config.js 的 dailyTasks 字段，每项含 id、name、minutes（预设倒计时分钟数）；任务每天固定显示在待办页面的独立面板中，性质与待办一致。
- 任务列表采用可滚动设计，最大高度为 3.25 个任务栏高度；任务数 ≤3 时不滚动，≥4 时出现滚动条，并在任务切换或进入运行态时重新测算高度，适配不同屏幕尺寸。
- 新增进度条与勾选交互，实时反映当日任务完成情况。

#### 1.2 任务完成率与锁屏解除

- 锁屏时段自然结束（checkTimeAndToggle）前校验当日每日任务完成率；未达 60% 时保持锁定并下发 daily-task-blocking 提示（5 分钟节流），达标或未配置任务则正常解除锁屏。
- Alt+F4 / 关闭按钮拦截新增 blockByDaily 判定，未达标时拦截关闭并提示进度；通过 emergencyExitInProgress 标记放行紧急退出期间的关闭操作，确保紧急退出仍是可靠逃生通道。
- 完成率阈值与任务清单均在 config.js 配置；未配置每日任务时，解除锁屏逻辑与 v1.0.0 一致，不影响既有用户。

#### 1.3 AI 倒计时联动

- 扩展智能助手工具能力，识别「开始 xx 任务」指令，触发对应任务的预设时长倒计时；倒计时与每日任务清单联动，结束后标记完成。

#### 1.4 数据持久化

- 每日任务完成状态按日期持久化于 focus-settings.json（dailyTaskDate / dailyTaskCompleted），重启后保留当日进度。

### 二、缺陷修复

| 模块 | 缺陷描述 | 修复方案 |
|---|---|---|
| 数据持久化 | 用户可变数据（focus-settings.json、site-stats.json、focus-stats.json、uploaded-files.json、custom-sounds.json、timer-result.json、todos/、files/ 等）原存放于安装目录（baseDir），NSIS 重装会覆盖，导致自定义文件夹、专注时间统计、待办、文件库等数据丢失；数据迁移函数虽已将旧数据复制至 userData，但 main.js 运行时仍读写 baseDir，迁移形同虚设。 | 将 main.js 中所有可变数据路径常量统一改为 dataDir（app.getPath('userData')）：FOCUS_SETTINGS_FILE、SITE_STATS_FILE、timer-result.json 读写、UPLOADED_LIST_FILE 读写、CUSTOM_SOUNDS_FILE；与 main/config.js 的 migrateUserData 迁移列表对齐；迁移时机确保在 app.ready 内先于 loadFocusSettings 等所有数据读取执行。 |
| 配置加载 | main/config.js 的 loadAppConfig 未返回 dailyTasks 字段，导致面板因 tasks 为空而 display:none 不显示。 | 在 loadAppConfig 返回对象中显式加入 dailyTasks: normalizeDailyTasks(config.dailyTasks)，并补充 normalizeDailyTasks 实现。 |
| 设置持久化 | loadFocusSettings 与 save-focus-settings IPC 重建对象时丢弃 dailyTaskDate / dailyTaskCompleted，导致每日任务进度在重启或保存设置后丢失。 | 在两处保留新增字段，避免进度丢失。 |
| 任务校验位置 | 60% 完成率校验最初放在紧急退出流程，与「到达时段结束才校验」的预期不符。 | 将校验移至 checkTimeAndToggle 的 destroyOverlay 前与遮罩 close 事件拦截，紧急退出不再校验。 |

### 三、安全与数据隐私

- 重装/升级数据保留：用户可变数据迁出安装目录后，NSIS 覆盖安装不再触及用户数据；旧版升级时由 migrateUserData 一次性把安装目录内的可变文件与 todos/files 目录复制到 userData（仅当目标不存在时），迁移失败不阻断启动。
- 敏感信息扫描：_mk-utf8-payload.js 在生成推送 payload 前对 UTF-8 文件执行 sk-、apiKey 赋值、ghp_/github_pat_、Bearer 令牌等模式扫描，命中即阻断（exit 2）。
- .gitignore 已保护 focus-settings.json、focus-stats.json、site-stats.json、uploaded-files.json、files/*、todos/*、cookies.sqlite* 等运行期数据，仓库仅保留占位 README / 空数组。

### 四、升级指引

由 v1.0.0 升级至 v1.1.0：

1. 使用新版本安装包覆盖安装；本次升级不会丢失用户数据（可变数据已迁至 userData 目录）。
2. 首次启动新版本时，旧安装目录内的 focus-settings.json、focus-stats.json、site-stats.json、todos/、files/ 等会被自动迁移到 userData 目录（仅一次性，幂等）。
3. 如需启用每日任务，在 config.js 中配置 dailyTasks 字段（每项含 id、name、minutes）；未配置则不影响原有锁屏解除逻辑。

### 五、已知问题

| 编号 | 问题描述 | 影响范围 | 临时处理方式 |
|---|---|---|---|
| 1 | extensions 与 userscripts 目录尚未纳入数据迁移，重装可能丢失用户安装的扩展/脚本。 | 使用扩展/用户脚本功能的用户。 | 升级前手动备份 extensions/userscripts 目录，升级后还原。 |
| 2 | instantModeEnabled 仍仅支持通过 config.js 配置，未在设置界面暴露。 | 调试类用户。 | 修改 config.js 对应字段后重启应用。 |

### 六、贡献与反馈

- 缺陷报告与功能建议请提交至项目 Issues 页面：https://github.com/HMZ137/FocusLocker/issues 。

---

## [1.0.0] - 2026-08-20 · 首次开源发布

对应标签：v1.0.0

### 版本概述

本版本为 FocusLocker 项目首次对外开源发布。随本版本一同提供的内容包括：桌面端 Electron 主程序、预加载脚本、渲染层界面、配置模板、看门狗守护脚本、官网展示页、构建配置，以及内置环境音资源与本地字体资源。构建链路基于 electron-builder，可在符合 README 要求的 Windows 环境中复现。

### 一、新增功能

#### 1.1 桌面端锁闭与时间调度

- 支持按照“HH:MM-HH:MM”格式配置多条每日锁闭时间段；到达开始时间后，应用自动进入全屏遮罩层，并拦截 Esc、Alt+F4、Win 键相关系统级操作组合。
- 提供白名单 BrowserView 能力。在锁闭期间，用户可继续访问预先配置的白名单站点；支持针对单个站点配置页面缩放比例（zoom）以及域名别名（aliases）。
- 提供紧急退出通道。紧急退出采用多步校验流程：呼出通道后，用户需逆向抄录并输入指定长度的随机校验码，随后在倒计时窗口内完成二次确认；成功解除后，同一运行会话内设有二十分钟冷却期，避免通过反复紧急退出绕过锁闭。
- 实现单实例运行机制。当检测到已有实例运行时，后启动的实例将立即退出，以保障 cookies 等 SQLite 数据库写入的一致性。

#### 1.2 智能助手与文件库

- 预置 DeepSeek 与 Kimi 两种对话入口，支持两类使用模式：其一，通过 BrowserView 在线登录对应官网；其二，在本地配置文件中填写 deepseekApiKey 直接接入开放平台。
- 智能助手支持以下能力：问答、待办事项管理、主题与环境音切换、文件挂载管理、文件库内容检索与引用。
- 文件库支持两类数据源：一类来自配置项 fileViewDirs 指定的本地绝对路径目录，另一类来自用户通过界面上传的附件。当前已挂载的文件会以特定徽标进行提示。
- 附件与挂载上下文支持以下常见格式：PDF、Word（DOCX）、Excel（XLSX/XLS）、CSV 以及多种代码格式；对应的解析依赖已在 package.json 中声明。

#### 1.3 计时与专注工具

- 提供番茄钟能力，内置 50、30、10、5、1 分钟等多段预设时长，并可触发阶段提醒。
- 提供倒计时能力、专注里程碑横幅以及专注报告汇总。
- 提供全局快捷键系统。默认快捷键与功能对应关系如下：

  | 快捷键 | 对应功能 |
  |---|---|
  | Ctrl + Shift + Alt + Space | 切换白名单网站 |
  | Ctrl + Shift + Alt + T | 固定或取消固定当前视图 |
  | Ctrl + Shift + Alt + E | 延长锁闭剩余时长 |
  | Ctrl + Shift + Alt + A | 唤起智能助手面板 |
  | Ctrl + Shift + Alt + L | 立即锁定当前会话 |
  | Ctrl + Shift + Alt + F12 | 发起紧急退出流程 |

#### 1.4 用户界面与视觉呈现

- 采用深色玻璃拟态风格的界面体系，配合多层模糊与背景氛围层，提供视觉层次感。
- 提供网格、星点等装饰层，并确保 focus-visible 状态下键盘导航具有可辨识的焦点样式。
- 使用本地七段式数字字体 DSEG7Classic-Bold.woff2，字体资源全部本地化，不发起远程请求。
- 内置多套封面图资源（位于 Sounds 目录下对应的 webp 与 jpg 文件），并支持用户自定义壁纸。
- 提供环境音播放能力，内置雨声、篝火、海浪、提示铃、白浪等音轨；支持循环播放、音量调节、封面切换以及叠加用户自定义本地音频文件（MP3/OGG）。

#### 1.5 看门狗守护进程

- guard.ps1：承担主进程退出监控职责；当主进程被主动结束时，自动重启应用，以减少通过任务管理器绕过锁闭的可能性。
- guard-proc.vbs：用于无窗口后台派生守护脚本，避免控制台窗口常驻。
- guard-task.vbs：作为计划任务入口，可用于配置“用户登录即启动”的自动拉起策略。

#### 1.6 配置与进程间通信

- 配置通过根目录 config.js 统一描述，主要字段包括：锁闭时间段 timeRanges、白名单站点 sites、智能助手密钥 deepseekApiKey、本地文件库目录 fileViewDirs、看门狗开关 guardEnabled、开机自启 autoLaunch、即时模式 instantModeEnabled。
- 设置界面中的“保存配置”通过 IPC 通道 save-config-from-edit 合并写入配置文件，用户无需手工编辑 JS 文件。
- 设置界面中的“专注设置”通过 IPC 通道 save-focus-settings 单独写入 focus-settings.json，实现专注相关参数的独立持久化。

#### 1.7 官网展示页

- website 目录包含纯静态落地页（index.html、styles.css、app.js）。
- 提供本地预览脚本 website/server.mjs，默认监听端口 8808；用户可通过 http://localhost:8808/ 本地预览官网。

#### 1.8 构建与分发

- 采用 electron-builder 生成 NSIS 安装包，安装包要求管理员权限，支持用户自定义安装目录，并通过 build/installer.nsh 执行安装期附加逻辑。
- 构建输出产物包括：“FocusLocker Setup <版本号>.exe”安装程序与 win-unpacked 便携解压目录。
- 构建配置中 extraFiles 节点明确了随安装包一并分发的外部资源，包括 Sounds、extensions、userscripts、todos、外部可执行文件、守护脚本、config.js 等。

### 二、缺陷修复

| 模块 | 缺陷描述 | 修复方案 |
|---|---|---|
| 设置页 | 主进程 save-config-from-edit 处理逻辑中，局部变量 guardEnabled 与外部同名变量产生遮蔽，导致开关状态在合并写入时被错误覆盖，进而引发保存失败或保存结果不生效。 | 将局部变量重命名为 cfgGuardEnabled，消除遮蔽；同时在渲染进程侧补充失败时的系统提示，使用户可感知保存结果。 |
| 设置页 | 错误状态区域采用 textContent 写入包含 SVG 标记的提示内容，导致 SVG 标签被原样输出为文本而非图标。 | 改为通过 innerHTML 写入，并在写入前对用户可控制输入部分进行 HTML 转义，确保图标与文本显示正常。 |
| 设置页 | saveFocusSettings 调用失败时仅记录控制台错误，未向用户提供明确反馈。 | 对该调用添加 try/catch 包裹，在成功与失败两种分支下均通过 showSystemToast 向用户提供提示；失败提示附带具体错误信息。 |

### 三、安全与合规

- 配置文件模板化。仓库根目录下的 config.js 以及 main/config.js 中，deepseekApiKey 默认值为空字符串，fileViewDirs 默认值为空数组，sites 字段保留示例配置。首次部署时，用户需在本地副本中填写实际配置。
- 本次发布前执行多轮敏感信息扫描，覆盖以下模式：DeepSeek 风格密钥（sk- 前缀，不少于二十个字符）、apiKey 字段赋值形式的实值、GitHub 个人访问令牌（ghp_ 与 github_pat_ 前缀）、HTTP Authorization Bearer 令牌；扫描结果均为零命中。
- 对配置文件中的盘号绝对路径进行专项扫描（例如 K:\\、D:\\ 等形式），结果为零命中。
- 仓库根目录 .gitignore 已对以下运行期数据与不必要提交内容进行排除：cookies.sqlite 及其相关文件、focus-settings.json、focus-stats.json、site-stats.json、uploaded-files.json、files 目录下用户数据、todos 目录下用户数据、node_modules、dist* 构建产物、SoundVolumeView.exe、nircmd.exe、_deploy-*.ps1、ui-v2、maiMBot 等。
- 安装包请求管理员权限的用途包括：计划任务注册、全局热键、窗口置顶、音量控制辅助脚本（wechat-volume.ps1）等系统级能力。
- 看门狗与紧急退出冷却机制协同工作：即使主进程被终止并由看门狗重新拉起，紧急退出的二十分钟冷却期仍继续生效。

### 四、产物说明

本次随仓库发布共包含三十六项文件。其中文本类文件二十五份，涵盖 HTML、CSS、JavaScript、PowerShell、VBScript、NSIS 脚本、JSON、Markdown 等；二进制资源十二份，包括 Sounds 目录下的四份 OGG 音频、五份 webp/jpg 封面图、build/icon.ico、assets/fonts 下的 DSEG7Classic-Bold.woff2、以及 website 下对应的图标与字体资源。

### 五、升级指引

本版本为首次发布，不存在由旧版本升级的路径。后续版本升级时，请遵循以下通用步骤：

1. 备份本地运行数据，包括 config.js、focus-settings.json 以及 files 与 todos 两个目录中的自定义内容。
2. 退出 FocusLocker 主程序，并通过任务管理器确认 guard.ps1 及对应 wscript 守护进程均已退出。
3. 使用新版本安装包覆盖安装，或解压新版本的 win-unpacked 目录至目标位置。
4. 对照新版本 config.js 模板中新增或变更的字段，手工合并本地已自定义的密钥、文件库目录、锁闭时间段与白名单站点等内容。

### 六、已知问题

下表所列问题计划在下一个补丁版本中处理。

| 编号 | 问题描述 | 影响范围 | 临时处理方式 |
|---|---|---|---|
| 1 | package.json 的 scripts 中未定义 dist 脚本，README 中存在对 npm run dist 的示例引用。 | 构建命令文档与脚本一致性。 | 可直接执行 npm run build；或在 scripts 中追加 “dist”: “electron-builder”。 |
| 2 | instantModeEnabled（跳过验证码紧急退出的调试模式）仅支持通过修改 config.js 配置，未在设置界面暴露。 | 调试类用户。 | 修改 config.js 对应字段后重启应用。 |
| 3 | 看门狗当前仅监控主进程 PID；当渲染进程发生异常但 BrowserView 仍存活时，存在无法自动触发重启的情况。 | 极端异常场景。 | 手动结束主进程，由守护脚本在短时间内自动拉起并继续冷却周期。 |
| 4 | website/server.mjs 默认监听端口 8808，端口被占用时直接抛出异常。 | 本地官网预览。 | 释放 8808 端口后重试，或编辑 server.mjs 中的 PORT 配置项。 |
| 5 | 首次提交信息在部分 GBK 编码控制台中可能显示为乱码；仓库存储内容本身采用 UTF-8 编码。 | 仅本地命令行显示，不影响仓库内容。 | 具体版本说明以本更新日志及 GitHub Releases 页面为准。 |

### 七、贡献与反馈

- 本版本源码整理、安全扫描、README 与本更新日志由维护者 HMZ137 完成。
- 缺陷报告与功能建议请提交至项目 Issues 页面：https://github.com/HMZ137/FocusLocker/issues 。
