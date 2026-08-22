const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, screen, dialog, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync, spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const https = require('https');
const { getBaseDir, getDataDir, loadAppConfig, saveConfigPatch, loadRawConfig, normalizeDailyTasks } = require('./main/config');
const { importUserScript, injectUserScripts, loadCrxExtensions, loadUserScripts, loadExtensionSettings, saveExtensionSettings, installExtensionFile, installExtensionDir, importUserStyle, loadUserStyles, injectUserStyles, loadUserstyleSettings, listUserStylesMeta, saveUserStyleVarOverrides, toggleUserStyle, deleteUserStyle, compileUserStyle, promoteImportant, equivalentKeys } = require('./main/extensions');
const { MicaBrowserWindow, IS_WINDOWS_11 } = require('mica-electron');
const BROWSER_VIEW_PARTITION = 'persist:focus-locker-browser-views';

// ========== 日志系统 ==========
const LOG_FILE = path.join(app.getPath('userData'), 'logs', 'app.log');
function logToFile(level, ...args) {
  try {
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, entry);
  } catch (e) {
    try { console.error('[logToFile]', e.message); } catch (e2) { /* ignore */ }
  }
}
process.on('uncaughtException', (err) => {
  logToFile('FATAL', 'Uncaught Exception:', err.stack);
});

// ========== 核心依赖 ==========
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const csv = require('csv-parser');
const { Readable } = require('stream');
const baseDir = getBaseDir(app);
const dataDir = getDataDir(app); // 用户可变数据目录（userData）：跨重装保留
const svvPath = path.join(baseDir, 'SoundVolumeView.exe');

// ========== Electron 配置 ==========
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
// 限制磁盘缓存 400MB：所有 persist 分区共用磁盘上限；防止网站刷几天之后 Cache 目录飙到几 GB
app.commandLine.appendSwitch('disk-cache-size', String(400 * 1024 * 1024));
// 限制渲染进程数量，避免 N 个网站 = N 个 Chromium 渲染进程常驻
app.commandLine.appendSwitch('renderer-process-limit', '4');

const args = process.argv.slice(1);
const isTestMode = args.includes('--test');
const isQuickStart = args.includes('--quick-start') || args.includes('--quick');
let quickModeActive = isQuickStart; // 快速模式标识：本次会话（含 second-instance 触发的快速锁屏）是否处于快速模式
const isAutoStart = args.includes('--autostart');   // 由自启动注册表项注入：用于延迟/静默待命
const AUTO_START_DELAY_MS = 5000;                   // 开机自启动延迟：避开开机资源争抢

// 单实例锁：已有实例运行时直接退出，避免多实例并发读写同一会话数据库导致登录态丢失
try {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock && !isTestMode) {
    logToFile('WARN', '检测到已有实例运行，退出当前实例');
    app.exit(0);
  } else if (gotLock) {
    app.on('second-instance', (event, argv) => {
      try {
        // 测试模式启动：生产实例收到信号后销毁自身遮罩，让测试实例独占
        const wantTest = argv.includes('--test');
        if (wantTest) {
          logToFile('INFO', 'second-instance 收到测试模式请求，销毁生产遮罩让位');
          testHandoffActive = true;
          if (overlayWin && !overlayWin.isDestroyed()) {
            overlayWin.destroy();
            cleanupOverlay();
          }
          return;
        }
        // 快速模式请求：由已运行实例直接执行快速锁屏（保持单实例，避免 cookie 库并发写冲突）
        const wantQuick = argv.includes('--quick-start') || argv.includes('--quick');
        if (wantQuick) {
          logToFile('INFO', 'second-instance 收到快速锁屏请求');
          quickModeActive = true;
          extendLockTime(60);
          createOverlay();
          setTimeout(() => {
            if (overlayWin && !overlayWin.isDestroyed()) {
              overlayWin.webContents.send('quick-start-status', true);
            }
          }, 500);
          return;
        }
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.show();
          overlayWin.focus();
        }
      } catch (e) {
        logToFile('WARN', 'second-instance 处理异常', e.message);
      }
    });
  }
} catch (e) {
  logToFile('WARN', '单实例锁异常，继续启动', e.message);
}

let overlayWin = null;
let musicPopupWin = null;
let killTimer = null, checkTimer = null, topTimer = null, silenceTimer = null;
let originalNotificationSoundValue = null;
let emergencyExited = false;
let autoLaunchEnabled = true;
let guardMode = 'task';   // 看门狗模式：task=计划任务（默认，分发友好）；proc=guard.ps1 长驻守护
let guardEnabled = true;  // 看门狗总开关：false 时禁用"被强杀后自动重启"监测
let instantMode = false;  // 即时模式：任意时间直接紧急退出（跳过冷却/验证码/时长限制），遮罩顶部胶囊提醒
let instantModeEnabled = true; // 允许启用即时模式（config.js 参数）：false 时即时模式不可开启、不生效
let testHandoffActive = false;  // 生产实例收到测试模式 second-instance 信号后置 true：阻止 checkTimeAndToggle 重建遮罩
const testLockFile = path.join(baseDir, '.test-active'); // 测试实例存活标记文件：退出时删除，生产实例据此恢复调度

let forceAlwaysOnTop = true;
let isMusicPopped = false;

let isEmergencyBreak = false;
let emergencyCooldownUntil = 0;
let emergencyRestoreTimer = null;
let emergencyExemptUntil = 0;   // 紧急退出后：当前锁屏时段不再自动锁屏（毫秒时间戳）
let cooldownPauseTime = 0;       // 冷却暂停时间戳：遮罩激活期间冻结冷却计时，关闭遮罩时顺延
let dailyTasks = [];             // 每日任务列表（来自 config.js）
let emergencyExitInProgress = false; // 紧急退出正在关闭遮罩：关闭事件据此放行，不受每日任务拦截

let extendedUntil = 0;
let extendTimer = null;
let timerStartTime = null;

// ===== 全局快捷键（可在设置页自定义） =====
const DEFAULT_SHORTCUTS = {
  switchSite: 'Ctrl+Shift+Alt+Space',
  toggleAlwaysOnTop: 'Ctrl+Shift+Alt+T',
  emergencyExit: 'Ctrl+Shift+Alt+F12',
  toggleAgent: 'Ctrl+Shift+Alt+A',
  extendLock: 'Ctrl+Shift+Alt+E',
  toggleSiteLock: 'Ctrl+Shift+Alt+L',
  relock: 'Ctrl+Shift+Alt+R'
};
const SHORTCUT_ACTIONS = { switchSite: 'switchSite', toggleAlwaysOnTop: 'toggleAlwaysOnTop', emergencyExit: 'emergencyExit', toggleAgent: 'toggleAgent', extendLock: 'extendLock', toggleSiteLock: 'toggleSiteLock', relock: 'relock' };

// ===== 强化锁定 / 番茄钟 / 专注统计 =====
const FOCUS_SETTINGS_FILE = path.join(dataDir, 'focus-settings.json');
let focusSettings = { minLockMinutes: 0, verifyCodeEnabled: true, focusLen: 25, breakLen: 5, siteLockMinMinutes: 0, timerSyncPomodoro: true, instantMode: false, shortcuts: { ...DEFAULT_SHORTCUTS } };
let pendingMinSettings = null; // 已保存但下次出现遮罩才应用的两个最短时长设置
let pendingTaskRatio = null;   // 已保存但下次出现遮罩才应用的「每日任务完成率阈值」（自定义任务完成比例）
let lockStartedAt = null;   // 本次锁屏开始时间（用于最短锁定时长校验）
let pomodoro = {
  mode: 'idle',             // 'idle' | 'focus' | 'break'
  running: false,
  remaining: 0,
  pendingFocus: 0,          // 尚未落盘的专注秒数
  tickCount: 0,             // 落盘节流计数
  tickTimer: null
};
let todayFocusLoaded = 0;   // 今日已落盘的专注秒数
let todayPomodorosLoaded = 0; // 今日已完成番茄轮数（落盘值）
let todayHourly = Array(24).fill(0); // 今日每小时专注秒数
let focusStatsDate = null;  // 当前统计日期 YYYY-MM-DD

// ===== 倒计时相关 =====
let activeTimer = null; // { timeoutId, endTime, label, seconds }
let timerPomodoroSynced = false; // 倒计时接管了番茄钟剩余时长（番茄钟跟随倒计时结束）
let unlockAfterTimer = null; // 锁屏时段结束但倒计时仍在：延后到倒计时结束后 1 分钟再解锁

// 进程音量存储
let processVolumes = new Map();

let deepseekApiKey = null;

let siteList = [];
let viewsMap = new Map();
let visibleSiteId = null;
let siteLockActive = false; // 网站即时锁定（运行时开关，锁定期间禁止一切切换）
let siteLockedAt = 0;       // 锁定开始时间戳（用于网站最短锁定时长校验）
let siteViewActive = false; // 网站视图激活（专注助手「网站」页打开时 BrowserView 显示在面板内容区）
let sitePanelBounds = null;  // 网站面板内容区坐标 { top, height }（px，由渲染进程同步）
let layoutMode = 'modern';   // 界面布局：modern 现代（网站收纳面板）/ legacy 经典（网站常驻右侧）
// 环境音状态（主进程侧同步，供 AI 工具查询/控制）。混音模式：sounds = { rain: 60, fire: 40, ... }（value>0 表示该音源开启），masterVolume 为全局音量
const AMBIENT_TYPES = ['rain', 'fire', 'waves', 'white'];
const AMBIENT_LABELS = { rain: '雨声', fire: '篝火', waves: '海浪', white: '白噪音' };
let ambientState = { sounds: {}, masterVolume: 60 };

// ===== 网站使用时长统计 =====
const SITE_STATS_FILE = path.join(dataDir, 'site-stats.json');
let siteUsage = {};          // { 'YYYY-MM-DD': { siteId: 秒数 } }
let siteUsageDate = null;
let siteUsageTickTimer = null;

let timeRanges = [];
let userScripts = [];
let userStyles = []; // 用户样式（.user.css），随网站 BrowserView 加载注入
let extensionLoadResults = [];
let browserViewSession = null;
let extensionsReady = Promise.resolve();
const openExtensionWindows = new Set(); // 扩展 UI 窗口，遮罩关闭时统一释放，避免僵尸窗口占内存

// ========== Agent 工具定义 ==========
const tools = [
  {
    type: "function",
    function: {
      name: "get_lock_status",
      description: "获取当前锁屏状态",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "start_timer",
      description: "开始计时，记录当前时间。如果已经有一个计时在进行，则会重置计时（重新开始）。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "stop_timer",
      description: "停止计时，返回从开始到现在的总时长（格式：mm:ss）。如果尚未开始计时，则返回错误提示。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_timer_status",
      description: "查询当前计时器（秒表）已运行的时长，不会停止计时。与倒计时不同，这是“开始计时”工具产生的计时器。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "toggle_site_lock",
      description: "切换网站锁定：开启后锁定当前网站，锁定期间无法通过任何方式（UI/快捷键/AI）切换网站；再次调用可解除锁定。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "switch_site",
      description: "切换当前显示的网站",
      parameters: {
        type: "object",
        properties: {
          site_name: { type: "string", description: "目标站点名称" }
        },
        required: ["site_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "extend_lock",
      description: "延长锁屏时间",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "integer", description: "分钟数" }
        },
        required: ["minutes"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_todo",
      description: "添加待办任务",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "任务内容" }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_todos",
      description: "获取今日待办",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "emergency_exit",
      description: "紧急退出锁屏。受最短锁定/冷却/验证码等限制约束，最长只能退出 1200 秒（20 分钟）。若被拦截会返回原因。",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "integer", description: "暂停秒数" }
        },
        required: ["seconds"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_timer",
      description: "设置一个倒计时，在指定时间后提醒用户。",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "integer", description: "分钟数（可选，与 seconds 二选一）" },
          seconds: { type: "integer", description: "秒数（可选，与 minutes 二选一，优先使用 seconds）" },
          label: { type: "string", description: "倒计时标签（可选）" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "start_daily_task",
      description: "开始一个每日任务并启动其绑定的倒计时。传入任务名称（如“背单词”），系统会匹配 config.js 中配置的每日任务并按其设定时长启动倒计时。当用户说“开始xx任务”时调用此工具。",
      parameters: {
        type: "object",
        properties: {
          task_name: { type: "string", description: "要开始的任务名称" }
        },
        required: ["task_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "start_pomodoro",
      description: "开始番茄钟专注计时（时长在锁定设置中配置，默认 25 分钟）。专注期间会自动累计今日专注时长。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "pause_pomodoro",
      description: "暂停当前番茄钟计时。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "reset_pomodoro",
      description: "重置番茄钟计时（已累计的今日专注时长不会丢失）。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_focus_stats",
      description: "获取今日及近 7 天的专注时长统计。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "play_ambient_sound",
      description: "播放白噪音/环境音帮助专注。type 可选：rain(雨声)、fire(篝火)、waves(海浪)、white(白噪音)。可多次调用叠加多个音源混合播放（例如先放 rain 再放 fire 即为雨声+篝火）。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "音效类型：rain / fire / waves / white" }
        },
        required: ["type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "stop_ambient_sound",
      description: "停止环境音。不传 type 时停止全部音源；传入 type 时仅停止指定音源（如 rain）。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "可选：要停止的音效类型 rain / fire / waves / white，不传则全部停止" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_quote",
      description: "获取一条随机励志格言，可用于激励用户保持专注。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_pomodoro_state",
      description: "查询当前番茄钟状态（模式：专注/休息/待机、剩余时间、今日专注时长）。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_timer_state",
      description: "查询当前倒计时状态（有无进行中的倒计时、剩余秒数、标签）。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "cancel_timer",
      description: "取消当前进行中的倒计时，倒计时提醒将不再触发。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "toggle_always_on_top",
      description: "切换窗口置顶状态：开启后遮罩窗口始终位于所有窗口之上。返回切换后的置顶状态。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "set_layout_mode",
      description: "切换界面风格：modern（现代，全屏居中，网站收纳在专注助手面板）或 legacy（经典，左右分栏，网站常驻右侧）。",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", description: "目标风格：modern 或 legacy" }
        },
        required: ["mode"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_layout_mode",
      description: "查询当前界面风格（modern 现代 / legacy 经典）。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前日期与时间（含星期）。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_site_list",
      description: "获取网站列表：包含全部站点名称、当前显示的站点、固定状态与锁定状态。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_ambient_state",
      description: "查询环境音状态：正在播放哪些音源、各自音量、总音量。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "set_ambient_volume",
      description: "设置环境音音量（0-100）。",
      parameters: {
        type: "object",
        properties: {
          volume: { type: "integer", description: "音量值 0-100" }
        },
        required: ["volume"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_all_todos",
      description: "获取今日全部待办，返回带序号（index）的列表，供完成/删除待办使用。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_todo",
      description: "完成或取消完成某条待办。index 为 list_all_todos 返回的序号，completed 不传时切换完成状态。",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "待办序号（从 0 开始）" },
          completed: { type: "boolean", description: "true 完成 / false 取消完成（可选）" }
        },
        required: ["index"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_todo",
      description: "删除某条待办。index 为 list_all_todos 返回的序号。",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "待办序号（从 0 开始）" }
        },
        required: ["index"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_system_status",
      description: "获取系统综合状态：当前时间、锁屏状态、置顶、界面风格、番茄钟、倒计时、环境音、今日专注时长。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  // ===== 管理能力（网站 / 每日任务 / 扩展脚本） =====
  {
    type: "function",
    function: {
      name: "list_sites",
      description: "获取完整网站配置列表：每个网站的 id、名称、网址、缩放、别名、常驻（persistent）、固定（pinned）状态，以及当前显示的网站。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "add_site",
      description: "新增网站到网站配置。常驻（persistent=true）的网站离开遮罩后仍保持加载；固定（pinned=true）的网站锁屏期间置顶且禁止切换。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "网站名称（必填，须与现有网站不重名）" },
          url: { type: "string", description: "网址，需以 http:// 或 https:// 开头（必填）" },
          zoom: { type: "number", description: "缩放倍数，0.1~5，默认 1" },
          persistent: { type: "boolean", description: "是否常驻（离开遮罩不销毁），默认 true" },
          pinned: { type: "boolean", description: "是否固定（锁屏置顶），默认 false" },
          aliases: { type: "array", items: { type: "string" }, description: "别名列表（可选），用于语音/文字切换网站" }
        },
        required: ["name", "url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_site",
      description: "修改现有网站的配置（网址/缩放/常驻/固定/别名/名称）。通过 name 定位网站；只更新传入的字段。修改网址后已加载的视图会立即刷新。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "要修改的现有网站名称（必填）" },
          new_name: { type: "string", description: "改名后的新名称（可选）" },
          url: { type: "string", description: "新网址，需以 http:// 或 https:// 开头（可选）" },
          zoom: { type: "number", description: "新缩放倍数 0.1~5（可选）" },
          persistent: { type: "boolean", description: "是否常驻（可选）" },
          pinned: { type: "boolean", description: "是否固定（可选）" },
          aliases: { type: "array", items: { type: "string" }, description: "新别名列表（可选）" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remove_site",
      description: "删除一个网站。若该网站为当前显示网站会先切换到其他网站；对应已加载视图同步销毁。网站锁定期间禁止删除。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "要删除的网站名称（必填）" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_daily_tasks",
      description: "获取每日任务列表（任务名与预计分钟数）。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "add_daily_task",
      description: "新增每日任务。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "任务名称（必填，须与现有任务不重名）" },
          minutes: { type: "integer", description: "预计分钟数，0~1440，默认 0" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remove_daily_task",
      description: "删除一个每日任务。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "要删除的任务名称（必填）" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_extension_status",
      description: "查询当前已加载的浏览器扩展（CRX）与用户脚本状态：扩展名称/来源/是否带配置页、脚本名称/匹配规则。",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索互联网获取最新信息。当用户问题涉及实时/时效性内容（新闻、事件、最新动态、需要查证的事实等）或现有知识可能过时时调用。返回前 5 条搜索结果（标题/网址/摘要），请基于结果摘要回答并附上来源链接。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词（建议简洁具体，可用中文）" }
        },
        required: ["query"]
      }
    }
  }
];

// ========== 配置加载 ==========
// 从扩展设置中读取被禁用的用户脚本文件名集合
function getDisabledUserScriptNames() {
  const settings = loadExtensionSettings(dataDir);
  return new Set(Object.keys(settings.disabledScripts || {}));
}

function loadConfig() {
  try {
    const config = loadAppConfig(app);
    autoLaunchEnabled = config.autoLaunch;
    guardMode = config.guardMode === 'proc' ? 'proc' : 'task';
    guardEnabled = config.guardEnabled !== false;
    instantModeEnabled = config.instantModeEnabled === true; // 默认关闭，需在 config.js 显式开启
    deepseekApiKey = config.deepseekApiKey;
    siteList = config.sites;
    timeRanges = config.timeRanges;
    dailyTasks = Array.isArray(config.dailyTasks) ? config.dailyTasks : [];
    userScripts = loadUserScripts(config.baseDir, config.userScripts, getDisabledUserScriptNames());
    userStyles = loadUserStyles(config.dataDir);
    logToFile('INFO', '配置加载完成', {
      configPath: config.configPath,
      autoLaunchEnabled,
      instantModeEnabled,
      sites: siteList.map(s => s.name),
      userScripts: userScripts.map(s => s.name),
      userStyles: userStyles.map(s => s.name)
    });
  } catch (e) {
    logToFile('ERROR', '配置加载失败', e.message);
  }
}

// ========== 管理员与自启 ==========
function ensureAdmin() {
  if (!app.isPackaged) return true;
  try {
    const exePath = app.getPath('exe');
    const result = execSync(
      `powershell -Command "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"`,
      { encoding: 'utf8', windowsHide: true }
    ).trim();
    if (result !== 'True') {
      spawn('powershell', [`Start-Process "${exePath}" -Verb RunAs`], {
        detached: true, stdio: 'ignore', shell: true, windowsHide: true
      });
      app.exit();
      return false;
    }
  } catch (e) { logToFile('ERROR', '管理员检查失败', e); }
  return true;
}

// ========== 自启动（双保险：Electron 原生 API + 注册表直写，同步清除 StartupApproved 禁用标记） ==========
const AUTO_START_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTO_START_REG_NAME = 'FocusLocker';
const AUTO_START_ARG = '--autostart';
const AUTO_START_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const AUTO_START_TASK_NAME = 'FocusLocker';   // 任务计划程序任务名（requireAdministrator 应用自启的唯一可靠方式）

function execRegQuery() {
  return new Promise((resolve, reject) => {
    exec(`reg query "${AUTO_START_REG_KEY}" /v ${AUTO_START_REG_NAME}`, { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout || '');
    });
  });
}
function retryAsync(fn, attempts, delayMs, tag) {
  return fn().catch(err => {
    if (attempts <= 1) { logToFile('ERROR', `自启动操作最终失败[${tag}]`, err.message); throw err; }
    logToFile('WARN', `自启动操作失败，将重试[${tag}]`, err.message);
    return new Promise(r => setTimeout(r, delayMs)).then(() => retryAsync(fn, attempts - 1, delayMs, tag));
  });
}
// 清除 StartupApproved 禁用标记（任务管理器禁用后为 02+时间戳，启用应为 02 后跟 11 个 00）
function clearStartupApproved() {
  const bytes = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const hex = bytes.toString('hex');
  return new Promise((resolve) => {
    spawn('reg', ['add', AUTO_START_APPROVED_KEY, '/v', AUTO_START_REG_NAME, '/t', 'REG_BINARY', '/d', hex, '/f'], {
      windowsHide: true, stdio: 'ignore'
    }).on('exit', (code) => {
      if (code !== 0) logToFile('WARN', 'StartupApproved 启用标记写回失败，退出码 ' + code);
      resolve();
    });
  });
}
// 写入自启动：任务计划程序为主路径（最高权限、登录时静默启动，绕过 UAC 弹窗），注册表 Run 为辅
function setupAutoLaunch() {
  const exePath = app.getPath('exe');
  const args = [AUTO_START_ARG];
  const regValue = `"${exePath}" ${AUTO_START_ARG}`;
  // 1. 任务计划程序：登录时以最高权限运行（requireAdministrator 应用自启的正解）
  const writeTask = () => new Promise((resolve, reject) => {
    spawn('schtasks', ['/Create', '/TN', AUTO_START_TASK_NAME, '/TR', `"${exePath}" ${AUTO_START_ARG}`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F'], {
      windowsHide: true, stdio: 'ignore'
    }).on('exit', (code) => code === 0 ? resolve() : reject(new Error(`schtasks /Create 退出码 ${code}`)));
  });
  // 2. Electron 原生 API（辅助：失败仅告警，不阻断）
  const writeLoginItem = () => {
    try {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false, path: exePath, args });
      const s = app.getLoginItemSettings();
      if (!s.openAtLogin) {
        logToFile('WARN', 'setLoginItemSettings 写入后 openAtLogin=false，将由注册表直写兜底');
      }
    } catch (e) {
      logToFile('WARN', 'setLoginItemSettings 异常', e.message);
    }
  };
  // 3. 注册表 Run 直写（辅助，非管理员 exe 场景仍可生效）
  const writeReg = () => new Promise((resolve, reject) => {
    spawn('reg', ['add', AUTO_START_REG_KEY, '/v', AUTO_START_REG_NAME, '/t', 'REG_SZ', '/d', regValue, '/f'], {
      windowsHide: true, stdio: 'ignore'
    }).on('exit', (code) => code === 0 ? resolve() : reject(new Error(`reg add 退出码 ${code}`)));
  });
  const queryTask = () => new Promise((resolve) => {
    exec(`schtasks /Query /TN ${AUTO_START_TASK_NAME}`, { windowsHide: true }, (err) => resolve(!err));
  });
  const verify = () => Promise.all([
    execRegQuery().then(stdout => stdout.includes(AUTO_START_ARG)).catch(() => false),
    queryTask()
  ]).then(([regOk, taskOk]) => {
    if (!regOk && !taskOk) throw new Error('自启动校验失败：任务计划与注册表 Run 项均不存在');
  });
  return retryAsync(() =>
    Promise.resolve()
      .then(writeTask)
      .then(writeLoginItem)
      .then(writeReg)
      .then(clearStartupApproved)
      .then(verify), 3, 1000, 'setup')
    .then(() => { logToFile('INFO', '开机自启配置写入完成', { exePath, args, regValue }); return true; })
    .catch(err => { logToFile('ERROR', '开机自启写入最终失败', err && err.message); return false; });
}
// 移除自启动
function removeAutoLaunch() {
  const exePath = app.getPath('exe');
  const args = [AUTO_START_ARG];
  const delLoginItem = () => new Promise(resolve => {
    try { app.setLoginItemSettings({ openAtLogin: false, path: exePath, args }); } catch (e) {}
    resolve();
  });
  const delTask = () => new Promise((resolve, reject) => {
    spawn('schtasks', ['/Delete', '/TN', AUTO_START_TASK_NAME, '/F'], {
      windowsHide: true, stdio: 'ignore'
    }).on('exit', (code) => {
      if (code === 0) return resolve();
      // 任务不存在也视为删除成功
      exec(`schtasks /Query /TN ${AUTO_START_TASK_NAME}`, { windowsHide: true }, (err) => {
        err ? resolve() : reject(new Error(`schtasks /Delete 退出码 ${code}`));
      });
    });
  });
  const del = () => new Promise((resolve, reject) => {
    spawn('reg', ['delete', AUTO_START_REG_KEY, '/v', AUTO_START_REG_NAME, '/f'], {
      windowsHide: true, stdio: 'ignore'
    }).on('exit', (code) => {
      if (code === 0) return resolve();
      execRegQuery().then(() => reject(new Error('reg delete 失败且该项仍存在')), () => resolve());
    });
  });
  return retryAsync(() => delLoginItem().then(delTask).then(del), 3, 1000, 'remove')
    .then(() => true).catch(() => false);
}
function applyAutoLaunch() {
  logToFile('INFO', '应用自启配置', { autoLaunchEnabled });
  return autoLaunchEnabled ? setupAutoLaunch() : removeAutoLaunch();
}

