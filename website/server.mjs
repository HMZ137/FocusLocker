/* FocusLocker 官网 · 本地静态服务器
   用法: node server.mjs [port]   (默认 8808)
   - / 与网站静态资源来自 ./website
   - /downloads/ 映射到 ../dist-v18 安装包目录
*/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(__dirname);
const DL_ROOT = resolve(__dirname, '..', 'dist-v18');
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

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const full = normalize(join(root, decoded));
  return full.startsWith(resolve(root) + sep) || full === resolve(root) ? full : null;
}

const server = createServer(async (req, res) => {
  try {
    let urlPath = new URL(req.url, 'http://localhost').pathname;
    if (urlPath === '/') urlPath = '/index.html';

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
