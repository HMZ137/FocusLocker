const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('utils', {
  formatTime: () => {
    const days = ['日','一','二','三','四','五','六'];
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    const d = String(now.getDate()).padStart(2,'0');
    const day = days[now.getDay()];
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    const ss = String(now.getSeconds()).padStart(2,'0');
    return { line1: `${y}/${m}/${d} 周${day}`, line2: `${hh}:${mm}:${ss}` };
  },
  getTestMode: () => ipcRenderer.invoke('get-test-mode'),
  getInstantMode: () => ipcRenderer.invoke('get-instant-mode'),
  // 测试辅助（仅 --test 模式可用）
  testInstantExit: () => ipcRenderer.invoke('test-instant-exit'),
  testRelock: () => ipcRenderer.invoke('test-relock'),
  testRelockAfterDelay: (ms) => ipcRenderer.send('test-relock-after-delay', ms),
  testSetLockSimulation: (v) => ipcRenderer.invoke('test-set-lock-simulation', v),
  testToolCall: (toolName, args) => ipcRenderer.invoke('test-tool-call', toolName, args),
  getQuickStartMode: () => ipcRenderer.invoke('get-quick-start-mode'),
  closeOverlay: () => ipcRenderer.send('close-overlay'),
  getSoundCovers: () => ipcRenderer.invoke('get-sound-covers'),
  setSoundCover: (type) => ipcRenderer.invoke('set-sound-cover', type),
  clearSoundCover: (type) => ipcRenderer.invoke('clear-sound-cover', type),
  getCustomSounds: () => ipcRenderer.invoke('get-custom-sounds'),
  addCustomSounds: () => ipcRenderer.invoke('add-custom-sounds'),
  removeCustomSound: (id) => ipcRenderer.invoke('remove-custom-sound', id),
  toggleAutoLaunch: () => ipcRenderer.invoke('toggle-auto-launch'),
  getAutoLaunchStatus: () => ipcRenderer.invoke('get-auto-launch-status'),
  switchSite: (target) => ipcRenderer.invoke('switch-site', target),
  setSiteView: (active) => ipcRenderer.invoke('set-site-view', active),
  setSitePanelBounds: (rect) => ipcRenderer.invoke('set-site-panel-bounds', rect),
  setLayoutMode: (mode) => ipcRenderer.invoke('set-layout-mode', mode),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  toggleSiteLock: () => ipcRenderer.invoke('toggle-site-lock'),
  getSiteLock: () => ipcRenderer.invoke('get-site-lock'),
  onSiteLockChanged: (callback) => {
    ipcRenderer.on('site-lock-changed', (event, active) => callback(active));
  },
  onSiteLockBlocked: (callback) => {
    ipcRenderer.on('site-lock-blocked', (event, data) => callback(data));
  },
  getSites: () => ipcRenderer.invoke('get-sites'),
  getCurrentSite: () => ipcRenderer.invoke('get-current-site'),
  onSiteChanged: (callback) => {
    ipcRenderer.on('site-changed', (event, name) => callback(name));
  },
  onAlwaysOnTopChanged: (callback) => {
    ipcRenderer.on('always-on-top-changed', (event, enabled) => callback(enabled));
  },
  onCooldownStatus: (callback) => {
    ipcRenderer.on('cooldown-status', (event, seconds) => callback(seconds));
  },
  showExtendDialog: () => ipcRenderer.invoke('show-extend-dialog'),
  extendLock: (minutes) => ipcRenderer.send('extend-lock', minutes),
  onExtendedStatus: (callback) => {
    ipcRenderer.on('extended-status', (event, seconds) => callback(seconds));
  },

  // AI
  chatWithAgent: (messages) => ipcRenderer.invoke('deepseek-chat', messages),
  abortChat: () => ipcRenderer.send('deepseek-abort'),
  onChatChunk: (callback) => {
    ipcRenderer.on('chat-chunk', (event, chunk) => callback(chunk));
  },
  onChatReasoningChunk: (callback) => {
    ipcRenderer.on('chat-reasoning-chunk', (event, chunk) => callback(chunk));
  },
  onChatDone: (callback) => {
    ipcRenderer.on('chat-done', () => callback());
  },
  onChatError: (callback) => {
    ipcRenderer.on('chat-error', (event, error) => callback(error));
  },
  onChatToolResult: (callback) => {
    ipcRenderer.on('chat-tool-result', (event, data) => callback(data));
  },
  onChatWebSearch: (callback) => {
    ipcRenderer.on('chat-web-search', (event, data) => callback(data));
  },
  onChatWebSearchDone: (callback) => {
    ipcRenderer.on('chat-web-search-done', () => callback());
  },
  onToggleAgent: (callback) => {
    ipcRenderer.on('toggle-agent', () => callback());
  },
  onAddTodo: (callback) => {
    ipcRenderer.on('add-todo', (event, text) => callback(text));
  },

  // 文件
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  parseFile: (filePath) => ipcRenderer.invoke('parse-file', filePath),
  // 读取图片为 data URL（base64 内联），供 DeepSeek Vision 多模态调用
  readImageDataUrl: (filePath) => ipcRenderer.invoke('read-image-data-url', filePath),
  saveFile: (content, defaultName) => ipcRenderer.invoke('save-file', content, defaultName),
  importUserScript: () => ipcRenderer.invoke('import-user-script-dialog'),
  importUserStyle: () => ipcRenderer.invoke('import-user-style-dialog'),
  installExtension: () => ipcRenderer.invoke('install-extension-dialog'),
  installExtensionDir: () => ipcRenderer.invoke('install-extension-dir-dialog'),
  reloadExtensions: () => ipcRenderer.invoke('reload-extensions'),
  toggleExtension: (sourcePath, enabled) => ipcRenderer.invoke('toggle-extension', sourcePath, enabled),
  toggleUserScript: (scriptId, enabled) => ipcRenderer.invoke('toggle-user-script', scriptId, enabled),
  getExtensionStatus: () => ipcRenderer.invoke('get-extension-status'),
  openExtensionUi: (extensionId, preferredPage) => ipcRenderer.invoke('open-extension-ui', extensionId, preferredPage),
  listUserStylesMeta: () => ipcRenderer.invoke('list-user-styles-meta'),
  getUserStyleDetail: (styleId) => ipcRenderer.invoke('get-user-style-detail', styleId),
  saveUserStyleOverrides: (styleId, patch) => ipcRenderer.invoke('save-user-style-overrides', styleId, patch),
  toggleUserStyle: (styleId, enabled) => ipcRenderer.invoke('toggle-user-style', styleId, enabled),
  deleteUserStyle: (styleId) => ipcRenderer.invoke('delete-user-style', styleId),
  reloadUserStyles: () => ipcRenderer.invoke('reload-user-styles'),
  previewUserStyleCss: (styleId, overrideValues) => ipcRenderer.invoke('preview-user-style-css', styleId, overrideValues),

  // 文件查看
  getFileViewConfig: () => ipcRenderer.invoke('get-file-view-config'),
  pickFileViewDirs: () => ipcRenderer.invoke('pick-file-view-dirs'),
  removeFileViewDir: (dir) => ipcRenderer.invoke('remove-file-view-dir', dir),
  scanFileView: () => ipcRenderer.invoke('scan-file-view'),
  readFileText: (filePath) => ipcRenderer.invoke('read-file-text', filePath),
  openFilesDir: () => ipcRenderer.invoke('open-files-dir'),
  importFilesToFilesDir: () => ipcRenderer.invoke('import-files-to-files-dir'),
  pickFilesToAttach: () => ipcRenderer.invoke('pick-files-to-attach'),
  importSelectedFiles: (filePaths) => ipcRenderer.invoke('import-selected-files', filePaths),
  deleteUploadedFile: (filePath) => ipcRenderer.invoke('delete-uploaded-file', filePath),
  exportFiles: (filePaths) => ipcRenderer.invoke('export-selected-files', filePaths),

  // To-Do
  loadTodos: (dateStr) => ipcRenderer.invoke('load-todos', dateStr),
  saveTodos: (dateStr, todos) => ipcRenderer.invoke('save-todos', dateStr, todos),

  // 每日任务
  getDailyTasks: () => ipcRenderer.invoke('get-daily-tasks'),
  toggleDailyTask: (taskId) => ipcRenderer.invoke('toggle-daily-task', taskId),
  setDailyTask: (taskId, completed) => ipcRenderer.invoke('set-daily-task', taskId, completed),
  onDailyTaskUpdated: (callback) => {
    ipcRenderer.on('daily-task-updated', (event, data) => callback(data));
  },
  onDailyTaskStarted: (callback) => {
    ipcRenderer.on('daily-task-started', (event, data) => callback(data));
  },
  onDailyTaskBlocking: (callback) => {
    ipcRenderer.on('daily-task-blocking', (event, data) => callback(data));
  },
  onDailyTaskUnblocked: (callback) => {
    ipcRenderer.on('daily-task-unblocked', (event, data) => callback(data));
  },

  // 倒计时
  setTimer: (seconds, label, taskId) => ipcRenderer.send('set-timer', seconds, label, taskId || null),
  getTimerState: () => ipcRenderer.invoke('get-timer-state'),
  cancelTimer: () => ipcRenderer.invoke('cancel-timer'),
  onTimerStarted: (callback) => {
    ipcRenderer.on('timer-started', (event, data) => callback(data));
  },
  onTimerCancelled: (callback) => {
    ipcRenderer.on('timer-cancelled', (event, data) => callback(data));
  },
  onTimerDone: (callback) => {
    ipcRenderer.on('timer-done', (event, data) => callback(data));
  },

  // 番茄钟 / 专注统计
  getPomodoroState: () => ipcRenderer.invoke('get-pomodoro-state'),
  getFocusStats: () => ipcRenderer.invoke('get-focus-stats'),
  startPomodoro: () => ipcRenderer.invoke('pomodoro-start'),
  pausePomodoro: () => ipcRenderer.invoke('pomodoro-pause'),
  resetPomodoro: () => ipcRenderer.invoke('pomodoro-reset'),
  onPomodoroStatus: (callback) => {
    ipcRenderer.on('pomodoro-status', (event, data) => callback(data));
  },
  onPomodoroComplete: (callback) => {
    ipcRenderer.on('pomodoro-complete', (event, data) => callback(data));
  },
  onAmbientSoundCommand: (callback) => {
    ipcRenderer.on('ambient-sound-command', (event, data) => callback(data));
  },
  syncAmbientState: (state) => ipcRenderer.invoke('sync-ambient-state', state),
  onLayoutModeChanged: (callback) => {
    ipcRenderer.on('layout-mode-changed', (event, mode) => callback(mode));
  },
  onTodosChanged: (callback) => {
    ipcRenderer.on('todos-changed', () => callback());
  },

  // 格言
  getQuotes: () => ipcRenderer.invoke('get-quotes'),

  // 声音资源
  getSoundAssets: () => ipcRenderer.invoke('get-sound-assets'),
  // 遮罩材质切换（有封面背景时透明，无背景时 Acrylic）
  setOverlayMaterial: (material) => ipcRenderer.invoke('set-overlay-material', material),

  // 锁定 / 番茄钟设置
  getFocusSettings: () => ipcRenderer.invoke('get-focus-settings'),
  saveFocusSettings: (settings) => ipcRenderer.invoke('save-focus-settings', settings),

  // 专注报告 / 网站统计 / 快捷键
  getFocusReport: (days) => ipcRenderer.invoke('get-focus-report', days),
  getSiteStats: () => ipcRenderer.invoke('get-site-stats'),
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  saveShortcuts: (shortcuts) => ipcRenderer.invoke('save-shortcuts', shortcuts),
  setShortcutCapturing: (capturing) => ipcRenderer.send('set-shortcut-capturing', capturing),

  // 遮罩内编辑 config.js
  getConfigForEdit: () => ipcRenderer.invoke('get-config-for-edit'),
  saveConfigFromEdit: (cfg) => ipcRenderer.invoke('save-config-from-edit', cfg),

  // 强化锁定：紧急退出
  requestEmergencyExit: () => ipcRenderer.invoke('request-emergency-exit'),
  onEmergencyBlocked: (callback) => {
    ipcRenderer.on('emergency-blocked', (event, data) => callback(data));
  },
  // 关闭被拦截（Alt+F4 等）时主进程下发遮罩内提示
  onCloseBlocked: (callback) => {
    ipcRenderer.on('close-blocked', (event, data) => callback(data));
  },
  // 遮罩内尝试打开外部链接被拦截（防止跳转 GitHub 等导致无法退出）
  onExternalLinkBlocked: (callback) => {
    ipcRenderer.on('external-link-blocked', (event, url) => callback(url));
  },

  // 快速启动模式状态
  onQuickStartStatus: (callback) => {
    ipcRenderer.on('quick-start-status', (event, enabled) => callback(enabled));
  }
});
