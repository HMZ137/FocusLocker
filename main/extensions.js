const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileHash(filePath) {
  const stat = fs.statSync(filePath);
  return crypto.createHash('sha1').update(`${filePath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 10);
}

function getCrxZipBuffer(buffer) {
  if (buffer.slice(0, 4).toString() !== 'Cr24') return buffer;
  const version = buffer.readUInt32LE(4);
  if (version === 2) {
    const publicKeyLength = buffer.readUInt32LE(8);
    const signatureLength = buffer.readUInt32LE(12);
    return buffer.slice(16 + publicKeyLength + signatureLength);
  }
  if (version === 3) {
    const headerLength = buffer.readUInt32LE(8);
    return buffer.slice(12 + headerLength);
  }
  throw new Error(`不支持的 CRX 版本: ${version}`);
}

async function extractCrx(crxPath, outputRoot) {
  const targetDir = path.join(outputRoot, `${path.basename(crxPath, '.crx')}-${fileHash(crxPath)}`);
  const manifestPath = path.join(targetDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) return targetDir;

  ensureDir(targetDir);
  const zipBuffer = getCrxZipBuffer(fs.readFileSync(crxPath));
  const zip = await JSZip.loadAsync(zipBuffer);
  const entries = Object.values(zip.files);

  await Promise.all(entries.map(async entry => {
    const safeName = entry.name.replace(/^([/\\])+/, '');
    const dest = path.resolve(targetDir, safeName);
    if (!dest.startsWith(targetDir)) return;
    if (entry.dir) {
      ensureDir(dest);
      return;
    }
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, await entry.async('nodebuffer'));
  }));

  if (!fs.existsSync(manifestPath)) throw new Error('CRX 中未找到 manifest.json');
  return targetDir;
}

// 发现所有可加载的扩展来源：
//  - .crx 文件（安装目录 extensions/ 与用户数据目录 extensions/，运行时安装的文件放后者）
//  - 解压扩展目录（含 manifest.json 的文件夹，类似 Chrome「加载已解压的扩展程序」）
//
// 注意：扫描目录仅为 baseDir/extensions 与 dataDir/extensions；.crx 的解压缓存目录位于独立的
// ext-unpacked（见 loadCrxExtensions），不会被这里扫到，因而不会被当成独立扩展重复加载。
function discoverExtensions(baseDir, dataDir) {
  const roots = [];
  roots.push(ensureDir(path.join(baseDir, 'extensions')));
  if (dataDir && dataDir !== baseDir) {
    roots.push(ensureDir(path.join(dataDir, 'extensions')));
  }

  // 收集所有 .crx 的「基础名」（去扩展名），用于识别并跳过「解压缓存目录」。
  // extractCrx 解压产物命名规则为 <基础名>-<10位hash>，与同名 .crx 一一对应；
  // 这些缓存目录不应被当作独立「已解压扩展」加载（否则会与 .crx 重复加载，且禁用 .crx 后
  // 其解压目录仍以另一路径加载，导致禁用失效）。
  const crxBaseNames = new Set();
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.crx')) {
        crxBaseNames.add(path.basename(entry.name, '.crx'));
      }
    }
  }

  const items = [];
  const seen = new Set();
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.crx')) {
        if (seen.has(full)) continue;
        seen.add(full);
        items.push({ type: 'crx', path: full });
      } else if (entry.isDirectory() && fs.existsSync(path.join(full, 'manifest.json'))) {
        // 跳过 .crx 的解压缓存目录：名为 <基础名>-<10位hash> 且该基础名对应一个 .crx 文件。
        const m = /^(.+)-([0-9a-f]{10})$/.exec(entry.name);
        if (m && crxBaseNames.has(m[1])) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        items.push({ type: 'dir', path: full });
      }
    }
  }
  return items;
}

function readManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

// ===== 扩展启用/禁用状态持久化（dataDir/extensions-settings.json）=====
// 结构: { "disabled": { "<sourcePath>": true }, "disabledScripts": { "<fileName>": true } }
function getExtensionSettingsPath(dataDir) {
  return path.join(dataDir, 'extensions-settings.json');
}
function loadExtensionSettings(dataDir) {
  const p = getExtensionSettingsPath(dataDir);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) || {}; }
  catch (_) { return {}; }
}
function saveExtensionSettings(dataDir, settings) {
  const p = getExtensionSettingsPath(dataDir);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
}

function findExistingPage(extensionDir, candidates) {
  return candidates.find(page => page && fs.existsSync(path.join(extensionDir, page))) || null;
}

function getExtensionUi(extensionDir, manifest) {
  const optionPage = manifest.options_ui?.page || manifest.options_page || null;
  const popupPage = manifest.action?.default_popup || manifest.browser_action?.default_popup || null;
  const managePage = findExistingPage(extensionDir, [
    'manage.html',
    optionPage,
    'options.html',
    popupPage,
    'popup.html',
    'index.html'
  ]);
  return {
    managePage,
    optionPage: findExistingPage(extensionDir, [optionPage, 'options.html']),
    popupPage: findExistingPage(extensionDir, [popupPage, 'popup.html'])
  };
}

// ===== 扩展禁用键：与安装位置无关 =====
// 禁用状态持久化在 extensions-settings.json，若用绝对路径做键，一旦 dev→打包 / 重装到其它目录，
// 路径变化会导致键不匹配，「禁用」自动失效。因此统一改用「相对根目录的位置无关键」：
//   base:<相对 baseDir 的路径>   或   data:<相对 dataDir 的路径>
// 例如 base:extensions/my-ext.crx，无论应用装在哪个盘都一致。
// 同时保留绝对路径键的兼容（旧版本写入的键），匹配时两种形式都认。
function safeRelativeKey(root, p) {
  try {
    const rel = path.relative(root, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  } catch (_) { /* 跨盘/不可解析，忽略 */ }
  return null;
}
// 返回一个来源的全部候选键（含旧版绝对路径键 + 位置无关键）
function sourceKeysFor(item, baseDir, dataDir) {
  const keys = [path.resolve(item.path)]; // 兼容旧版绝对路径键
  const rb = safeRelativeKey(baseDir, item.path);
  if (rb) keys.push('base:' + rb);
  const rd = safeRelativeKey(dataDir, item.path);
  if (rd) keys.push('data:' + rd);
  return keys;
}
// 优先返回位置无关键（写入禁用表 / 回传渲染进程都用它）
function stableSourceKey(item, baseDir, dataDir) {
  const keys = sourceKeysFor(item, baseDir, dataDir);
  const loc = keys.find(k => k.startsWith('base:') || k.startsWith('data:'));
  return loc || keys[0];
}
// 由禁用键还原 .crx 源文件绝对路径（支持绝对路径键与位置无关键）
function crxPathFromKey(key, baseDir, dataDir) {
  if (key.startsWith('base:') || key.startsWith('data:')) {
    const root = key.startsWith('base:') ? baseDir : dataDir;
    const full = path.join(root, key.slice(key.indexOf(':') + 1));
    if (full.toLowerCase().endsWith('.crx')) return full;
    return null;
  }
  // 旧版绝对路径键
  if (path.isAbsolute(key) && key.toLowerCase().endsWith('.crx')) return key;
  return null;
}
// 由任意一个禁用键（绝对路径 / base: / data: 任意形式）还原出「该扩展来源」的全部等价键，
// 用于在「启用」时一次性清除所有等价键，避免旧数据残留的绝对路径键无法被删掉而导致「禁用后无法启用」。
function equivalentKeys(key, baseDir, dataDir) {
  let abs;
  if (key.startsWith('base:')) abs = path.join(baseDir, key.slice(5));
  else if (key.startsWith('data:')) abs = path.join(dataDir, key.slice(5));
  else abs = key; // 绝对路径键
  abs = path.resolve(abs);
  const keys = new Set([abs]);
  const rb = safeRelativeKey(baseDir, abs); if (rb) keys.add('base:' + rb);
  const rd = safeRelativeKey(dataDir, abs); if (rd) keys.add('data:' + rd);
  return [...keys];
}
// 由禁用键还原已解压目录的绝对路径（支持绝对路径键与位置无关键）
function dirPathFromKey(key, baseDir, dataDir) {
  if (key.startsWith('base:') || key.startsWith('data:')) {
    const root = key.startsWith('base:') ? baseDir : dataDir;
    return path.join(root, key.slice(key.indexOf(':') + 1));
  }
  return key;
}
async function loadCrxExtensions(app, targetSession, baseDir, dataDir, log = () => {}) {
  const items = discoverExtensions(baseDir, dataDir);
  // 解压目录必须独立于 discoverExtensions 扫描的目录（baseDir/extensions、dataDir/extensions），
  // 否则 extractCrx 解压出的 <name>-<hash> 目录会被当作独立「已解压扩展」再次加载：既造成
  // 重复加载，又导致禁用 .crx 后其解压目录仍以另一路径加载，使「禁用」失效。
  const unpackRoot = ensureDir(path.join(app.getPath('userData'), 'ext-unpacked'));
  const results = [];

  // 用户手动禁用的扩展源路径集合
  const settings = loadExtensionSettings(dataDir);
  const disabledSources = new Set(Object.keys(settings.disabled || {}));

  // 计算被禁用扩展「实际加载时」所在的目录集合，用于加载前强制卸载残留的已禁用扩展：
  //  - .crx 的加载目录是其解压目录（与源 .crx 路径不同），需据 fileHash 还原
  //  - 已解压目录则直接使用其源路径
  // 这样即使上一轮会话中该扩展已被 loadExtension，本次也会先卸载，确保「禁用」真正生效。
  const disabledDirs = new Set();
  for (const key of disabledSources) {
    const crxPath = crxPathFromKey(key, baseDir, dataDir);
    if (crxPath) {
      // .crx 的实际加载目录是其解压缓存目录（与源 .crx 路径不同），据 fileHash 还原
      try {
        disabledDirs.add(path.resolve(path.join(unpackRoot, `${path.basename(crxPath, '.crx')}-${fileHash(crxPath)}`)));
      } catch (_) { /* 源文件可能已不存在，忽略 */ }
    } else {
      try { disabledDirs.add(path.resolve(dirPathFromKey(key, baseDir, dataDir))); } catch (_) {}
    }
  }

  // 当前会话已加载的扩展（按其目录去重）：运行时「重新加载」时跳过，避免 loadExtension 重复抛错；
  // 同时顺手卸载仍残留的已禁用扩展。
  let loadedByDir = new Set();
  try {
    const loaded = targetSession.getAllExtensions ? targetSession.getAllExtensions() : [];
    for (const e of loaded) {
      if (!e || !e.path) continue;
      const eDir = path.resolve(e.path);
      loadedByDir.add(eDir);
      if (disabledDirs.has(eDir)) {
        try { targetSession.removeExtension(e.id); log('INFO', '启动清理：卸载已禁用扩展', e.path); } catch (_) { /* 可能已卸载 */ }
        loadedByDir.delete(eDir);
      }
    }
  } catch (_) {}

  // 同一次扫描内按解压目录去重：同一目录可能被「.crx 源 + 已解压目录」两种途径发现，只处理一次
  const seenDirs = new Set();

  for (const item of items) {
    const sourceKey = stableSourceKey(item, baseDir, dataDir);
    const candidateKeys = sourceKeysFor(item, baseDir, dataDir);
    const isDisabled = candidateKeys.some(k => disabledSources.has(k));
    try {
      // 用户已禁用的扩展：不加载，仅保留一条记录供 UI 展示并允许重新启用
      if (isDisabled) {
        const manifest = item.type === 'dir' ? readManifest(item.path) : {};
        results.push({
          id: manifest.id || path.basename(item.path, path.extname(item.path)),
          name: manifest.name || path.basename(item.path, path.extname(item.path)),
          file: path.basename(item.path),
          dir: item.path,
          sourcePath: sourceKey,
          ui: getExtensionUi(item.path, manifest),
          success: true,
          disabled: true
        });
        log('INFO', '扩展已禁用，跳过加载', item.path);
        continue;
      }
      let extensionDir;
      if (item.type === 'crx') {
        extensionDir = await extractCrx(item.path, unpackRoot);
      } else {
        extensionDir = item.path; // 解压目录直接使用
      }
      const resolvedDir = path.resolve(extensionDir);
      if (seenDirs.has(resolvedDir)) continue; // 同目录已被本次扫描处理过
      seenDirs.add(resolvedDir);
      const manifest = readManifest(extensionDir);
      if (loadedByDir.has(resolvedDir)) {
        // 已加载：保留状态条目但不重复 loadExtension
        const ext = (targetSession.getAllExtensions ? targetSession.getAllExtensions() : [])
          .find(e => e.path && path.resolve(e.path) === path.resolve(extensionDir));
        results.push({
          id: ext ? ext.id : (manifest.id || path.basename(item.path)),
          name: (ext && ext.name) || manifest.name || path.basename(item.path, path.extname(item.path)),
          file: path.basename(item.path),
          dir: extensionDir,
          sourcePath: sourceKey,
          ui: getExtensionUi(extensionDir, manifest),
          success: true,
          alreadyLoaded: true
        });
        continue;
      }
      const extension = await targetSession.loadExtension(extensionDir, { allowFileAccess: true });
      loadedByDir.add(path.resolve(extensionDir));
      results.push({
        id: extension.id,
        name: extension.name || manifest.name || path.basename(item.path, path.extname(item.path)),
        file: path.basename(item.path),
        dir: extensionDir,
        sourcePath: sourceKey,
        ui: getExtensionUi(extensionDir, manifest),
        success: true
      });
      log('INFO', '扩展加载成功', extension.name, item.path);
    } catch (err) {
      results.push({ file: path.basename(item.path), success: false, error: err.message });
      log('ERROR', '扩展加载失败', item.path, err.message);
    }
  }

  return results;
}

// 运行时安装 .crx：复制到用户数据目录 extensions/（跨重装保留），下次 loadCrxExtensions 自动发现
function installExtensionFile(dataDir, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('文件不存在');
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext !== '.crx') throw new Error('仅支持 .crx 扩展文件');
  const targetDir = ensureDir(path.join(dataDir, 'extensions'));
  let dest = path.join(targetDir, path.basename(sourcePath));
  if (fs.existsSync(dest)) dest = path.join(targetDir, `${path.basename(sourcePath, '.crx')}-${Date.now()}.crx`);
  fs.copyFileSync(sourcePath, dest);
  return { fileName: path.basename(dest), filePath: dest };
}

// 运行时安装解压扩展目录（类似 Chrome「加载已解压的扩展程序」）
function installExtensionDir(dataDir, sourceDir) {
  if (!sourceDir || !fs.existsSync(sourceDir)) throw new Error('目录不存在');
  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('所选目录中没有 manifest.json，不是有效的扩展文件夹');
  const targetRoot = ensureDir(path.join(dataDir, 'extensions'));
  const dirName = `${path.basename(sourceDir)}-${fileHash(sourceDir)}`;
  const dest = path.join(targetRoot, dirName);
  if (fs.existsSync(dest)) return { fileName: dirName, filePath: dest, existed: true };
  fs.cpSync(sourceDir, dest, { recursive: true });
  return { fileName: dirName, filePath: dest };
}

function getUserscriptDir(baseDir) {
  return ensureDir(path.join(baseDir, 'userscripts'));
}

function readUserscriptMeta(code) {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(code)?.[1] || '';
  const name = /@name\s+(.+)/.exec(block)?.[1]?.trim();
  const matches = [...block.matchAll(/@(match|include)\s+(.+)/g)].map(m => m[2].trim()).filter(Boolean);
  return { name, matches };
}

// 解析简单的 JS 字符串字面量转义：\\ -> \, \/ -> /, \n -> 换行, \uXXXX / \xXX / 八进制 等
function unescapeJsStringLiteral(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|([\s\S]))/g,
    (_, u, x, o, c) => {
      if (u) return String.fromCharCode(parseInt(u, 16));
      if (x) return String.fromCharCode(parseInt(x, 16));
      if (o) return String.fromCharCode(parseInt(o, 8));
      switch (c) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'v': return '\v';
        case 'b': return '\b';
        case 'f': return '\f';
        case '0': return '\0';
        case '\'': return '\'';
        case '"': return '"';
        case '\\': return '\\';
        case '/': return '/';
        default: return c;
      }
    });
}

// 解析 @var 行，支持类型：select / range / color / text
function parseStyleVarLine(line) {
  // @var <type> <name> "<label>" <value>
  const m = /@var\s+(select|range|color|text|checkbox|dropdown)\s+([\w\u4e00-\u9fa5\-.:]+)\s+"([^"]*)"\s*([\s\S]*)$/.exec(line);
  if (!m) return null;
  const [, type, name, label, rawValue] = m;
  const raw = rawValue.trim();
  const def = {
    type,
    name,
    // label 中的 \uXXXX 需要反转义（用户样式作者常用 Unicode 转义写中文）
    label: unescapeJsStringLiteral(label),
    defaultValue: null,
    options: null,
    range: null
  };
  try {
    if (type === 'select' || type === 'dropdown') {
      // 解析 {...} 字面量 JSON-ish（键值对，值为字符串）
      const obj = parseLiteralObject(raw);
      if (obj && Object.keys(obj).length) {
        def.options = Object.entries(obj).map(([k, v]) => ({
          // 键（下拉框显示文本）也可能是 \uXXXX
          label: unescapeJsStringLiteral(k),
          value: v
        }));
        def.defaultValue = def.options[0].value;
      }
    } else if (type === 'range') {
      // [default,min,max,step]
      const arr = parseLiteralArray(raw);
      if (arr && arr.length >= 2) {
        def.defaultValue = Number(arr[0]);
        def.range = { min: Number(arr[1]), max: Number(arr[2]), step: arr.length >= 4 ? Number(arr[3]) : 1 };
      }
    } else if (type === 'color') {
      def.defaultValue = raw.replace(/^['"]|['"]$/g, '').trim() || '#ff0000';
    } else if (type === 'checkbox') {
      const v = raw.replace(/^['"]|['"]$/g, '').trim();
      def.defaultValue = (v === '1' || v === 'true');
    } else { // text
      def.defaultValue = raw.replace(/^['"]|['"]$/g, '');
    }
  } catch (_) {
    return null;
  }
  if (def.defaultValue === null || def.defaultValue === undefined) return null;
  return def;
}

// 解析 "{\"label\":\"value\", ...}" 或不规范但常见的 USO 格式（键不带引号、值用括号）
function parseLiteralObject(raw) {
  if (!raw.startsWith('{')) return null;
  // 把最外层花括号去掉，再按顶层逗号分割成 "key":"value"
  const inner = raw.slice(1, raw.lastIndexOf('}'));
  const parts = splitTopLevel(inner, ',');
  const result = {};
  for (const part of parts) {
    const colonIdx = findTopLevelColon(part);
    if (colonIdx < 0) continue;
    let key = part.slice(0, colonIdx).trim();
    let val = part.slice(colonIdx + 1).trim();
    // 去掉 key 的引号
    key = key.replace(/^['"]|['"]$/g, '');
    // 去掉 val 的引号（单/双），但保留里面的 CSS 内容
    val = val.replace(/^['"]|['"]$/g, '');
    if (key) result[key] = val;
  }
  return result;
}
function parseLiteralArray(raw) {
  if (!raw.startsWith('[')) return null;
  const inner = raw.slice(1, raw.lastIndexOf(']'));
  return splitTopLevel(inner, ',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
}
// 按分隔符切分（忽略花括号/方括号/引号内部）
function splitTopLevel(str, sep) {
  const out = [];
  let cur = '', depth = 0, inS = null, inD = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inS) { cur += c; if (c === "'" && str[i - 1] !== '\\') inS = null; continue; }
    if (inD) { cur += c; if (c === '"' && str[i - 1] !== '\\') inD = null; continue; }
    if (c === "'") { inS = true; cur += c; continue; }
    if (c === '"') { inD = true; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (depth === 0 && c === sep) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function findTopLevelColon(str) {
  let depth = 0, inS = null, inD = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inS) { if (c === "'" && str[i - 1] !== '\\') inS = null; continue; }
    if (inD) { if (c === '"' && str[i - 1] !== '\\') inD = null; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (depth === 0 && c === ':') return i;
  }
  return -1;
}

// 从 @-moz-document 中抽取匹配规则：domain / regexp / url / url-prefix
function extractMozDocumentMatches(code) {
  const matches = [];
  const regex = /@-moz-document\s+([^{]+)\s*\{/g;
  let m;
  while ((m = regex.exec(code)) !== null) {
    const args = m[1].trim();
    for (const part of splitTopLevel(args, ',')) {
      const arg = part.trim();
      const dm = /^domain\((.+)\)$/.exec(arg);
      if (dm) {
        const dom = stripQuotes(dm[1].trim());
        // domain("x.com") 匹配 x.com 及其所有子域名
        matches.push(`*://*.${dom}/*`);
        matches.push(`*://${dom}/*`);
        continue;
      }
      const rm = /^regexp\((.+)\)$/.exec(arg);
      if (rm) {
        // regexp("...") 内的字符串字面量已按 JS 字面量进行转义（如 \\S → 实际要的是 \S）
        const src = unescapeJsStringLiteral(stripQuotes(rm[1].trim()));
        matches.push({ regexp: src });
        continue;
      }
      const um = /^url-prefix\((.+)\)$/.exec(arg);
      if (um) {
        const pref = stripQuotes(um[1].trim());
        matches.push(`${pref}*`);
        continue;
      }
      const u = /^url\((.+)\)$/.exec(arg);
      if (u) matches.push(stripQuotes(u[1].trim()));
    }
  }
  return matches;
}
function stripQuotes(s) {
  return s.replace(/^['"]|['"]$/g, '');
}

// 用户样式头注释使用 ==UserStyle== 块（Stylus 格式：/* ==UserStyle== ... ==/UserStyle== */）
function readStyleMeta(code) {
  const block = /\/\*?\s*==UserStyle==([\s\S]*?)==\/UserStyle==/.exec(code)?.[1] || '';
  // 优先 @name（无后缀版），否则回落 @name:zh；内中的 \uXXXX 需要反转义
  const name = unescapeJsStringLiteral(
    /@name\s+([^:@\n][^\n]*)/.exec(block)?.[1]?.trim() ||
    /@name:zh\s+(.+)/.exec(block)?.[1]?.trim() || ''
  ) || undefined;
  const desc = unescapeJsStringLiteral(
    /@description\s+([^:@\n][^\n]*)/.exec(block)?.[1]?.trim() ||
    /@description:zh\s+(.+)/.exec(block)?.[1]?.trim() || ''
  ) || undefined;
  const version = /@version\s+(.+)/.exec(block)?.[1]?.trim();
  const preprocessor = /@preprocessor\s+(.+)/.exec(block)?.[1]?.trim() || 'uso';
  const license = /@license\s+(.+)/.exec(block)?.[1]?.trim();
  const author = /@author\s+(.+)/.exec(block)?.[1]?.trim();

  // 解析 @var 定义：注意 @var 的 value 部分可能跨多行（对象/数组含换行）
  const vars = [];
  const varLines = [];
  // 按 @var 开头行切片，后续非空行若属于当前 value 则追加（遇到下一个 @/==/行前缀即可停止）
  const rawLines = block.split(/\r?\n/);
  let cur = null;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const start = /^\s*@var\s+(select|range|color|text|checkbox|dropdown)\s+/i.exec(line);
    if (start) {
      if (cur) varLines.push(cur);
      cur = line.replace(/^\s*/, '');
      // 若 select/range 这一行已经闭合，则可直接提交
      if (isVarLineComplete(cur)) {
        varLines.push(cur);
        cur = null;
      }
    } else if (cur) {
      cur += '\n' + line;
      if (isVarLineComplete(cur)) {
        varLines.push(cur);
        cur = null;
      }
    }
  }
  if (cur) varLines.push(cur);
  for (const vl of varLines) {
    const v = parseStyleVarLine(vl);
    if (v) vars.push(v);
  }

  // 匹配规则：优先头注释里的 @match/@include
  let matches = [...block.matchAll(/@(match|include)\s+(.+)/g)].map(m => m[2].trim()).filter(Boolean);
  // 再从 @-moz-document 里补充（Stylus 常见格式，使用 domain/regexp 精确匹配）
  for (const rule of extractMozDocumentMatches(code)) {
    if (!matches.includes(rule)) matches.push(rule);
  }

  return {
    name,
    description: desc,
    version,
    author,
    license,
    preprocessor,
    vars,
    matches
  };
}

// 检测 @var value 字面量是否完整闭合（{} 或 [] 成对，或 color/text 只有一行）
function isVarLineComplete(line) {
  const body = line.replace(/^@var\s+(select|range|color|text|checkbox|dropdown)\s+[\w\u4e00-\u9fa5\-.:]+\s+"[^"]*"\s*/i, '');
  const first = body.trimStart()[0];
  if (first === '{') {
    let depth = 0, inS = false, inD = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i], p = body[i - 1];
      if (inS) { if (c === "'" && p !== '\\') inS = false; continue; }
      if (inD) { if (c === '"' && p !== '\\') inD = false; continue; }
      if (c === "'") { inS = true; continue; }
      if (c === '"') { inD = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    return depth <= 0;
  }
  if (first === '[') {
    let depth = 0;
    for (const c of body) if (c === '[') depth++; else if (c === ']') depth--;
    return depth <= 0;
  }
  return true; // color / text 单行
}

function loadUserScripts(baseDir, configuredScripts = [], disabledScriptNames = new Set()) {
  const scriptDir = getUserscriptDir(baseDir);
  const fileScripts = fs.readdirSync(scriptDir, { withFileTypes: true })
    .filter(item => item.isFile() && /\.(user\.)?js$/i.test(item.name))
    .map(item => {
      const filePath = path.join(scriptDir, item.name);
      const code = fs.readFileSync(filePath, 'utf-8');
      const meta = readUserscriptMeta(code);
      return {
        id: item.name,
        name: meta.name || item.name,
        path: filePath,
        code,
        matches: meta.matches.length ? meta.matches : ['*://*/*'],
        enabled: !disabledScriptNames.has(item.name)
      };
    });

  const inlineScripts = (Array.isArray(configuredScripts) ? configuredScripts : [])
    .filter(script => script && script.enabled !== false)
    .map((script, idx) => {
      const code = script.code || (script.path && fs.existsSync(path.resolve(baseDir, script.path))
        ? fs.readFileSync(path.resolve(baseDir, script.path), 'utf-8')
        : '');
      return {
        name: script.name || `config-script-${idx + 1}`,
        path: script.path || null,
        code,
        matches: Array.isArray(script.matches) && script.matches.length ? script.matches : ['*://*/*'],
        enabled: !!code
      };
    })
    .filter(script => script.enabled);

  return [...fileScripts, ...inlineScripts];
}

function matchPattern(pattern, url) {
  if (!pattern) return true;
  if (typeof pattern === 'object' && pattern.regexp) {
    try {
      return new RegExp(pattern.regexp).test(url);
    } catch (_) {
      return false;
    }
  }
  if (pattern === '*') return true;
  if (typeof pattern !== 'string') return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

function getMatchedScripts(scripts, url) {
  return scripts.filter(script => script.enabled !== false && script.matches.some(pattern => matchPattern(pattern, url)));
}

async function injectUserScripts(webContents, scripts, url, log = () => {}) {
  const matched = getMatchedScripts(scripts, url);
  for (const script of matched) {
    try {
      await webContents.executeJavaScript(`(() => {\n${script.code}\n})();`, true);
      log('INFO', '用户脚本注入成功', script.name, url);
    } catch (err) {
      log('ERROR', '用户脚本注入失败', script.name, err.message);
    }
  }
}

function importUserScript(baseDir, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('脚本文件不存在');
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext !== '.js') throw new Error('仅支持 .js 或 .user.js 脚本');
  const scriptDir = getUserscriptDir(baseDir);
  const parsed = path.parse(sourcePath);
  let dest = path.join(scriptDir, parsed.base);
  if (fs.existsSync(dest)) dest = path.join(scriptDir, `${parsed.name}-${Date.now()}${parsed.ext}`);
  fs.copyFileSync(sourcePath, dest);
  return { fileName: path.basename(dest), filePath: dest };
}

// ===== 用户样式（.user.css，供 Stylus 风格样式 / 轻量注入） =====
function getUserstyleDir(dataDir) {
  return ensureDir(path.join(dataDir, 'userstyles'));
}
function getUserstyleSettingsPath(dataDir) {
  return path.join(getUserstyleDir(dataDir), 'userstyle-settings.json');
}
function loadUserstyleSettings(dataDir) {
  const p = getUserstyleSettingsPath(dataDir);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) || {}; }
  catch (_) { return {}; }
}
function saveUserstyleSettings(dataDir, settings) {
  const p = getUserstyleSettingsPath(dataDir);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
}

