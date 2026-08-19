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
  const jsonPath = path.join(baseDir, 'config.json');
  const jsPath = path.join(baseDir, 'config.js');
  return {
    baseDir,
    configPath: fs.existsSync(jsPath) ? jsPath : jsonPath,
    config: {
      ...readJson(jsonPath),
      ...readJsConfig(jsPath, { app, baseDir })
    }
  };
}

function loadAppConfig(app) {
  const { baseDir, configPath, config } = loadRawConfig(app);
  const sites = normalizeSites(config.sites);
  const timeRanges = normalizeTimeRanges(config.timeRanges);
  return {
    baseDir,
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
    userScripts: config.userScripts || []
  };
}

function saveConfigPatch(app, patch) {
  const filePath = path.join(getBaseDir(app), 'config.json');
  const config = readJson(filePath);
  fs.writeFileSync(filePath, JSON.stringify({ ...config, ...patch }, null, 2), 'utf-8');
}

module.exports = {
  getBaseDir,
  loadAppConfig,
  saveConfigPatch,
  loadRawConfig
};
