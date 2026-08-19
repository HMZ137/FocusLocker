# FocusLocker · 把时间，锁给专注

> Windows 桌面专注锁屏工具 · Electron 构建
> 设定学习时段，到点自动锁定电脑；白名单网站内继续查资料、听音乐、问 AI，把分心挡在屏幕之外。

---

## ✨ 核心特性

| 模块 | 说明 |
|---|---|
| ⏰ **定时锁定** | 按 `HH:MM-HH:MM` 配置多段锁屏时段，到点自动加载遮罩，白名单 BrowserView 继续浏览 |
| 🤖 **AI 专注助手** | 内置 DeepSeek / Kimi 对话：可问答、管理待办、切换主题/环境音、增删文件，支持文件库 PDF/Word/Excel/代码随上下文上传 |
| 📚 **文件库** | 本地目录接入 + 上传附件双路径；文件卡片绿色「已挂载」徽标，支持双击预览 |
| 🔑 **验证码紧急退出** | 紧急退出需按快捷键 → 输入超长验证码（反向抄录） → 倒计时内确认，内置 20 分钟冷却防止滥用 |
| 🐶 **看门狗守护** | 独立 VBS/计划任务派生守护进程，一旦主进程被结束立即重启并进入 20 分钟紧急解除冷却 |
| 🎯 **快速指令/快捷键** | Ctrl+Shift+Alt+Space/T/E/A/L/F12 快速切换网站/固定/延长/呼出 AI/锁定当前/紧急退出 |
| 🌊 **环境音 & 封面图** | 内置雨声/篝火/海浪/铃/抖音白浪+自定义本地 MP3/OGG；支持壁纸自定义封面 |
| 🍅 **番茄钟 / 倒计时** | 专注报告、里程碑横幅、长时 50/30/10/5/1 分钟分段提醒 |
| 🪟 **现代玻璃拟态 UI** | 深色主题 + 靛蓝/紫/青渐变文字 + blur 发光背景氛围层 + 网格 + 星星 + focus-visible 键盘导航友好 |

---

## 📂 项目目录结构

```
focus-locker/
├─ main.js                  Electron 主进程：窗口/BrowserView/IPC/锁屏调度/看门狗/定时器
├─ preload.js               contextBridge：渲染进程安全调用 IPC 的桥梁
├─ config.js                应用配置模板（⚠️ 请在本地副本填入 Key，勿提交至仓库）
├─ package.json / lock.json 依赖声明（electron-builder / electron 等）
│
├─ renderer/
│  └─ index.html            遮罩 UI（主界面 / 设置页 / AI 对话 / 文件库 / 倒计时）
├─ main/
│  ├─ config.js             配置装载/重载（loadConfig / loadAppConfig / deploy-merge 清理）
│  └─ extensions.js         BrowserView 扩展 & userscripts 装载
│
├─ assets/
│  ├─ fonts/DSEG7Classic-Bold.woff2   七段式数字字体（离线本地资源）
│  └─ icons.svg                        内联 SVG 图标精灵
├─ build/
│  ├─ icon.ico / installer.nsh        electron-builder 安装包资源
│  └─ set-runas.ps1 / wechat-volume.ps1  安装期提权与音量控制辅助脚本
├─ Sounds/                内置环境音（ogg/jpg/webp 缩略）
├─ extensions/            扩展占位（README 说明）
├─ userscripts/           用户脚本目录（可选）
│
├─ files/README.md        ⚠️ 用户上传附件，禁止提交个人文件（.gitignore 已保护）
├─ todos/README.md        ⚠️ 每日个人待办 JSON，禁止提交（.gitignore 已保护）
│
├─ website/               项目官网展示页（纯静态 + Node server.mjs 本地预览）
│
├─ guard.ps1 / guard-proc.vbs / guard-task.vbs   看门狗守护进程（进程防杀 & 定时任务重启）
│
└─ uploaded-files.json    空数组占位（记录当前已挂载到 AI 上下文的附件列表；运行期生成）
```

---

## 🚀 快速开始（开发模式）

### 环境要求
- **Windows 10 / 11**（依赖 Win32 托盘、计划任务、全局快捷键等）
- **Node.js ≥ 18**（建议 20 LTS）
- **npm ≥ 9** 或 **pnpm ≥ 8**

### 安装依赖
```powershell
npm install
```

### 启动开发（带实时 DevTools 主窗口）
```powershell
# 直接启动遮罩内主界面（非定时触发测试）
npm start

# 可选：测试模式（关闭时段判定，按 Esc 直接退出遮罩；详见 main.js --test 参数）
node main.js --test
```

> 注意：应用设计为**单实例**运行，第二个实例会直接退出以保护 SQLite cookies 数据库写入。

### 构建发布安装包
```powershell
# 使用 electron-builder 输出到 dist/
npm run dist
```

构建产物包括：
- `FocusLocker Setup <版本>.exe`（NSIS 安装包）
- `win-unpacked/`（便携解包版）

---

## ⚙️ 配置说明（config.js）

打开 `config.js`，常用字段：

```js
{
  deepseekApiKey: '',      // ⚠️ DeepSeek 开放平台 API Key，留空则走 BrowserView 在线登录
  autoLaunch: true,        // 开机自启
  guardEnabled: true,      // 看门狗（结束进程自动重启 + 紧急解除冷却）
  instantModeEnabled: false, // 即时模式（关闭验证码退出，仅调试）
  timeRanges: [            // 每日锁屏时段（24h）
    { start: '18:00', end: '21:00' }
  ],
  sites: [                 // 白名单网站（id 必须唯一！）
    { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com', zoom: 1.4, aliases: [] }
  ],
  fileViewDirs: []         // 文件库默认显示的本地绝对路径数组（示例：['D:\\Notes\\错题本']）
}
```

