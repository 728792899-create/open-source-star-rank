import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.join(siteRoot, 'generated', 'data');
const outputRoot = path.join(siteRoot, 'public', 'social');
const fontFile = [
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
].find((candidate) => existsSync(candidate));

async function jsonFiles(root) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await jsonFiles(target));
    else if (entry.name.endsWith('.json') && entry.name !== 'index.json') found.push(target);
  }
  return found.sort();
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const jobs = [];
for (const file of await jsonFiles(path.join(dataRoot, 'daily'))) {
  const ranking = JSON.parse(await readFile(file, 'utf8'));
  jobs.push({ ranking, label: 'Daily Top 100', name: `daily-${ranking.date}.png` });
}
for (const file of await jsonFiles(path.join(dataRoot, 'events', 'daily'))) {
  const ranking = JSON.parse(await readFile(file, 'utf8'));
  jobs.push({ ranking, label: 'Public Event Top 100', name: `events-daily-${ranking.date}.png`, eventMode: true });
}
for (const file of await jsonFiles(path.join(dataRoot, 'period'))) {
  const ranking = JSON.parse(await readFile(file, 'utf8'));
  jobs.push({ ranking, label: `${ranking.period_days} Day Top 100`, name: `period-${ranking.period_days}d-${ranking.date}.png` });
}
for (const file of (await jsonFiles(path.join(dataRoot, 'language'))).filter((item) => !item.endsWith('/index.json'))) {
  const ranking = JSON.parse(await readFile(file, 'utf8'));
  jobs.push({ ranking, label: `${ranking.language} Top 50`, name: `language-${ranking.slug}-${ranking.date}.png` });
}
const queue = [...jobs];
async function renderQueue() {
  const worker = new Worker(new URL('./render-social-card-worker.mjs', import.meta.url));
  try {
    while (queue.length) {
      const job = queue.shift();
      await new Promise((resolve, reject) => {
        const onError = (error) => { worker.off('message', onMessage); reject(error); };
        const onMessage = (message) => {
          worker.off('error', onError);
          message.ok ? resolve() : reject(new Error(message.error));
        };
        worker.once('error', onError);
        worker.once('message', onMessage);
        worker.postMessage({ ...job, output: path.join(outputRoot, job.name), fontFile });
      });
    }
  } finally {
    await worker.terminate();
  }
}
await Promise.all(Array.from({ length: Math.min(jobs.length, availableParallelism(), 4) }, renderQueue));
console.log(`Generated ${jobs.length} social ranking card(s)`);
