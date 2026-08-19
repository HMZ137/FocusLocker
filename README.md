# FocusLocker · 把时间锁给专注

Windows 桌面专注锁屏工具，基于 Electron 构建。  
设定学习时段，到点自动锁定电脑；白名单网站内可继续查资料、听音乐、使用 AI 助手——把分心挡在屏幕外，把时间锁给真正的专注。

（开发圈内戏称本作为“3A 级定时锁屏大作”，因为确实有三位 AI 模型参与过代码生成，不过最终的产物嘛……懂的都懂，史山代码也是代码。）

---

## 核心特性

| 模块 | 说明 |
|---|---|
| 定时锁定 | 按 HH:MM-HH:MM 配置多段锁屏时段，到点自动加载遮罩，白名单中的 BrowserView 可继续浏览。比老妈喊你吃饭还准时。 |
| AI 专注助手 | 内置 DeepSeek / Kimi 对话能力，支持问答、管理待办、切换主题与环境音、增删文件，并可上传 PDF / Word / Excel / 代码等文件作为上下文。三位 AI 各显神通，虽然有时会互相“打架”，但最终总能给你一个答案。 |
| 文件库 | 支持本地目录接入和上传附件两种方式；文件卡片显示绿色“已挂载”徽标，双击即可预览。再也不用在文件夹里翻到眼瞎。 |
| 验证码紧急退出 | 紧急退出需按快捷键，输入反向抄录的超长验证码，并在倒计时内确认；内置 20 分钟冷却期防止滥用。专治“我就出去一下”的手贱冲动。 |
| 看门狗守护 | 通过独立的 VBS / 计划任务派生守护进程，一旦主进程被结束即自动重启，并立即进入 20 分钟紧急解除冷却。想杀进程？比小强还顽强。 |
| 快速指令与快捷键 | 提供 Ctrl+Shift+Alt+Space / T / E / A / L / F12 等组合键，快速切换网站、固定当前网站、延长锁屏、呼出 AI、锁定当前网站、触发紧急退出。熟练之后可盲操。 |
| 环境音与封面图 | 内置雨声、篝火、海浪、铃声、白噪音等示例音效，支持自定义本地 MP3 / OGG 文件；壁纸封面也可自定义。学习也要有影院级沉浸感。 |
| 番茄钟 / 倒计时 | 提供专注报告、里程碑横幅，以及 50 / 30 / 10 / 5 / 1 分钟分段提醒，比健身房的倒计时还让人心跳加速。 |
| 现代玻璃拟态 UI | 采用深色主题，靛蓝 / 紫 / 青渐变文字，配合模糊发光背景层、网格与星星装饰，并支持 focus-visible 键盘导航。光看界面就能骗自己多学五分钟。 |

---

## 项目目录结构

```
focus-locker/
├─ main.js                  Electron 主进程：窗口/BrowserView/IPC/锁屏调度/看门狗/定时器（史山核心）
├─ preload.js               contextBridge：渲染进程安全调用 IPC 的桥梁
├─ config.js                应用配置模板（请在本地副本填入 Key，勿提交至仓库）
├─ package.json / lock.json 依赖声明（electron-builder / electron 等）
│
├─ renderer/
│  └─ index.html            遮罩 UI（主界面 / 设置页 / AI 对话 / 文件库 / 倒计时——全塞在一个文件里，典型的史山风格）
├─ main/
│  ├─ config.js             配置装载/重载（loadConfig / loadAppConfig / deploy-merge 清理）
│  └─ extensions.js         BrowserView 扩展 & userscripts 装载（能跑就别动）
│
├─ assets/
│  ├─ fonts/DSEG7Classic-Bold.woff2   七段式数字字体（离线本地资源）
│  └─ icons.svg                        内联 SVG 图标精灵
├─ build/
│  ├─ icon.ico / installer.nsh        electron-builder 安装包资源
│  └─ set-runas.ps1 / wechat-volume.ps1  安装期提权与音量控制辅助脚本
├─ Sounds/                内置环境音（ogg/jpg/webp 缩略）
├─ extensions/            扩展占位（README 说明，实际很少人用）
├─ userscripts/           用户脚本目录（可选，大佬专属）
│
├─ files/README.md        用户上传附件，禁止提交个人文件（.gitignore 已保护）
├─ todos/README.md        每日个人待办 JSON，禁止提交（.gitignore 已保护）
│
├─ website/               项目官网展示页（纯静态 + Node server.mjs 本地预览）
│
├─ guard.ps1 / guard-proc.vbs / guard-task.vbs   看门狗守护进程（进程防杀 & 定时任务重启）
│
└─ uploaded-files.json    空数组占位（记录当前已挂载到 AI 上下文的附件列表；运行期生成）
```

---

## 快速开始（开发模式）

