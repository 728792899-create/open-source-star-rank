import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadCardJobs } from './social-card-inputs.mjs';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.join(siteRoot, 'generated', 'data');
const outputRoot = path.join(siteRoot, 'public', 'social');
const fontFile = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
].find((candidate) => existsSync(candidate));
const localizationPath = path.join(dataRoot, 'i18n', 'zh-CN', 'repositories.json');
const localization = existsSync(localizationPath)
  ? JSON.parse(await readFile(localizationPath, 'utf8'))
  : { repositories: [] };
const localizedNames = new Map(localization.repositories.map((entry) => [entry.repository_id, entry.display_name_zh]));
const withLocalizedNames = (ranking) => ({
  ...ranking,
  entries: ranking.entries.map((entry) => ({ ...entry, display_name_zh: localizedNames.get(entry.repository_id) ?? null })),
});

const jobs = (await loadCardJobs(dataRoot, path.join(siteRoot, 'generated', 'social-cards.json')))
  .map((job) => ({ ...job, ranking: withLocalizedNames(job.ranking) }));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const queue = [...jobs];
async function renderQueue() {
  const worker = new Worker(new URL('./render-social-card-worker.mjs', import.meta.url), { workerData: { outputRoot } });
  try {
    while (queue.length) {
      const job = queue.shift();
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
        const onError = (error) => { cleanup(); reject(error); };
        const onExit = (code) => onError(new Error(`Card renderer exited before replying (${code})`));
        const timer = setTimeout(() => onError(new Error('Card renderer timed out')), 30_000);
        const onMessage = (message) => {
          cleanup();
          message.ok ? resolve() : reject(new Error(message.error));
        };
        worker.once('error', onError);
        worker.once('exit', onExit);
        worker.once('message', onMessage);
        worker.postMessage({ ...job, fontFile });
      });
    }
  } finally {
    await worker.terminate();
  }
}
await Promise.all(Array.from({ length: Math.min(jobs.length, availableParallelism(), 4) }, renderQueue));
console.log(`Generated ${jobs.length} social ranking card(s)`);