// ========== 进程加固：看门狗 ==========
// 两种模式：
//  'task'（默认）：schtasks 每分钟检查任务（guard-task.ps1）。由任务计划程序独立运行，不受
//                 Electron Job Object 影响（主进程被强杀时 guard 不会连带死亡），短生命周期
//                 也不触发杀软"隐藏长驻监控进程"误判，适合分发。
//  'proc'（可选）：guard.ps1 隐藏 powershell 长驻守护，重启更快（秒级），但依赖杀软信任区。
const GRACE_EXIT_FLAG = path.join(app.getPath('userData'), 'graceful-exit.flag');
// 看门狗重启标记：guard 拉起的新实例据此进入 20 分钟紧急退出冷却，防止"杀进程重启绕过锁屏"
const WATCHDOG_RESTART_FLAG = path.join(app.getPath('userData'), 'watchdog-restart.flag');
const GUARD_TASK_NAME = 'FocusLockerGuard';
const GUARD_PROC_TASK_NAME = 'FocusLockerGuardProc';
let watchdogProc = null;

// task 模式：创建/刷新计划任务（每分钟检查主进程，被强杀后自动拉起）
// 用 wscript.exe 承载 VBS（GUI 子系统宿主），避免 powershell 控制台窗口每分钟闪现
function ensureGuardTask() {
  return new Promise((resolve) => {
    const script = path.join(baseDir, 'guard-task.vbs');
    const tr = `wscript.exe "${script}"`;
    spawn('schtasks', ['/Create', '/TN', GUARD_TASK_NAME, '/TR', tr, '/SC', 'MINUTE', '/MO', '1', '/F', '/RL', 'HIGHEST', '/IT'], {
      windowsHide: true, stdio: 'ignore'
    }).on('exit', (code) => {
      if (code === 0) logToFile('INFO', '看门狗计划任务已创建/刷新', { task: GUARD_TASK_NAME });
      else logToFile('WARN', '看门狗计划任务创建失败，退出码 ' + code);
      resolve(code === 0);
    });
  });
}
function queryScheduledTask(taskName) {
  return new Promise((resolve) => {
    exec(`schtasks /Query /TN ${taskName}`, { windowsHide: true }, (err) => resolve(!err));
  });
}

// proc 模式：通过计划任务 + wscript 启动长驻 guard.ps1。
// guard.ps1 的进程树从"任务计划程序服务"派生，脱离 Electron Job Object——
// 主进程被 taskkill /f 强杀时，Job Object 连坐销毁的只是 job 内进程，guard.ps1 得以存活，
// 实现秒级重启。任务每分钟触发一次，VBS 幂等检查保证 guard 被反杀后能重新拉起。
function startWatchdogProc() {
  if (isTestMode || !guardEnabled || watchdogProc) return;
  const exePath = app.getPath('exe');
  const restartArgs = args.filter(a => a !== '--test').join(' ');
  const script = path.join(baseDir, 'guard-proc.vbs');
  const tr = `wscript.exe "${script}" ${process.pid} "${restartArgs}"`;
  watchdogProc = { pid: process.pid }; // 哨兵：防止重复创建任务
  spawn('schtasks', ['/Create', '/TN', GUARD_PROC_TASK_NAME, '/TR', tr, '/SC', 'MINUTE', '/MO', '1', '/F', '/RL', 'HIGHEST', '/IT'], {
    windowsHide: true, stdio: 'ignore'
  }).on('exit', (code) => {
    if (code === 0) {
      logToFile('INFO', '看门狗守护任务已创建(proc)', { mainPid: process.pid, restartArgs });
      // 立即触发一次，让 guard.ps1 尽快长驻，无需等待下一分钟
      spawn('schtasks', ['/Run', '/TN', GUARD_PROC_TASK_NAME], { windowsHide: true, stdio: 'ignore' })
        .on('error', e => logToFile('WARN', '看门狗立即触发失败', e.message));
    } else {
      watchdogProc = null;
      logToFile('WARN', '看门狗守护任务创建失败，退出码 ' + code);
    }
  });
  logToFile('INFO', '看门狗已启动(proc)');
}

// 按配置模式启动看门狗
async function startWatchdog() {
  if (isTestMode || !guardEnabled) return;
  if (guardMode === 'proc') {
    startWatchdogProc();
  } else {
    await ensureGuardTask();
  }
}

// 定期校验看门狗：task 模式检查任务存在；proc 模式检查守护任务并幂等触发（VBS 自行判断 guard 是否存活）
async function ensureWatchdog() {
  if (isTestMode || !guardEnabled) return;
  if (guardMode === 'proc') {
    const ok = await queryScheduledTask(GUARD_PROC_TASK_NAME);
    if (!ok) {
      logToFile('WARN', '看门狗守护任务缺失，重新创建');
      startWatchdogProc();
      return;
    }
    // 任务在但 guard.ps1 可能已被反杀：幂等触发一次，VBS 检查后决定是否重新拉起
    spawn('schtasks', ['/Run', '/TN', GUARD_PROC_TASK_NAME], { windowsHide: true, stdio: 'ignore' })
      .on('error', e => logToFile('WARN', '看门狗触发失败', e.message));
    return;
  }
  const ok = await queryScheduledTask(GUARD_TASK_NAME);
  if (!ok) {
    logToFile('WARN', '看门狗计划任务缺失，重新创建');
    await ensureGuardTask();
  }
}

// ========== 进程音量控制（SoundVolumeView 方案） ==========
const MUTE_ENTRIES = [
  { names: ['qq.exe', 'QQ'] },
  { names: ['steam.exe', 'Steam'] },
  { names: ['Minecraft.Windows.exe', 'Minecraft.Windows', 'Minecraft'] },
  { names: ['Weixin.exe', 'Weixin', 'WeChat', '微信', 'WeChatUtility.exe'] },
  { names: ['WeChatAppEx x64', 'WeChatAppEx','WeChatAppEx x64.exe', 'WeChatAppEx.exe']}
];

function isProcessRunning(processName) {
  return new Promise((resolve) => {
    exec(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, { windowsHide: true }, (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.toLowerCase().includes(processName.toLowerCase()));
    });
  });
}

function runSvv(args) {
  return new Promise((resolve) => {
    if (!fs.existsSync(svvPath)) {
      logToFile('ERROR', `[Volume] SoundVolumeView.exe not found at: ${svvPath}`);
      resolve(false);
      return;
    }
    const cmd = `"${svvPath}" ${args}`;
    logToFile('INFO', `[Volume] exec: ${cmd}`);
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        logToFile('ERROR', `[Volume] SoundVolumeView failed`, err.message, stderr);
        resolve(false);
      } else {
        logToFile('INFO', `[Volume] SoundVolumeView success`, stdout.trim());
        resolve(true);
      }
    });
  });
}

// 静音所有目标进程
async function muteTargetProcesses() {
  if (!fs.existsSync(svvPath)) {
    logToFile('ERROR', `[Volume] SoundVolumeView.exe not found. Please download from https://www.nirsoft.net/utils/sound_volume_view.html and place it at: ${svvPath}`);
    return;
  }

  for (const entry of MUTE_ENTRIES) {
    const primaryName = entry.names[0];
    if (processVolumes.has(primaryName)) continue;

    let running = false;
    for (const alias of entry.names) {
      running = await isProcessRunning(alias);
      if (running) break;
    }
    if (!running) {
      logToFile('WARN', `[Volume] Process not running: ${primaryName}`);
      continue;
    }

    let success = false;
    let matchedName = primaryName;
    for (const alias of entry.names) {
      success = await runSvv(`/Mute "${alias}"`);
      if (success) { matchedName = alias; break; }
    }

    if (success) {
      processVolumes.set(primaryName, { name: matchedName });
      logToFile('INFO', `[Volume] Muted: ${primaryName} (matched as "${matchedName}")`);
    } else {
      logToFile('ERROR', `[Volume] Failed to mute: ${primaryName}, tried: ${entry.names.join(', ')}`);
    }
  }
}

// 异步恢复
async function unmuteTargetProcesses() {
  for (const [, info] of processVolumes) {
    let ok = await runSvv(`/SetVolume "${info.name}" 100`);
    if (!ok) ok = await runSvv(`/Unmute "${info.name}"`);
    if (ok) {
      logToFile('INFO', `[Volume] Unmuted: ${info.name}`);
    } else {
      logToFile('ERROR', `[Volume] Failed to unmute: ${info.name}`);
    }
  }
  processVolumes.clear();
}

// 同步恢复
function unmuteTargetProcessesSync() {
  if (!fs.existsSync(svvPath)) {
    logToFile('ERROR', `[Volume] SoundVolumeView.exe not found at: ${svvPath}`);
    processVolumes.clear();
    return;
  }
  for (const [, info] of processVolumes) {
    try {
      execSync(`"${svvPath}" /SetVolume "${info.name}" 100`, { windowsHide: true, timeout: 5000 });
      execSync(`"${svvPath}" /Unmute "${info.name}"`, { windowsHide: true, timeout: 5000 });
      logToFile('INFO', `[Volume] Sync restored: ${info.name}`);
    } catch (e) {
      logToFile('ERROR', `[Volume] Sync restore failed: ${info.name}`, e.message);
    }
  }
  processVolumes.clear();
}

// 定时强制静音
function maintainMute() {
  for (const [, info] of processVolumes) {
    runSvv(`/Mute "${info.name}"`);
  }
}

// ========== 窗口最小化 ==========
function minimizeAllWindows() {
  exec('powershell -command "(new-object -com shell.application).minimizeall()"', { windowsHide: true });
}

// ========== 锁屏判断 ==========
// 当前锁屏时段的结束时间戳（紧急退出后用于豁免该时段）
function getCurrentRangeEnd() {
  const now = new Date();
  const currentMin = now.getHours() * 60 + now.getMinutes();
  for (const range of timeRanges) {
    if (currentMin >= range.startMin && currentMin < range.endMin) {
      const end = new Date(now);
      end.setHours(Math.floor(range.endMin / 60), range.endMin % 60, 0, 0);
      return end.getTime();
    }
  }
  return 0;
}
let testEnableLockTime = false; // 测试辅助：--test 模式下模拟真实锁屏时段判断（仅测试用）
function isInLockTime() {
  if ((isTestMode && !testEnableLockTime) || emergencyExited || isEmergencyBreak) return false;
  const now = Date.now();
  if (emergencyExemptUntil > now) return false; // 紧急退出豁免：本锁屏时段不再自动锁屏
  if (extendedUntil > now) return true;
  const date = new Date();
  const currentMin = date.getHours() * 60 + date.getMinutes();
  for (const range of timeRanges) {
    if (currentMin >= range.startMin && currentMin < range.endMin) return true;
  }
  return false;
}

// ========== 系统静音 ==========
const REG_PATH = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';
const REG_VALUE = 'NOC_GLOBAL_SETTING_ALLOW_NOTIFICATION_SOUNDS';
function readSilenceValue() {
  try {
    const cmd = `powershell -Command "Get-ItemProperty -Path '${REG_PATH}' -Name '${REG_VALUE}' -ErrorAction Stop | Select-Object -ExpandProperty '${REG_VALUE}'"`;
    const out = execSync(cmd, { encoding: 'utf8', windowsHide: true }).trim();
    return out === '1' ? 1 : 0;
  } catch (e) { return 1; }
}
function setSilenceValue(val) {
  exec(`powershell -Command "Set-ItemProperty -Path '${REG_PATH}' -Name '${REG_VALUE}' -Value ${val}"`, { windowsHide: true });
}
function enableSilence() {
  if (originalNotificationSoundValue === null) {
    originalNotificationSoundValue = readSilenceValue();
  }
  setSilenceValue(0);
}
function disableSilence() {
  if (originalNotificationSoundValue !== null) {
    setSilenceValue(originalNotificationSoundValue);
    originalNotificationSoundValue = null;
  }
}

// ========== 输入对话框 ==========
function createInputDialog(options) {
  return new Promise((resolve) => {
    ipcMain.removeAllListeners('input-dialog-result');
    const { title, message, defaultValue = '60' } = options;
    const win = new BrowserWindow({
      width: 400, height: 180,
      parent: (overlayWin && !overlayWin.isDestroyed()) ? overlayWin : undefined,
      modal: true, show: false, frame: false, transparent: false,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        background: rgba(24, 26, 32, 0.95);
        backdrop-filter: blur(16px);
        color: #F0F2F8;
        padding: 24px 32px;
        display: flex;
        flex-direction: column;
        height: 100vh;
        justify-content: center;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.06);
      }
      label {
        font-size: 16px;
        font-weight: 450;
        margin-bottom: 12px;
        color: rgba(240, 242, 248, 0.6);
      }
      input {
        padding: 10px 14px;
        font-size: 18px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(0,0,0,0.3);
        color: #fff;
        outline: none;
        transition: 0.2s;
        font-family: inherit;
      }
      input:focus {
        border-color: #7C8CFA;
        box-shadow: 0 0 0 3px rgba(124, 140, 250, 0.25);
        background: rgba(0,0,0,0.4);
      }
      .buttons {
        margin-top: 20px;
        display: flex;
        gap: 12px;
        justify-content: flex-end;
      }
      button {
        padding: 10px 28px;
        border: none;
        border-radius: 10px;
        font-size: 16px;
        cursor: pointer;
        font-weight: 500;
        transition: 0.2s;
        font-family: inherit;
      }
      button#ok {
        background: #7C8CFA;
        color: #000;
        box-shadow: 0 2px 12px rgba(124, 140, 250, 0.3);
      }
      button#ok:hover {
        transform: scale(1.03);
        box-shadow: 0 4px 20px rgba(124, 140, 250, 0.4);
      }
      button#cancel {
        background: rgba(255,255,255,0.06);
        color: #F0F2F8;
        border: 1px solid rgba(255,255,255,0.08);
      }
      button#cancel:hover {
        background: rgba(255,255,255,0.12);
      }
    </style>
  </head>
  <body>
    <label>${message}</label>
    <input type="number" id="input" value="${defaultValue}" min="1" step="1" autofocus />
    <div class="buttons">
      <button id="cancel">取消</button>
      <button id="ok">确定</button>
    </div>
    <script>
      const input=document.getElementById('input');
      const okBtn=document.getElementById('ok');
      const cancelBtn=document.getElementById('cancel');
      const {ipcRenderer}=require('electron');
      function sendResult(value){ ipcRenderer.send('input-dialog-result', value); window.close(); }
      okBtn.addEventListener('click',()=>{ const val=parseInt(input.value,10); if(isNaN(val)||val<=0){alert('请输入正整数！');return;} sendResult(val); });
      cancelBtn.addEventListener('click',()=>{ sendResult(null); });
      input.addEventListener('keydown',(e)=>{ if(e.key==='Enter') okBtn.click(); if(e.key==='Escape') cancelBtn.click(); });
      input.focus(); input.select();
    </script>
  </body>
  </html>
`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once('ready-to-show', () => { win.show(); });
    win.on('closed', () => { ipcMain.removeAllListeners('input-dialog-result'); resolve(null); });
    ipcMain.once('input-dialog-result', (event, value) => { resolve(value); if (!win.isDestroyed()) win.close(); });
  });
}

// ========== 验证码对话框（强化锁定） ==========
function createCodeDialog() {
  const code = String(Math.floor(1000 + Math.random() * 9000));
  return new Promise((resolve) => {
    ipcMain.removeAllListeners('code-dialog-result');
    const win = new BrowserWindow({
      width: 440, height: 300,
      parent: (overlayWin && !overlayWin.isDestroyed()) ? overlayWin : undefined,
      modal: true, show: false, frame: false, transparent: false,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>验证码确认</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: 'Segoe UI', system-ui, sans-serif;
        background: rgba(18, 22, 34, 0.96);
        color: #EEF1FA;
        padding: 28px 36px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        height: 100vh;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.07);
      }
      .title { font-size: 17px; font-weight: 600; margin-bottom: 8px; }
      .hint { font-size: 13px; color: rgba(238,241,250,0.6); margin-bottom: 16px; }
      .code {
        text-align: center;
        font-family: 'Orbitron', monospace;
        font-size: 34px;
        font-weight: 700;
        letter-spacing: 0.3em;
        padding: 12px;
        border-radius: 12px;
        background: rgba(124, 140, 250, 0.12);
        border: 1px solid rgba(124, 140, 250, 0.3);
        color: #9AA7FF;
        margin-bottom: 16px;
      }
      input {
        padding: 10px 14px;
        font-size: 20px;
        letter-spacing: 0.4em;
        text-align: center;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(0,0,0,0.3);
        color: #fff;
        outline: none;
        transition: 0.2s;
        font-family: inherit;
      }
      input:focus { border-color: #7C8CFA; box-shadow: 0 0 0 3px rgba(124,140,250,0.25); }
      .err { color: #FF6B7A; font-size: 13px; min-height: 18px; margin-top: 8px; text-align: center; }
      .buttons { margin-top: 12px; display: flex; gap: 12px; justify-content: flex-end; }
      button {
        padding: 10px 26px; border: none; border-radius: 10px;
        font-size: 15px; cursor: pointer; font-weight: 500; transition: 0.2s; font-family: inherit;
      }
      button#ok { background: linear-gradient(135deg, #9AA7FF, #5E6FE8); color: #fff; box-shadow: 0 2px 12px rgba(124,140,250,0.35); }
      button#ok:hover { transform: scale(1.03); }
      button#cancel { background: rgba(255,255,255,0.06); color: #EEF1FA; border: 1px solid rgba(255,255,255,0.08); }
      button#cancel:hover { background: rgba(255,255,255,0.12); }
    </style>
  </head>
  <body>
    <div class="title">🔒 验证码解锁</div>
    <div class="hint">请输入下方验证码以确认紧急退出，防止误触偷懒：</div>
    <div class="code">${code}</div>
    <input type="text" id="input" maxlength="4" autofocus />
    <div class="err" id="err"></div>
    <div class="buttons">
      <button id="cancel">取消</button>
      <button id="ok">确认退出</button>
    </div>
    <script>
      const input=document.getElementById('input');
      const err=document.getElementById('err');
      const code='${code}';
      const {ipcRenderer}=require('electron');
      function ok(){ if(input.value.trim()===code){ ipcRenderer.send('code-dialog-result', true); window.close(); } else { err.textContent='验证码不正确，请重试'; input.select(); } }
      function cancel(){ ipcRenderer.send('code-dialog-result', false); window.close(); }
      document.getElementById('ok').addEventListener('click', ok);
      document.getElementById('cancel').addEventListener('click', cancel);
      input.addEventListener('keydown',(e)=>{ if(e.key==='Enter') ok(); if(e.key==='Escape') cancel(); });
      input.focus();
    </script>
  </body>
  </html>
`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once('ready-to-show', () => { win.show(); });
    win.on('closed', () => { ipcMain.removeAllListeners('code-dialog-result'); resolve(false); });
    ipcMain.once('code-dialog-result', (event, ok) => { resolve(ok); if (!win.isDestroyed()) win.close(); });
  });
}

// ========== 延长锁屏 ==========
function extendLockTime(minutes) {
  if (minutes <= 0) return false;
  if (minutes > 1440) return false; // 防御：单次延长不超过 24 小时，避免数值异常/无限锁屏
  const now = Date.now();
  let baseTime = now;
  if (extendedUntil > now) {
    baseTime = extendedUntil;
  } else {
    const date = new Date();
    const currentMin = date.getHours() * 60 + date.getMinutes();
    let found = false;
    for (const range of timeRanges) {
      if (currentMin >= range.startMin && currentMin < range.endMin) {
        const endDate = new Date(date);
        endDate.setHours(Math.floor(range.endMin / 60), range.endMin % 60, 0, 0);
        baseTime = endDate.getTime();
        found = true;
        break;
      }
    }
    if (!found) baseTime = now;
    if (baseTime <= now) baseTime = now;
  }
  extendedUntil = baseTime + minutes * 60 * 1000;
  if (extendedUntil <= now) extendedUntil = now + minutes * 60 * 1000;

  // 延长锁屏后遮罩继续保留，取消此前排定的"倒计时结束后 1 分钟解锁"，避免到点后误关遮罩被拦截弹窗
  if (unlockAfterTimer) {
    clearTimeout(unlockAfterTimer);
    unlockAfterTimer = null;
  }

  if (extendTimer) clearInterval(extendTimer);
  extendTimer = setInterval(() => {
    const nowTs = Date.now();
    const remaining = Math.max(0, Math.floor((extendedUntil - nowTs) / 1000));
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('extended-status', remaining);
    }
    if (remaining === 0) {
      clearInterval(extendTimer);
      extendTimer = null;
      if (!isInLockTime() && overlayWin && !overlayWin.isDestroyed()) {
        destroyOverlay();
      }
    }
  }, 1000);
  checkTimeAndToggle();
  logToFile('INFO', '锁屏延长', { minutes, until: new Date(extendedUntil).toISOString() });
  return true;
}

// ========== 倒计时核心函数 ==========
// taskId（可选）：若倒计时由 start_daily_task 触发，传入任务 id，结束时 timer-done 事件 payload 带上，渲染层据此把任务标记完成
function startTimer(seconds, label, taskId) {
  if (!label) label = '倒计时';
  if (!(Number.isFinite(seconds) && seconds > 0)) return false;
  if (seconds > 86400) return false; // 防御：倒计时不超过 24 小时，避免 setTimeout 溢出导致异常
  if (activeTimer) {
    clearTimeout(activeTimer.timeoutId);
    activeTimer = null;
  }
  const endTime = Date.now() + seconds * 1000;
  const timeoutId = setTimeout(() => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      // 发送事件让前端显示通知；taskId 存在时前端可据此把对应每日任务标记完成
      overlayWin.webContents.send('timer-done', { label, endTime, taskId: taskId || null });
    }
    // 若番茄钟剩余时长被倒计时接管，倒计时结束即完成本轮专注（与番茄钟完成逻辑一致）
    if (timerPomodoroSynced) {
      timerPomodoroSynced = false;
      if (pomodoro.mode === 'focus') {
        todayPomodorosLoaded += 1;
        persistFocusStats();
        pomodoro.mode = 'break';
        pomodoro.remaining = focusSettings.breakLen * 60;
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('pomodoro-complete', { from: 'focus', to: 'break' });
        }
      }
    }
    activeTimer = null;
  }, seconds * 1000);
  activeTimer = { timeoutId, endTime, label, seconds, taskId: taskId || null };
  // 番茄钟联动（由 focusSettings.timerSyncPomodoro 开关控制）：
  // 原则：倒计时时长小于番茄钟当前时长时二者不同步（倒计时独立结束，番茄钟继续），
  //       倒计时时长不小于番茄钟当前时长时，番茄钟剩余同步到倒计时并跟随一起结束。
  timerPomodoroSynced = false;
  if (focusSettings.timerSyncPomodoro) {
    if (pomodoro.mode === 'focus' && pomodoro.running) {
      // 专注运行中：剩余不足倒计时 → 同步延长；剩余充足 → 不干预（倒计时先结束）
      if (pomodoro.remaining < seconds) {
        pomodoro.remaining = seconds;
        timerPomodoroSynced = true;
      }
    } else if (pomodoro.mode === 'focus' && !pomodoro.running) {
      // 专注暂停：恢复运行；倒计时更长则同步，否则保持原剩余
      pomodoro.running = true;
      startPomodoroTimers();
      if (pomodoro.remaining < seconds) {
        pomodoro.remaining = seconds;
        timerPomodoroSynced = true;
      }
      sendPomodoroStatus();
    } else {
      // 空闲 / 休息：自动开启专注。倒计时不足一轮专注时长时按标准时长运行，二者不同步
      pomodoro.mode = 'focus';
      pomodoro.running = true;
      const syncFull = seconds >= focusSettings.focusLen * 60;
      pomodoro.remaining = syncFull ? seconds : focusSettings.focusLen * 60;
      timerPomodoroSynced = syncFull;
      startPomodoroTimers();
      sendPomodoroStatus();
    }
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('timer-started', { label, totalSeconds: seconds, endTime });
  }
  logToFile('INFO', '倒计时已启动', { label, seconds, pomodoroSynced: timerPomodoroSynced });
  return true;
}

