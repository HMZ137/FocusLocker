# FocusLocker v1.3.0 发布说明

对应标签：v1.3.0（已推送）

## 相比 v1.2.0 的变更（约 4500 行新增）

### 新增功能

#### 1. 每日任务完成门槛（自定义比例 + 常驻提示）

- 锁定设置面板新增「每日任务完成比例」配置项（10%–100%，步进 5%，默认 60%），修改后下次遮罩生效；阈值持久化为 `focusSettings.dailyTaskRatio`。
- 锁定时段结束后，若任务完成率未达阈值，遮罩无法解锁，底部弹出**常驻提示条**提醒未完成最低任务量（节流 30 秒）；完成任务达标后自动消失。
- 新增 `daily-task-blocking` / `daily-task-unblocked` IPC 事件，任务勾选实时驱动提示条显隐。

#### 2. 遮罩顶部任务完成度进度条

- 遮罩顶部新增全宽 6px 进度条：填充宽度 = 当前完成率，未达标为警示琥珀色，达标后**变为绿色**并发光；白色刻度线动态指示阈值位置。
- 适配两种布局模式：左右布局（经典）与全屏布局（现代）下网站 BrowserView 均自动下移避让，进度条始终完整可见。
- 无每日任务时自动隐藏，`pointer-events: none` 不影响顶部交互。

### 缺陷修复

#### 3. 扩展禁用失效与误加载非本目录扩展

- 解压目录从 `userData/extensions` 改为独立的 `userData/ext-unpacked`，与扫描目录解耦，杜绝 `.crx` 解压目录被重复加载。
- 禁用状态键由绝对路径改为与安装位置无关的相对键（`base:extensions/x.crx` / `data:extensions/x.crx`），兼容旧版绝对路径键，跨重装/打包后禁用依然有效。

#### 4. 自定义 CSS 与原站 CSS 抢位置/重叠

- 自定义 CSS 以「用户来源（user）」注入并自动提升为 `!important`，稳定盖过原站正常样式。
- 对 `font-family` / `font` / `src` / `content` 等字体相关声明跳过，图标字体不再被覆盖成方块占位符。

#### 5. 扩展开关无法启用

- 扩展/用户脚本/用户样式三个列表的开关 `onchange` 误绑在 `<label>` 上，导致状态恒为假（点击「启用」实际执行了禁用）。
- 已改为绑定内部 `<input type="checkbox">`，并在主进程三个 toggle 处理器增加布尔参数校验，杜绝同类问题被静默吞掉。

#### 6. 文件预览适配亮色模式

- 预览容器与媒体舞台背景改用 CSS 变量（`--preview-bg` / `--preview-grid` / `--surface-*`），亮/暗两套配色。
- highlight.js 主题改为 `--code-*` 变量驱动（暗色 atom-one-dark / 亮色 atom-one-light），移除写死的 CDN 主题样式。

---

## 发行版上传清单

| 文件 | 说明 |
|---|---|
| `dist-build7/FocusLocker Setup 1.3.0.exe` | NSIS 安装包（约 165 MB，sha512 见 latest.yml） |
| `dist-build7/latest.yml` | 自动更新元数据 |
| `dist-build7/FocusLocker Setup 1.3.0.exe.blockmap` | 增量更新块映射 |
