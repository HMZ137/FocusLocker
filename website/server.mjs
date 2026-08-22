/* FocusLocker 官网 · 本地静态服务器
   用法: node server.mjs [port]   (默认 8808)
   - / 与网站静态资源来自 ./website
   - /downloads/ 映射到 ../dist-build6 安装包目录
   - /downloads/latest   → 302 重定向到最新版安装包
   - /downloads/version  → JSON { version, file } 最新版信息
*/
import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(__dirname);
const DL_ROOT = resolve(__dirname, '..', 'dist-build6');
const PORT = Number(process.argv[2]) || 8808;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.exe': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------- 最新版安装包探测 ---------- */
function parseVersion(name) {
  const m = name.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
async function findLatestInstaller() {
  const entries = await readdir(DL_ROOT, { withFileTypes: true });
  let best = null;
  for (const e of entries) {
    if (!e.isFile() || !/\.exe$/i.test(e.name)) continue;
    const v = parseVersion(e.name);
    if (!v) continue;
    if (!best || cmpVersion(v, best.version) > 0) best = { name: e.name, version: v };
  }
  return best;
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const full = normalize(join(root, decoded));
  return full.startsWith(resolve(root) + sep) || full === resolve(root) ? full : null;
}

const server = createServer(async (req, res) => {
  try {
    let urlPath = new URL(req.url, 'http://localhost').pathname;
    if (urlPath === '/') urlPath = '/index.html';

    /* 下载最新版：302 重定向到当前最新安装包 */
    if (urlPath === '/downloads/latest' || urlPath === '/downloads/latest/') {
      const latest = await findLatestInstaller();
      if (!latest) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('No installer found in ' + DL_ROOT);
      }
      const target = '/downloads/' + encodeURIComponent(latest.name);
      res.writeHead(302, { Location: target });
      return res.end();
    }

    /* 下载版本信息：供页面动态展示最新版号 */
    if (urlPath === '/downloads/version') {
      const latest = await findLatestInstaller();
      const body = JSON.stringify(latest
        ? { version: latest.version.join('.'), file: latest.name }
        : { version: null, file: null });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(body);
    }

    const isDl = urlPath.startsWith('/downloads/');
    const root = isDl ? DL_ROOT : WEB_ROOT;
    const rel = isDl ? urlPath.slice('/downloads'.length) : urlPath;
    const filePath = safeJoin(root, rel);
    if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }

    const st = await stat(filePath);
    if (st.isDirectory()) {
      const index = join(filePath, 'index.html');
      const ist = await stat(index);
      if (!ist.isFile()) throw new Error('no index');
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(await readFile(index));
    }

    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    return res.end(await readFile(filePath));
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log('FocusLocker 官网已部署:  http://localhost:' + PORT);
  console.log('下载目录映射:  /downloads/ -> ' + DL_ROOT);
});