// ========== DeepSeek API 调用（流式+工具） ==========
let currentAbortController = null;

// Agent 系统提示词：引导多步任务规划与工具使用规范
const AGENT_SYSTEM_PROMPT = `你是 Focus Locker 的专注助手，运行在锁定遮罩内，帮助用户保持专注并管理时间。

你的能力：查询/控制锁屏状态、番茄钟、倒计时、网站（切换/锁定）、待办（增删改查）、环境音（播放/停止/音量）、窗口置顶、界面风格（现代/经典）等。

使用准则：
1. 需要了解现状时，先调用查询类工具（get_* / list_*）获取实时数据，不要凭空猜测。
2. 多步任务按顺序调用工具：先查询 → 再操作 → 最后汇报结果。
3. 操作待办时，index 必须以 list_all_todos 返回的序号为准，操作前务必先查询。
4. 切换网站前先调用 get_site_list 确认站点名称；若网站已锁定或固定，如实告知用户原因。
5. 工具返回 error 时，向用户说明失败原因，并给出可行的替代方案。
6. 全部回答使用中文，简洁友好；每次操作后简要汇报执行结果。`;

// 检测消息中是否包含图片：DeepSeek Vision 要求图片只能出现在 user 消息的 content 数组里（type=image_url）
// 文档：https://api-docs.deepseek.com/guides/vision/ —— 传给普通 V4-Flash 会直接报错，故按需切换 vision 模型
function messagesContainImage(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => {
    if (!m) return false;
    if (Array.isArray(m.content)) {
      return m.content.some(c => c && c.type === 'image_url');
    }
    return false;
  });
}

function callDeepSeekAPI(messages, stream = true) {
  return new Promise((resolve, reject) => {
    if (!deepseekApiKey) {
      reject(new Error('未配置 DeepSeek API Key'));
      return;
    }
    const hasImage = messagesContainImage(messages);
    const abortController = new AbortController();
    currentAbortController = abortController;
    const requestData = JSON.stringify({
      // 有图片附件走 vision 模型，无图片走默认文本模型（vision 在纯文本任务上与 V4-Flash 持平，按需切换即可）
      model: hasImage ? 'deepseek-v4-flash-vision-exp' : 'deepseek-v4-flash',
      messages: messages,
      tools: tools,
      tool_choice: 'auto',
      stream: stream,
      max_tokens: 8192,
      temperature: 0.7
    });
    const options = {
      hostname: 'api.deepseek.com',
      port: 443,
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekApiKey}`,
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(requestData)
      }
    };
    const req = https.request(options, (res) => {
      let buffer = '';
      let fullContent = '';
      let toolCalls = [];
      // StringDecoder 保持跨 data 事件的多字节 UTF-8 序列完整，避免中文/表情被切断解码成 �（U+FFFD）
      const decoder = new StringDecoder('utf8');
      res.on('data', (chunk) => {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
  const parsed = JSON.parse(data);
  const delta = parsed.choices?.[0]?.delta;
  if (delta) {
    if (delta.content) {
      fullContent += delta.content;
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('chat-chunk', delta.content);
      }
    }
    if (delta.reasoning_content) {
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('chat-reasoning-chunk', delta.reasoning_content);
      }
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCalls.find(t => t.index === tc.index);
        if (existing) {
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          if (tc.function?.name) existing.function.name = tc.function.name;
        } else {
          toolCalls.push({
            id: tc.id || `call_${Date.now()}_${Math.random()}`,
            type: 'function',
            index: tc.index || 0,
            function: {
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || ''
            }
          });
        }
      }
    }
  }
} catch (e) { /* ignore */ }
          }
      });
      res.on('end', () => {
        currentAbortController = null;
        if (overlayWin && !overlayWin.isDestroyed()) {
          // 只有当没有后续工具调用时，才发送 chat-done
          // 否则继续循环，由下一轮 API 调用输出自然语言总结
          if (toolCalls.length === 0) {
            overlayWin.webContents.send('chat-done');
          }
        }
        if (toolCalls.length > 0) {
          resolve({
            choices: [{
              message: {
                role: 'assistant',
                content: fullContent || null,
                tool_calls: toolCalls.map(tc => ({
                  id: tc.id,
                  type: tc.type,
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments
                  }
                }))
              }
            }]
          });
        } else {
          resolve({ choices: [{ message: { role: 'assistant', content: fullContent } }] });
        }
      });
      res.on('error', (err) => {
        currentAbortController = null;
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('chat-error', err.message);
        }
        reject(err);
      });
    });
    req.on('error', (err) => {
      currentAbortController = null;
      if (err.name === 'AbortError' || err.code === 'ECONNRESET') {
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('chat-done');
        }
        resolve({ choices: [{ message: { role: 'assistant', content: '' } }] });
      } else {
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('chat-error', err.message);
        }
        reject(err);
      }
    });
    abortController.signal.addEventListener('abort', () => {
      req.destroy();
    });
    req.write(requestData);
    req.end();
  });
}

// ========== 工具执行 ==========
const DEFAULT_QUOTES_MAIN = [
  '千里之行，始于足下。', '不积跬步，无以至千里。', '业精于勤，荒于嬉；行成于思，毁于随。',
  '宝剑锋从磨砺出，梅花香自苦寒来。', '少壮不努力，老大徒伤悲。', '博观而约取，厚积而薄发。',
  '天道酬勤，功不唐捐。', '学如逆水行舟，不进则退。', '路漫漫其修远兮，吾将上下而求索。',
  '日日行，不怕千万里；常常做，不怕千万事。', '合抱之木，生于毫末；九层之台，起于累土。',
  '心之所向，素履以往。', '功崇惟志，业广惟勤。', '锲而不舍，金石可镂。',
  '书山有路勤为径，学海无涯苦作舟。', '凡事预则立，不预则废。', '水滴石穿，绳锯木断。',
  '为者常成，行者常至。', '青衿之志，履践致远。', '莫问收获，但问耕耘。'
];

function getQuotesForAgent() {
  try {
    const file = path.join(dataDir, 'quotes.json');
    if (fs.existsSync(file)) {
      const q = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(q) && q.length) {
        const list = q.filter(s => typeof s === 'string' && s.trim());
        if (list.length) return list;
      }
    }
  } catch (e) { logToFile('WARN', '读取格言文件失败', e.message); }
  return DEFAULT_QUOTES_MAIN;
}

async function executeToolCall(toolName, args) {
  logToFile('INFO', '执行工具', { toolName, args });
  switch (toolName) {
    case 'get_lock_status':
      return {
        isLocked: isInLockTime(),
        isEmergencyBreak: isEmergencyBreak,
        remainingSeconds: overlayWin ? Math.max(0, Math.floor((extendedUntil - Date.now()) / 1000)) : 0,
        extendedUntil: extendedUntil,
        isInLockTime: isInLockTime()
      };
    case 'switch_site': {
      const target = args.site_name?.toLowerCase().trim() || '';
      if (!target) return { error: '未指定站点名称' };
      if (siteLockActive) return { error: '网站已锁定，锁定期间无法切换。请先解除锁定。' };
      const current = siteList.find(s => s.id === visibleSiteId);
      if (current && current.pinned) {
        return { error: `网站「${current.name}」已固定，锁定期间无法切换。解锁后才能切换。` };
      }
      let site = siteList.find(s => s.name.toLowerCase() === target);
      if (!site) site = siteList.find(s => s.name.toLowerCase().includes(target));
      if (!site) site = siteList.find(s => s.aliases && s.aliases.some(a => a.toLowerCase() === target));
      if (!site) site = siteList.find(s => s.aliases && s.aliases.some(a => a.toLowerCase().includes(target)));
      if (!site) {
        return { error: `未找到匹配的站点: ${args.site_name}。可用站点: ${siteList.map(s => s.name).join(', ')}` };
      }
      switchSite(site.id);
      return { success: true, currentSite: site.name };
    }
    case 'extend_lock': {
      let minutes = args.minutes;
      if (typeof minutes === 'string') minutes = parseInt(minutes, 10);
      if (isNaN(minutes) || minutes <= 0) {
        return { error: '请输入有效的延长分钟数（正整数）' };
      }
      if (minutes > 1440) {
        return { error: '单次延长不能超过 24 小时（1440 分钟）' };
      }
      const success = extendLockTime(minutes);
      return { success, minutes };
    }
    case 'add_todo': {
      if (!args.text || typeof args.text !== 'string') {
        return { error: '待办内容不能为空' };
      }
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('add-todo', args.text);
      }
      return { success: true, todo: args.text };
    }
    case 'get_todos': {
      const dateStr = new Date().toISOString().slice(0, 10);
      const todos = await loadTodosFromFile(dateStr);
      return { todos };
    }
    case 'emergency_exit': {
      let seconds = args.seconds;
      if (typeof seconds === 'string') seconds = parseInt(seconds, 10);
      if (isNaN(seconds) || seconds <= 0) {
        return { error: '请输入有效的秒数（正整数，且不超过 1200 秒）' };
      }
      // 走与用户快捷键一致的受控链路：最短锁定/冷却/验证码/1200 秒时长上限全部生效
      return emergencyExit(seconds);
    }
    case 'set_timer': {
      let seconds = Number(args.seconds);
      // minutes 仅在未显式提供 seconds 时生效（与工具描述"优先使用 seconds"一致）
      if (!(seconds > 0) && args.minutes !== undefined && args.minutes !== null) {
        seconds = Number(args.minutes) * 60;
      }
      if (!Number.isFinite(seconds) || seconds <= 0) return { error: '请指定有效的秒数或分钟数' };
      if (seconds > 86400) return { error: '倒计时时长不能超过 24 小时（86400 秒）' };
      const label = args.label || '倒计时';
      startTimer(seconds, label);
      return { success: true, message: `倒计时已设置：${label}，${seconds} 秒后提醒`, endTime: activeTimer?.endTime };
    }
    case 'start_daily_task': {
      const target = (args.task_name || '').toString().toLowerCase().trim();
      if (!target) return { error: '未指定任务名称' };
      if (!dailyTasks.length) return { error: '当前未配置每日任务' };
      let task = dailyTasks.find(t => (t.name || '').toLowerCase() === target);
      if (!task) task = dailyTasks.find(t => (t.name || '').toLowerCase().includes(target));
      if (!task) return { error: `未找到匹配的任务：${args.task_name}。可用任务：${dailyTasks.map(t => t.name).join('、')}` };
      const minutes = Number(task.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return { error: `任务「${task.name}」未配置有效时长` };
      const seconds = Math.min(Math.round(minutes * 60), 86400);
      startTimer(seconds, task.name, task.id);
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('daily-task-started', { id: task.id, name: task.name, minutes, seconds });
      }
      return { success: true, message: `已开始任务「${task.name}」的倒计时：${minutes} 分钟`, task: task.name, minutes };
    }
        case 'start_timer': {
      timerStartTime = Date.now();
      const startTimeStr = new Date(timerStartTime).toLocaleTimeString('zh-CN');
      return { success: true, message: `计时已开始，开始时间：${startTimeStr}` };
    }
    case 'stop_timer': {
      if (timerStartTime === null) {
        return { error: '尚未开始计时，请先使用“开始计时”工具。' };
      }
      const elapsedMs = Date.now() - timerStartTime;
      const totalSeconds = Math.floor(elapsedMs / 1000);
      const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      const duration = `${minutes}:${seconds}`;
      timerStartTime = null; // 重置
      return { success: true, duration, message: `计时结束，总时长：${duration}` };
    }
    case 'get_timer_status': {
      if (timerStartTime === null) {
        return { active: false, message: '尚未开始计时，请先使用“开始计时”工具。' };
      }
      const elapsedMs = Date.now() - timerStartTime;
      const totalSeconds = Math.floor(elapsedMs / 1000);
      const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      const startedAt = new Date(timerStartTime).toLocaleTimeString('zh-CN');
      return {
        active: true,
        startedAt,
        elapsedSeconds: totalSeconds,
        elapsed: `${minutes}:${seconds}`,
        message: `计时已进行 ${minutes}:${seconds}（开始于 ${startedAt}）`
      };
    }
    case 'toggle_site_lock': {
      const r = toggleSiteLock();
      if (r.success) {
        return { success: true, locked: r.active, message: r.active ? '网站已锁定，锁定期间无法切换' : '网站锁定已解除' };
      }
      return { error: `网站锁定未满最短时长，还需等待约 ${r.waitMinutes} 分钟` };
    }
    case 'start_pomodoro': {
      startPomodoro();
      return { success: true, message: `番茄钟已开始，专注 ${focusSettings.focusLen} 分钟` };
    }
    case 'pause_pomodoro': {
      pausePomodoro();
      return { success: true, message: '番茄钟已暂停' };
    }
    case 'reset_pomodoro': {
      resetPomodoro();
      return { success: true, message: '番茄钟已重置' };
    }
    case 'get_focus_stats': {
      return { stats: getFocusStatsData(), todayFocusSeconds: getTodayFocusSeconds() };
    }
    case 'play_ambient_sound': {
      const type = String(args.type || '').toLowerCase();
      if (!AMBIENT_TYPES.includes(type) && !isCustomSoundType(type)) {
        return { error: '音效类型无效，可选：rain(雨声)、fire(篝火)、waves(海浪)、white(白噪音) 或自定义音源' };
      }
      ambientState.sounds[type] = Math.max(20, ambientState.sounds[type] || 60); // 已开启则保持原音量，否则默认 60
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('ambient-sound-command', { action: 'sync', state: JSON.parse(JSON.stringify(ambientState)) });
      }
      const names = Object.keys(ambientState.sounds).map(t => AMBIENT_LABELS[t] || t).join('+') || '无';
      return { success: true, sounds: { ...ambientState.sounds }, masterVolume: ambientState.masterVolume, message: `已播放${AMBIENT_LABELS[type] || type}，当前混合：${names}` };
    }
    case 'stop_ambient_sound': {
      if (args.type) {
        const type = String(args.type).toLowerCase();
        if (!AMBIENT_TYPES.includes(type) && !isCustomSoundType(type)) return { error: '音效类型无效，可选：rain / fire / waves / white 或自定义音源' };
        delete ambientState.sounds[type];
      } else {
        ambientState.sounds = {};
      }
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('ambient-sound-command', { action: 'sync', state: JSON.parse(JSON.stringify(ambientState)) });
      }
      const playing = Object.keys(ambientState.sounds).length;
      return { success: true, message: playing > 0 ? '已停止指定音源，其他音源继续播放' : '环境音已全部停止' };
    }
    case 'get_quote': {
      const quotes = getQuotesForAgent();
      if (quotes.length === 0) return { error: '暂无格言' };
      const quote = quotes[Math.floor(Math.random() * quotes.length)];
      return { quote };
    }
    case 'get_pomodoro_state': {
      const s = getPomodoroStateObj();
      const modeLabel = s.mode === 'focus' ? '专注中' : (s.mode === 'break' ? '休息中' : '待机');
      return {
        mode: s.mode,
        running: s.running,
        remainingSeconds: s.remaining,
        focusLen: s.focusLen,
        breakLen: s.breakLen,
        todayFocusSeconds: s.todayFocusSeconds,
        message: `番茄钟状态：${modeLabel}，剩余 ${Math.floor(s.remaining / 60)} 分 ${s.remaining % 60} 秒，今日专注 ${Math.floor(s.todayFocusSeconds / 60)} 分钟`
      };
    }
    case 'get_timer_state': {
      if (!activeTimer) return { active: false, message: '当前没有进行中的倒计时' };
      const remaining = Math.max(0, Math.ceil((activeTimer.endTime - Date.now()) / 1000));
      return {
        active: true,
        label: activeTimer.label,
        remainingSeconds: remaining,
        endTime: activeTimer.endTime,
        message: `倒计时「${activeTimer.label}」进行中，剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒`
      };
    }
    case 'cancel_timer': {
      if (!activeTimer) return { success: false, message: '当前没有进行中的倒计时' };
      clearTimeout(activeTimer.timeoutId);
      activeTimer = null;
      timerPomodoroSynced = false;
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('timer-cancelled', {});
      }
      return { success: true, message: '倒计时已取消' };
    }
    case 'toggle_always_on_top': {
      forceAlwaysOnTop = !forceAlwaysOnTop;
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.setAlwaysOnTop(forceAlwaysOnTop, 'screen-saver');
        overlayWin.webContents.send('always-on-top-changed', forceAlwaysOnTop);
      }
      return { success: true, alwaysOnTop: forceAlwaysOnTop, message: forceAlwaysOnTop ? '已开启置顶' : '已关闭置顶' };
    }
    case 'set_layout_mode': {
      const mode = String(args.mode || '').toLowerCase() === 'legacy' ? 'legacy' : 'modern';
      layoutMode = mode;
      if (layoutMode === 'legacy') siteViewActive = false;
      updateBrowserViewBounds();
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('layout-mode-changed', layoutMode);
      }
      return { success: true, mode: layoutMode, message: layoutMode === 'legacy' ? '已切换到经典风格（网站常驻右侧）' : '已切换到现代风格（网站收纳在面板）' };
    }
    case 'get_layout_mode': {
      return { mode: layoutMode, message: layoutMode === 'legacy' ? '当前为经典风格' : '当前为现代风格' };
    }
    case 'get_current_time': {
      const now = new Date();
      const days = ['日','一','二','三','四','五','六'];
      const hh = String(now.getHours()).padStart(2,'0');
      const mm = String(now.getMinutes()).padStart(2,'0');
      const ss = String(now.getSeconds()).padStart(2,'0');
      return {
        date: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
        time: `${hh}:${mm}:${ss}`,
        weekday: `周${days[now.getDay()]}`,
        message: `现在是 ${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 周${days[now.getDay()]} ${hh}:${mm}:${ss}`
      };
    }
    case 'get_site_list': {
      return {
        sites: siteList.map(s => ({
          id: s.id,
          name: s.name,
          pinned: !!s.pinned,
          current: s.id === visibleSiteId
        })),
        currentSite: (siteList.find(s => s.id === visibleSiteId) || {}).name || '',
        siteLockActive
      };
    }
    case 'get_ambient_state': {
      const active = Object.keys(ambientState.sounds).filter(t => (ambientState.sounds[t] || 0) > 0);
      const names = active.map(t => AMBIENT_LABELS[t] || t).join('、');
      return {
        sounds: { ...ambientState.sounds },
        masterVolume: ambientState.masterVolume,
        playing: active.length > 0,
        message: active.length > 0
          ? `正在播放：${names}，总音量 ${ambientState.masterVolume}%`
          : '当前未播放环境音'
      };
    }
    case 'set_ambient_volume': {
      let v = Number(args.volume);
      if (isNaN(v)) return { error: '请输入有效的音量（0-100）' };
      v = Math.max(0, Math.min(100, Math.round(v)));
      ambientState.masterVolume = v;
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('ambient-sound-command', { action: 'volume', value: v });
      }
      return { success: true, volume: v, message: `环境音总音量已设置为 ${v}%` };
    }
    case 'list_all_todos': {
      const dateStr = todayStr();
      const todos = await loadTodosFromFile(dateStr);
      const completedCount = todos.filter(t => t.completed).length;
      return {
        date: dateStr,
        todos: todos.map((t, i) => ({ index: i, text: t.text, completed: !!t.completed, pinned: !!t.pinned })),
        message: todos.length === 0 ? '今天还没有待办' : `今日共 ${todos.length} 条待办，其中 ${completedCount} 条已完成`
      };
    }
    case 'complete_todo': {
      const dateStr = todayStr();
      const todos = await loadTodosFromFile(dateStr);
      const index = Number(args.index);
      if (isNaN(index) || index < 0 || index >= todos.length) {
        return { error: `待办序号无效，可用范围 0-${Math.max(0, todos.length - 1)}（可先调用 list_all_todos 查看序号）` };
      }
      const completed = args.completed === undefined ? !todos[index].completed : !!args.completed;
      todos[index].completed = completed;
      fs.writeFileSync(path.join(todoDir, `${dateStr}.json`), JSON.stringify(todos, null, 2));
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('todos-changed');
      return { success: true, index, text: todos[index].text, completed, message: `待办「${todos[index].text}」已${completed ? '完成' : '取消完成'}` };
    }
    case 'delete_todo': {
      const dateStr = todayStr();
      const todos = await loadTodosFromFile(dateStr);
      const index = Number(args.index);
      if (isNaN(index) || index < 0 || index >= todos.length) {
        return { error: `待办序号无效，可用范围 0-${Math.max(0, todos.length - 1)}（可先调用 list_all_todos 查看序号）` };
      }
      const removed = todos.splice(index, 1)[0];
      fs.writeFileSync(path.join(todoDir, `${dateStr}.json`), JSON.stringify(todos, null, 2));
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('todos-changed');
      return { success: true, text: removed.text, remaining: todos.length, message: `待办「${removed.text}」已删除，剩余 ${todos.length} 条` };
    }
    case 'get_system_status': {
      const now = new Date();
      const days = ['日','一','二','三','四','五','六'];
      const hh = String(now.getHours()).padStart(2,'0');
      const mm = String(now.getMinutes()).padStart(2,'0');
      const ss = String(now.getSeconds()).padStart(2,'0');
      const ps = getPomodoroStateObj();
      const modeLabel = ps.mode === 'focus' ? '专注中' : (ps.mode === 'break' ? '休息中' : '待机');
      const timerInfo = activeTimer
        ? { active: true, label: activeTimer.label, remainingSeconds: Math.max(0, Math.ceil((activeTimer.endTime - Date.now()) / 1000)) }
        : { active: false };
      return {
        time: `${hh}:${mm}:${ss}`,
        date: `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 周${days[now.getDay()]}`,
        lockStatus: { locked: isInLockTime(), emergencyBreak: isEmergencyBreak },
        alwaysOnTop: forceAlwaysOnTop,
        layoutMode,
        currentSite: (siteList.find(s => s.id === visibleSiteId) || {}).name || '',
        siteLockActive,
        pomodoro: { mode: ps.mode, running: ps.running, remainingSeconds: ps.remaining, label: modeLabel },
        countdown: timerInfo,
        ambient: { sounds: { ...ambientState.sounds }, masterVolume: ambientState.masterVolume },
        todayFocusMinutes: Math.floor(getTodayFocusSeconds() / 60)
      };
    }
    // ===== 管理能力（网站 / 每日任务 / 扩展脚本） =====
    case 'list_sites': {
      return {
        sites: siteList.map(s => ({
          id: s.id, name: s.name, url: s.url, zoom: s.zoom,
          aliases: Array.isArray(s.aliases) ? s.aliases : [],
          persistent: s.persistent !== false, pinned: !!s.pinned
        })),
        currentSite: (siteList.find(s => s.id === visibleSiteId) || {}).name || '',
        siteLockActive,
        message: `共 ${siteList.length} 个网站`
      };
    }
    case 'add_site': {
      const name = String(args.name || '').trim();
      const url = String(args.url || '').trim();
      if (!name) return { error: '网站名称不能为空' };
      if (!/^https?:\/\//i.test(url)) return { error: `网址无效：${url}（需以 http:// 或 https:// 开头）` };
      if (siteList.some(s => s.name.toLowerCase() === name.toLowerCase())) {
        return { error: `已存在同名网站「${name}」` };
      }
      let zoom = Number(args.zoom);
      if (isNaN(zoom) || zoom <= 0) zoom = 1;
      if (zoom > 5) return { error: '缩放不能超过 5' };
      const persistent = args.persistent !== false;
      const pinned = !!args.pinned;
      const aliases = Array.isArray(args.aliases) ? args.aliases.map(a => String(a).trim()).filter(Boolean) : [];
      const site = { id: uniqueSiteId(name, siteList.map(s => s.id)), name, url, zoom, aliases, pinned, persistent };
      const newSites = siteList.map(serializeSite);
      newSites.push(serializeSite(site));
      persistRuntimeConfig({ sites: newSites });
      // 常驻网站立即创建视图并挂载，方便本次锁屏直接切换使用
      if (persistent && overlayWin && !overlayWin.isDestroyed()) ensureSiteView(site.id);
      return { success: true, message: `已新增网站「${name}」（${persistent ? '常驻' : '非常驻'}）`, site: serializeSite(site) };
    }
    case 'update_site': {
      const name = String(args.name || '').trim();
      if (!name) return { error: '请指定要修改的网站名称' };
      const target = siteList.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (!target) return { error: `未找到网站「${name}」。可用网站：${siteList.map(s => s.name).join('、')}` };
      const updated = { ...target };
      if (args.new_name !== undefined && String(args.new_name).trim() && String(args.new_name).trim() !== updated.name) {
        const newName = String(args.new_name).trim();
        if (siteList.some(s => s.id !== updated.id && s.name.toLowerCase() === newName.toLowerCase())) {
          return { error: `已存在同名网站「${newName}」` };
        }
        updated.name = newName;
      }
      if (args.url !== undefined) {
        const newUrl = String(args.url).trim();
        if (!/^https?:\/\//i.test(newUrl)) return { error: `网址无效：${newUrl}（需以 http:// 或 https:// 开头）` };
        updated.url = newUrl;
      }
      if (args.zoom !== undefined) {
        const newZoom = Number(args.zoom);
        if (isNaN(newZoom) || newZoom <= 0 || newZoom > 5) return { error: `缩放无效：${args.zoom}（应为 0.1~5）` };
        updated.zoom = newZoom;
      }
      if (args.persistent !== undefined) updated.persistent = !!args.persistent;
      if (args.pinned !== undefined) updated.pinned = !!args.pinned;
      if (args.aliases !== undefined) updated.aliases = Array.isArray(args.aliases) ? args.aliases.map(a => String(a).trim()).filter(Boolean) : [];
      const newSites = siteList.map(s => serializeSite(s.id === target.id ? updated : s));
      persistRuntimeConfig({ sites: newSites });
      // 网址变化：已加载视图立即刷新（若视图存活）
      const view = viewsMap.get(target.id);
      if (view && !view.webContents.isDestroyed() && updated.url !== target.url) {
        view.webContents.loadURL(updated.url);
      }
      return { success: true, message: `网站「${target.name}」已更新`, site: serializeSite(updated) };
    }
    case 'remove_site': {
      const name = String(args.name || '').trim();
      if (!name) return { error: '请指定要删除的网站名称' };
      const target = siteList.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (!target) return { error: `未找到网站「${name}」。可用网站：${siteList.map(s => s.name).join('、')}` };
      if (siteLockActive && target.id === visibleSiteId) {
        return { error: `网站「${target.name}」已锁定，无法删除。请先解除网站锁定。` };
      }
      // 若删除的是当前显示网站，先切换到第一个剩余网站
      if (target.id === visibleSiteId) {
        const remain = siteList.filter(s => s.id !== target.id);
        if (remain.length > 0) {
          visibleSiteId = remain[0].id;
          ensureSiteView(visibleSiteId); // 保证新前台有视图
          if (overlayWin && !overlayWin.isDestroyed()) {
            overlayWin.webContents.send('site-changed', remain[0].name);
            updateBrowserViewBounds();
          }
        } else {
          visibleSiteId = null;
        }
      }
      // 销毁对应视图：使用统一 destroySiteView 完成 removeBrowserView + removeAllListeners + webContents.destroy + Map 删除
      destroySiteView(target.id);
      const newSites = siteList.filter(s => s.id !== target.id).map(serializeSite);
      persistRuntimeConfig({ sites: newSites });
      return { success: true, message: `网站「${target.name}」已删除，剩余 ${newSites.length} 个网站` };
    }
    case 'list_daily_tasks': {
      return {
        tasks: dailyTasks.map(t => ({ name: t.name, minutes: Number(t.minutes) || 0 })),
        message: dailyTasks.length === 0 ? '当前未配置每日任务' : `共 ${dailyTasks.length} 个每日任务`
      };
    }
    case 'add_daily_task': {
      const taskName = String(args.name || '').trim();
      if (!taskName) return { error: '任务名称不能为空' };
      if (dailyTasks.some(t => t.name.toLowerCase() === taskName.toLowerCase())) {
        return { error: `已存在同名任务「${taskName}」` };
      }
      let minutes = Number(args.minutes);
      if (isNaN(minutes) || minutes < 0) minutes = 0;
      if (minutes > 1440) return { error: '分钟数不能超过 1440' };
      const normalized = normalizeDailyTasks([...dailyTasks, { name: taskName, minutes }]).map(t => ({ id: t.id, name: t.name, minutes: t.minutes }));
      persistRuntimeConfig({ dailyTasks: normalized });
      return { success: true, message: `已新增每日任务「${taskName}」（${minutes} 分钟）` };
    }
    case 'remove_daily_task': {
      const taskName = String(args.name || '').trim();
      if (!taskName) return { error: '请指定要删除的任务名称' };
      const targetTask = dailyTasks.find(t => t.name.toLowerCase() === taskName.toLowerCase());
      if (!targetTask) return { error: `未找到任务「${taskName}」。可用任务：${dailyTasks.map(t => t.name).join('、')}` };
      const normalized = normalizeDailyTasks(dailyTasks.filter(t => t.id !== targetTask.id)).map(t => ({ id: t.id, name: t.name, minutes: t.minutes }));
      persistRuntimeConfig({ dailyTasks: normalized });
      return { success: true, message: `每日任务「${targetTask.name}」已删除，剩余 ${normalized.length} 个` };
    }
    case 'get_extension_status': {
      const crx = extensionLoadResults.map(item => item.success ? { id: item.id, name: item.name, file: item.file, ui: item.ui, success: true } : item);
      const scripts = userScripts.map(s => ({ name: s.name, matches: s.matches, path: s.path }));
      const styles = userStyles.map(s => ({ name: s.name, matches: s.matches, path: s.path }));
      return {
        extensions: crx,
        userScripts: scripts,
        userStyles: styles,
        message: `已加载 ${crx.length} 个扩展 · ${scripts.length} 个用户脚本 · ${styles.length} 个用户样式`
      };
    }
    case 'web_search': {
      const query = String(args.query || '').trim();
      if (!query) return { error: '搜索关键词不能为空' };
      const result = await performWebSearch(query);
      if (result.error) return { error: result.error };
      return {
        query,
        results: result.results,
        message: `已搜索「${query}」，共 ${result.results.length} 条结果`
      };
    }
    default:
      throw new Error(`未知工具: ${toolName}`);
  }
}

// ===== agent 管理工具辅助 =====
// 网站配置序列化（写回 config.json 用，保留 id 以稳定去重，persistent 显式落盘）
function serializeSite(s) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    zoom: typeof s.zoom === 'number' && s.zoom > 0 ? s.zoom : 1,
    aliases: Array.isArray(s.aliases) ? s.aliases : [],
    persistent: s.persistent !== false,
    pinned: !!s.pinned
  };
}
// 从名称生成唯一网站 id（与 UI 保存的 pushSite 规则一致）
function uniqueSiteId(name, existingIds) {
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'site';
  let base = id, n = 2;
  while (existingIds.includes(id)) id = `${base}_${n++}`;
  return id;
}
// 将运行时配置变更合并写回 dataDir/config.json 并重载（网站/每日任务管理工具用）
function persistRuntimeConfig(patch) {
  const raw = loadRawConfig(app);
  const merged = { ...(raw.config || {}) };
  if (patch.sites) merged.sites = patch.sites;
  if (patch.dailyTasks !== undefined) merged.dailyTasks = patch.dailyTasks;
  delete merged.pinWindows;
  const configJsonPath = path.join(raw.dataDir, 'config.json');
  fs.writeFileSync(configJsonPath, JSON.stringify(merged, null, 2), 'utf-8');
  logToFile('INFO', 'agent 配置变更已保存', { configJsonPath, siteCount: (merged.sites || []).length, dailyTaskCount: (merged.dailyTasks || []).length });
  loadConfig();
  return configJsonPath;
}

