# FocusLocker 更新日志

版本号采用语义化版本规范（Semantic Versioning 2.0.0），格式为“主版本号.次版本号.修订版本号”（MAJOR.MINOR.PATCH），各段含义如下：

- 主版本号（MAJOR）：包含不兼容变更，例如配置格式、IPC 协议、快捷键语义或主要交互流程的破坏性调整。
- 次版本号（MINOR）：在保持向后兼容的前提下新增功能、新增配置项或新增模块。
- 修订版本号（PATCH）：在保持向后兼容的前提下修复缺陷、调整文案与样式、进行性能优化或小幅重构。

本文档与 GitHub Releases 页面保持同步。如仅需了解最新版本内容，请直接阅读最近版本对应的章节。

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
