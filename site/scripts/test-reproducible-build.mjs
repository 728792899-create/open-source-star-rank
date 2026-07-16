import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  STAR_RANK_DATA_DIR: path.join(siteRoot, '.e2e-data'),
  SITE_URL: 'https://728792899-create.github.io/open-source-star-rank',
  BASE_PATH: '/open-source-star-rank',
  SOURCE_DATE_EPOCH: '1784132400',
};
const files = [
  'index.html',
  'daily/2026-07-14/index.html',
  'daily/2026-07-13/index.html',
  'data/index.json',
  'data/daily/2026-07-14.json',
  'data/daily/2026-07-13.json',
  'events/daily/2026-07-14/index.html',
  'data/events/index.json',
  'data/events/daily/2026-07-14.json',
  'period/7d/2026-07-14/index.html',
  'data/period/7d/2026-07-14.json',
  'language/typescript-ed0504f7/daily/2026-07-14/index.html',
  'data/language/typescript-ed0504f7/daily/2026-07-14.json',
  'repo/10001/index.html',
  'data/repositories.json',
  'category/index.html',
  'category/ai-machine-learning/index.html',
  'status/index.html',
  'methodology/index.html',
  'data/classification/index.json',
  'data/classification/repositories.json',
  'social/daily-2026-07-14.png',
  'social/events-daily-2026-07-14.png',
  'rss.xml',
  'atom.xml',
  'feed.json',
  'sitemap-0.xml',
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: siteRoot, env, stdio: 'inherit' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function hashes() {
  return Object.fromEntries(await Promise.all(files.map(async (relative) => {
    const contents = await readFile(path.join(siteRoot, 'dist', relative));
    return [relative, createHash('sha256').update(contents).digest('hex')];
  })));
}

await run(process.execPath, ['scripts/create-e2e-data.mjs']);
await run('npm', ['run', 'build']);
const first = await hashes();
await run('npm', ['run', 'build']);
const second = await hashes();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  throw new Error(`Build is not reproducible:\n${JSON.stringify({ first, second }, null, 2)}`);
}
console.log(`Verified ${files.length} reproducible HTML, JSON, feed, and social artifacts`);