// ===== 联网搜索（web_search 工具） =====
// 无 key 方案：抓取 Bing 中国（cn.bing.com，国内可直接访问）结果页并解析前 5 条（标题/网址/摘要）
function stripHtmlTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&ensp;/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&middot;/g, '·').replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCharCode(parseInt(n, 10)); } catch (e) { return m; } })
    .trim();
}
function parseBingResults(html) {
  const out = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  for (const block of blocks.slice(0, 5)) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/);
    if (!a) continue;
    const url = /^https?:/i.test(a[1]) ? a[1] : 'https:' + a[1];
    const title = stripHtmlTags(a[2]);
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title, url, snippet: p ? stripHtmlTags(p[1]) : '' });
  }
  return out;
}
function performWebSearch(query) {
  return new Promise((resolve) => {
    const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN';
    let settled = false;
    const done = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done({ error: `搜索服务返回状态码 ${res.statusCode}` });
        return;
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { html += d; });
      res.on('end', () => {
        const results = parseBingResults(html);
        if (!results.length) { done({ error: '未获取到搜索结果' }); return; }
        done({ results });
      });
      res.on('error', (e) => done({ error: e.message }));
    });
    req.on('error', (e) => done({ error: e.message }));
    req.setTimeout(12000, () => { try { req.destroy(); } catch (e) { /* 忽略 */ } done({ error: '搜索超时' }); });
  });
}

async function loadTodosFromFile(dateStr) {
  const filePath = path.join(dataDir, 'todos', `${dateStr}.json`);
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch { return []; }
}

// ========== 专注统计 / 番茄钟 / 锁定设置 ==========
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function loadFocusSettings() {
  try {
    if (fs.existsSync(FOCUS_SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(FOCUS_SETTINGS_FILE, 'utf-8'));
      focusSettings = {
        minLockMinutes: Math.max(0, Number(s.minLockMinutes) || 0),
        verifyCodeEnabled: s.verifyCodeEnabled !== false,
        focusLen: Math.max(1, Math.min(120, Number(s.focusLen) || 25)),
        breakLen: Math.max(1, Math.min(60, Number(s.breakLen) || 5)),
        siteLockMinMinutes: Math.max(0, Math.min(480, Number(s.siteLockMinMinutes) || 0)),
        timerSyncPomodoro: s.timerSyncPomodoro !== false,
        instantMode: s.instantMode === true,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...(s.shortcuts && typeof s.shortcuts === 'object' ? s.shortcuts : {}) },
        dailyTaskDate: s.dailyTaskDate || '',
        dailyTaskCompleted: (s.dailyTaskCompleted && typeof s.dailyTaskCompleted === 'object') ? s.dailyTaskCompleted : {},
        dailyTaskRatio: Math.max(0.1, Math.min(1, Number(s.dailyTaskRatio) || 0.6))
      };
    }
  } catch (e) { logToFile('WARN', '读取锁定设置失败', e.message); }
  instantMode = focusSettings.instantMode && instantModeEnabled; // 同步全局即时模式状态（供紧急退出/Esc 判断）；被禁用时强制关闭
  registerRelockShortcut(); // 启动时注册重新锁定快捷键
}
function saveFocusSettingsToFile(data) {
  try {
    fs.writeFileSync(FOCUS_SETTINGS_FILE, JSON.stringify(data || focusSettings, null, 2), 'utf-8');
  } catch (e) { logToFile('WARN', '保存锁定设置失败', e.message); }
}
function initFocusStats() {
  focusStatsDate = todayStr();
  todayFocusLoaded = 0;
  todayPomodorosLoaded = 0;
  todayHourly = Array(24).fill(0);
  try {
    const file = path.join(dataDir, 'focus-stats.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const raw = data[focusStatsDate];
      if (raw && typeof raw === 'object') {
        todayFocusLoaded = Number(raw.seconds) || 0;
        todayPomodorosLoaded = Number(raw.pomodoros) || 0;
        if (Array.isArray(raw.hourly) && raw.hourly.length === 24) {
          todayHourly = raw.hourly.map(v => Math.max(0, Number(v) || 0));
        }
      } else {
        todayFocusLoaded = Number(raw) || 0; // 兼容旧格式（纯数字秒数）
      }
    }
  } catch (e) { todayFocusLoaded = 0; }
}
function persistFocusStats() {
  if (!focusStatsDate || pomodoro.pendingFocus <= 0) return;
  todayFocusLoaded += pomodoro.pendingFocus;
  pomodoro.pendingFocus = 0;
  try {
    const file = path.join(dataDir, 'focus-stats.json');
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
    data[focusStatsDate] = {
      seconds: todayFocusLoaded,
      pomodoros: todayPomodorosLoaded,
      hourly: todayHourly.slice()
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { logToFile('WARN', '写入专注统计失败', e.message); }
}
function getTodayFocusSeconds() {
  return todayFocusLoaded + pomodoro.pendingFocus;
}
function getFocusStatsData() {
  const stats = {};
  try {
    const file = path.join(dataDir, 'focus-stats.json');
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
    for (let i = 6; i >= 0; i--) {
      const key = todayStr(new Date(Date.now() - i * 86400000));
      const raw = data[key];
      stats[key] = (raw && typeof raw === 'object') ? (Number(raw.seconds) || 0) : (Number(raw) || 0);
    }
  } catch (e) { /* ignore */ }
  stats[todayStr()] = getTodayFocusSeconds();
  return stats;
}
// 专注报告：最近 days 天，每天含总秒数、番茄轮数、每小时分布（hourly 为 null 表示当日无小时数据）
function getFocusReportData(days = 14) {
  let data = {};
  try {
    const file = path.join(dataDir, 'focus-stats.json');
    data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  } catch (e) { /* ignore */ }
  const result = {};
  const tKey = todayStr();
  for (let i = days - 1; i >= 0; i--) {
    const key = todayStr(new Date(Date.now() - i * 86400000));
    const raw = data[key];
    let seconds = 0, pomodoros = 0, hourly = null;
    if (raw && typeof raw === 'object') {
      seconds = Number(raw.seconds) || 0;
      pomodoros = Number(raw.pomodoros) || 0;
      if (Array.isArray(raw.hourly) && raw.hourly.length === 24) hourly = raw.hourly.map(v => Math.max(0, Number(v) || 0));
    } else {
      seconds = Number(raw) || 0;
    }
    if (key === tKey) {
      seconds = getTodayFocusSeconds();
      pomodoros = todayPomodorosLoaded;
      hourly = todayHourly.slice(); // 内存值已含未落盘的逐秒累计
    }
    result[key] = { seconds, pomodoros, hourly };
  }
  return result;
}
function getPomodoroStateObj() {
  return {
    mode: pomodoro.mode,
    running: pomodoro.running,
    remaining: pomodoro.remaining,
    focusLen: focusSettings.focusLen,
    breakLen: focusSettings.breakLen,
    todayFocusSeconds: getTodayFocusSeconds()
  };
}
function sendPomodoroStatus() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('pomodoro-status', getPomodoroStateObj());
  }
}
function pomodoroTick() {
  // 跨天自动归档
  const now = todayStr();
  if (now !== focusStatsDate) {
    persistFocusStats();
    focusStatsDate = now;
    todayFocusLoaded = 0;
    todayPomodorosLoaded = 0;
    todayHourly = Array(24).fill(0);
  }
  if (pomodoro.running) {
    if (timerPomodoroSynced && activeTimer) {
      // 剩余时长已被倒计时接管：跟随倒计时走，完成由倒计时结束回调触发，这里不重复切换
      pomodoro.remaining = Math.max(0, Math.ceil((activeTimer.endTime - Date.now()) / 1000));
      if (pomodoro.mode === 'focus') {
        pomodoro.pendingFocus += 1;
        todayHourly[new Date().getHours()] += 1;
      }
    } else {
      pomodoro.remaining = Math.max(0, pomodoro.remaining - 1);
      if (pomodoro.mode === 'focus') {
        pomodoro.pendingFocus += 1;
        todayHourly[new Date().getHours()] += 1;
      }
      if (pomodoro.remaining <= 0) {
        const from = pomodoro.mode;
        if (from === 'focus') todayPomodorosLoaded += 1; // 完成一轮专注，番茄数 +1
        persistFocusStats();
        pomodoro.mode = from === 'focus' ? 'break' : 'focus';
        pomodoro.remaining = (pomodoro.mode === 'focus' ? focusSettings.focusLen : focusSettings.breakLen) * 60;
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('pomodoro-complete', { from, to: pomodoro.mode });
        }
      }
    }
  }
  // 每 30 秒落盘一次，避免长时间运行丢失数据
  pomodoro.tickCount += 1;
  if (pomodoro.tickCount % 30 === 0) persistFocusStats();
  sendPomodoroStatus();
}
// 定时器仅在番茄钟运行期间启用，空闲时零开销
function startPomodoroTimers() {
  if (!pomodoro.tickTimer) {
    pomodoro.tickTimer = setInterval(pomodoroTick, 1000);
  }
}
function stopPomodoroTimers() {
  if (pomodoro.tickTimer) {
    clearInterval(pomodoro.tickTimer);
    pomodoro.tickTimer = null;
  }
}
function startPomodoro() {
  if (pomodoro.mode === 'idle') {
    pomodoro.mode = 'focus';
    pomodoro.remaining = focusSettings.focusLen * 60; // 分钟 → 秒
  }
  pomodoro.running = true;
  startPomodoroTimers();
  sendPomodoroStatus();
}
function pausePomodoro() {
  pomodoro.running = false;
  persistFocusStats();
  stopPomodoroTimers();
  sendPomodoroStatus();
}
function resetPomodoro() {
  persistFocusStats();
  pomodoro.mode = 'idle';
  pomodoro.running = false;
  stopPomodoroTimers();
  pomodoro.remaining = 0;
  sendPomodoroStatus();
}