// 基于 meta.vars 定义和 settings 里的覆盖值，产出变量名 → 最终值 映射
function resolveVarValues(meta, override) {
  const vars = Array.isArray(meta?.vars) ? meta.vars : [];
  const over = override?.values && typeof override.values === 'object' ? override.values : {};
  const result = {};
  for (const v of vars) {
    if (Object.prototype.hasOwnProperty.call(over, v.name)) {
      // 对 range 做数值化
      if (v.type === 'range') {
        const n = Number(over[v.name]);
        result[v.name] = Number.isFinite(n) ? n : v.defaultValue;
      } else if (v.type === 'checkbox') {
        const x = over[v.name];
        result[v.name] = (x === true || x === 1 || x === '1' || x === 'true');
      } else {
        result[v.name] = over[v.name];
      }
    } else {
      result[v.name] = v.defaultValue;
    }
  }
  return result;
}

// USO 风格：把 /*[[varName]]*/ 替换为变量值；支持嵌套替换（简单迭代几次即可）
function substituteVars(css, valueMap) {
  let out = css;
  for (let i = 0; i < 4; i++) {
    let changed = false;
    out = out.replace(/\/\*\[\[([\w\u4e00-\u9fa5\-.:]+)\]\]\*\//g, (_, name) => {
      if (Object.prototype.hasOwnProperty.call(valueMap, name)) {
        changed = true;
        return String(valueMap[name]);
      }
      return _;
    });
    if (!changed) break;
  }
  return out;
}

