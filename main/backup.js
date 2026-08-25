// ========== 数据备份 / 导入 ==========
// 负责把各类用户数据（配置、设置、Cookie、环境音、文件库、Todos、统计、扩展、用户样式/脚本）
// 按用户勾选的数据集打包为 zip，或从 zip 还原。
// 使用 jszip（mammoth 的传递依赖，已处于生产依赖链，无需额外安装）。
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

// 给可能永久挂起的 promise 加超时兜底（如会话存储损坏时 cookies.get 永不返回）。
// Chromium 会话存储（quota/cookie 数据库）异常时，cookies.get/flushStore 会无限期挂起，
// 普通 try/catch 拦不住，必须靠超时让导出流程继续。
function raceWithTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => {
        console.warn('[backup] ' + label + ' 超时（' + ms + 'ms），跳过该项以避免导出卡死');
        resolve(undefined);
      }, ms);
    })
  ]);
}

// 标记持久分区会话存储库可能已损坏：写入标记文件，下次启动由主进程自愈
// （备份并清空该分区存储目录，让 Chromium 重建）。仅当 cookies.get 超时时调用。
function markPartitionCorrupt(dataDir) {
  try {
    fs.writeFileSync(path.join(dataDir, 'partition-storage-corrupt.flag'), new Date().toISOString());
  } catch (_) { /* 忽略写入失败 */ }
}

// 数据集定义：每个 key 对应要收集/还原的文件或目录
//  - files：相对 root 的单个文件
//  - dirs：相对 root 的目录（递归）
//  - base：true 表示根目录为 baseDir（安装目录，如 userscripts），否则为 dataDir（userData）
//  - special：'cookie' 表示走 session.cookies API，不走文件
const DATASETS = {
  website:    { label: '网站设置', files: ['config.json'] },
  settings:   { label: '专注与通知设置', files: ['focus-settings.json'] },
  cookie:     { label: '登录 Cookie', special: 'cookie' },
  sounds:     { label: '自定义环境音', files: ['custom-sounds.json', 'ambient-covers.json'] },
  files:      { label: '文件库', dirs: ['files'], files: ['uploaded-files.json'] },
  todos:      { label: '待办 Todos', dirs: ['todos'] },
  stats:      { label: '使用统计', files: ['focus-stats.json', 'site-stats.json'] },
  extensions: { label: '浏览器扩展', dirs: ['extensions'], files: ['extensions-settings.json'] },
  userstyles: { label: '用户样式', dirs: ['userstyles'] },
  userscripts:{ label: '用户脚本', dirs: ['userscripts'], base: true }
};

// 递归把目录写入 zip（zipPrefix 用 posix 分隔符，跨平台一致）
function addDirToZip(zip, absDir, zipPrefix) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(absDir, ent.name);
    const rel = path.posix.join(zipPrefix, ent.name);
    if (ent.isDirectory()) {
      addDirToZip(zip, abs, rel);
    } else if (ent.isFile()) {
      zip.file(rel, fs.readFileSync(abs));
    }
  }
}

// 收集自定义环境音的音频文件本体（custom-sounds.json 的 path、ambient-covers.json 的 value）写入 sounds-media/
async function addSoundMedia(zip, dataDir) {
  const readJson = (f) => {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  };
  const paths = [];
  const sounds = readJson('custom-sounds.json');
  if (Array.isArray(sounds)) {
    for (const s of sounds) {
      if (s && typeof s.path === 'string' && fs.existsSync(s.path)) paths.push(s.path);
    }
  }
  const covers = readJson('ambient-covers.json');
  if (covers && typeof covers === 'object') {
    for (const k of Object.keys(covers)) {
      const v = covers[k];
      if (typeof v === 'string' && fs.existsSync(v)) paths.push(v);
    }
  }
  for (const fp of paths) {
    try {
      zip.file(`sounds-media/${path.basename(fp)}`, fs.readFileSync(fp));
    } catch (_) { /* 跳过无法读取的音频 */ }
  }
}