// ========== 文件解析 ==========
const MAX_PARSE_SIZE = 50 * 1024 * 1024;
async function parseFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('文件不存在');
  const stats = fs.statSync(filePath);
  if (stats.size > MAX_PARSE_SIZE) throw new Error(`文件过大 (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  let text = '';
  if (ext === '.pdf') {
  const pdfParseFn = typeof pdfParse === 'function' ? pdfParse : (pdfParse.default || pdfParse.parse);
  const data = await pdfParseFn(buffer);
    text = data.text || '';
  } else if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value || '';
  } else if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    let rows = [];
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet);
      if (json.length) rows.push(`--- ${sheetName} ---`, ...json.map(JSON.stringify));
    });
    text = rows.join('\n');
  } else if (ext === '.csv') {
    const results = await new Promise((resolve, reject) => {
      const data = [];
      const stream = Readable.from(buffer.toString());
      stream.pipe(csv()).on('data', d => data.push(d)).on('end', () => resolve(data)).on('error', reject);
    });
    text = results.map(JSON.stringify).join('\n');
  } else if (ext === '.rtf') {
    // RTF：提取纯文本（剥离控制字和花括号）
    let raw = buffer.toString('latin1');
    text = raw.replace(/\\par[d]?/g, '\n').replace(/\\'[0-9a-f]{2}/g, '').replace(/\\[a-zA-Z]+-?\d* ?/g, '').replace(/[{}]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  } else if (['.txt','.md','.json','.js','.py','.html','.css','.ts','.c','.cpp','.java','.go','.rs','.sql','.yaml','.yml','.xml','.log'].includes(ext)) {
    try { text = buffer.toString('utf-8'); } catch (e) { text = buffer.toString('latin1'); }
  } else {
    throw new Error(`不支持的文件格式: ${ext}`);
  }
  return { text, fileName: path.basename(filePath), size: stats.size };
}

// ========== 全局快捷键（可在设置页自定义） ==========
function registerOverlayShortcuts() {
  const sc = { ...DEFAULT_SHORTCUTS, ...((focusSettings.shortcuts) || {}) };
  const reg = (acc, action) => {
    if (acc && !globalShortcut.isRegistered(acc)) globalShortcut.register(acc, () => runShortcutAction(action));
  };
  reg(sc.switchSite, 'switchSite');
  if (isTestMode) reg(sc.toggleAlwaysOnTop, 'toggleAlwaysOnTop');
  reg(sc.emergencyExit, 'emergencyExit');
  reg(sc.toggleAgent, 'toggleAgent');
  reg(sc.extendLock, 'extendLock');
  reg(sc.toggleSiteLock, 'toggleSiteLock');
  registerRelockShortcut(); // 重新锁定快捷键独立注册，遮罩关闭后仍可用
  logToFile('INFO', '全局快捷键注册完成', sc);
}
function runShortcutAction(action) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  switch (action) {
    case 'switchSite': switchToNextSite(); break;
    case 'toggleAlwaysOnTop': toggleAlwaysOnTop(); break;
    case 'emergencyExit': emergencyExit(); break;
    case 'toggleAgent': overlayWin.webContents.send('toggle-agent'); break;
    case 'extendLock':
      createInputDialog({ title: '延长锁屏', message: '请输入延长分钟数：', defaultValue: '30' })
        .then(minutes => { if (minutes !== null) extendLockTime(minutes); });
      break;
    case 'toggleSiteLock': toggleSiteLock(); break;
    default: break;
  }
}
function unregisterOverlayShortcuts() {
  globalShortcut.unregisterAll();
  registerRelockShortcut(); // 注销后立即恢复重新锁定快捷键，确保即时退出后仍可用
}

// ========== 状态发送 ==========
function sendCooldownStatus(remainingSeconds) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('cooldown-status', remainingSeconds);
  }
}
function sendExtendedStatus(seconds) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('extended-status', seconds);
  }
}

// ========== 网易云音乐弹出 ==========
function getMusicView() {
  for (const [id, view] of viewsMap) {
    const site = siteList.find(s => s.id === id);
    if (site && (site.id === 'music' || site.url.includes('music.163.com'))) {
      return view;
    }
  }
  return null;
}
function popMusicView() {
  const view = getMusicView();
  if (!view || !overlayWin || isMusicPopped) return;
  if (!musicPopupWin || musicPopupWin.isDestroyed()) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    musicPopupWin = new BrowserWindow({
      width: 900, height: 700,
      x: Math.floor((width - 900) / 2), y: Math.floor((height - 700) / 2),
      frame: false, transparent: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: true, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    musicPopupWin.on('resize', () => {
      if (musicPopupWin && !musicPopupWin.isDestroyed() && isMusicPopped) {
        const v = getMusicView();
        if (v) {
          const b = musicPopupWin.getContentBounds();
          v.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
        }
      }
    });
    musicPopupWin.on('closed', () => {
      musicPopupWin = null;
      isMusicPopped = false;
    });
  }
  overlayWin.removeBrowserView(view);
  musicPopupWin.setBrowserView(view);
  musicPopupWin.show();
  musicPopupWin.focus();
  const b = musicPopupWin.getContentBounds();
  view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  isMusicPopped = true;
}
function restoreMusicView() {
  const view = getMusicView();
  if (!view || !overlayWin || !isMusicPopped || !musicPopupWin) return;
  musicPopupWin.removeBrowserView(view);
  overlayWin.addBrowserView(view);
  updateBrowserViewBounds();
  musicPopupWin.hide();
  isMusicPopped = false;
}

// ========== BrowserView 管理 ==========
// 单个网站的 BrowserView 创建（含加载、注入、事件绑定）
function createSiteView(site) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      partition: BROWSER_VIEW_PARTITION
    }
  });
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.addBrowserView(view);
  viewsMap.set(site.id, view);
  const sess = view.webContents.session;
  sess.setPermissionRequestHandler((webContents, permission, callback) => callback(true));
  view.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  extensionsReady.finally(() => {
    if (!view.webContents.isDestroyed()) view.webContents.loadURL(site.url);
  });
  view.webContents.on('did-finish-load', () => {
    if (view.webContents.isDestroyed()) return;
    view.webContents.setZoomFactor(site.zoom);
    if (site.injectCSS) {
      // 站点级自定义 CSS 同样以「用户来源」注入并强制 !important，
      // 稳定盖过原站样式（含原站的 !important），不再抢位置/重叠
      view.webContents.insertCSS(promoteImportant(site.injectCSS), { cssOrigin: 'user' });
    }
    injectUserScripts(view.webContents, userScripts, view.webContents.getURL(), logToFile);
    injectUserStyles(view.webContents, userStyles, view.webContents.getURL(), logToFile);
  });
  view.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (!view.webContents.isDestroyed()) view.webContents.loadURL(url);
  });
  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logToFile('ERROR', `[${site.name}] 加载失败`, errorDescription, validatedURL);
  });
  view.webContents.on('before-input-event', (event, input) => {
    handleShortcut(event, input);
  });
  // 防御：webContents 被 Chromium 提前销毁时同步清理 Map，避免遗留空引用导致下次懒加载跳过
  view.webContents.on('destroyed', () => {
    if (viewsMap.get(site.id) === view) viewsMap.delete(site.id);
  });
  return view;
}

// 彻底销毁单个站点 BrowserView：从各窗口卸载、移除事件、清 permission、销毁 webContents、从 Map 移除
// 注意：不会 touch session 级存储（cookie/cache），登录态仍保留
function destroySiteView(siteId) {
  const view = viewsMap.get(siteId);
  if (!view) return false;
  try {
    // 1) 从所有可能挂载的 BrowserWindow 上移除
    if (musicPopupWin && !musicPopupWin.isDestroyed()) {
      try { musicPopupWin.removeBrowserView(view); } catch (_) {}
    }
    if (overlayWin && !overlayWin.isDestroyed()) {
      try { overlayWin.removeBrowserView(view); } catch (_) {}
    }
    // 2) 清理 session 级 request handler（对单个 view 粒度不严格）
    try {
      const sess = view.webContents && view.webContents.session;
      if (sess && typeof sess.setPermissionRequestHandler === 'function') {
        sess.setPermissionRequestHandler(null);
      }
    } catch (_) {}
    // 3) 移除所有事件监听器，打断对 view/webContents 的引用，避免 GC 被闭包 hold 住
    try { view.webContents && view.webContents.removeAllListeners && view.webContents.removeAllListeners(); } catch (_) {}
    try { view.removeAllListeners && view.removeAllListeners(); } catch (_) {}
    // 4) 销毁 webContents（释放渲染进程、DOM、JS heap；若已销毁内部 no-op）
    if (view.webContents && !view.webContents.isDestroyed()) {
      try { view.webContents.destroy(); } catch (_) {}
    }
  } catch (e) {
    logToFile('WARN', '销毁网站视图异常', siteId, e.message);
  } finally {
    viewsMap.delete(siteId);
  }
  return true;
}

// 确保指定网站的视图存在：常驻视图遮罩重建后仍存活，直接重新挂载；非常驻视图被销毁后在此懒加载重建
function ensureSiteView(siteId) {
  if (viewsMap.has(siteId)) {
    const v = viewsMap.get(siteId);
    if (overlayWin && !overlayWin.isDestroyed()) {
      try { overlayWin.addBrowserView(v); } catch (e) { logToFile('WARN', '重新挂载网站视图失败', siteId, e.message); }
    }
    return v;
  }
  const site = siteList.find(s => s.id === siteId);
  if (!site || !overlayWin || overlayWin.isDestroyed()) return null;
  return createSiteView(site);
}

function createBrowserViews() {
  try {
    // 遮罩创建 / 重建时，先卸载 viewsMap 中已经存在但 siteList 里已经不存在的"野"视图（例如用户在设置里删掉了某条）
    for (const [id, view] of [...viewsMap]) {
      const stillPresent = siteList.some(s => s.id === id);
      if (!stillPresent) destroySiteView(id);
    }
    siteList.forEach((site) => {
      // 常驻网站：提前创建并加载，即使不在遮罩显示也保持存活；上次遮罩保留的视图直接重新挂载
      if (!site.persistent) return;
      if (viewsMap.has(site.id)) {
        if (overlayWin && !overlayWin.isDestroyed()) {
          try { overlayWin.addBrowserView(viewsMap.get(site.id)); } catch (e) { logToFile('WARN', '重新挂载常驻网站视图失败', site.id, e.message); }
        }
        return;
      }
      createSiteView(site);
    });
    // 当前可见网站必须有视图（若为非常驻也立即创建，保证打开即显示）
    const firstId = siteList[0] ? siteList[0].id : null;
    visibleSiteId = firstId;
    if (firstId) ensureSiteView(firstId);
    updateBrowserViewBounds();
  } catch (err) {
    logToFile('ERROR', '创建 BrowserView 失败', err);
  }
}

function handleShortcut(event, input) {
  if (input.control && input.shift && input.alt && !input.meta && input.type === 'keyDown') {
    if (input.code === 'Space') {
      event.preventDefault();
      switchToNextSite();
    } else if (input.code === 'KeyT' && isTestMode) {
      event.preventDefault();
      toggleAlwaysOnTop();
    } else if (input.code === 'KeyM') {
      event.preventDefault();
      if (!isMusicPopped) popMusicView();
    } else if (input.code === 'KeyE') {
      event.preventDefault();
      if (overlayWin && !overlayWin.isDestroyed()) {
        createInputDialog({
          title: '延长锁屏',
          message: '请输入延长分钟数：',
          defaultValue: '30'
        }).then(minutes => { if (minutes !== null) extendLockTime(minutes); });
      }
    } else if (input.code === 'KeyA') {
      event.preventDefault();
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('toggle-agent');
      }
    } else if (input.code === 'KeyL') {
      event.preventDefault();
      toggleSiteLock();
    } else if (input.code === 'F12' && !isTestMode) {
      event.preventDefault();
      emergencyExit();
    }
  }
  if (input.code === 'KeyM' && input.type === 'keyUp' && isMusicPopped) {
    restoreMusicView();
  }
  // 测试模式 / 即时模式：按 Esc 直接退出遮罩（复用测试模式设计）
  if ((isTestMode || instantMode) && input.key === 'Escape' && input.type === 'keyDown' &&
      !input.alt && !input.control && !input.shift && !input.meta) {
    event.preventDefault();
    if (instantMode) {
      instantEmergencyExit();
    } else {
      overlayWin.close();
    }
  }
}

function updateBrowserViewBounds() {
  if (!overlayWin || overlayWin.isDestroyed() || viewsMap.size === 0 || isMusicPopped) return;
  const bounds = overlayWin.getBounds();
  const hiddenBounds = { x: bounds.width + 1000, y: 0, width: bounds.width, height: bounds.height };
  // 顶部每日任务进度条高度（6px 条 + 2px 间隙）：网站视图须从其下方开始，避免盖住进度条
  const TOP_BAR_PX = 8;
  // 经典布局（左右分栏）：网站常驻右侧 40%，顶部让位给全宽进度条
  if (layoutMode === 'legacy') {
    const rightWidth = Math.floor(bounds.width * 0.4);
    const visibleBounds = { x: bounds.width - rightWidth, y: TOP_BAR_PX, width: rightWidth, height: bounds.height - TOP_BAR_PX };
    viewsMap.forEach((view, id) => {
      view.setBounds(id === visibleSiteId ? visibleBounds : hiddenBounds);
    });
    return;
  }
  // 现代布局：网站视图激活时铺在面板内容区（header 下方），随面板高度调整；否则整体隐藏
  let visibleBounds = hiddenBounds;
  if (siteViewActive && sitePanelBounds) {
    const maxTop = bounds.height - 40;
    const top = Math.max(TOP_BAR_PX, Math.min(sitePanelBounds.top, maxTop));
    const height = Math.max(40, Math.min(sitePanelBounds.height, bounds.height - top));
    visibleBounds = { x: 0, y: top, width: bounds.width, height };
  }
  viewsMap.forEach((view, id) => {
    if (id === visibleSiteId && siteViewActive) view.setBounds(visibleBounds);
    else view.setBounds(hiddenBounds);
  });
}

// ========== 网站即时锁定（运行时固定） ==========
function getSiteLockState() {
  return { active: siteLockActive, minMinutes: focusSettings.siteLockMinMinutes || 0 };
}
function toggleSiteLock() {
  if (siteLockActive) {
    // 解除锁定：校验网站最短锁定时长
    const minMin = focusSettings.siteLockMinMinutes || 0;
    if (minMin > 0) {
      const elapsed = (Date.now() - siteLockedAt) / 60000;
      if (elapsed < minMin) {
        const waitMinutes = Math.ceil(minMin - elapsed);
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('site-lock-blocked', { reason: 'minLock', waitMinutes });
        }
        return { success: false, reason: 'minLock', waitMinutes };
      }
    }
    siteLockActive = false;
    siteLockedAt = 0;
  } else {
    siteLockActive = true;
    siteLockedAt = Date.now();
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('site-lock-changed', siteLockActive);
  }
  logToFile('INFO', '网站锁定切换', { active: siteLockActive });
  return { success: true, active: siteLockActive };
}

function switchSite(targetId) {
  if (siteLockActive) return; // 网站锁定中：禁止切换
  if (targetId === visibleSiteId) return;
  const current = siteList.find(s => s.id === visibleSiteId);
  if (current && current.pinned) return; // 已固定网站：锁定期间禁止切换
  const prevId = visibleSiteId;
  const prevSite = current;
  if (isMusicPopped) restoreMusicView();
  // 非常驻网站视图可能已被销毁，切换时懒加载重建
  const view = ensureSiteView(targetId);
  if (!view) return;
  visibleSiteId = targetId;
  updateBrowserViewBounds();
  if (overlayWin && !overlayWin.isDestroyed()) {
    const site = siteList.find(s => s.id === visibleSiteId);
    overlayWin.webContents.send('site-changed', site ? site.name : visibleSiteId);
  }
  // 关键：离开的网站如果是"非常驻"，立即销毁释放渲染进程与内存（屏外隐藏并不能省内存）
  if (prevId && prevSite && !prevSite.persistent && prevId !== visibleSiteId) {
    destroySiteView(prevId);
    logToFile('INFO', '切换后已释放非常驻网站视图', { prevId, prevName: prevSite.name });
  }
}
function switchToNextSite() {
  if (siteList.length <= 1) return;
  if (siteLockActive) return; // 网站锁定中：禁止切换
  const current = siteList.find(s => s.id === visibleSiteId);
  if (current && current.pinned) return; // 已固定网站：锁定期间禁止切换
  const currentIndex = siteList.findIndex(s => s.id === visibleSiteId);
  const nextIndex = (currentIndex + 1) % siteList.length;
  switchSite(siteList[nextIndex].id);
}

// ========== 网站使用时长统计 ==========
let siteUsageSaveCounter = 0;
function loadSiteUsage() {
  try {
    if (fs.existsSync(SITE_STATS_FILE)) {
      siteUsage = JSON.parse(fs.readFileSync(SITE_STATS_FILE, 'utf-8')) || {};
    }
  } catch (e) { siteUsage = {}; }
  siteUsageDate = todayStr();
  if (!siteUsage[siteUsageDate]) siteUsage[siteUsageDate] = {};
}
function saveSiteUsage() {
  try {
    fs.writeFileSync(SITE_STATS_FILE, JSON.stringify(siteUsage, null, 2), 'utf-8');
  } catch (e) { logToFile('WARN', '写入网站统计失败', e.message); }
}
function siteUsageTick() {
  const now = todayStr();
  if (now !== siteUsageDate) {
    saveSiteUsage(); // 跨天归档
    siteUsageDate = now;
    siteUsage[now] = siteUsage[now] || {};
  }
  if (!visibleSiteId) return;
  siteUsage[siteUsageDate][visibleSiteId] = (siteUsage[siteUsageDate][visibleSiteId] || 0) + 10;
  siteUsageSaveCounter += 1;
  if (siteUsageSaveCounter % 3 === 0) saveSiteUsage(); // 每 30 秒落盘
}
function startSiteUsageTracking() {
  loadSiteUsage();
  if (siteUsageTickTimer) clearInterval(siteUsageTickTimer);
  siteUsageTickTimer = setInterval(siteUsageTick, 10000);
}
function stopSiteUsageTracking() {
  if (siteUsageTickTimer) { clearInterval(siteUsageTickTimer); siteUsageTickTimer = null; }
  saveSiteUsage();
}
// 返回：{ today: { siteId: 秒 }, days: { 'YYYY-MM-DD': { siteId: 秒 } } }（近 7 天）
function getSiteStatsData() {
  const today = todayStr();
  const result = { today: {}, days: {} };
  for (let i = 6; i >= 0; i--) {
    const key = todayStr(new Date(Date.now() - i * 86400000));
    result.days[key] = siteUsage[key] || {};
  }
  if (siteUsageDate === today) result.today = { ...(siteUsage[today] || {}) };
  else result.today = siteUsage[today] || {};
  return result;
}
function toggleAlwaysOnTop() {
  if (!isTestMode) return;
  forceAlwaysOnTop = !forceAlwaysOnTop;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setAlwaysOnTop(forceAlwaysOnTop, 'screen-saver');
    overlayWin.webContents.send('always-on-top-changed', forceAlwaysOnTop);
  }
}

// ========== 遮罩窗口 ==========
async function createOverlay() {
  if (overlayWin) return;
  siteViewActive = false; // 遮罩重建时重置网站视图状态
  // 冷却恢复：遮罩重建时恢复冷却计时（顺延退出期间暂停的时间，确保锁屏期间冷却才倒计时）
  if (cooldownPauseTime > 0) {
    const pauseDuration = Date.now() - cooldownPauseTime;
    emergencyCooldownUntil += pauseDuration;
    cooldownPauseTime = 0;
    logToFile('INFO', '紧急退出冷却已恢复（退出期间已暂停）', { pausedSec: Math.round(pauseDuration / 1000) });
  }
  // 保存当前锁屏会话时段：防止用户修改 config.js 后重启/强杀绕过锁屏
  try {
    focusSettings.lockSessionRanges = timeRanges.map(r => ({ start: r.start, end: r.end, startMin: r.startMin, endMin: r.endMin }));
    saveFocusSettingsToFile({ ...focusSettings });
    logToFile('INFO', '锁屏会话时段已持久化', { ranges: timeRanges.map(r => `${r.start}-${r.end}`) });
  } catch (e) { logToFile('WARN', '保存锁屏会话时段失败', e.message); }
  // 已保存的最短时长设置：本次出现遮罩时应用
  if (pendingMinSettings) {
    focusSettings = { ...focusSettings, ...pendingMinSettings };
    pendingMinSettings = null;
  }
  // 已保存的自定义任务完成比例：本次出现遮罩时应用（下次启动生效）
  if (pendingTaskRatio != null) {
    focusSettings = { ...focusSettings, dailyTaskRatio: pendingTaskRatio };
    pendingTaskRatio = null;
  }
  try {
    overlayWin = new MicaBrowserWindow({
      fullscreen: true,
      frame: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    // Aero 玻璃（Acrylic）：毛玻璃模糊 + 半透明深色着色，透出桌面
    try {
      overlayWin.setCustomEffect(4, '#0B0E17', 0.18);
      overlayWin.setDarkTheme();
    } catch (e) { logToFile('WARN', 'Aero 效果应用失败', e.message); }
    overlayWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    overlayWin.webContents.on('before-input-event', (event, input) => {
      handleShortcut(event, input);
    });
    // ===== 拦截遮罩内导航（防止点开 MD 链接等把遮罩页面跳转到外部网站，导致被困无法退出） =====
    overlayWin.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      overlayWin.webContents.send('external-link-blocked', url);
    });
    overlayWin.webContents.setWindowOpenHandler(({ url }) => {
      overlayWin.webContents.send('external-link-blocked', url);
      return { action: 'deny' };
    });
    if (isTestMode) {
      overlayWin.webContents.openDevTools({ mode: 'detach' });
    }
    overlayWin.setMenuBarVisibility(false);
    topTimer = setInterval(() => {
      if (overlayWin && !overlayWin.isDestroyed() && forceAlwaysOnTop) {
        overlayWin.setAlwaysOnTop(true, 'screen-saver');
      }
    }, 1000);
    enableSilence();

    muteTargetProcesses().catch(err => logToFile('ERROR', '静音进程失败', err));

    silenceTimer = setInterval(enableSilence, 30 * 1000);
    killTimer = setInterval(() => {
      maintainMute();
    }, 10000);

    overlayWin.on('resize', updateBrowserViewBounds);
    overlayWin.webContents.on('did-finish-load', () => {
      createBrowserViews();
      startSiteUsageTracking();
      // 快速模式标识：渲染端就绪后再通知，避免一次性事件早于监听注册而丢失
      if (quickModeActive) {
        overlayWin.webContents.send('quick-start-status', true);
      }
      const site = siteList.find(s => s.id === visibleSiteId);
      overlayWin.webContents.send('site-changed', site ? site.name : '');
      overlayWin.webContents.send('always-on-top-changed', forceAlwaysOnTop);
      // 锁屏时段已结束但每日任务未达标：立即推送常驻提示
      if (!isInLockTime()) {
        const dpLoad = getDailyTaskProgress();
        if (!dpLoad.met) {
          overlayWin.webContents.send('daily-task-blocking', {
            completed: dpLoad.completed, total: dpLoad.total,
            need: Math.ceil(dpLoad.total * dpLoad.threshold)
          });
        }
      }
      const extendRemaining = Math.max(0, Math.floor((extendedUntil - Date.now()) / 1000));
      sendExtendedStatus(extendRemaining);
      // 遮罩重建后：若延长锁屏仍在有效期内但计时器已停（如紧急退出后恢复），重新启动计时器
      if (extendedUntil > Date.now() && !extendTimer) {
        extendTimer = setInterval(() => {
          const nowTs = Date.now();
          const remaining = Math.max(0, Math.floor((extendedUntil - nowTs) / 1000));
          if (overlayWin && !overlayWin.isDestroyed()) {
            overlayWin.webContents.send('extended-status', remaining);
          }
          if (remaining === 0) {
            clearInterval(extendTimer);
            extendTimer = null;
            if (!isInLockTime() && overlayWin && !overlayWin.isDestroyed()) {
              destroyOverlay();
            }
          }
        }, 1000);
        logToFile('INFO', '延长锁屏计时器已随遮罩重建恢复', { remainSec: extendRemaining });
      }
    });

    // ===== 拦截窗口关闭 =====
    overlayWin.on('close', (event) => {
      if (isTestMode) return;
      // 紧急退出正在关闭时放行；否则锁屏时段/倒计时/每日任务未达标均拦截关闭
      const dailyProgress = getDailyTaskProgress();
      const blockByDaily = !emergencyExitInProgress && !dailyProgress.met;
      if (isInLockTime() || activeTimer || blockByDaily) {
        event.preventDefault();
        // Defense in depth：若紧急退出进行中仍走到这里（理论上不会，emergencyExitInProgress 已在 doEmergencyExit/instantEmergencyExit 设为 true），
        // 说明状态机被破坏 → 回滚冷却时间，避免「bug 导致无法退出却仍计入冷却」
        if (emergencyExitInProgress) {
          emergencyCooldownUntil = 0;
          logToFile('WARN', '紧急退出进行中却被 close 拦截，已回滚冷却时间（defense in depth）');
        }
        let msg = '当前';
        if (activeTimer) msg += '有倒计时进行中，';
        if (isInLockTime()) msg += '处于锁屏时段，';
        if (blockByDaily) {
          const need = Math.ceil(dailyProgress.total * dailyProgress.threshold);
          msg += `每日任务完成率不足（${dailyProgress.completed}/${dailyProgress.total}，需完成 ${need} 项），`;
        }
        msg += '无法关闭遮罩。请使用紧急退出功能 (Ctrl+Shift+Alt+F12) 或等待倒计时结束。';
        // 遮罩内提示（避免系统对话框被 browserView 遮挡）
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('close-blocked', { message: msg });
        }
      }
    });

    overlayWin.on('closed', () => cleanupOverlay());
    registerOverlayShortcuts();

    lockStartedAt = Date.now();
    logToFile('INFO', '遮罩已创建');
  } catch (err) {
    logToFile('ERROR', '创建遮罩失败', err);
  }
}

// ========== 清理遮罩 ==========
function cleanupOverlay() {
  if (activeTimer) {
    clearTimeout(activeTimer.timeoutId);
    activeTimer = null;
    timerPomodoroSynced = false;
  }
  emergencyExitInProgress = false; // 关闭完成，恢复拦截
  unregisterOverlayShortcuts();
  stopSiteUsageTracking();
  if (killTimer) { clearInterval(killTimer); killTimer = null; }
  if (topTimer) { clearInterval(topTimer); topTimer = null; }
  if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
  disableSilence();
  unmuteTargetProcessesSync();
  sendCooldownStatus(0);
  // 冷却暂停：遮罩关闭时暂停冷却计时（退出期间不消耗冷却时间，回到锁屏后冷却继续）
  if (emergencyCooldownUntil > Date.now() && cooldownPauseTime === 0) {
    cooldownPauseTime = Date.now();
    logToFile('INFO', '紧急退出冷却已暂停（退出期间冻结）');
  }

  // 遮罩关闭：仅保留 siteList 中标记为"常驻"的视图，其余一律销毁释放渲染进程内存
  // 之前 keepVisibleId 保留前台非常驻的逻辑会导致网站泄漏（用户打开过的非常驻永远不释放，数量多了轻松 >1G）
  for (const [id, view] of [...viewsMap]) {
    const site = siteList.find(s => s.id === id);
    // siteList 已不存在的"野"视图也一并销毁
    const keepAlive = !!(site && site.persistent);
    // 先统一从 overlay / musicPopup 上卸载，避免窗口句柄被 BrowserView 强引用
    try {
      if (isMusicPopped && musicPopupWin && !musicPopupWin.isDestroyed()) {
        const mv = getMusicView && getMusicView();
        if (view !== mv && overlayWin && !overlayWin.isDestroyed()) overlayWin.removeBrowserView(view);
        else if (view === mv) musicPopupWin.removeBrowserView(view);
      } else if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.removeBrowserView(view);
      }
    } catch (_) {}
    if (keepAlive) continue;
    destroySiteView(id);
  }
  // 关闭所有扩展 UI 子窗口（它们以 overlayWin 为 parent，遮罩消失后通常不会自动关，留着吃内存）
  for (const w of [...openExtensionWindows]) {
    try { if (w && !w.isDestroyed()) w.close(); } catch (_) {}
    openExtensionWindows.delete(w);
  }
  if (musicPopupWin && !musicPopupWin.isDestroyed()) {
    musicPopupWin.close();
    musicPopupWin = null;
  }
  overlayWin = null;
  isMusicPopped = false;
  visibleSiteId = null;
  lockStartedAt = null;
  siteLockActive = false; // 锁屏结束后解除网站锁定
  siteLockedAt = 0;
  // 锁屏会话结束：清除会话时段保护，重新加载 config.js 以应用用户在锁定期间保存的变更
  if (focusSettings.lockSessionRanges) {
    delete focusSettings.lockSessionRanges;
    saveFocusSettingsToFile({ ...focusSettings });
    try { loadConfig(); } catch (e) { logToFile('WARN', '锁屏会话结束后 reload config 失败', e.message); }
    logToFile('INFO', '锁屏会话已结束，已清除会话时段保护并重新加载 config.js');
  }
  if (isTestMode && !isEmergencyBreak && !instantMode) {
    // 即时模式下关闭遮罩不退出进程（与生产行为一致），便于测试"退出后重新锁屏"
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    app.quit();
  }
}

// ========== 紧急退出 ==========
// preSeconds：可选预定时长（agent 工具调用时传入）。返回状态对象供调用方反馈。
function emergencyExit(preSeconds) {
  logToFile('INFO', '触发紧急退出' + (instantMode ? '（即时模式）' : ''));
  // 即时模式：任意时间直接退出，跳过最短锁定/冷却/验证码，时长无限制
  if (instantMode) {
    instantEmergencyExit();
    return { success: true, immediate: true };
  }
  // 防偷懒：紧急恢复期间再次触发 → 顺延恢复时间
  if (emergencyRestoreTimer) {
    renewEmergencyBreak();
    return { success: false, reason: 'renewed' };
  }
  // 最短锁定时长校验
  if (focusSettings.minLockMinutes > 0 && lockStartedAt) {
    const elapsed = (Date.now() - lockStartedAt) / 60000;
    if (elapsed < focusSettings.minLockMinutes) {
      const wait = Math.ceil(focusSettings.minLockMinutes - elapsed);
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('emergency-blocked', { reason: 'minLock', waitMinutes: wait });
      }
      return { success: false, reason: 'minLock', waitMinutes: wait };
    }
  }
  // 冷却校验（遮罩激活期间冷却已暂停，按冻结时刻计算剩余）
  const cooldownNow = cooldownPauseTime > 0 ? cooldownPauseTime : Date.now();
  if (cooldownNow < emergencyCooldownUntil) {
    const remaining = Math.ceil((emergencyCooldownUntil - cooldownNow) / 1000);
    sendCooldownStatus(remaining);
    return { success: false, reason: 'cooldown', remainingSeconds: remaining };
  }
  // 验证码解锁
  if (focusSettings.verifyCodeEnabled) {
    createCodeDialog().then(ok => {
      if (ok) proceedEmergencyExit(preSeconds);
    }).catch(err => {
      logToFile('ERROR', '验证码对话框错误', err);
    });
    return { pending: true, reason: 'verifyCode' };
  }
  return proceedEmergencyExit(preSeconds);
}

// preSeconds：已有时长则跳过输入框，但仍执行 1200 秒上限校验
function proceedEmergencyExit(preSeconds) {
  if (preSeconds !== undefined && preSeconds !== null) {
    const seconds = Number(preSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { success: false, reason: 'invalidSeconds' };
    }
    // 最大时长校验：紧急退出时长不允许超过 1200 秒（20 分钟）
    if (seconds > 1200) {
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('emergency-blocked', { reason: 'maxDuration', maxSeconds: 1200 });
      }
      logToFile('WARN', '紧急退出时长超限被拦截', { seconds, maxSeconds: 1200 });
      return { success: false, reason: 'maxDuration', maxSeconds: 1200 };
    }
    doEmergencyExit(seconds);
    return { success: true, seconds };
  }
  createInputDialog({
    title: '紧急退出计时',
    message: '请输入退出时长（秒）：',
    defaultValue: '60'
  }).then((seconds) => {
    if (seconds === null) return;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    // 最大时长校验：紧急退出时长不允许超过 1200 秒（20 分钟）
    if (seconds > 1200) {
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('emergency-blocked', { reason: 'maxDuration', maxSeconds: 1200 });
      }
      logToFile('WARN', '紧急退出时长超限被拦截', { seconds, maxSeconds: 1200 });
      return;
    }
    doEmergencyExit(seconds);
  }).catch(err => {
    logToFile('ERROR', '紧急退出对话框错误', err);
  });
  return { pending: true, reason: 'inputDialog' };
}

// 防偷懒：恢复期间再次触发紧急退出，顺延恢复时间并刷新冷却
function renewEmergencyBreak() {
  logToFile('INFO', '防偷懒：紧急退出恢复时间顺延 60 秒');
  emergencyCooldownUntil = Date.now() + 20 * 60 * 1000;
  cooldownPauseTime = Date.now(); // 重新暂停新冷却（退出期间不消耗冷却时间）
  if (emergencyRestoreTimer) clearTimeout(emergencyRestoreTimer);
  emergencyRestoreTimer = setTimeout(() => {
    isEmergencyBreak = false;
    emergencyExited = false;
    emergencyRestoreTimer = null;
    emergencyExemptUntil = 0; // 恢复后取消本时段豁免，重新按时段判断是否锁屏
    sendCooldownStatus(0);
    checkTimeAndToggle();
    logToFile('INFO', '紧急退出恢复（顺延后）');
  }, 60 * 1000);
  sendCooldownStatus(20 * 60);
}

function doEmergencyExit(seconds) {
  if (activeTimer) {
    clearTimeout(activeTimer.timeoutId);
    activeTimer = null;
    timerPomodoroSynced = false;
  }
  if (extendTimer) { clearInterval(extendTimer); extendTimer = null; }
  // 保留 extendedUntil：紧急退出后恢复锁屏时，剩余延长时长仍然有效
  if (emergencyRestoreTimer) {
    clearTimeout(emergencyRestoreTimer);
    emergencyRestoreTimer = null;
  }
  // 先标记紧急退出状态再关闭遮罩，否则 close 事件会因"锁屏时段"/"每日任务未达标"拦截关闭
  isEmergencyBreak = true;
  emergencyExited = true;
  emergencyExitInProgress = true; // 放行 close 事件：close 拦截器据此跳过 60% 校验，避免紧急退出被卡死（cleanupOverlay 会在关闭完成后清零）
  emergencyCooldownUntil = Date.now() + 20 * 60 * 1000;
  emergencyExemptUntil = getCurrentRangeEnd(); // 本锁屏时段不再自动锁屏
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
  }
  sendCooldownStatus(20 * 60);
  emergencyRestoreTimer = setTimeout(() => {
    isEmergencyBreak = false;
    emergencyExited = false;
    emergencyRestoreTimer = null;
    emergencyExemptUntil = 0; // 恢复后取消本时段豁免，重新按时段判断是否锁屏
    sendCooldownStatus(0);
    checkTimeAndToggle();
    logToFile('INFO', '紧急退出恢复');
  }, seconds * 1000);
  logToFile('INFO', `紧急退出 ${seconds} 秒，冷却至 ${new Date(emergencyCooldownUntil).toISOString()}`);
}

// 即时模式紧急退出：跳过最短锁定/冷却/验证码与时长限制，直接关闭遮罩。
// 不设置 isEmergencyBreak/emergencyExited，仅靠 emergencyExemptUntil 豁免本锁屏时段，
// 时段结束后 isInLockTime() 自动恢复判断，下一时段照常锁屏。
function instantEmergencyExit() {
  if (activeTimer) {
    clearTimeout(activeTimer.timeoutId);
    activeTimer = null;
    timerPomodoroSynced = false;
  }
  if (extendTimer) { clearInterval(extendTimer); extendTimer = null; }
  // 保留 extendedUntil：即时退出后恢复锁屏时，剩余延长时长仍然有效
  if (emergencyRestoreTimer) {
    clearTimeout(emergencyRestoreTimer);
    emergencyRestoreTimer = null;
  }
  isEmergencyBreak = false;
  emergencyExited = false;
  emergencyExitInProgress = true; // 放行 close 事件：即时模式紧急退出同样需要跳过 60% 校验（cleanupOverlay 关闭完成后清零）
  emergencyCooldownUntil = 0;   // 无冷却
  cooldownPauseTime = 0;        // 清除暂停标记
  emergencyExemptUntil = getCurrentRangeEnd(); // 本锁屏时段不再自动锁屏
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
  }
  sendCooldownStatus(0);
  logToFile('INFO', '即时模式紧急退出：遮罩已关闭，本时段不再自动锁屏，时长无限制');
}

// 手动重新锁定：取消紧急退出/即时退出的本时段豁免，立即按当前时间重新判定锁屏
function relockOverlay() {
  if (emergencyRestoreTimer) { clearTimeout(emergencyRestoreTimer); emergencyRestoreTimer = null; }
  isEmergencyBreak = false;
  emergencyExited = false;
  emergencyCooldownUntil = 0;
  emergencyExemptUntil = 0;
  sendCooldownStatus(0);
  logToFile('INFO', '手动重新锁定：已取消豁免状态');
  if (!isInLockTime()) {
    logToFile('INFO', '手动重新锁定：当前不在锁屏时段，无需锁屏');
    return;
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    logToFile('INFO', '手动重新锁定：遮罩已存在');
    return;
  }
  minimizeAllWindows();
  setTimeout(() => createOverlay(), 300);
}
// 独立注册"重新锁定"全局快捷键：不依赖遮罩生命周期，即时退出（遮罩关闭）后仍可用
function registerRelockShortcut() {
  const sc = { ...DEFAULT_SHORTCUTS, ...((focusSettings.shortcuts) || {}) };
  const acc = sc.relock;
  if (!acc) return;
  if (globalShortcut.isRegistered(acc)) globalShortcut.unregister(acc);
  try {
    globalShortcut.register(acc, () => relockOverlay());
    logToFile('INFO', '重新锁定快捷键已注册', { relock: acc });
  } catch (e) {
    logToFile('WARN', '重新锁定快捷键注册失败', { acc, error: e.message });
  }
}

function destroyOverlay() {
  // 已排定延后解锁（等倒计时结束后 1 分钟），保持等待，避免轮询提前关闭
  if (unlockAfterTimer) return;
  // 锁屏时段结束但倒计时仍在进行：等倒计时结束后 1 分钟再真正解锁
  if (activeTimer && activeTimer.endTime > Date.now()) {
    const delay = Math.max(1500, activeTimer.endTime + 60000 - Date.now());
    unlockAfterTimer = setTimeout(() => {
      unlockAfterTimer = null;
      flushStopwatchResult();
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
    }, delay);
    logToFile('INFO', '锁屏时段结束但倒计时进行中，等待倒计时结束后 1 分钟解锁', { delayMs: delay });
    return;
  }
  flushStopwatchResult();
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
}

// ========== 计时（秒表）结果落盘 ==========
function formatStopwatchResult(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h} 小时 ${m} 分 ${s} 秒`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}
// 锁屏结束时秒表仍在计时：结束计时，把时长输出到应用根目录 timer-result.json
function flushStopwatchResult() {
  if (timerStartTime === null) return;
  const elapsedMs = Date.now() - timerStartTime;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const result = {
    date: todayStr(),
    startedAt: new Date(timerStartTime).toLocaleString('zh-CN'),
    endedAt: new Date().toLocaleString('zh-CN'),
    seconds: totalSeconds,
    duration: formatStopwatchResult(totalSeconds)
  };
  timerStartTime = null;
  try {
    fs.writeFileSync(path.join(dataDir, 'timer-result.json'), JSON.stringify(result, null, 2), 'utf-8');
    logToFile('INFO', '锁屏结束，计时结果已写入用户数据目录', result);
  } catch (e) {
    logToFile('WARN', '写入计时结果失败', e.message);
  }
}
// 次日启动时清除上次的计时结果文件
function clearTimerResultFile() {
  try {
    const filePath = path.join(dataDir, 'timer-result.json');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    logToFile('WARN', '清除上次计时结果失败', e.message);
  }
}