保存后重启应用生效。**锁屏期间的「设置页 → 保存配置」会把 config.js 合并写入并提示下次启动生效（部分字段即时生效，如 autoLaunch/guardEnabled）。**

---

## ⌨️ 快捷键速查

| 快捷键 | 功能 |
|---|---|
| `Ctrl + Shift + Alt + Space` | 切换白名单网站 |
| `Ctrl + Shift + Alt + T` | 固定当前网站（下次优先打开） |
| `Ctrl + Shift + Alt + E` | 延长本次锁屏（弹出小时/分钟选择） |
| `Ctrl + Shift + Alt + A` | 呼出 AI 专注助手（支持文件与控屏指令） |
| `Ctrl + Shift + Alt + L` | 锁定当前网站，阻止切换 |
| `Ctrl + Shift + Alt + F12` | 验证码紧急退出（最长 1200 秒，之后强制恢复遮罩） |

---

## 🔐 安全与数据隐私

**本仓库默认不会泄露任何个人信息，但你提交到自己的 Fork 前请额外确认：**

1. **API Key 绝不入库**：`deepseekApiKey` 必须保持空字符串；开发时在本地副本或应用内「设置页 → DeepSeek API Key」填写，已写入 `.gitignore`/模板保护。
2. **个人数据目录不入库**：`files/*`、`todos/*`、`focus-settings.json`、`focus-stats.json`、`site-stats.json`、`cookies.sqlite*`、`uploaded-files.json` 已在 `.gitignore` 中黑名单，仅保留占位 README/空数组。
3. **本机绝对路径不入库**：`fileViewDirs` 模板默认为空 `[]`，不要把 `K:\Media\…`、个人盘号等写进模板。
4. **看门狗二进制不随源码仓分发**：`SoundVolumeView.exe`、`nircmd.exe` 等第三方工具由安装包构建阶段附带，源码仓不包含，避免 EXE 安全告警与仓库膨胀。
5. **登录 cookies 本地保存**：DeepSeek 登录态写入 `cookies.sqlite*`（主进程目录下），异常退出 3 秒内刷盘保护，**请不要打包到仓库**。
6. **推送 GitHub 时推荐安全路径**：
   - 🟢 SSH Key（最推荐）：`git remote add origin git@github.com:<you>/focus-locker.git`
   - 🟢 HTTPS + Personal Access Token（经典/细粒度）：**不要把 `ghp_xxx` 直接写进 remote URL 或脚本**，建议通过 Windows 凭据管理器 / `git config --global credential.helper manager` 交互输入。

---

## 🧱 工程约束与设计约定

> 详细设计约束请查阅项目开发历史；这里给出最关键的 6 条，避免踩坑。

1. **单实例模式**：非 `--test` 模式全局只允许一个实例运行，防止 cookies 数据库写冲突。
2. **白名单 sites.id 必须唯一**：否则 BrowserView 创建期间会发生叠加覆盖。
3. **紧急退出**：最小时长/冷却/验证码三重保护，最长不得超过 1200 秒（20 分钟）；重启看门狗后立即进入 20 分钟冷却期。
4. **紧急退出恢复回调**：必须同时 `emergencyExemptUntil = 0` 并调 `checkTimeAndToggle()` 以保证锁屏时段内立即重绘遮罩。
5. **全局快捷键生命周期**：`registerOverlayShortcuts` 只在遮罩期间注册；非遮罩期仍要工作的能力（例如恢复锁定）需要独立额外注册的 shortcut 通道。
6. **AI 工具 → 紧急退出**：禁止 Agent 直接调用 `doEmergencyExit()`（绕过最小锁/冷却/验证码 + 无上限），统一走 `emergencyExit(preSeconds)` 完整校验链；`set_timer` 必须遵守「seconds 参数优先于 minutes」。

---

## 🆘 常见问题

**Q：锁屏期间还能继续访问 DeepSeek / 网易云音乐吗？**
A：可以。把网站加到 `config.js` 的 `sites` 白名单，遮罩期间 BrowserView 直接内嵌加载。

**Q：锁屏后遇到急事怎么退出？**
A：按 `Ctrl+Shift+Alt+F12` → 按提示抄录反向验证码 → 倒计时内点确认。单次最长 20 分钟，到期自动恢复遮罩并进入 20 分钟冷却。

**Q：直接结束进程能绕过锁屏吗？**
A：不能。看门狗守护进程通过计划任务派生，主进程被杀后会自动重启并立即进入 20 分钟紧急解除冷却。

**Q：AI 助手要额外配置吗？**
A：不用。在 `config.js` 留空 `deepseekApiKey` 会通过 BrowserView 登录 DeepSeek 官网；也可以填入开放平台 API Key 走 REST 请求。

**Q：关机/重启后锁屏还生效吗？**
A：只要 `autoLaunch: true`（默认）已启用开机自启 + 看门狗重启时段规则，开机后如落在配置时段内会自动进入遮罩。

---

## 📄 License

本项目采用 **MIT** 许可证发布，详见源码。内置第三方资源遵循其各自原始许可证：
- `DSEG7Classic-Bold.woff2`（DSEG 字体）：由 [けしかん](https://github.com/keshikan/DSEG) 提供，OFL 1.1。
- Sounds 目录中的 `Rain.ogg / MC-Campfire.ogg / wave.ogg / bell.ogg` 示例音，替换为自有版权或 CC0 资源后再公开分发安装包。
