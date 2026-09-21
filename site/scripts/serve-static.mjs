import { open, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const compressible = new Set(['.css', '.html', '.js', '.json', '.txt', '.xml', '.svg']);

export function createPreviewServer({ dist, basePath = '/' }) {
  const root = realpathSync(dist);
  const base = basePath === '/' ? '' : `/${basePath.replace(/^\/+|\/+$/g, '')}`;
  const within = (file) => file.startsWith(`${root}${path.sep}`);
  const text = (response, status, message) => {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(message);
  };
  async function openFile(file) {
    if (!within(file)) return null;
    try {
      const resolved = await realpath(file);
      if (!within(resolved)) return null;
      const handle = await open(resolved, 'r');
      try {
        if ((await handle.stat()).isFile()) return handle;
      } catch (error) { await handle.close(); throw error; }
      await handle.close();
      return null;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    }
  }
  return createServer(async (request, response) => {
    let handle;
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('allow', 'GET, HEAD');
        text(response, 405, 'Method not allowed');
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
        if (pathname.includes('\0')) throw new URIError('Invalid path');
      } catch { text(response, 400, 'Bad request'); return; }
      let relative = null;
      if (!base || pathname === base || pathname.startsWith(`${base}/`)) {
        relative = pathname.slice(base.length) || '/';
        if (relative.endsWith('/')) relative += 'index.html';
      }
      let file = relative === null ? '' : path.resolve(root, `.${relative}`);
      handle = file ? await openFile(file) : null;
      const found = Boolean(handle);
      if (!handle) {
        file = path.join(root, '404.html');
        handle = await openFile(file);
      }
      if (!handle) { text(response, 404, 'Not found'); return; }
      const extension = path.extname(file);
      response.statusCode = found ? 200 : 404;
      response.setHeader('content-type', mimeTypes[extension] ?? 'application/octet-stream');
      response.setHeader('vary', 'Accept-Encoding');
      if (request.method === 'HEAD') { response.end(); return; }
      const gzip = /\bgzip\b/u.test(request.headers['accept-encoding'] ?? '') && compressible.has(extension);
      if (gzip) response.setHeader('content-encoding', 'gzip');
      const stream = handle.createReadStream();
      await pipeline(stream, ...(gzip ? [createGzip()] : []), response);
    } catch {
      text(response, 500, 'Unable to read preview resource');
    } finally {
      await handle?.close().catch(() => {});
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = Number(process.env.PORT ?? 4322);
  const basePath = process.env.BASE_PATH ?? '/';
  createPreviewServer({ dist: path.join(siteRoot, 'dist'), basePath }).listen(port, '127.0.0.1', () => {
    console.log(`Local http://127.0.0.1:${port}${basePath}`);
  });
}
