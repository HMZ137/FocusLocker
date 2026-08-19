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

function discoverCrxFiles(baseDir) {
  const extensionDir = ensureDir(path.join(baseDir, 'extensions'));
  const roots = [baseDir, extensionDir];
  const seen = new Set();
  return roots.flatMap(dir => fs.readdirSync(dir, { withFileTypes: true })
    .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.crx'))
    .map(item => path.join(dir, item.name)))
    .filter(file => (seen.has(file) ? false : seen.add(file)));
}

function readManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
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

async function loadCrxExtensions(app, targetSession, baseDir, log = () => {}) {
  const crxFiles = discoverCrxFiles(baseDir);
  const unpackRoot = ensureDir(path.join(app.getPath('userData'), 'extensions'));
  const results = [];

  for (const crxPath of crxFiles) {
    try {
      const extensionDir = await extractCrx(crxPath, unpackRoot);
      const manifest = readManifest(extensionDir);
      const extension = await targetSession.loadExtension(extensionDir, { allowFileAccess: true });
      results.push({
        id: extension.id,
        name: extension.name || manifest.name || path.basename(crxPath, '.crx'),
        file: path.basename(crxPath),
        dir: extensionDir,
        ui: getExtensionUi(extensionDir, manifest),
        success: true
      });
      log('INFO', '扩展加载成功', extension.name, crxPath);
    } catch (err) {
      results.push({ file: path.basename(crxPath), success: false, error: err.message });
      log('ERROR', '扩展加载失败', crxPath, err.message);
    }
  }

  return results;
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

function loadUserScripts(baseDir, configuredScripts = []) {
  const scriptDir = getUserscriptDir(baseDir);
  const fileScripts = fs.readdirSync(scriptDir, { withFileTypes: true })
    .filter(item => item.isFile() && /\.(user\.)?js$/i.test(item.name))
    .map(item => {
      const filePath = path.join(scriptDir, item.name);
      const code = fs.readFileSync(filePath, 'utf-8');
      const meta = readUserscriptMeta(code);
      return {
        name: meta.name || item.name,
        path: filePath,
        code,
        matches: meta.matches.length ? meta.matches : ['*://*/*'],
        enabled: true
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
  if (!pattern || pattern === '*') return true;
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

module.exports = {
  getUserscriptDir,
  importUserScript,
  injectUserScripts,
  loadCrxExtensions,
  loadUserScripts
};