function checkTimeAndToggle() {
  if (isTestMode || emergencyExited) return;
  // 测试模式交接：生产实例在测试实例运行期间不重建遮罩
  if (testHandoffActive) {
    let testRunning = false;
    try {
      const pidStr = fs.readFileSync(testLockFile, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, 0); // 信号 0：不实际发信号，仅检测进程是否存在；不存在则抛异常
        testRunning = true;
      }
    } catch (e) { /* 文件不存在或进程已终止 */ }
    if (!testRunning) {
      testHandoffActive = false;
      try { fs.rmSync(testLockFile, { force: true }); } catch (e) {}
      logToFile('INFO', '测试实例已退出，恢复生产锁屏调度');
    } else {
      return;
    }
  }
  if (isInLockTime() && !overlayWin) {
    minimizeAllWindows();
    setTimeout(() => createOverlay(), 300);
  } else if (!isInLockTime() && overlayWin) {
    // 每日任务未达 60% 完成率：锁屏时段结束后保持锁定，直到完成率达标（未配置任务时不拦截）
    const dailyProgress = getDailyTaskProgress();
    if (!dailyProgress.met) {
      notifyDailyTaskBlocking(dailyProgress);
      return;
    }
    dailyTaskBlockNotifiedAt = 0; // 达标后重置通知节流
    destroyOverlay();
  }
}

// 每日任务阻塞通知：常驻提示由 did-finish-load / toggle / set 实时推送，
// 周期性检查（checkLockSchedule）仅需补充推送以防用户未操作时提示丢失
let dailyTaskBlockNotifiedAt = 0;
function notifyDailyTaskBlocking(progress) {
  const now = Date.now();
  if (now - dailyTaskBlockNotifiedAt < 30 * 1000) return; // 节流降至 30 秒
  dailyTaskBlockNotifiedAt = now;
  const need = Math.ceil(progress.total * progress.threshold);
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('daily-task-blocking', { completed: progress.completed, total: progress.total, need });
  }
  logToFile('INFO', '锁屏时段已结束，每日任务完成率不足，保持锁定', progress);
}

// ========== IPC ==========
ipcMain.on('close-overlay', () => {
  if (overlayWin && isTestMode) overlayWin.close();
});
ipcMain.handle('get-auto-launch-status', async () => autoLaunchEnabled);
ipcMain.handle('toggle-auto-launch', async () => {
  autoLaunchEnabled = !autoLaunchEnabled;
  const ok = await applyAutoLaunch();
  if (ok) {
    try { saveConfigPatch(app, { autoLaunch: autoLaunchEnabled }); } catch (e) {}
  }
  return { enabled: autoLaunchEnabled, ok };
});
ipcMain.handle('get-sites', async () => siteList.map(s => ({ id: s.id, name: s.name, pinned: !!s.pinned, persistent: s.persistent !== false })));
ipcMain.handle('toggle-site-lock', async () => toggleSiteLock());
ipcMain.handle('get-site-lock', async () => getSiteLockState());
ipcMain.handle('get-current-site', async () => {
  const site = siteList.find(s => s.id === visibleSiteId);
  return site ? site.name : '';
});
ipcMain.handle('switch-site', async (event, targetId) => {
  switchSite(targetId);
  const site = siteList.find(s => s.id === visibleSiteId);
  return site ? site.name : '';
});
ipcMain.handle('set-site-view', async (event, active) => {
  siteViewActive = !!active;
  if (!siteViewActive) sitePanelBounds = null;
  updateBrowserViewBounds();
  return siteViewActive;
});
ipcMain.handle('set-site-panel-bounds', async (event, rect) => {
  if (rect && typeof rect.top === 'number' && typeof rect.height === 'number') {
    sitePanelBounds = { top: Math.round(rect.top), height: Math.round(rect.height) };
    if (siteViewActive) updateBrowserViewBounds();
  }
  return true;
});
ipcMain.handle('set-layout-mode', async (event, mode) => {
  layoutMode = mode === 'legacy' ? 'legacy' : 'modern';
  if (layoutMode === 'legacy') siteViewActive = false;
  updateBrowserViewBounds();
  return layoutMode;
});
ipcMain.handle('toggle-always-on-top', async () => {
  toggleAlwaysOnTop();
  return forceAlwaysOnTop;
});
ipcMain.handle('get-always-on-top', async () => forceAlwaysOnTop);
ipcMain.handle('get-test-mode', async () => isTestMode);
ipcMain.handle('get-instant-mode', async () => instantMode);
// 测试辅助（仅 --test 模式）：绕过全局快捷键直接驱动即时退出/手动重新锁定，供 CDP 冒烟测试
if (isTestMode) {
  ipcMain.handle('test-instant-exit', async () => {
    if (!instantMode) return { skipped: true };
    instantEmergencyExit();
    return { skipped: false, exemptUntil: emergencyExemptUntil };
  });
  ipcMain.handle('test-relock', async () => {
    relockOverlay();
    return {
      overlayExists: !!(overlayWin && !overlayWin.isDestroyed()),
      inLockTime: isInLockTime(),
      exemptUntil: emergencyExemptUntil
    };
  });
  // 安全网：遮罩销毁后由主进程延迟触发 relockOverlay（fire-and-forget，供 SendKeys 快捷键测试兜底）
  ipcMain.on('test-relock-after-delay', (event, ms) => {
    const delay = Math.max(100, Math.min(30000, Number(ms) || 500));
    setTimeout(() => { try { relockOverlay(); } catch (e) {} }, delay);
  });
  // 开启/关闭"模拟真实锁屏时段判断"（默认关闭时 isInLockTime 恒 false，与测试模式原有行为一致）
  ipcMain.handle('test-set-lock-simulation', async (event, v) => {
    testEnableLockTime = v === true;
    return { enabled: testEnableLockTime, inLockTime: isInLockTime() };
  });
  // 测试辅助：直接驱动 agent 工具执行（验证工具参数校验与权限约束）
  ipcMain.handle('test-tool-call', async (event, toolName, args) => {
    return await executeToolCall(toolName, args || {});
  });
}
ipcMain.handle('get-quick-start-mode', async () => isQuickStart || quickModeActive);

// 延长锁屏
ipcMain.handle('show-extend-dialog', async () => {
  return await createInputDialog({
    title: '延长锁屏',
    message: '请输入延长分钟数：',
    defaultValue: '30'
  });
});
ipcMain.on('extend-lock', (event, minutes) => {
  const success = extendLockTime(minutes);
  if (!success) {
    dialog.showMessageBox({
      type: 'warning',
      title: '无法延长',
      message: '无效的分钟数',
      buttons: ['确定'],
      parent: (overlayWin && !overlayWin.isDestroyed()) ? overlayWin : undefined
    });
  }
});

// ===== 倒计时 IPC =====
// 第三个可选参数 taskId：若由「延长 5 分钟」按钮等场景传入，新倒计时也会保留任务关联（结束时 timer-done 仍带 taskId）
ipcMain.on('set-timer', (event, seconds, label, taskId) => {
  const success = startTimer(seconds, label, taskId || null);
  if (!success) {
    dialog.showMessageBox({
      type: 'warning',
      title: '设置倒计时失败',
      message: '无效的秒数',
      buttons: ['确定'],
      parent: (overlayWin && !overlayWin.isDestroyed()) ? overlayWin : undefined
    });
  }
});
ipcMain.handle('get-timer-state', async () => {
  if (!activeTimer) return { active: false };
  const remaining = Math.max(0, Math.ceil((activeTimer.endTime - Date.now()) / 1000));
  return { active: true, label: activeTimer.label, totalSeconds: activeTimer.seconds, remainingSeconds: remaining, endTime: activeTimer.endTime };
});
ipcMain.handle('cancel-timer', async () => {
  if (!activeTimer) return { success: false, message: '当前没有进行中的倒计时' };
  clearTimeout(activeTimer.timeoutId);
  activeTimer = null;
  timerPomodoroSynced = false;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('timer-cancelled', {});
  }
  return { success: true, message: '倒计时已取消' };
});

// DeepSeek AI
ipcMain.handle('deepseek-chat', async (event, messages) => {
  if (!deepseekApiKey) {
    event.sender.send('chat-error', '未配置 DeepSeek API Key');
    return;
  }
  try {
    // 注入 Agent 系统提示词，提升多步任务规划能力
    const messageHistory = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }].concat(messages.slice());
    for (let loop = 0; loop < 10; loop++) {
      const response = await callDeepSeekAPI(messageHistory);
      const assistantMsg = response.choices[0].message;
      messageHistory.push({
        role: 'assistant',
        content: assistantMsg.content || null,
        tool_calls: assistantMsg.tool_calls || undefined
      });
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (const toolCall of assistantMsg.tool_calls) {
          try {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            // 联网搜索：先通知渲染端将「思考过程」切换为「正在搜索」状态
            if (toolCall.function.name === 'web_search') {
              if (overlayWin && !overlayWin.isDestroyed()) {
                overlayWin.webContents.send('chat-web-search', { query: String(args.query || '') });
              }
            }
            const result = await executeToolCall(toolCall.function.name, args);
            if (overlayWin && !overlayWin.isDestroyed()) {
              overlayWin.webContents.send('chat-tool-result', {
                toolName: toolCall.function.name,
                result: result
              });
              // 搜索完成：通知渲染端把「正在搜索」恢复为「思考过程」并在标题前加「已搜索网页」标签
              if (toolCall.function.name === 'web_search') {
                overlayWin.webContents.send('chat-web-search-done');
              }
            }
            messageHistory.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result)
            });
          } catch (err) {
            messageHistory.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: err.message })
            });
          }
        }
      } else {
        return;
      }
    }
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('chat-error', '工具调用循环超限');
    }
  } catch (err) {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('chat-error', err.message);
    }
  }
});

ipcMain.on('deepseek-abort', () => {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
});

// 文件操作
ipcMain.handle('open-file-dialog', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(overlayWin, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文件', extensions: ['txt','pdf','docx','xlsx','xls','csv','md','json','js','py','html','css','ts','c','cpp','java','go','rs','sql','yaml','yml','xml','log'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths.length === 1 ? result.filePaths[0] : result.filePaths;
});

ipcMain.handle('parse-file', async (event, filePath) => {
  try {
    const result = await parseFile(filePath);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 读取图片为 data URL（base64 内联）：DeepSeek Vision 接受 data:image/...;base64,... 形式
// 文档说明单张图片最大 32 MiB，超限提前拒绝，避免 API 返回 400
const VISION_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const VISION_MIME_MAP = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
ipcMain.handle('read-image-data-url', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: '文件不存在' };
    const ext = path.extname(filePath).toLowerCase();
    const mime = VISION_MIME_MAP[ext];
    if (!mime) return { success: false, error: `不支持的图片格式: ${ext || '无扩展名'}（仅支持 jpg/jpeg/png/gif/webp）` };
    const stats = fs.statSync(filePath);
    if (stats.size > VISION_MAX_IMAGE_BYTES) {
      return { success: false, error: `图片过大 (${(stats.size / 1024 / 1024).toFixed(1)} MB)，单张上限 32 MB` };
    }
    const buffer = fs.readFileSync(filePath);
    const b64 = buffer.toString('base64');
    return { success: true, dataUrl: `data:${mime};base64,${b64}`, mime, size: stats.size };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-file', async (event, content, defaultName) => {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  const result = await dialog.showSaveDialog(overlayWin, {
    title: '保存文件',
    defaultPath: defaultName || 'output.txt',
    properties: ['createDirectory', 'showOverwriteConfirmation']
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return { filePath: result.filePath, fileName: path.basename(result.filePath) };
});

// ========== 文件查看（读取指定文件夹 / 根目录 files 文件夹） ==========
const FILE_VIEW_EXTS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico',           // 图片
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.flv',                             // 视频
  '.mp3', '.wav', '.flac', '.ogg', '.m4a',                                     // 音频
  '.pdf', '.docx', '.xlsx', '.xls', '.rtf', '.doc',                            // 文档
  '.md', '.txt', '.json', '.js', '.ts', '.html', '.css', '.py', '.java',      // 文本/代码
  '.c', '.cpp', '.go', '.rs', '.sql', '.yaml', '.yml', '.xml', '.log', '.csv'
];
const FILES_DIR_NAME = 'files';
// 记录通过"上传"功能传入的文件名清单（区分手动放入 files 目录的文件）
const UPLOADED_LIST_FILE = 'uploaded-files.json';
function loadUploadedFiles() {
  try {
    const p = path.join(dataDir, UPLOADED_LIST_FILE);
    if (!fs.existsSync(p)) return new Set();
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return new Set(Array.isArray(arr) ? arr.filter(n => typeof n === 'string') : []);
  } catch (e) { return new Set(); }
}
function saveUploadedFiles(set) {
  try { fs.writeFileSync(path.join(dataDir, UPLOADED_LIST_FILE), JSON.stringify([...set], null, 2), 'utf-8'); } catch (e) { logToFile('WARN', '写入上传清单失败', e.message); }
}

function ensureFilesDir() {
  const dir = path.join(dataDir, FILES_DIR_NAME);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) { logToFile('WARN', '创建 files 目录失败', e.message); }
  return dir;
}
function loadFileViewDirs() {
  try {
    const raw = loadAppConfig(app).raw || {};
    const dirs = Array.isArray(raw.fileViewDirs) ? raw.fileViewDirs : [];
    return [...new Set(dirs.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim().replace(/[\\/]+$/, '')))];
  } catch (e) { return []; }
}
// 扫描时跳过与文件查看无关的大目录（避免把 node_modules 等数千文件扫进来卡顿）
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'dist-v2', 'build', 'out',
  '.cache', '__pycache__', '.vscode', '.idea', '.github', 'vendor', 'target'
]);
function scanDirRecursive(dir, rootLabel, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      scanDirRecursive(full, rootLabel, out);
    } else if (entry.isFile()) {
      if (entry.name === UPLOADED_LIST_FILE) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!FILE_VIEW_EXTS.includes(ext)) continue;
      try {
        const stats = fs.statSync(full);
        out.push({
          path: full,
          name: entry.name,
          root: rootLabel,
          rel: path.relative(rootLabel, full).split(path.sep).join('/'),
          ext: ext.slice(1),
          size: stats.size,
          mtime: stats.mtimeMs
        });
      } catch (e) { /* 跳过无法读取的文件 */ }
    }
  }
}

