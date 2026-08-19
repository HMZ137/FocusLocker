将 `.crx` 扩展文件放在这里，或直接放在应用根目录。

应用启动时会自动扫描并加载：
- 根目录下的 `*.crx`
- `extensions` 目录下的 `*.crx`

说明：
- `.crx` 会先自动解包到运行数据目录，再通过 Electron 加载。
- 修改、替换扩展后重启应用生效。
- 扩展只会加载到右侧网页 BrowserView 的专用会话，不会注入左侧主界面、AI 面板或遮罩 UI。
- 含 `options.html`、`manage.html` 或 popup 页的扩展，可在应用“文件管理”面板点击“配置CRX”打开其内置 UI。
- Stylus 可作为 `.crx` 放入本目录；重启后点击“配置CRX”进入 Stylus 的内置管理/配置页面。
