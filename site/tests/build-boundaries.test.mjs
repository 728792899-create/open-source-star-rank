import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { cardOutput, loadCardJobs } from '../scripts/social-card-inputs.mjs';
import { createPreviewServer } from '../scripts/serve-static.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'starrank-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('cards consume only validated manifest records with matching output identities', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'daily'));
  await writeFile(path.join(root, 'daily/2026-09-19.json'), JSON.stringify({ date: '2026-09-19', entries: [] }));
  await writeFile(path.join(root, 'daily/extra.json'), 'not a ranking');
  const manifest = path.join(root, 'manifest.json');
  await writeFile(manifest, JSON.stringify([{ kind: 'daily', path: 'daily/2026-09-19.json' }]));
  const jobs = await loadCardJobs(root, manifest);
  assert.deepEqual(jobs.map((job) => job.name), ['daily-2026-09-19.png']);
  assert.equal(cardOutput(root, jobs[0].name), path.join(root, jobs[0].name));
  assert.throws(() => cardOutput(root, '../outside.png'));
  await writeFile(path.join(root, 'daily/2026-09-19.json'), JSON.stringify({ date: '2026-09-18', entries: [] }));
  await assert.rejects(loadCardJobs(root, manifest), /differs/u);
  await writeFile(manifest, JSON.stringify([{ kind: 'daily', path: 'daily/extra.json' }]));
  await assert.rejects(loadCardJobs(root, manifest), /Invalid validated card path/u);
  for (const [kind, file, metadata, name] of [
    ['period', 'period/7d/2026-09-19.json', { period_days: 7 }, 'period-7d-2026-09-19.png'],
    ['language', 'language/python/daily/2026-09-19.json', { slug: 'python', language: 'Python' }, 'language-python-2026-09-19.png'],
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), JSON.stringify({ date: '2026-09-19', entries: [], ...metadata }));
    await writeFile(manifest, JSON.stringify([{ kind, path: file }]));
    assert.deepEqual((await loadCardJobs(root, manifest)).map((job) => job.name), [name]);
    assert.equal(cardOutput(root, name), path.join(root, name));
    await writeFile(path.join(root, file), JSON.stringify({ date: '2026-09-19', entries: [], period_days: 30, slug: 'rust' }));
    await assert.rejects(loadCardJobs(root, manifest), /differs/u);
  }
});

test('preview contains request failures, handles missing fallback and preserves ordinary responses', async (t) => {
  const root = await fixture(t);
  const dist = path.join(root, 'dist');
  await mkdir(dist);
  await writeFile(path.join(dist, 'index.html'), 'preview fixture');
  await writeFile(path.join(root, 'private.txt'), 'outside fixture');
  await symlink(path.join(root, 'private.txt'), path.join(dist, 'linked.txt'));
  const server = createPreviewServer({ dist, basePath: '/app' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (url, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
  assert.equal((await request('/app/%')).status, 400);
  assert.equal((await request('/app/missing')).status, 404);
  assert.equal((await request('/app/linked.txt')).status, 404);
  assert.equal((await request('/app/', 'POST')).status, 405);
  const okay = await request('/app/', 'GET', { 'accept-encoding': 'gzip', host: 'invalid host' });
  assert.equal(okay.status, 200);
  assert.equal(gunzipSync(okay.body).toString(), 'preview fixture');
  assert.equal((await request('/app/', 'HEAD')).body.length, 0);
  for (const [name, contentType] of [['brand.svg', 'image/svg+xml'], ['art.webp', 'image/webp']]) {
    await writeFile(path.join(dist, name), 'fixture asset');
    const asset = await request(`/app/${name}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['content-type'], contentType);
  }
  await writeFile(path.join(dist, '404.html'), 'missing fixture');
  const missing = await request('/app/not-found');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.toString(), 'missing fixture');
});
