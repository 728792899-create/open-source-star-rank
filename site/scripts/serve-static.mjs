import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(siteRoot, 'dist');
const port = Number(process.env.PORT ?? 4322);
const rawBase = process.env.BASE_PATH ?? '/';
const base = rawBase === '/' ? '' : `/${rawBase.replace(/^\/+|\/+$/g, '')}`;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const compressibleExtensions = new Set(['.css', '.html', '.js', '.json', '.txt', '.xml']);

function resolveRequest(pathname) {
  if (base && pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  let relative = decodeURIComponent(base ? pathname.slice(base.length) : pathname);
  if (!relative || relative === '/') relative = '/index.html';
  else if (relative.endsWith('/')) relative += 'index.html';
  const candidate = path.resolve(dist, `.${relative}`);
  if (!candidate.startsWith(`${dist}${path.sep}`)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
  const requested = resolveRequest(pathname);
  const file = requested ?? path.join(dist, '404.html');
  const extension = path.extname(file);
  response.statusCode = requested ? 200 : 404;
  response.setHeader('Content-Type', mimeTypes[extension] ?? 'application/octet-stream');
  response.setHeader('Vary', 'Accept-Encoding');
  const acceptsGzip = request.headers['accept-encoding']?.includes('gzip');
  if (acceptsGzip && compressibleExtensions.has(extension)) {
    response.setHeader('Content-Encoding', 'gzip');
    createReadStream(file).pipe(createGzip()).pipe(response);
  } else {
    createReadStream(file).pipe(response);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local http://127.0.0.1:${port}${base || '/'}`);
});
