import { readFile } from 'node:fs/promises';
import path from 'node:path';

const patterns = {
  daily: /^daily\/(\d{4}-\d{2}-\d{2})\.json$/u,
  period: /^period\/(7|30)d\/(\d{4}-\d{2}-\d{2})\.json$/u,
  language: /^language\/([a-z0-9-]+)\/daily\/(\d{4}-\d{2}-\d{2})\.json$/u,
};

export function cardOutput(root, name) {
  if (typeof name !== 'string' || !/^(?:daily-\d{4}-\d{2}-\d{2}|period-(?:7|30)d-\d{4}-\d{2}-\d{2}|language-[a-z0-9-]+-\d{4}-\d{2}-\d{2})\.png$/u.test(name)) {
    throw new Error('Invalid social-card output name');
  }
  const output = path.resolve(root, name);
  if (path.dirname(output) !== path.resolve(root)) throw new Error('Social-card output outside root');
  return output;
}

export async function loadCardJobs(dataRoot, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest)) throw new Error('Invalid validated card manifest');
  const names = new Set();
  const jobs = [];
  for (const item of manifest) {
    const match = item && typeof item.path === 'string' && Object.hasOwn(patterns, item.kind)
      ? patterns[item.kind].exec(item.path) : null;
    if (!match) throw new Error('Invalid validated card path');
    const ranking = JSON.parse(await readFile(path.join(dataRoot, item.path), 'utf8'));
    const date = match.at(-1);
    if (ranking.date !== date || (item.kind === 'period' && ranking.period_days !== Number(match[1])) ||
        (item.kind === 'language' && ranking.slug !== match[1])) throw new Error('Card metadata differs from validated path');
    const name = item.kind === 'daily' ? `daily-${date}.png`
      : item.kind === 'period' ? `period-${match[1]}d-${date}.png` : `language-${match[1]}-${date}.png`;
    if (names.has(name)) throw new Error('Duplicate social-card output');
    names.add(name);
    const label = item.kind === 'daily' ? `昨日净增 Top ${ranking.ranking_limit ?? 100}`
      : item.kind === 'period' ? `${ranking.period_days} 日净增 Top ${ranking.ranking_limit ?? 100}`
      : `${ranking.language} Top ${ranking.ranking_limit ?? 50}`;
    jobs.push({ ranking, name, label });
  }
  return jobs;
}
