import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(siteRoot, '..');
const source = path.resolve(process.env.STAR_RANK_DATA_DIR ?? path.join(siteRoot, 'seed-data'));
const generated = path.join(siteRoot, 'generated', 'data');
const publicData = path.join(siteRoot, 'public', 'data');
const schemaSource = path.join(repositoryRoot, 'schemas', 'star-rank');
const run = promisify(execFile);

if (!existsSync(path.join(source, 'index.json'))) {
  throw new Error(`Missing star rank index: ${path.join(source, 'index.json')}`);
}

const index = JSON.parse(await readFile(path.join(source, 'index.json'), 'utf8'));
if (!Array.isArray(index.available_dates) || !['initializing', 'ready'].includes(index.status)) {
  throw new Error('Invalid star rank index schema');
}
for (const date of index.available_dates) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !existsSync(path.join(source, 'daily', `${date}.json`))) {
    throw new Error(`Index references a missing or invalid daily ranking: ${date}`);
  }
}

await rm(generated, { recursive: true, force: true });
await rm(publicData, { recursive: true, force: true });
await mkdir(path.dirname(generated), { recursive: true });
await mkdir(path.dirname(publicData), { recursive: true });
await cp(source, generated, { recursive: true });
await cp(source, publicData, { recursive: true });
await cp(schemaSource, path.join(generated, 'schema'), { recursive: true, force: true });
await cp(schemaSource, path.join(publicData, 'schema'), { recursive: true, force: true });

const eventIndexPath = path.join(generated, 'events', 'index.json');
if (!existsSync(eventIndexPath)) {
  const eventIndex = {
    schema_version: '1.0.0',
    status: 'initializing',
    timezone: 'Asia/Shanghai',
    updated_at: null,
    latest_date: null,
    available_dates: [],
    methodology_version: 'gharchive-public-watch-events-v1',
    freshness_threshold_hours: 36,
    latest_source_metrics: null,
  };
  const serialized = `${JSON.stringify(eventIndex, null, 2)}\n`;
  await mkdir(path.dirname(eventIndexPath), { recursive: true });
  await mkdir(path.join(publicData, 'events'), { recursive: true });
  await writeFile(eventIndexPath, serialized);
  await writeFile(path.join(publicData, 'events', 'index.json'), serialized);
}

await run(process.env.PYTHON ?? 'python3', [
  path.join(repositoryRoot, 'tools', 'localize_repositories.py'),
  '--data-dir',
  generated,
  '--overrides-file',
  path.join(repositoryRoot, 'data', 'localization-overrides.zh-CN.json'),
  '--offline',
  '--public-only',
  '--deterministic',
]);
await rm(path.join(publicData, 'i18n'), { recursive: true, force: true });
await cp(path.join(generated, 'i18n'), path.join(publicData, 'i18n'), { recursive: true });

await run(process.env.PYTHON ?? 'python3', [
  path.join(repositoryRoot, 'tools', 'classify_repositories.py'),
  '--data-dir',
  generated,
  '--taxonomy-file',
  path.join(repositoryRoot, 'data', 'classification-taxonomy.zh-CN.json'),
  '--overrides-file',
  path.join(repositoryRoot, 'data', 'classification-overrides.zh-CN.json'),
  '--offline',
  '--public-only',
  '--deterministic',
]);
await rm(path.join(publicData, 'classification'), { recursive: true, force: true });
await cp(path.join(generated, 'classification'), path.join(publicData, 'classification'), { recursive: true });

await run(process.env.PYTHON ?? 'python3', [
  path.join(repositoryRoot, 'tools', 'validate_star_rank_data.py'),
  '--data-dir',
  generated,
]);

console.log(`Prepared ${index.available_dates.length} ranking day(s) from ${source}`);
