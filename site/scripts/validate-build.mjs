import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(siteRoot, 'dist');
const required = [
  'index.html',
  '404.html',
  'methodology/index.html',
  'status/index.html',
  'period/7d/index.html',
  'period/30d/index.html',
  'language/index.html',
  'data/index.json',
  'data/schema/index.schema.json',
  'data/schema/daily.schema.json',
  'data/schema/state.schema.json',
  'data/schema/snapshot.schema.json',
  'data/schema/language.schema.json',
  'data/schema/language-index.schema.json',
  'data/schema/period.schema.json',
  'data/schema/repositories.schema.json',
  'og.png',
  'robots.txt',
  'rss.xml',
  'atom.xml',
  'feed.json',
  'sitemap-index.xml',
];
for (const relative of required) {
  if (!existsSync(path.join(dist, relative))) throw new Error(`Build is missing ${relative}`);
}

const indexHtml = await readFile(path.join(dist, 'index.html'), 'utf8');
for (const marker of ['lang="zh-CN"', 'rel="canonical"', 'application/ld+json', 'property="og:image"', '开源星榜']) {
  if (!indexHtml.includes(marker)) throw new Error(`Homepage is missing ${marker}`);
}

const dataIndex = JSON.parse(await readFile(path.join(dist, 'data/index.json'), 'utf8'));
if (!['1.1.0', '1.2.0'].includes(dataIndex.schema_version) || dataIndex.freshness_threshold_hours !== 36) {
  throw new Error('Published index does not satisfy a supported public contract');
}
const rss = await readFile(path.join(dist, 'rss.xml'), 'utf8');
if (!rss.includes('<rss version="2.0">') || !rss.includes('开源星榜')) {
  throw new Error('RSS feed is invalid');
}
const atom = await readFile(path.join(dist, 'atom.xml'), 'utf8');
if (!atom.includes('xmlns="http://www.w3.org/2005/Atom"') || !atom.includes('开源星榜')) throw new Error('Atom feed is invalid');
const jsonFeed = JSON.parse(await readFile(path.join(dist, 'feed.json'), 'utf8'));
if (jsonFeed.version !== 'https://jsonfeed.org/version/1.1' || !Array.isArray(jsonFeed.items)) throw new Error('JSON Feed is invalid');
if (dataIndex.schema_version === '1.2.0') {
  for (const relative of ['data/repositories.json', 'data/language/index.json']) {
    if (!existsSync(path.join(dist, relative))) throw new Error(`1.2 build is missing ${relative}`);
  }
  if (!dataIndex.sampling || !dataIndex.periods) throw new Error('1.2 index is missing sampling availability');
  const repositories = JSON.parse(await readFile(path.join(dist, 'data/repositories.json'), 'utf8'));
  if (repositories.repositories.length !== repositories.candidate_count) throw new Error('Repository catalog count is inconsistent');
  for (const repository of repositories.repositories.slice(0, 3)) {
    if (!existsSync(path.join(dist, 'repo', String(repository.repository_id), 'index.html'))) throw new Error(`Repository page is missing: ${repository.repository_id}`);
  }
}
if (dataIndex.status === 'ready') {
  const date = dataIndex.latest_date;
  const dailyPage = path.join(dist, 'daily', date, 'index.html');
  const dailyJson = path.join(dist, 'data', 'daily', `${date}.json`);
  if (!existsSync(dailyPage) || !existsSync(dailyJson)) {
    throw new Error(`Latest ranking ${date} is not published as HTML and JSON`);
  }
  if (!existsSync(path.join(dist, 'social', `daily-${date}.png`))) throw new Error(`Daily social card is missing for ${date}`);
  const dailyHtml = await readFile(dailyPage, 'utf8');
  for (const marker of ['data-ranking-row', 'ItemList', 'data-date-selector', 'data-copy-ranking', 'rel="canonical"']) {
    if (!dailyHtml.includes(marker)) throw new Error(`Daily ranking is missing ${marker}`);
  }
  const sitemap = await readFile(path.join(dist, 'sitemap-0.xml'), 'utf8');
  if (!sitemap.includes(`<lastmod>${new Date(JSON.parse(await readFile(dailyJson, 'utf8')).window_end).toISOString()}</lastmod>`)) {
    throw new Error('Historical sitemap entry is missing the ranking window lastmod');
  }
} else if (dataIndex.schema_version === '1.2.0') {
  for (const marker of ['有效基线 0/2', 'data-countdown', '不计入日榜基线']) {
    if (!indexHtml.includes(marker)) throw new Error(`Initialization page is missing ${marker}`);
  }
}

console.log(`Validated static build (${dataIndex.status})`);
