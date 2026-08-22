const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEFAULT_SITES = [
  { id: 'deepseek', url: 'https://chat.deepseek.com', name: 'DeepSeek', zoom: 1.6 },
  { id: 'music', url: 'https://music.163.com', name: '网易云音乐', zoom: 1.0 }
];

function getBaseDir(app) {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..');
}

// 用户可变数据目录（userData）：跨重装/卸载保留，NSIS 不会触碰
function getDataDir(app) {
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyDirRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dst, entry);
    let stat;
    try { stat = fs.statSync(s); } catch (e) { continue; }
    if (stat.isDirectory()) copyDirRecursive(s, d);
    else { try { fs.copyFileSync(s, d); } catch (e) { } }
  }
}

// 一次性迁移：旧版本将可变数据存于安装目录(baseDir)，新版本迁移到 userData(dataDir) 以防重装丢失
function migrateUserData(baseDir, dataDir, app) {
  try {
    // 1) 配置：若 dataDir/config.json 不存在，从 baseDir 的 config.js + config.json 合并生成（保留用户运行时编辑）
    const cfgJsonDst = path.join(dataDir, 'config.json');
    if (!fs.existsSync(cfgJsonDst)) {
      const jsConfig = readJsConfig(path.join(baseDir, 'config.js'), { app, baseDir });
      const baseJson = readJson(path.join(baseDir, 'config.json'));
      const merged = { ...baseJson, ...jsConfig };
      if (Object.keys(merged).length) {
        fs.writeFileSync(cfgJsonDst, JSON.stringify(merged, null, 2), 'utf-8');
      }
    }
    // 2) 其他可变数据文件：baseDir → dataDir（仅当 dataDir 无该文件时）
    const files = ['focus-settings.json', 'focus-stats.json', 'site-stats.json', 'quotes.json', 'custom-sounds.json', 'ambient-covers.json', 'uploaded-files.json'];
    for (const f of files) {
      const s = path.join(baseDir, f);
      const d = path.join(dataDir, f);
      if (fs.existsSync(s) && !fs.existsSync(d)) {
        try { fs.copyFileSync(s, d); } catch (e) { }
      }
    }
    // 3) todos 目录 + files 目录（用户上传的文件库）
    copyDirRecursive(path.join(baseDir, 'todos'), path.join(dataDir, 'todos'));
    copyDirRecursive(path.join(baseDir, 'files'), path.join(dataDir, 'files'));
    // 4) 合并 NSIS customInit 备份的旧 config.js（覆盖安装时新版 config.js 会覆盖安装目录，NSIS 在覆盖前把旧版备份到此处）
    //    策略：legacy 补 config.json 缺失字段，config.json 已有字段优先（cur 是用户后来通过 UI 保存或新版默认，更新更可信）
    const legacyJsPath = path.join(dataDir, 'config.legacy.js');
    if (fs.existsSync(legacyJsPath)) {
      try {
        const legacyConfig = readJsConfig(legacyJsPath, { app, baseDir }) || {};
        const cur = fs.existsSync(cfgJsonDst) ? (readJson(cfgJsonDst) || {}) : {};
        const patched = { ...legacyConfig, ...cur };
        if (Object.keys(patched).length) {
          fs.writeFileSync(cfgJsonDst, JSON.stringify(patched, null, 2), 'utf-8');
        }
        // 合并成功后删除 legacy 备份，避免下次重复合并
        try { fs.unlinkSync(legacyJsPath); } catch (e) { }
      } catch (e) { /* 合并失败保留 legacy，下次启动再试 */ }
    }
  } catch (e) { /* 迁移失败不阻断启动 */ }
}

function parseTime(str) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function normalizeSites(sites) {
  if (!Array.isArray(sites)) return [];
  const usedIds = new Set();
  return sites
    .filter(s => s && s.url)
    .map((s, idx) => {
      // id 必须唯一：viewsMap 以 site.id 为键，重复 id 会让后一个 BrowserView 覆盖前一个（如网易云 id="_" 被电子课本覆盖，导致无法切换）
      let id = s.id || `site_${idx}`;
      if (usedIds.has(id)) {
        let n = 1;
        while (usedIds.has(`${id}_${n}`)) n++;
        id = `${id}_${n}`;
      }
      usedIds.add(id);
      return {
        id,
        url: s.url,
        name: s.name || id || '未命名',
        aliases: Array.isArray(s.aliases) ? s.aliases : [],
        zoom: typeof s.zoom === 'number' ? s.zoom : 1,
        injectCSS: s.injectCSS || null,
        pinned: !!s.pinned
      };
    });
}