// 生成备份 zip 的 Buffer
async function buildBackupZip(opts, ctx) {
  const { dataDir, baseDir, browserViewSession } = ctx;
  const selectedKeys = Array.isArray(opts && opts.selectedKeys) ? opts.selectedKeys : Object.keys(DATASETS);
  const includeMedia = !opts || opts.includeMedia !== false;
  const zip = new JSZip();
  const manifest = {
    app: 'FocusLocker',
    format: 'focuslocker-backup',
    version: '1.0',
    appVersion: '1.4.0',
    exportedAt: new Date().toISOString(),
    keys: selectedKeys.filter(k => DATASETS[k])
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  for (const key of manifest.keys) {
    const ds = DATASETS[key];
    const root = ds.base ? baseDir : dataDir;
    if (ds.files) {
      for (const f of ds.files) {
        const abs = path.join(root, f);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          zip.file(f, fs.readFileSync(abs));
        }
      }
    }
    if (ds.dirs) {
      for (const d of ds.dirs) {
        const abs = path.join(root, d);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
          addDirToZip(zip, abs, d);
        }
      }
    }
  }

  // Cookie：先 flush 落盘再读取，导出为 JSON（跨机器可用）
  // 重要：会话存储异常（quota/cookie 数据库损坏或锁死）时 cookies.get/flushStore 可能永久挂起，
  // 必须加超时兜底，否则导出会卡死在「正在导出数据…」。
  if (manifest.keys.includes('cookie') && browserViewSession && browserViewSession.cookies) {
    try {
      if (typeof browserViewSession.cookies.flushStore === 'function') {
        await raceWithTimeout(browserViewSession.cookies.flushStore().catch(() => {}), 3000, 'cookies.flushStore');
      }
    } catch (_) { /* 忽略 */ }
    try {
      const cookies = await raceWithTimeout(browserViewSession.cookies.get({}), 5000, 'cookies.get');
      if (cookies) zip.file('cookies.json', JSON.stringify(cookies, null, 2));
      else markPartitionCorrupt(dataDir); // 超时：会话存储可能已损坏，标记供下次启动自愈
    } catch (_) { /* 忽略 cookie 导出失败 */ }
  }

  // 环境音音频本体
  if (manifest.keys.includes('sounds') && includeMedia) {
    await addSoundMedia(zip, dataDir);
  }

  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

// 从 zip folder 对象解压到目标目录（folder.files 的 key 为相对 folder 名的路径）
async function extractFolder(folder, targetDir) {
  const files = folder.files || {};
  for (const relPath of Object.keys(files)) {
    const entry = files[relPath];
    if (!entry || entry.dir) continue;
    const target = path.join(targetDir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async('nodebuffer'));
  }
}

// 导入后把 custom-sounds.json 里的绝对路径改写为还原后的 media 路径
function rewriteSoundPaths(jsonPath, mediaDir) {
  if (!fs.existsSync(jsonPath)) return;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch { return; }
  if (!Array.isArray(arr)) return;
  for (const s of arr) {
    if (s && typeof s.path === 'string') {
      const base = path.basename(s.path);
      const newp = path.join(mediaDir, base);
      if (fs.existsSync(newp)) s.path = newp;
    }
  }
  fs.writeFileSync(jsonPath, JSON.stringify(arr, null, 2));
}

// 导入后把 ambient-covers.json 里的绝对路径改写为还原后的 media 路径
function rewriteCoverPaths(jsonPath, mediaDir) {
  if (!fs.existsSync(jsonPath)) return;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch { return; }
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') {
      const base = path.basename(v);
      const newp = path.join(mediaDir, base);
      if (fs.existsSync(newp)) obj[k] = newp;
    }
  }
  fs.writeFileSync(jsonPath, JSON.stringify(obj, null, 2));
}