// 编译：去掉 @-moz-document 包装（保留内层 CSS，因我们已经通过 matches 做匹配过滤），然后变量替换
function unwrapMozDocumentBlocks(css) {
  // 把每个 @-moz-document X { inner } 替换为 inner（去掉最外层包装，支持嵌套 {}）
  const regex = /@-moz-document\s+[^{]+\s*\{/g;
  // 先定位每个 @-moz-document 的起始，再解析其 block
  let result = '';
  let last = 0;
  let m;
  while ((m = regex.exec(css)) !== null) {
    const headStart = m.index;
    const headEnd = regex.lastIndex; // 指向 '{' 后面
    // 从 headEnd - 1（{ 的位置）往后找匹配的 }
    const blockStart = headEnd - 1;
    const blockEnd = findMatchingBrace(css, blockStart);
    if (blockEnd < 0) break;
    const inner = css.slice(blockStart + 1, blockEnd);
    result += css.slice(last, headStart) + inner;
    last = blockEnd + 1;
    regex.lastIndex = last;
  }
  result += css.slice(last);
  return result;
}
function findMatchingBrace(str, openIdx) {
  if (str[openIdx] !== '{') return -1;
  let depth = 0, inS = false, inD = false;
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i], p = str[i - 1];
    if (inS) { if (c === "'" && p !== '\\') inS = false; continue; }
    if (inD) { if (c === '"' && p !== '\\') inD = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function compileUserStyle(styleObj, settings) {
  // loadUserStyles 会把 meta 字段摊平；兼容 meta 存在或直接摊平两种情况
  const meta = styleObj.meta || {
    vars: styleObj.vars,
    preprocessor: styleObj.preprocessor
  };
  const override = (settings && styleObj.id && settings[styleObj.id]) || {};
  const valueMap = resolveVarValues(meta, override);
  let css = styleObj.code;
  // 先去掉 @-moz-document 包装（无论使用何种预处理器，这一步对 Chromium 都有益）
  css = unwrapMozDocumentBlocks(css);
  // 对 uso / stylus / default 预处理模式都做一次 /*[[x]]*/ 替换
  if (meta.preprocessor !== 'none') {
    css = substituteVars(css, valueMap);
  }
  return css;
}

function styleIdFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[^\w\u4e00-\u9fa5\-.:]/g, '_');
}

function loadUserStyles(dataDir) {
  const styleDir = getUserstyleDir(dataDir);
  const settings = loadUserstyleSettings(dataDir);
  return fs.readdirSync(styleDir, { withFileTypes: true })
    .filter(item => item.isFile() && /\.(user\.)?css$/i.test(item.name))
    .map(item => {
      const filePath = path.join(styleDir, item.name);
      const code = fs.readFileSync(filePath, 'utf-8');
      const meta = readStyleMeta(code);
      const id = styleIdFromPath(filePath);
      const override = settings[id] || {};
      const enabled = override.enabled !== false;
      const matches = meta.matches.length ? meta.matches : ['*://*/*'];
      return {
        id,
        name: meta.name || item.name,
        description: meta.description || '',
        version: meta.version || '',
        author: meta.author || '',
        license: meta.license || '',
        preprocessor: meta.preprocessor || 'uso',
        vars: meta.vars || [],
        varValues: resolveVarValues(meta, override),
        enabled,
        path: filePath,
        fileName: item.name,
        code,
        matches
      };
    });
}

// 返回给渲染进程的轻量元数据（不含 raw code，避免太大）
function listUserStylesMeta(dataDir) {
  const styles = loadUserStyles(dataDir);
  return styles.map(s => ({
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
  }));
}

function saveUserStyleVarOverrides(dataDir, styleId, { enabled, values }) {
  const settings = loadUserstyleSettings(dataDir);
  const cur = settings[styleId] || {};
  if (typeof enabled === 'boolean') cur.enabled = enabled;
  if (values && typeof values === 'object') cur.values = { ...(cur.values || {}), ...values };
  settings[styleId] = cur;
  saveUserstyleSettings(dataDir, settings);
  return true;
}
function toggleUserStyle(dataDir, styleId, enabled) {
  return saveUserStyleVarOverrides(dataDir, styleId, { enabled: !!enabled });
}
function deleteUserStyle(dataDir, styleId) {
  const styleDir = getUserstyleDir(dataDir);
  const list = fs.readdirSync(styleDir, { withFileTypes: true });
  for (const item of list) {
    if (!item.isFile()) continue;
    const fp = path.join(styleDir, item.name);
    if (styleIdFromPath(fp) === styleId) {
      fs.unlinkSync(fp);
      const settings = loadUserstyleSettings(dataDir);
      if (settings[styleId]) {
        delete settings[styleId];
        saveUserstyleSettings(dataDir, settings);
      }
      return true;
    }
  }
  return false;
}

function getMatchedStyles(styles, url) {
  return styles.filter(s => s.enabled !== false && s.matches.some(p => matchPattern(p, url)));
}

async function injectUserStyles(webContents, styles, url, settingsOrNull, log = () => {}) {
  // 兼容旧签名：settingsOrNull 可能是 log
  const settings = (settingsOrNull && typeof settingsOrNull === 'object') ? settingsOrNull : null;
  const matched = getMatchedStyles(styles, url);
  for (const style of matched) {
    try {
      const compiled = compileUserStyle(style, settings || {});
      if (!compiled.trim()) continue;
      // 以「用户来源」注入并强制 !important：用户 !important > 作者 !important > 作者 normal，
      // 稳定盖过原站 CSS（含原站的 !important），不再抢位置/重叠。
      await webContents.insertCSS(promoteImportant(compiled), { cssOrigin: 'user' });
      log('INFO', '用户样式注入成功', style.name, url);
    } catch (err) {
      log('ERROR', '用户样式注入失败', style.name, err.message);
    }
  }
}

function importUserStyle(dataDir, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('样式文件不存在');
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext !== '.css') throw new Error('仅支持 .css 或 .user.css 样式');
  const styleDir = getUserstyleDir(dataDir);
  const parsed = path.parse(sourcePath);
  let dest = path.join(styleDir, parsed.base);
  if (fs.existsSync(dest)) dest = path.join(styleDir, `${parsed.name}-${Date.now()}${parsed.ext}`);
  fs.copyFileSync(sourcePath, dest);
  return { fileName: path.basename(dest), filePath: dest };
}