function normalizeTimeRanges(ranges) {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .map(r => {
      const start = parseTime(r && r.start);
      const end = parseTime(r && r.end);
      return start !== null && end !== null && end > start ? { startMin: start, endMin: end } : null;
    })
    .filter(Boolean);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readJsConfig(filePath, context) {
  if (!fs.existsSync(filePath)) return {};
  let source = fs.readFileSync(filePath, 'utf-8');
  source = source.replace(/^\s*export\s+default\s+/m, 'module.exports = ');
  const moduleRef = { exports: {} };

  const sandbox = {
    module: moduleRef,
    exports: moduleRef.exports,
    config: undefined,
    __dirname: path.dirname(filePath),
    __filename: filePath,
    require,
    process,
    console,
    app: context.app,
    baseDir: context.baseDir
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: filePath, timeout: 3000 });
  const moduleExports = sandbox.module.exports;
  const exported = (typeof moduleExports === 'function') || (moduleExports && Object.keys(moduleExports).length)
    ? sandbox.module.exports
    : (sandbox.exports.default || sandbox.exports.config || sandbox.config || {});
  const result = typeof exported === 'function' ? exported(context) : exported;
  return result && typeof result === 'object' ? result : {};
}

function loadRawConfig(app) {
  const baseDir = getBaseDir(app);
  const dataDir = getDataDir(app);
  migrateUserData(baseDir, dataDir, app); // 一次性迁移旧版安装目录内的可变数据到 userData
  const jsPath = path.join(baseDir, 'config.js');       // 安装目录内的打包默认配置（只读基线）
  const jsonPath = path.join(dataDir, 'config.json');  // userData 内的用户配置（运行时保存，跨重装保留）
  return {
    baseDir,
    dataDir,
    configPath: fs.existsSync(jsonPath) ? jsonPath : (fs.existsSync(jsPath) ? jsPath : jsonPath),
    config: {
      ...readJsConfig(jsPath, { app, baseDir }),  // 打包默认（底层）
      ...readJson(jsonPath)                        // 用户覆盖（顶层）
    }
  };
}

function loadAppConfig(app) {
  const { baseDir, dataDir, configPath, config } = loadRawConfig(app);
  const sites = normalizeSites(config.sites);
  const timeRanges = normalizeTimeRanges(config.timeRanges);
  return {
    baseDir,
    dataDir,
    configPath,
    raw: config,
    imagePath: config.imagePath || null,
    autoLaunch: Object.prototype.hasOwnProperty.call(config, 'autoLaunch') ? !!config.autoLaunch : true,
    guardMode: config.guardMode || 'task',
    guardEnabled: config.guardEnabled !== false,
    instantModeEnabled: config.instantModeEnabled === true,
    deepseekApiKey: config.deepseekApiKey || null,
    sites: sites.length ? sites : DEFAULT_SITES.map(s => ({ ...s })),
    timeRanges: timeRanges.length ? timeRanges : [{ startMin: 18 * 60, endMin: 20 * 60 + 30 }],
    extensions: config.extensions || {},
    userScripts: config.userScripts || [],
    dailyTasks: normalizeDailyTasks(config.dailyTasks)
  };
}

// 基于任务名生成稳定短 id：用户修改 config.js 中任务顺序/插入新任务时，旧任务 id 不变，避免今日完成状态错位
function dailyTaskIdFromName(name) {
  // djb2 哈希取低 6 位 hex：冲突概率可接受（任务数 ≤ 几十个量级）
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return 'd_' + (h >>> 0).toString(16).slice(0, 6);
}
function normalizeDailyTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  const seen = new Set();
  const result = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] && typeof tasks[i] === 'object' ? tasks[i] : {};
    const name = (t.name || '').toString().trim();
    if (!name) continue;
    let id = (t.id || '').toString().trim();
    const fromName = dailyTaskIdFromName(name);
    // 优先：显式 id（如果未冲突） → 其次：基于 name 的稳定 hash id → 最后：序列号兜底
    if (!id || seen.has(id)) id = seen.has(fromName) ? `daily_${i + 1}` : fromName;
    if (seen.has(id)) id = `daily_${i + 1}_${Date.now().toString(36)}`; // 极端冲突兜底
    seen.add(id);
    const minutes = Math.max(0, Math.round(Number(t.minutes) || 0));
    result.push({ id, name, minutes });
  }
  return result;
}

function saveConfigPatch(app, patch) {
  const filePath = path.join(getDataDir(app), 'config.json');
  const config = readJson(filePath);
  fs.writeFileSync(filePath, JSON.stringify({ ...config, ...patch }, null, 2), 'utf-8');
}

module.exports = {
  getBaseDir,
  getDataDir,
  loadAppConfig,
  saveConfigPatch,
  loadRawConfig,
  normalizeDailyTasks,
  dailyTaskIdFromName,
  readJsConfig,
  readJson
};