// 逐条把 cookie 写回 session
async function importCookies(sess, cookies) {
  if (!Array.isArray(cookies)) return;
  for (const c of cookies) {
    if (!c || typeof c !== 'object') continue;
    const ck = { ...c };
    // 移除 set() 不支持/会导致失败的字段
    delete ck.storeId;
    delete ck.hostOnly;
    delete ck.session;
    delete ck.creation;
    delete ck.creationTime;
    if (!ck.url) {
      const domain = ck.domain && ck.domain.startsWith('.') ? ck.domain.slice(1) : (ck.domain || 'localhost');
      const proto = ck.secure ? 'https' : 'http';
      ck.url = `${proto}://${domain}${ck.path && ck.path !== '/' ? ck.path : ''}`;
    }
    if (ck.sameSite && typeof ck.sameSite !== 'string') ck.sameSite = String(ck.sameSite);
    try {
      await sess.cookies.set(ck);
    } catch (_) { /* 单条失败忽略，继续其余 */ }
  }
  if (typeof sess.cookies.flushStore === 'function') {
    try { await sess.cookies.flushStore(); } catch (_) {}
  }
}

// 应用备份：解析 zip，按 manifest.keys 还原数据，返回 { keys, errors }
async function applyBackupZip(zipBuffer, ctx) {
  const { dataDir, baseDir, browserViewSession } = ctx;
  const zip = await JSZip.loadAsync(zipBuffer);
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('无效的备份文件（缺少 manifest.json）');
  const manifest = JSON.parse(await manifestFile.async('string'));
  const keys = Array.isArray(manifest.keys) ? manifest.keys : [];
  const errors = [];

  for (const key of keys) {
    const ds = DATASETS[key];
    if (!ds || ds.special === 'cookie') continue;
    const root = ds.base ? baseDir : dataDir;
    if (ds.files) {
      for (const f of ds.files) {
        const zf = zip.file(f);
        if (zf) {
          const target = path.join(root, f);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, await zf.async('nodebuffer'));
        }
      }
    }
    if (ds.dirs) {
      for (const d of ds.dirs) {
        const folder = zip.folder(d);
        if (folder) {
          const target = path.join(root, d);
          fs.mkdirSync(target, { recursive: true });
          await extractFolder(folder, target);
        }
      }
    }
  }

  // 环境音音频本体还原 + 重写路径
  if (keys.includes('sounds')) {
    const mediaFolder = zip.folder('sounds-media');
    if (mediaFolder) {
      const mediaDir = path.join(dataDir, 'custom-sounds-media');
      fs.mkdirSync(mediaDir, { recursive: true });
      await extractFolder(mediaFolder, mediaDir);
      rewriteSoundPaths(path.join(dataDir, 'custom-sounds.json'), mediaDir);
      rewriteCoverPaths(path.join(dataDir, 'ambient-covers.json'), mediaDir);
    }
  }

  // 安全：剥离锁屏会话时段，防止导入他人配置后立即触发锁屏绕过
  const fsPath = path.join(dataDir, 'focus-settings.json');
  if (fs.existsSync(fsPath)) {
    try {
      const obj = JSON.parse(fs.readFileSync(fsPath, 'utf-8'));
      if (obj && obj.lockSessionRanges) {
        delete obj.lockSessionRanges;
        fs.writeFileSync(fsPath, JSON.stringify(obj, null, 2));
      }
    } catch (_) {}
  }

  // Cookie 还原
  if (keys.includes('cookie') && browserViewSession && browserViewSession.cookies) {
    const cf = zip.file('cookies.json');
    if (cf) {
      try {
        const cookies = JSON.parse(await cf.async('string'));
        await importCookies(browserViewSession, cookies);
      } catch (e) {
        errors.push('Cookie 还原失败：' + e.message);
      }
    }
  }

  return { ok: true, keys, errors };
}

module.exports = { buildBackupZip, applyBackupZip, DATASETS };