ipcMain.handle('get-file-view-config', async () => {
  return { filesDir: ensureFilesDir(), dirs: loadFileViewDirs() };
});
ipcMain.handle('pick-file-view-dirs', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return [];
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '选择要查看的文件夹（可多选）',
    properties: ['openDirectory', 'multiSelections']
  });
  if (result.canceled || result.filePaths.length === 0) return loadFileViewDirs();
  const dirs = [...new Set([...loadFileViewDirs(), ...result.filePaths])];
  try { saveConfigPatch(app, { fileViewDirs: dirs }); } catch (e) {}
  return dirs;
});
ipcMain.handle('remove-file-view-dir', async (event, dir) => {
  const dirs = loadFileViewDirs().filter(d => d !== dir);
  try { saveConfigPatch(app, { fileViewDirs: dirs }); } catch (e) {}
  return dirs;
});
ipcMain.handle('scan-file-view', async () => {
  const filesDir = ensureFilesDir();
  const roots = [{ dir: filesDir, label: 'files' }];
  for (const d of loadFileViewDirs()) {
    if (d !== filesDir) roots.push({ dir: d, label: path.basename(d) });
  }
  const files = [];
  for (const root of roots) scanDirRecursive(root.dir, root.label, files);
  const uploaded = loadUploadedFiles();
  for (const f of files) f.uploaded = uploaded.has(f.name);
  files.sort((a, b) => (a.root === b.root ? (a.rel < b.rel ? -1 : 1) : (a.root < b.root ? -1 : 1)));
  return { files, filesDir };
});
ipcMain.handle('read-file-text', async (event, filePath) => {
  try {
    const result = await parseFile(filePath);
    return { success: true, text: result.text || '', fileName: result.fileName, size: result.size };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('open-files-dir', async () => {
  shell.openPath(ensureFilesDir());
  return true;
});
// 导出选中的文件：复制到用户选择的目录（重名自动加序号）
ipcMain.handle('export-selected-files', async (event, filePaths) => {
  if (!overlayWin || overlayWin.isDestroyed()) return { canceled: true };
  if (!Array.isArray(filePaths) || !filePaths.length) return { canceled: true };
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '选择导出目标文件夹',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const dir = result.filePaths[0];
  let count = 0;
  for (const src of filePaths) {
    try {
      const parsed = path.parse(path.basename(src));
      let dest = path.join(dir, parsed.base);
      let i = 1;
      while (fs.existsSync(dest)) dest = path.join(dir, `${parsed.name}_${i++}${parsed.ext}`);
      fs.copyFileSync(src, dest);
      count++;
    } catch (e) { logToFile('WARN', '导出文件失败', e.message); }
  }
  return { canceled: false, count, dirName: path.basename(dir) };
});
// 上传文件到 files 目录（重名自动加序号），供新文件查看页合并旧文件系统的上传功能
ipcMain.handle('import-files-to-files-dir', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return { canceled: true };
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '选择要上传的文件（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文件', extensions: FILE_VIEW_EXTS.map(e => e.replace(/^\./, '')) },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filesDir = ensureFilesDir();
  const imported = [];
  const uploaded = loadUploadedFiles();
  for (const src of result.filePaths) {
    try {
      const parsed = path.parse(path.basename(src));
      let dest = path.join(filesDir, parsed.base);
      let i = 1;
      while (fs.existsSync(dest)) dest = path.join(filesDir, `${parsed.name}_${i++}${parsed.ext}`);
      fs.copyFileSync(src, dest);
      imported.push({ name: path.basename(dest), path: dest, size: fs.statSync(dest).size });
      uploaded.add(path.basename(dest));
    } catch (e) { logToFile('WARN', '上传文件失败', e.message); }
  }
  saveUploadedFiles(uploaded);
  return { canceled: false, files: imported, filesDir };
});
// 将本地已存在的文件复制到 files 目录并标记为"上传"（不弹系统对话框）
ipcMain.handle('import-selected-files', async (event, filePaths) => {
  if (!Array.isArray(filePaths) || !filePaths.length) return { count: 0, files: [] };
  const filesDir = ensureFilesDir();
  const uploaded = loadUploadedFiles();
  let count = 0;
  const imported = [];
  for (const src of filePaths) {
    try {
      const parsed = path.parse(path.basename(src));
      let dest = path.join(filesDir, parsed.base);
      let i = 1;
      while (fs.existsSync(dest)) dest = path.join(filesDir, `${parsed.name}_${i++}${parsed.ext}`);
      fs.copyFileSync(src, dest);
      const finalName = path.basename(dest);
      uploaded.add(finalName);
      imported.push({ name: finalName, path: dest, size: fs.statSync(dest).size });
      count++;
    } catch (e) { logToFile('WARN', '上传本地文件失败', e.message); }
  }
  if (count) saveUploadedFiles(uploaded);
  return { count, files: imported };
});
// 删除上传到文件库的文件（仅限 files 目录内），并从上传清单与附加栏移除
ipcMain.handle('delete-uploaded-file', async (event, filePath) => {
  try {
    const filesDir = ensureFilesDir();
    const resolved = path.resolve(String(filePath || ''));
    const rel = path.relative(filesDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { success: false, error: '只能删除文件库（files 目录）中的文件' };
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    const name = path.basename(resolved);
    const uploaded = loadUploadedFiles();
    uploaded.delete(name);
    saveUploadedFiles(uploaded);
    return { success: true, name };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 选择文件附加到对话（不复制到文件库），返回文件基本信息
ipcMain.handle('pick-files-to-attach', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return { canceled: true };
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '选择要附加到对话的文件（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文件', extensions: FILE_VIEW_EXTS.map(e => e.replace(/^\./, '')) },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const files = [];
  for (const p of result.filePaths) {
    try { files.push({ name: path.basename(p), path: p, size: fs.statSync(p).size }); } catch (e) {}
  }
  return { canceled: false, files };
});

ipcMain.handle('import-user-script-dialog', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '导入用户脚本',
    properties: ['openFile'],
    filters: [
      { name: '用户脚本', extensions: ['js'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    const imported = importUserScript(baseDir, result.filePaths[0]);
    userScripts = loadUserScripts(baseDir, loadAppConfig(app).userScripts, getDisabledUserScriptNames());
    return { success: true, ...imported, count: userScripts.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function getExtensionPage(extension, preferredPage) {
  if (!extension || !extension.success || !extension.id) return null;
  const ui = extension.ui || {};
  const page = preferredPage || ui.managePage || ui.optionPage || ui.popupPage;
  return page ? `chrome-extension://${extension.id}/${page.replace(/^\/+/, '')}` : null;
}

ipcMain.handle('open-extension-ui', async (event, extensionId, preferredPage) => {
  const extension = extensionLoadResults.find(item => item.success && (!extensionId || item.id === extensionId));
  const url = getExtensionPage(extension, preferredPage);
  if (!url) return { success: false, error: '未找到可打开的扩展配置页面' };

  try {
    const owner = overlayWin && !overlayWin.isDestroyed() ? overlayWin : undefined;
    const win = new BrowserWindow({
      width: 1080,
      height: 760,
      parent: owner,
      show: false,
      title: `${extension.name || '扩展'} 配置`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: BROWSER_VIEW_PARTITION
      }
    });
    win.setMenuBarVisibility(false);
    // 跟踪扩展窗口：用户手动关闭或遮罩 cleanupOverlay 时统一从 Set 中释放，避免僵尸窗口
    openExtensionWindows.add(win);
    win.once('closed', () => {
      openExtensionWindows.delete(win);
      try { win.webContents && win.webContents.removeAllListeners && win.webContents.removeAllListeners(); } catch (_) {}
    });
    win.once('ready-to-show', () => win.show());
    await win.loadURL(url);
    if (!win.isVisible()) win.show();
    return { success: true, name: extension.name, url };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-extension-status', async () => ({
  crx: extensionLoadResults.map(item => item.success ? {
    id: item.id,
    name: item.name,
    file: item.file,
    ui: item.ui,
    sourcePath: item.sourcePath,
    disabled: !!item.disabled,
    success: true
  } : item),
  userScripts: userScripts.map(s => ({
    id: s.id,
    name: s.name,
    matches: s.matches,
    path: s.path,
    enabled: s.enabled !== false
  })),
  userStyles: userStyles.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    version: s.version,
    author: s.author,
    enabled: s.enabled,
    fileName: s.fileName,
    varsCount: (s.vars && s.vars.length) || 0,
    matches: s.matches.map(p => typeof p === 'object' ? `regexp:${p.regexp}` : p),
    path: s.path
  }))
}));

// 重新加载扩展（安装 .crx / 解压目录后调用）：已加载的跳过重复加载，新增的直接 loadExtension
async function reloadExtensions() {
  if (!browserViewSession) return { success: false, error: '会话尚未初始化' };
  try {
    extensionLoadResults = await loadCrxExtensions(app, browserViewSession, baseDir, dataDir, logToFile);
    return { success: true, extensions: extensionLoadResults };
  } catch (err) {
    logToFile('ERROR', '重新加载扩展失败', err.message);
    return { success: false, error: err.message };
  }
}

// 像正常浏览器一样安装扩展：选择 .crx 文件
ipcMain.handle('install-extension-dialog', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '安装 CRX 扩展',
    properties: ['openFile'],
    filters: [
      { name: 'Chrome 扩展 (.crx)', extensions: ['crx'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    const installed = installExtensionFile(dataDir, result.filePaths[0]);
    const reload = await reloadExtensions();
    return { success: true, ...installed, reloaded: reload.success, extensions: reload.extensions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 像正常浏览器一样安装扩展：选择解压扩展文件夹（含 manifest.json）
ipcMain.handle('install-extension-dir-dialog', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '安装解压扩展文件夹',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    const installed = installExtensionDir(dataDir, result.filePaths[0]);
    const reload = await reloadExtensions();
    return { success: true, ...installed, reloaded: reload.success, extensions: reload.extensions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 导入用户样式（.user.css，Stylus 风格），复制到用户数据目录 userstyles/
ipcMain.handle('import-user-style-dialog', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '导入用户样式',
    properties: ['openFile'],
    filters: [
      { name: '用户样式', extensions: ['css'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    const imported = importUserStyle(dataDir, result.filePaths[0]);
    userStyles = loadUserStyles(dataDir);
    return { success: true, ...imported, count: userStyles.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reload-extensions', async () => reloadExtensions());

// ========== 扩展 / 用户脚本 启用·禁用 ==========
// 切换扩展启用状态：禁用时先从会话卸载（若已加载），再写禁用标记并重载；启用时清除标记并重载
ipcMain.handle('toggle-extension', async (_evt, sourcePath, enabled) => {
  try {
    if (!sourcePath) return { success: false, error: '缺少扩展标识' };
    if (typeof enabled !== 'boolean') return { success: false, error: `非法的启用状态参数: ${enabled}` };
    const settings = loadExtensionSettings(dataDir);
    if (!settings.disabled) settings.disabled = {};
    if (enabled) {
      // 一个扩展来源可能以多种键形式存在（绝对路径 / base: / data:），
      // 旧版本数据里可能残留绝对路径键，仅按 sourcePath 删除会漏掉，导致「禁用后无法启用」。
      // 这里一次性清除所有等价键。
      for (const k of equivalentKeys(sourcePath, baseDir, dataDir)) {
        delete settings.disabled[k];
      }
    } else {
      // 若该扩展当前已加载，先从会话中卸载
      const item = extensionLoadResults.find(r => r.success && r.sourcePath === sourcePath && !r.disabled && r.id);
      if (item && item.id && browserViewSession) {
        try { browserViewSession.removeExtension(item.id); } catch (e) { /* 可能已卸载 */ }
      }
      settings.disabled[sourcePath] = true;
    }
    saveExtensionSettings(dataDir, settings);
    const reload = await reloadExtensions();
    return { success: reload.success, extensions: reload.extensions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 切换用户脚本启用状态：禁用后不再注入该脚本
ipcMain.handle('toggle-user-script', async (_evt, scriptId, enabled) => {
  try {
    if (!scriptId) return { success: false, error: '缺少脚本标识' };
    if (typeof enabled !== 'boolean') return { success: false, error: `非法的启用状态参数: ${enabled}` };
    const settings = loadExtensionSettings(dataDir);
    if (!settings.disabledScripts) settings.disabledScripts = {};
    if (enabled) {
      delete settings.disabledScripts[scriptId];
    } else {
      settings.disabledScripts[scriptId] = true;
    }
    saveExtensionSettings(dataDir, settings);
    userScripts = loadUserScripts(baseDir, loadAppConfig(app).userScripts, getDisabledUserScriptNames());
    return { success: true, count: userScripts.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ========== 用户样式元数据 / 变量配置 / 启停 / 删除 / 重载 ==========
ipcMain.handle('list-user-styles-meta', async () => {
  try {
    return { success: true, styles: listUserStylesMeta(dataDir) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-user-style-detail', async (_evt, styleId) => {
  try {
    const all = loadUserStyles(dataDir);
    const s = all.find(x => x.id === styleId);
    if (!s) return { success: false, error: '未找到该用户样式' };
    return {
      success: true,
      style: {
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        author: s.author,
        enabled: s.enabled,
        fileName: s.fileName,
        vars: s.vars,
        varValues: s.varValues,
        matches: s.matches.map(p => typeof p === 'object' ? `regexp:${p.regexp}` : p)
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-user-style-overrides', async (_evt, styleId, patch) => {
  try {
    saveUserStyleVarOverrides(dataDir, styleId, patch || {});
    // 重新加载内存中 userStyles，保持最新覆盖值 / enabled
    userStyles = loadUserStyles(dataDir);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('toggle-user-style', async (_evt, styleId, enabled) => {
  try {
    if (typeof enabled !== 'boolean') return { success: false, error: `非法的启用状态参数: ${enabled}` };
    toggleUserStyle(dataDir, styleId, enabled);
    userStyles = loadUserStyles(dataDir);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-user-style', async (_evt, styleId) => {
  try {
    deleteUserStyle(dataDir, styleId);
    userStyles = loadUserStyles(dataDir);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reload-user-styles', async () => {
  try {
    userStyles = loadUserStyles(dataDir);
    return { success: true, count: userStyles.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 编译预览：给定 styleId + 可选覆盖值，返回处理后的 CSS（供 UI 预览/调试）
ipcMain.handle('preview-user-style-css', async (_evt, styleId, overrideValues) => {
  try {
    const all = loadUserStyles(dataDir);
    const s = all.find(x => x.id === styleId);
    if (!s) return { success: false, error: '未找到该用户样式' };
    const patch = overrideValues && typeof overrideValues === 'object' ? overrideValues : null;
    // 临时合并覆盖值（不写盘），构造一次带 override 的 settings 快照
    let css;
    if (patch) {
      const tmp = {};
      tmp[styleId] = { enabled: true, values: { ...(s.varValues || {}), ...patch } };
      css = compileUserStyle({ ...s, id: styleId }, tmp);
    } else {
      css = compileUserStyle(s, {});
    }
    return { success: true, css };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// To-Do
const todoDir = path.join(dataDir, 'todos');
ipcMain.handle('load-todos', async (event, dateStr) => {
  const filePath = path.join(todoDir, `${dateStr}.json`);
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return []; }
});
ipcMain.handle('save-todos', async (event, dateStr, todos) => {
  if (!fs.existsSync(todoDir)) fs.mkdirSync(todoDir, { recursive: true });
  fs.writeFileSync(path.join(todoDir, `${dateStr}.json`), JSON.stringify(todos, null, 2));
  return true;
});

// ===== 番茄钟 / 专注统计 / 设置 / 格言 IPC =====
ipcMain.handle('get-pomodoro-state', async () => getPomodoroStateObj());
ipcMain.handle('get-focus-stats', async () => ({ stats: getFocusStatsData(), todayFocusSeconds: getTodayFocusSeconds() }));
ipcMain.handle('pomodoro-start', async () => { startPomodoro(); return getPomodoroStateObj(); });
ipcMain.handle('pomodoro-pause', async () => { pausePomodoro(); return getPomodoroStateObj(); });
ipcMain.handle('pomodoro-reset', async () => { resetPomodoro(); return getPomodoroStateObj(); });
ipcMain.handle('get-quotes', async () => {
  try {
    const file = path.join(dataDir, 'quotes.json');
    if (fs.existsSync(file)) {
      const q = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(q) && q.length) {
        return q.filter(s => typeof s === 'string' && s.trim());
      }
    }
  } catch (e) { logToFile('WARN', '读取格言文件失败', e.message); }
  return null;
});
// 声音资源：type → { audio, cover } 文件 URL
const SOUND_MAP = {
  rain:  { audio: 'Rain.ogg',              cover: 'DM_20260812161141_001.webp' },
  fire:  { audio: 'MC-Campfire.ogg',       cover: 'mc-campfire.jpg' },
  waves: { audio: 'wave.ogg',              cover: 'wave.webp' },
  white: { audio: 'bell.ogg',              cover: 'bell.webp' }
};
// 自定义环境音：用户通过设置面板添加的音频文件（路径引用，不复制）
const CUSTOM_SOUNDS_FILE = path.join(dataDir, 'custom-sounds.json');
function loadCustomSounds() {
  try {
    if (fs.existsSync(CUSTOM_SOUNDS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(CUSTOM_SOUNDS_FILE, 'utf-8'));
      if (Array.isArray(arr)) {
        return arr.filter(c => c && typeof c.id === 'string' && c.id && typeof c.path === 'string' && c.path);
      }
    }
  } catch (e) { logToFile('WARN', '读取自定义音源失败', e.message); }
  return [];
}
function saveCustomSounds(list) {
  try { fs.writeFileSync(CUSTOM_SOUNDS_FILE, JSON.stringify(list, null, 2), 'utf-8'); }
  catch (e) { logToFile('WARN', '保存自定义音源失败', e.message); }
}
// 是否为自定义音源类型（custom_<id>）
function isCustomSoundType(type) {
  return typeof type === 'string' && type.startsWith('custom_');
}
// 环境音背景图：type → 背景图路径（覆盖内置默认封面；key 含 custom_<id>）
const AMBIENT_COVERS_FILE = path.join(dataDir, 'ambient-covers.json');
function loadAmbientCovers() {
  try {
    if (fs.existsSync(AMBIENT_COVERS_FILE)) {
      const obj = JSON.parse(fs.readFileSync(AMBIENT_COVERS_FILE, 'utf-8'));
      if (obj && typeof obj === 'object') {
        const out = {};
        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === 'string' && obj[k]) out[k] = obj[k];
        }
        return out;
      }
    }
  } catch (e) { logToFile('WARN', '读取环境音背景图失败', e.message); }
  return {};
}
function saveAmbientCovers(covers) {
  try { fs.writeFileSync(AMBIENT_COVERS_FILE, JSON.stringify(covers, null, 2), 'utf-8'); }
  catch (e) { logToFile('WARN', '保存环境音背景图失败', e.message); }
}
// 选择并设置某环境音的背景图
ipcMain.handle('set-sound-cover', async (event, type) => {
  const valid = AMBIENT_TYPES.includes(type) || isCustomSoundType(type);
  if (!valid) return { success: false, error: '音效类型无效' };
  if (!overlayWin || overlayWin.isDestroyed()) return { success: false, error: '遮罩不可用' };
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '选择背景图',
    filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };
  const covers = loadAmbientCovers();
  covers[type] = result.filePaths[0];
  saveAmbientCovers(covers);
  logToFile('INFO', '环境音背景图已设置', { type });
  return { success: true, covers };
});
// 清除某环境音的背景图
ipcMain.handle('clear-sound-cover', async (event, type) => {
  const valid = AMBIENT_TYPES.includes(type) || isCustomSoundType(type);
  if (!valid) return { success: false, error: '音效类型无效' };
  const covers = loadAmbientCovers();
  delete covers[type];
  saveAmbientCovers(covers);
  return { success: true, covers };
});
// 读取全部环境音背景图
ipcMain.handle('get-sound-covers', async () => loadAmbientCovers());

ipcMain.handle('get-custom-sounds', async () => loadCustomSounds());
ipcMain.handle('add-custom-sounds', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return loadCustomSounds();
  const result = await dialog.showOpenDialog(overlayWin, {
    title: '选择自定义环境音音频（可多选）',
    filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'webm'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || result.filePaths.length === 0) return loadCustomSounds();
  const list = loadCustomSounds();
  const existing = new Set(list.map(c => c.path.toLowerCase()));
  for (const p of result.filePaths) {
    if (existing.has(p.toLowerCase())) continue;
    existing.add(p.toLowerCase());
    list.push({
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: path.basename(p, path.extname(p)) || path.basename(p),
      path: p
    });
  }
  saveCustomSounds(list);
  logToFile('INFO', '已添加自定义音源', { added: list.map(c => c.name) });
  return list;
});
ipcMain.handle('remove-custom-sound', async (event, id) => {
  const list = loadCustomSounds().filter(c => c.id !== id);
  saveCustomSounds(list);
  // 清除环境音时同步删除其背景图配置，避免残留
  const covers = loadAmbientCovers();
  if (delete covers['custom_' + id]) saveAmbientCovers(covers);
  return list;
});
ipcMain.handle('get-sound-assets', async () => {
  const { pathToFileURL } = require('url');
  const soundsDir = path.join(baseDir, 'Sounds');
  const covers = loadAmbientCovers();
  const result = {};
  for (const [type, m] of Object.entries(SOUND_MAP)) {
    const audioPath = path.join(soundsDir, m.audio);
    const coverPath = path.join(soundsDir, m.cover);
    if (!fs.existsSync(audioPath)) continue;
    // 用户自定义背景图优先，其次内置默认封面
    const customCover = covers[type];
    result[type] = {
      audio: pathToFileURL(audioPath).href,
      cover: customCover && fs.existsSync(customCover)
        ? pathToFileURL(customCover).href
        : (fs.existsSync(coverPath) ? pathToFileURL(coverPath).href : null)
    };
  }
  // 合并用户自定义音源（key = custom_<id>）
  for (const cs of loadCustomSounds()) {
    if (cs.path && fs.existsSync(cs.path)) {
      const customCover = covers['custom_' + cs.id];
      result['custom_' + cs.id] = {
        audio: pathToFileURL(cs.path).href,
        cover: customCover && fs.existsSync(customCover) ? pathToFileURL(customCover).href : null,
        custom: true
      };
    }
  }
  return result;
});
// 渲染进程同步环境音状态到主进程（供 AI 工具 get_ambient_state 使用）
ipcMain.handle('sync-ambient-state', async (event, state) => {
  if (state && typeof state === 'object') {
    if (state.sounds && typeof state.sounds === 'object') {
      const sounds = {};
      for (const t of Object.keys(state.sounds)) {
        if (!AMBIENT_TYPES.includes(t) && !isCustomSoundType(t)) continue;
        const vol = Number(state.sounds[t]);
        if (!isNaN(vol) && vol > 0) sounds[t] = Math.max(0, Math.min(100, Math.round(vol)));
      }
      ambientState.sounds = sounds;
    }
    if (typeof state.masterVolume === 'number') {
      ambientState.masterVolume = Math.max(0, Math.min(100, Math.round(state.masterVolume)));
    }
  }
  return true;
});
ipcMain.handle('set-overlay-material', async (event, material) => {
  if (!overlayWin || overlayWin.isDestroyed()) return false;
  try {
    if (material === 'opaque') {
      overlayWin.disableDWM(); // 有封面背景时：关闭毛玻璃（CSS 以近不透明背景呈现封面）
    } else {
      overlayWin.setCustomEffect(4, '#0B0E17', 0.18); // 无背景时：Aero Acrylic 毛玻璃
      overlayWin.setDarkTheme();
    }
    return true;
  } catch (e) { logToFile('WARN', '切换遮罩材质失败', e.message); return false; }
});
ipcMain.handle('get-focus-settings', async () => ({ ...focusSettings, ...(pendingMinSettings || {}), dailyTaskRatio: pendingTaskRatio != null ? pendingTaskRatio : (focusSettings.dailyTaskRatio ?? 0.6) }));

// ========== 每日任务 ==========
function getTodayStr() { return new Date().toISOString().slice(0, 10); }

// 构建当前 dailyTasks 的 name→id 映射，用于完成状态回退匹配与 id 变更后迁移
function buildDailyTaskByName() {
  const m = new Map();
  for (const t of dailyTasks) if (t && t.name) m.set(t.name.trim().toLowerCase(), t.id);
  return m;
}

// 完成状态迁移：把旧版 focus-settings.json 里基于 daily_1/2/3 的完成状态，迁移到新版基于 name 哈希的稳定 id
// 兼容两类遗留数据：1) 纯 daily_N 序号 id（v1.0.0 默认 normalize）；2) 基于 name 的哈希 id 中任务名没变的（无需动）
function migrateDailyTaskState(state) {
  if (!state || typeof state !== 'object') return null;
  const curIds = new Set(dailyTasks.map(t => t.id));
  const byName = buildDailyTaskByName(); // nameKey→currentId
  const newState = { ...state };
  let changed = false;

  // 1) 收集所有「待迁移 key」：非当前 id 且值为布尔（完成状态）；或 daily_N 形式
  const toDelete = [];
  const pending = []; // [oldKey, value]
  for (const k of Object.keys(newState)) {
    if (curIds.has(k)) continue; // 已是当前任务 id，保留不动
    const v = newState[k];
    if (typeof v !== 'boolean') { toDelete.push(k); continue; } // 无效值类型：排除
    // 若 key 本身就是 nameKey（未来格式或外部写入），直接迁移
    if (byName.has(k)) { pending.push([k, v]); continue; }
    // 旧版 daily_N：按 name 顺序位置找匹配（如果 dailyTasks[i-1] 存在且无其他来源完成状态时迁移）
    const m = /^daily_(\d+)$/.exec(k);
    if (m) {
      const idx = Number(m[1]) - 1; // daily_1 → idx 0
      if (idx >= 0 && idx < dailyTasks.length) {
        pending.push([k, v, { indexHint: idx }]);
      } else {
        toDelete.push(k);
      }
      continue;
    }
    // 其他未知 key：删除（可能是用户彻底删除该任务后残留的旧哈希 id）
    toDelete.push(k);
  }

  // 2) 应用 pending：优先按 name 精确匹配；否则用顺序位置
  const assigned = new Set(); // 已分配完成状态的新 id，不被重复覆盖
  // 按 nameKey 精确的先走（无 indexHint 形式 + byName.has(k) 的这些）
  for (const [oldKey, val, hint] of pending) {
    if (hint && hint.indexHint !== undefined) continue; // 顺序位匹配的放最后
    const nameKey = oldKey;
    const newId = byName.get(nameKey);
    if (newId && !assigned.has(newId) && !newState[newId]) {
      newState[newId] = val;
      assigned.add(newId);
      toDelete.push(oldKey);
      changed = true;
    } else if (newId && newState[newId] !== undefined) {
      toDelete.push(oldKey); // 已在当前 id 有状态，旧条目只是冗余
      changed = true;
    }
  }
  // 顺序位匹配（旧 daily_N → 当前 dailyTasks[N-1].id）
  for (const [oldKey, val, hint] of pending) {
    if (!hint || hint.indexHint === undefined) continue;
    const t = dailyTasks[hint.indexHint];
    if (!t) { toDelete.push(oldKey); changed = true; continue; }
    if (assigned.has(t.id) || newState[t.id]) {
      toDelete.push(oldKey);
      changed = true;
      continue;
    }
    newState[t.id] = val;
    assigned.add(t.id);
    toDelete.push(oldKey);
    changed = true;
  }

  // 3) 清理
  for (const k of toDelete) {
    if (k in newState) { delete newState[k]; changed = true; }
  }
  return changed ? newState : null;
}

// 取当前每日任务完成状态（按今日日期重置 + 变更时做 id 迁移 + 持久化）
function getDailyTaskState() {
  const today = getTodayStr();
  let needSave = false;
  if (!focusSettings.dailyTaskDate || focusSettings.dailyTaskDate !== today) {
    focusSettings.dailyTaskDate = today;
    focusSettings.dailyTaskCompleted = {};
    needSave = true;
  }
  if (!focusSettings.dailyTaskCompleted || typeof focusSettings.dailyTaskCompleted !== 'object') {
    focusSettings.dailyTaskCompleted = {};
    needSave = true;
  }
  // id 变更迁移：每日第一次加载或 save-config-from-edit 重载 dailyTasks 后执行
  const migrated = migrateDailyTaskState(focusSettings.dailyTaskCompleted);
  if (migrated) {
    focusSettings.dailyTaskCompleted = migrated;
    needSave = true;
  }
  if (needSave) saveFocusSettingsToFile({ ...focusSettings });
  return focusSettings.dailyTaskCompleted;
}

function getDailyTaskProgress() {
  const threshold = focusSettings.dailyTaskRatio || 0.6; // 自定义任务完成比例（锁屏时段结束后是否保持锁定的判定阈值）
  if (!dailyTasks.length) return { total: 0, completed: 0, ratio: 1, threshold, met: true };
  const state = getDailyTaskState();
  const completed = dailyTasks.filter(t => !!state[t.id]).length;
  const ratio = completed / dailyTasks.length;
  return { total: dailyTasks.length, completed, ratio, threshold, met: ratio >= threshold };
}

// 返回 { id, name, minutes, completed } 并合并完成率，供 UI 展示
function dailyTasksSnapshot() {
  const state = getDailyTaskState();
  return { tasks: dailyTasks.map(t => ({ ...t, completed: !!state[t.id] })), ...getDailyTaskProgress() };
}

ipcMain.handle('get-daily-tasks', async () => dailyTasksSnapshot());

ipcMain.handle('toggle-daily-task', async (event, taskId) => {
  const state = getDailyTaskState();
  state[taskId] = !state[taskId];
  saveFocusSettingsToFile({ ...focusSettings });
  const snap = dailyTasksSnapshot();
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('daily-task-updated', snap);
    // 锁屏时段已结束：实时推送阻塞/解除状态，让常驻提示立即更新
    if (!isInLockTime()) {
      if (!snap.met) {
        overlayWin.webContents.send('daily-task-blocking', {
          completed: snap.completed, total: snap.total,
          need: Math.ceil(snap.total * snap.threshold)
        });
      } else {
        overlayWin.webContents.send('daily-task-unblocked', {});
      }
    }
  }
  return { success: true, total: snap.total, completed: snap.completed, ratio: snap.ratio, threshold: snap.threshold, met: snap.met };
});

// 明确设置某每日任务完成状态（completed=true 表示标记完成，false 表示取消完成）
// 与 toggle-daily-task 区别：toggle 是切换，重复调用会反复反转；set 是幂等设值，用于「倒计时结束点确定 → 标记完成」等需要明确语义的场景
ipcMain.handle('set-daily-task', async (event, taskId, completed) => {
  if (!taskId) return { success: false, error: '缺少 taskId' };
  const state = getDailyTaskState();
  state[taskId] = !!completed;
  saveFocusSettingsToFile({ ...focusSettings });
  const snap = dailyTasksSnapshot();
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('daily-task-updated', snap);
    // 锁屏时段已结束：实时推送阻塞/解除状态，让常驻提示立即更新
    if (!isInLockTime()) {
      if (!snap.met) {
        overlayWin.webContents.send('daily-task-blocking', {
          completed: snap.completed, total: snap.total,
          need: Math.ceil(snap.total * snap.threshold)
        });
      } else {
        overlayWin.webContents.send('daily-task-unblocked', {});
      }
    }
  }
  return { success: true, total: snap.total, completed: snap.completed, ratio: snap.ratio, threshold: snap.threshold, met: snap.met };
});
ipcMain.handle('get-focus-report', async (event, days) => getFocusReportData(Math.max(7, Math.min(31, Number(days) || 14))));
ipcMain.handle('get-site-stats', async () => {
  // 若未加载（如非锁屏期间查询），确保 siteUsage 已初始化
  if (!siteUsageDate) loadSiteUsage();
  return getSiteStatsData();
});
ipcMain.handle('save-focus-settings', async (event, settings) => {
  if (settings && typeof settings === 'object') {
    const validated = {
      minLockMinutes: Math.max(0, Number(settings.minLockMinutes) || 0),
      verifyCodeEnabled: settings.verifyCodeEnabled !== false,
      focusLen: Math.max(1, Math.min(120, Number(settings.focusLen) || 25)),
      breakLen: Math.max(1, Math.min(60, Number(settings.breakLen) || 5)),
      siteLockMinMinutes: Math.max(0, Math.min(480, Number(settings.siteLockMinMinutes) || 0)),
      timerSyncPomodoro: settings.timerSyncPomodoro !== false,
      instantMode: !!settings.instantMode && instantModeEnabled,
      shortcuts: focusSettings.shortcuts || { ...DEFAULT_SHORTCUTS }, // 保留快捷键配置不被覆盖
      dailyTaskDate: focusSettings.dailyTaskDate || '',
      dailyTaskCompleted: (focusSettings.dailyTaskCompleted && typeof focusSettings.dailyTaskCompleted === 'object') ? focusSettings.dailyTaskCompleted : {},
      dailyTaskRatio: Math.max(0.1, Math.min(1, Number(settings.dailyTaskRatio) || 0.6))
    };
    // 两个最短时长选项 + 自定义任务完成比例：保存后不立即生效，等下次出现遮罩时才应用；其余立即生效
    pendingMinSettings = {
      minLockMinutes: validated.minLockMinutes,
      siteLockMinMinutes: validated.siteLockMinMinutes
    };
    pendingTaskRatio = validated.dailyTaskRatio;
    focusSettings = {
      ...validated,
      minLockMinutes: focusSettings.minLockMinutes,
      siteLockMinMinutes: focusSettings.siteLockMinMinutes,
      dailyTaskRatio: focusSettings.dailyTaskRatio ?? 0.6
    };
    instantMode = focusSettings.instantMode && instantModeEnabled; // 同步全局即时模式状态，保存后立即生效；被禁用时强制关闭
    saveFocusSettingsToFile(validated); // 文件持久化新值，重启后同样下次遮罩生效
  }
  return { ...focusSettings, ...(pendingMinSettings || {}), dailyTaskRatio: pendingTaskRatio != null ? pendingTaskRatio : (focusSettings.dailyTaskRatio ?? 0.6) };
});
// ========== 快捷键自定义 ==========
ipcMain.handle('get-shortcuts', async () => ({ ...focusSettings.shortcuts || {} }));
// 快捷键捕获期间临时取消全局快捷键注册，避免按下当前快捷键仍触发功能
ipcMain.on('set-shortcut-capturing', (event, capturing) => {
  if (capturing) {
    unregisterOverlayShortcuts();
  } else {
    registerOverlayShortcuts();
  }
});
ipcMain.handle('save-shortcuts', async (event, shortcuts) => {
  if (!shortcuts || typeof shortcuts !== 'object') return { success: false, error: '参数无效' };
  const merged = { ...DEFAULT_SHORTCUTS };
  for (const [action, acc] of Object.entries(shortcuts)) {
    if (SHORTCUT_ACTIONS[action] && typeof acc === 'string' && acc.trim()) {
      merged[action] = acc.trim();
    }
  }
  focusSettings.shortcuts = merged;
  saveFocusSettingsToFile({ ...focusSettings });
  unregisterOverlayShortcuts();
  registerOverlayShortcuts();
  return { success: true, shortcuts: merged };
});
ipcMain.handle('request-emergency-exit', async () => { emergencyExit(); return true; });

// ========== 遮罩内编辑 config.js ==========
ipcMain.handle('get-config-for-edit', async () => {
  try {
    const raw = loadRawConfig(app);
    const cfg = raw.config || {};
    return {
      configPath: raw.configPath || '',
      autoLaunch: cfg.autoLaunch !== false,
      guardEnabled: cfg.guardEnabled !== false,
      instantModeEnabled: cfg.instantModeEnabled === true,
      deepseekApiKey: cfg.deepseekApiKey || '',
      timeRanges: (Array.isArray(cfg.timeRanges) ? cfg.timeRanges : [])
        .map(r => `${r && r.start}-${r && r.end}`),
      sites: (Array.isArray(cfg.sites) ? cfg.sites : []).map(s => ({
        id: s.id || '',
        name: s.name || '',
        url: s.url || '',
        zoom: typeof s.zoom === 'number' ? s.zoom : 1,
        aliases: Array.isArray(s.aliases) ? s.aliases : [],
        pinned: !!s.pinned,
        persistent: s.persistent !== false
      })),
      dailyTasks: normalizeDailyTasks(cfg.dailyTasks).map(t => ({ name: t.name, minutes: t.minutes }))
    };
  } catch (e) {
    logToFile('ERROR', '读取配置失败', e.message);
    return { error: e.message };
  }
});
ipcMain.handle('save-config-from-edit', async (event, data) => {
  try {
    const errors = [];
    // ---- 校验 ----
    const autoLaunch = data && data.autoLaunch !== false;
    const cfgGuardEnabled = !data || data.guardEnabled !== false; // 注意：不得命名为 guardEnabled，否则遮蔽外层 let guardEnabled，下方赋值时触发 TypeError
    const apiKey = (data && data.deepseekApiKey ? String(data.deepseekApiKey) : '').trim();
    // 锁屏时段：HH:MM-HH:MM，多个逗号分隔，end > start
    const timeRanges = [];
    const timeStr = (data && data.timeRanges ? String(data.timeRanges) : '').trim();
    if (timeStr) {
      for (const part of timeStr.split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(seg);
        if (!m) { errors.push(`锁屏时段格式错误：「${seg}」应为 HH:MM-HH:MM`); continue; }
        const s = (+m[1]) * 60 + (+m[2]);
        const e = (+m[3]) * 60 + (+m[4]);
        if (e <= s) { errors.push(`锁屏时段结束必须晚于开始：「${seg}」`); continue; }
        timeRanges.push({ start: seg.slice(0, 5), end: seg.slice(6) });
      }
    }
    // 网站列表：结构化数组（UI 编辑器）或文本行（每行 名称 | 网址 | 缩放 | 固定(是/否) | 别名1,别名2）
    const sites = [];
    const usedSiteIds = new Set();
    const pushSite = (name, url, zoom, aliases, pinned, persistent, idxLabel) => {
      if (!name) { errors.push(`${idxLabel}缺少名称`); return; }
      if (!/^https?:\/\//i.test(url)) { errors.push(`网站「${name}」的网址无效：${url}（需以 http:// 或 https:// 开头）`); return; }
      if (isNaN(zoom) || zoom <= 0 || zoom > 5) { errors.push(`网站「${name}」的缩放无效：${zoom}（应为 0.1~5）`); return; }
      // id 由名称生成，冲突时追加 _2、_3… 保证唯一（唯一 id 是 BrowserView 不叠加的前提）
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'site';
      let base = id, n = 2;
      while (usedSiteIds.has(id)) id = `${base}_${n++}`;
      usedSiteIds.add(id);
      sites.push({ id, name, url, zoom, aliases, pinned, persistent });
    };
    const sitesArr = data && Array.isArray(data.sites) ? data.sites : null;
    if (sitesArr) {
      sitesArr.forEach((s, i) => {
        const name = (s && s.name ? String(s.name) : '').trim();
        const url = (s && s.url ? String(s.url) : '').trim();
        if (!name && !url) return; // 完全空行（新增未填写）直接忽略
        let zoom = s && s.zoom !== undefined && s.zoom !== null ? s.zoom : 1;
        if (typeof zoom !== 'number') zoom = parseFloat(zoom);
        if (isNaN(zoom)) zoom = 1;
        const aliases = Array.isArray(s && s.aliases) ? s.aliases.map(a => String(a).trim()).filter(Boolean) : [];
        const pinned = !!(s && s.pinned);
        const persistent = !(s && s.persistent === false);
        pushSite(name, url, zoom, aliases, pinned, persistent, `网站第 ${i + 1} 项`);
      });
    } else {
      const sitesText = (data && data.sites ? String(data.sites) : '').trim();
      if (sitesText) {
        sitesText.split(/\r?\n/).forEach((line, i) => {
          const row = line.trim();
          if (!row) return;
          const parts = row.split('|').map(p => p.trim());
          if (parts.length < 2) { errors.push(`网站第 ${i + 1} 行格式错误：至少需要「名称 | 网址」`); return; }
          const name = parts[0];
          const url = parts[1];
          const zoom = parts.length > 2 && parts[2] !== '' ? parseFloat(parts[2]) : 1;
          const pinnedRaw = parts.length > 3 ? parts[3] : '';
          const aliases = parts.length > 4 && parts[4] ? parts[4].split(',').map(a => a.trim()).filter(Boolean) : [];
          pushSite(name, url, zoom, aliases, /^(是|true|1|固定)$/i.test(pinnedRaw), true, `网站第 ${i + 1} 行`);
        });
      }
    }
    // 每日任务：每行「任务名 | 预计分钟数」，分钟数可选（默认 0），空行忽略；| 之后仅接受纯数字（分钟）或为空
    const dailyTasksParsed = [];
    const dailyText = (data && data.dailyTasks ? String(data.dailyTasks) : '').trim();
    if (dailyText) {
      dailyText.split(/\r?\n/).forEach((line, i) => {
        const row = line.trim();
        if (!row) return;
        const parts = row.split('|').map(p => p.trim());
        const name = parts[0];
        if (!name) { errors.push(`每日任务第 ${i + 1} 行缺少任务名`); return; }
        let minutes = 0;
        if (parts.length >= 2 && parts[1] !== '') {
          const n = parseInt(parts[1], 10);
          if (isNaN(n) || n < 0 || n > 1440) { errors.push(`每日任务「${name}」的预计分钟数无效：${parts[1]}（需为 0~1440 整数或留空）`); return; }
          minutes = n;
        }
        dailyTasksParsed.push({ name, minutes });
      });
    }
    if (errors.length > 0) return { success: false, errors };
    // ---- 合并现有配置，写回 dataDir/config.json（下次启动生效） ----
    const raw = loadRawConfig(app);
    const merged = { ...(raw.config || {}) };
    merged.autoLaunch = autoLaunch;
    merged.guardEnabled = cfgGuardEnabled;
    if (apiKey) merged.deepseekApiKey = apiKey;
    else delete merged.deepseekApiKey;
    merged.timeRanges = timeRanges;
    merged.sites = sites;
    // 每日任务：写 normalize 后的稳定 id（name 哈希），空数组表示停用每日任务
    merged.dailyTasks = normalizeDailyTasks(dailyTasksParsed).map(t => ({ id: t.id, name: t.name, minutes: t.minutes }));
    delete merged.pinWindows; // 精简：移除窗口置顶配置残留
    guardEnabled = merged.guardEnabled !== false; // 看门狗开关即时生效，无需重启
    const configJsonPath = path.join(raw.dataDir, 'config.json');
    fs.writeFileSync(configJsonPath, JSON.stringify(merged, null, 2), 'utf-8');
    logToFile('INFO', '配置已通过遮罩内设置保存（下次启动生效）', {
      configJsonPath,
      dailyTaskCount: merged.dailyTasks.length
    });
    return { success: true, message: '配置已保存，下次启动生效', path: configJsonPath };
  } catch (e) {
    logToFile('ERROR', '保存配置失败', e.message);
    return { success: false, errors: [e.message] };
  }
});

function flushBrowserViewStorage() {
  try {
    const sess = browserViewSession || session.fromPartition(BROWSER_VIEW_PARTITION);
    if (sess.cookies && typeof sess.cookies.flushStore === 'function') {
      sess.cookies.flushStore().catch(err => logToFile('WARN', 'Cookie 写回失败', err.message));
    }
    if (typeof sess.flushStorageData === 'function') {
      sess.flushStorageData();
    }
  } catch (err) {
    logToFile('WARN', '网页会话写回失败', err.message);
  }
}

// Cookie 变化（登录/登出）后防抖 3 秒立即写回磁盘，避免异常退出导致登录态丢失
let cookieFlushTimer = null;
function scheduleCookieFlush() {
  if (cookieFlushTimer) clearTimeout(cookieFlushTimer);
  cookieFlushTimer = setTimeout(() => {
    cookieFlushTimer = null;
    flushBrowserViewStorage();
  }, 3000);
}

// ========== 启动 ==========
app.whenReady().then(async () => {
  if (isAutoStart) {
    // 开机自启动：延迟初始化，静默待命，避免与开机进程抢资源
    logToFile('INFO', '开机自启动，延迟初始化');
    await new Promise(r => setTimeout(r, AUTO_START_DELAY_MS));
  }
  if (!ensureAdmin()) return;
  loadConfig();
  clearTimerResultFile(); // 次日启动时清除上次锁屏落盘的计时结果
  loadFocusSettings();
  // 锁屏会话保护：若上次锁屏时保存了会话时段，且当前仍在该时段内，
  // 则使用会话时段覆盖 config.js 的 timeRanges，防止用户改配置后重启绕过锁屏
  if (Array.isArray(focusSettings.lockSessionRanges) && focusSettings.lockSessionRanges.length > 0) {
    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();
    const inSession = focusSettings.lockSessionRanges.some(r => curMin >= r.startMin && curMin < r.endMin);
    if (inSession) {
      timeRanges = focusSettings.lockSessionRanges.map(r => ({ start: r.start, end: r.end, startMin: r.startMin, endMin: r.endMin }));
      logToFile('WARN', '检测到活跃锁屏会话时段，覆盖 config.js 的 timeRanges（防止配置篡改绕过锁屏）',
        { sessionRanges: timeRanges.map(r => `${r.start}-${r.end}`) });
    } else {
      // 会话时段已结束：清除残留，让 config.js 的新时段生效
      delete focusSettings.lockSessionRanges;
      saveFocusSettingsToFile({ ...focusSettings });
      logToFile('INFO', '锁屏会话时段已过期，清除并使用 config.js 的新时段');
    }
  }
  initFocusStats();
  browserViewSession = session.fromPartition(BROWSER_VIEW_PARTITION);
  // 限制持久 partition 磁盘 / 内存缓存大小，避免长时间运行后 cache 膨胀到数 GB
  try {
    const SESSION_CACHE_MAX_BYTES = 400 * 1024 * 1024; // 400MB 上限：对 3~5 个前台/常驻网站足够；超出 Chromium 自动 LRU 淘汰
    if (browserViewSession.setUserAgent && typeof browserViewSession.setCacheSize === 'function') {
      browserViewSession.setCacheSize(SESSION_CACHE_MAX_BYTES);
    }
  } catch (err) {
    logToFile('WARN', '设置会话缓存上限失败', err.message);
  }
  // 每 4 小时清理一次代码缓存，避免 V8 code cache 随页面变化无限累积
  setInterval(() => {
    if (!browserViewSession) return;
    try {
      if (typeof browserViewSession.clearStorageData === 'function') {
        browserViewSession.clearStorageData({ storages: [] }).catch(() => {});
      }
    } catch (_) {}
  }, 4 * 3600 * 1000);
  // 登录/登出等 cookie 变化后立即落盘，防止异常退出丢登录态
  try {
    browserViewSession.cookies.on('changed', scheduleCookieFlush);
  } catch (err) {
    logToFile('WARN', '注册 Cookie 写回监听失败', err.message);
  }
  extensionsReady = loadCrxExtensions(app, browserViewSession, baseDir, dataDir, logToFile)
    .then(results => { extensionLoadResults = results; })
    .catch(err => {
      extensionLoadResults = [];
      logToFile('ERROR', '扩展加载流程失败', err.message);
    });
  // 自启动配置在非测试模式下始终应用（含快速模式，避免用户常用快捷方式启动导致配置永不写入）
  // 同时启动看门狗：taskkill /f 强杀后自动拉起；每次启动先清除上次遗留的优雅退出标记
  if (!isTestMode) {
    try { fs.rmSync(GRACE_EXIT_FLAG, { force: true }); } catch (e) {}
    if (guardEnabled) {
      // 被看门狗强杀拉起：进入 20 分钟紧急退出冷却，防止"杀进程重启"绕过锁屏
      try {
        if (fs.existsSync(WATCHDOG_RESTART_FLAG)) {
          emergencyCooldownUntil = Date.now() + 20 * 60 * 1000;
          cooldownPauseTime = Date.now(); // 遮罩创建前暂停冷却，创建后恢复
          logToFile('WARN', '检测到看门狗重启标记，进入 20 分钟紧急退出冷却（遮罩创建前暂停）');
        }
        fs.rmSync(WATCHDOG_RESTART_FLAG, { force: true });
      } catch (e) {}
    }
    applyAutoLaunch();
    startWatchdog();
  }
  // 定期校验看门狗（任务存在性 / 守护进程存活），被反杀后重新拉起
  setInterval(ensureWatchdog, 30000);

  if (isQuickStart) {
    // 快速启动模式：立即锁屏 1 小时，功能与正常模式相同
    extendLockTime(60);
    createOverlay();
    setTimeout(() => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('quick-start-status', true);
    }
    }, 500);
    checkTimer = setInterval(checkTimeAndToggle, 30 * 1000);
  } else if (isTestMode) {
    // 写入测试存活标记：生产实例据此跳过遮罩重建，退出时删除
    try { fs.writeFileSync(testLockFile, String(process.pid), 'utf-8'); } catch (e) {}
    createOverlay();
  } else {
    checkTimer = setInterval(checkTimeAndToggle, 30 * 1000);
    checkTimeAndToggle();
  }
}).catch(err => {
  try { console.error('启动失败:', err && (err.stack || err.message || err)); } catch (e) { }
  logToFile('FATAL', '启动失败', err.stack);
  app.quit();
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  // 测试模式退出：删除存活标记，生产实例下次 checkTimeAndToggle 时恢复调度
  if (isTestMode) {
    try { fs.rmSync(testLockFile, { force: true }); } catch (e) {}
  }
  // 优雅退出标记：写入自身 PID，看门狗据此判断"主动退出"而不再重启
  try { fs.writeFileSync(GRACE_EXIT_FLAG, String(process.pid)); } catch (e) {}
  // 删除看门狗计划任务（task 与 proc 模式都清理，配合优雅退出标记双保险，防止优雅退出后仍被拉起）
  spawn('schtasks', ['/Delete', '/TN', GUARD_TASK_NAME, '/F'], { windowsHide: true, stdio: 'ignore' });
  spawn('schtasks', ['/Delete', '/TN', GUARD_PROC_TASK_NAME, '/F'], { windowsHide: true, stdio: 'ignore' });
  // 关闭所有扩展 UI 窗口（before-quit 阶段若用户手动关遮罩后打开的窗口可能仍存在）
  for (const w of [...openExtensionWindows]) {
    try { if (w && !w.isDestroyed()) w.close(); } catch (_) {}
    openExtensionWindows.delete(w);
  }
  // 统一销毁所有站点视图（常驻也不留，进程即将退出，保证渲染进程被回收，不会把内存"甩给" Chromium 孤儿进程）
  for (const [id] of [...viewsMap]) destroySiteView(id);
  flushBrowserViewStorage();
  // 退出时清理持久 partition 的缓存/代码缓存：不 touch cookie/localStorage/IndexedDB（保留登录态）
  // 只清 file/cache/codecache/serviceworker，这些对 >1G 占用贡献最大
  if (browserViewSession) {
    try {
      browserViewSession.clearCache();
    } catch (_) {}
    try {
      // storages: appcache / cache storage / service workers / indexedDB 不要清（影响登录态/离线功能）
      // 这里只清 code cache，对保留登录态安全
      if (typeof browserViewSession.clearStorageData === 'function') {
        browserViewSession.clearStorageData({
          origin: undefined, // 全部 origin
          quotas: ['temporary', 'persistent'],
          storages: []
        }).catch(() => {});
      }
    } catch (_) {}
  }
  persistFocusStats();
  clearInterval(pomodoro.tickTimer);
  clearInterval(pomodoro.persistTimer);
  clearInterval(killTimer);
  clearInterval(checkTimer);
  if (topTimer) clearInterval(topTimer);
  if (silenceTimer) clearInterval(silenceTimer);
  if (emergencyRestoreTimer) clearTimeout(emergencyRestoreTimer);
  if (unlockAfterTimer) clearTimeout(unlockAfterTimer);
  if (extendTimer) clearInterval(extendTimer);
  if (activeTimer) clearTimeout(activeTimer.timeoutId);
  disableSilence();
  unmuteTargetProcessesSync();
  if (musicPopupWin && !musicPopupWin.isDestroyed()) {
    musicPopupWin.close();
  }
  unregisterOverlayShortcuts();
  if (!app.isPackaged) {
    process.exit(0);
  }
});