### 环境要求
- Windows 10 / 11（依赖 Win32 托盘、计划任务、全局快捷键等——Mac 用户请绕道，或装双系统）
- Node.js 18 或更高版本（建议 20 LTS，别用奇数版，别问为什么）
- npm 9 或更高版本，或 pnpm 8 或更高版本

### 安装依赖
```powershell
npm install
# 或 pnpm install（如果你喜欢快一点但偶尔报错）
```

### 启动开发（带实时 DevTools 主窗口）
```powershell
# 直接启动遮罩内主界面（非定时触发测试）
npm start

# 可选：测试模式（关闭时段判定，按 Esc 直接退出遮罩；详见 main.js --test 参数）
node main.js --test
```

注意：应用设计为单实例运行，第二个实例会直接退出以保护 SQLite cookies 数据库写入——毕竟多开容易崩，史山经不起折腾。

### 构建发布安装包
```powershell
# 使用 electron-builder 输出到 dist/
npm run dist
```

构建产物包括：
- FocusLocker Setup <版本>.exe（NSIS 安装包）
- win-unpacked/（便携解包版，解压即用）

---

## 配置说明（config.js）

打开 `config.js`，常用字段示例如下：

```js
{
  deepseekApiKey: '',      // DeepSeek 开放平台 API Key，留空则走 BrowserView 在线登录（推荐，省得填 key）
  autoLaunch: true,        // 开机自启（让你一开机就进入被锁的恐惧）
  guardEnabled: true,      // 看门狗（结束进程自动重启 + 紧急解除冷却，建议开着，防手贱）
  instantModeEnabled: false, // 即时模式（关闭验证码退出，仅调试，千万别在生产开）
  timeRanges: [            // 每日锁屏时段（24小时制）
    { start: '18:00', end: '21:00' }
  ],
  sites: [                 // 白名单网站（id 必须唯一！否则会互相覆盖）
    { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com', zoom: 1.4, aliases: [] }
  ],
  fileViewDirs: []         // 文件库默认显示的本地绝对路径数组（示例：['D:\\Notes\\错题本']，别写 C 盘）
}
```

保存后重启应用生效。锁屏期间在“设置页”保存配置会将 config.js 合并写入，并提示下次启动生效（部分字段如 autoLaunch / guardEnabled 会即时生效，但推荐重启保平安）。

---

## 快捷键速查

| 快捷键 | 功能 |
|---|---|
| Ctrl + Shift + Alt + Space | 切换白名单网站（跟换台一样快） |
| Ctrl + Shift + Alt + T | 固定当前网站（下次优先打开） |
| Ctrl + Shift + Alt + E | 延长本次锁屏（弹出小时/分钟选择） |
| Ctrl + Shift + Alt + A | 呼出 AI 专注助手（支持文件与控屏指令） |
| Ctrl + Shift + Alt + L | 锁定当前网站，阻止切换（自断后路） |
| Ctrl + Shift + Alt + F12 | 验证码紧急退出（最长 1200 秒，之后强制恢复遮罩，逃不掉的） |

---

## 安全与数据隐私

本仓库默认不会泄露任何个人信息，但提交到自己的 Fork 前请额外注意：

1. API Key 绝不入库：deepseekApiKey 必须保持空字符串；开发时在本地副本或应用内“设置页 → DeepSeek API Key”填写，已通过 .gitignore / 模板保护。
2. 个人数据目录不入库：files/*、todos/*、focus-settings.json、focus-stats.json、site-stats.json、cookies.sqlite*、uploaded-files.json 已在 .gitignore 中忽略，仅保留占位 README / 空数组。
3. 本机绝对路径不入库：fileViewDirs 模板默认为空 []，不要把个人盘号等写进模板。
4. 看门狗二进制不随源码仓分发：SoundVolumeView.exe、nircmd.exe 等第三方工具由安装包构建阶段附带，源码仓不包含，避免 EXE 安全告警与仓库膨胀。
5. 登录 cookies 本地保存：DeepSeek 登录态写入 cookies.sqlite*（主进程目录下），异常退出 3 秒内刷盘保护，请不要打包到仓库。
6. 推送 GitHub 时推荐安全方式：
   - SSH Key（推荐）：git remote add origin git@github.com:<you>/focus-locker.git
   - HTTPS + Personal Access Token：不要把 ghp_xxx 直接写进 remote URL 或脚本，建议通过 Windows 凭据管理器或 git config --global credential.helper manager 交互输入。

---

## 许可证

本项目采用 MIT 许可证发布，详见源码。内置第三方资源遵循其各自原始许可证：

- DSEG7Classic-Bold.woff2（DSEG 字体）：由 けしかん 提供，OFL 1.1。
- Sounds 目录中的 Rain.ogg / MC-Campfire.ogg / wave.ogg / bell.ogg 示例音效，请替换为自有版权或 CC0 资源后再公开分发安装包。