// ===== 强制 !important：让自定义/用户 CSS 稳赢网页（含网页的 !important）=====
// 仅给「规则体里的属性: 值」追加 !important；不触碰选择器、@-规则前导行。
// 配合 cssOrigin: 'user'：用户 !important > 作者 !important > 作者 normal，
// 即可稳定盖过原站 CSS，不再「抢位置/重叠」。
function promoteImportant(css) {
  if (typeof css !== 'string' || !css) return css;
  return css.replace(/([{;])\s*([@A-Za-z_\-][\w\u4e00-\u9fa5\-]*)\s*:\s*([^;{}]+)/g,
    (m, lead, prop, val) => {
      if (prop.charAt(0) === '@') return m; // @-规则前导行不处理
      if (/!important/i.test(val)) return m; // 已带 !important 不重复加
      // 跳过字体相关声明：否则用户 CSS 里的 font-family 会以「用户 !important」盖过
      // 网页的 icon font，导致图标字体回退成方块占位符。
      // 定位/布局类声明照旧加 !important，「抢位置/重叠」问题继续被压制。
      const p = prop.toLowerCase();
      if (p === 'font-family' || p === 'font' || p === 'src' || p === 'content') return m;
      return `${lead} ${prop}: ${val.trim()} !important`;
    });
}

module.exports = {
  getUserscriptDir,
  importUserScript,
  injectUserScripts,
  loadCrxExtensions,
  loadUserScripts,
  getExtensionSettingsPath,
  loadExtensionSettings,
  saveExtensionSettings,
  installExtensionFile,
  installExtensionDir,
  getUserstyleDir,
  getUserstyleSettingsPath,
  loadUserstyleSettings,
  saveUserstyleSettings,
  loadUserStyles,
  listUserStylesMeta,
  importUserStyle,
  injectUserStyles,
  compileUserStyle,
  saveUserStyleVarOverrides,
  toggleUserStyle,
  deleteUserStyle,
  promoteImportant,
  equivalentKeys
};
