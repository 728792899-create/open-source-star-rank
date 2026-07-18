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
  'category/index.html',
  'board/index.html',
  'all-time/index.html',
  'data/index.json',
  'data/schema/index.schema.json',
  'data/schema/daily.schema.json',
  'data/schema/state.schema.json',
  'data/schema/snapshot.schema.json',
  'data/schema/language.schema.json',
  'data/schema/language-index.schema.json',
  'data/schema/period.schema.json',
  'data/schema/repositories.schema.json',
  'data/schema/event-index.schema.json',
  'data/schema/event-daily.schema.json',
  'data/schema/event-category-pool.schema.json',
  'data/schema/alltime.schema.json',
  'data/schema/alltime-index.schema.json',
  'data/schema/localization.schema.json',
  'data/schema/classification-index.schema.json',
  'data/schema/classification-repositories.schema.json',
  'data/events/index.json',
  'data/i18n/zh-CN/repositories.json',
  'data/classification/index.json',
  'data/classification/repositories.json',
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
for (const marker of ['data-project-language="zh"', 'data-project-language="original"', '项目内容']) {
  if (!indexHtml.includes(marker)) throw new Error(`Homepage is missing localization control ${marker}`);
}

const dataIndex = JSON.parse(await readFile(path.join(dist, 'data/index.json'), 'utf8'));
if (!['1.1.0', '1.2.0'].includes(dataIndex.schema_version) || dataIndex.freshness_threshold_hours !== 36) {
  throw new Error('Published index does not satisfy a supported public contract');
}
const eventIndex = JSON.parse(await readFile(path.join(dist, 'data/events/index.json'), 'utf8'));
if (!['1.0.0', '1.1.0'].includes(eventIndex.schema_version) || eventIndex.freshness_threshold_hours !== 36) {
  throw new Error('Published event index does not satisfy a supported public contract');
}
if (eventIndex.schema_version === '1.1.0' && eventIndex.status === 'ready') {
  if (eventIndex.methodology_version !== 'gharchive-public-watch-events-v2') {
    throw new Error('Event index 1.1.0 is missing the v2 methodology');
  }
  const metrics = eventIndex.latest_source_metrics;
  if (metrics?.expected_hour_count !== 24 || metrics?.observed_hour_count !== 24 || metrics?.missing_hours?.length !== 0) {
    throw new Error('Event index 1.1.0 does not prove complete 24-hour coverage');
  }
  if (metrics?.ranking_complete !== true) throw new Error('Event index 1.1.0 is not a complete Top 100');
}
const localization = JSON.parse(await readFile(path.join(dist, 'data/i18n/zh-CN/repositories.json'), 'utf8'));
if (localization.schema_version !== '1.0.0' || localization.locale !== 'zh-CN') {
  throw new Error('Published localization catalog does not satisfy the 1.0.0 public contract');
}
if (localization.coverage.localized_count !== localization.repositories.length) {
  throw new Error('Published localization coverage is inconsistent');
}
const classificationIndex = JSON.parse(await readFile(path.join(dist, 'data/classification/index.json'), 'utf8'));
const classificationCatalog = JSON.parse(await readFile(path.join(dist, 'data/classification/repositories.json'), 'utf8'));
if (classificationIndex.schema_version !== '1.0.0' || classificationIndex.taxonomy_version !== '1.0.0') {
  throw new Error('Published classification index does not satisfy the 1.0.0 public contract');
}
if (classificationIndex.coverage.classified_count !== classificationCatalog.repositories.length) {
  throw new Error('Published classification coverage is inconsistent');
}
for (const category of classificationIndex.categories) {
  if (!existsSync(path.join(dist, 'category', category.id, 'index.html'))) {
    throw new Error(`Classification page is missing: ${category.id}`);
  }
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
}

if (eventIndex.status === 'ready') {
  const date = eventIndex.latest_date;
  for (const relative of [
    `events/daily/${date}/index.html`,
    `data/events/daily/${date}.json`,
    `social/events-daily-${date}.png`,
  ]) {
    if (!existsSync(path.join(dist, relative))) throw new Error(`Ready event build is missing ${relative}`);
  }
  const eventRanking = JSON.parse(await readFile(path.join(dist, 'data', 'events', 'daily', `${date}.json`), 'utf8'));
  const sitemap = await readFile(path.join(dist, 'sitemap-0.xml'), 'utf8');
  if (!sitemap.includes(`<lastmod>${new Date(eventRanking.window_end).toISOString()}</lastmod>`)) {
    throw new Error('Event sitemap entry is missing the ranking window lastmod');
  }
}

const eventIsDefault = eventIndex.status === 'ready' && Boolean(eventIndex.latest_date);
if (eventIsDefault) {
  for (const marker of ['data-ranking-mode="event"', '全站公开事件新增榜', 'GH Archive']) {
    if (!indexHtml.includes(marker)) throw new Error(`Event-first homepage is missing ${marker}`);
  }
} else {
  for (const marker of ['全站公开事件', '24 小时覆盖', '候选池净增榜']) {
    if (!indexHtml.includes(marker)) throw new Error(`Event initialization page is missing ${marker}`);
  }
}

const poolPath = eventIndex.latest_date
  ? path.join(dist, 'data', 'events', 'category', `${eventIndex.latest_date}.json`)
  : null;
const pool = poolPath && existsSync(poolPath) ? JSON.parse(await readFile(poolPath, 'utf8')) : null;
const classificationById = new Map(classificationCatalog.repositories.map((item) => [item.repository_id, item]));
const sortPool = (entries) => [...entries].sort((left, right) =>
  right.stars_added - left.stars_added
  || right.watch_events - left.watch_events
  || right.stars_total - left.stars_total
  || left.full_name.toLocaleLowerCase().localeCompare(right.full_name.toLocaleLowerCase()));
const rowIds = (html) => [...html.matchAll(/id="repo-(\d+)"[^>]*data-ranking-row/g)].map((match) => match[1]);
for (const category of classificationIndex.categories) {
  const expectedIds = pool
    ? sortPool(pool.entries.filter((entry) => classificationById.get(entry.repository_id)?.primary_category === category.id))
      .slice(0, 100)
      .map((entry) => String(entry.repository_id))
    : [];
  const categoryHtml = await readFile(path.join(dist, 'category', category.id, 'index.html'), 'utf8');
  const actualIds = rowIds(categoryHtml);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`Category board ${category.id} does not match the extended pool top 100`);
  }
  const expectedRobots = expectedIds.length ? 'index,follow' : 'noindex,follow';
  if (!categoryHtml.includes(`name="robots" content="${expectedRobots}"`)) {
    throw new Error(`Category board ${category.id} has an incorrect robots policy`);
  }
}

const allTimeIndexPath = path.join(dist, 'data', 'alltime', 'index.json');
if (existsSync(allTimeIndexPath)) {
  const allTimeIndex = JSON.parse(await readFile(allTimeIndexPath, 'utf8'));
  const allTimeBoard = JSON.parse(await readFile(path.join(dist, 'data', 'alltime', 'top-1000.json'), 'utf8'));
  if (allTimeIndex.schema_version !== '1.0.0' || allTimeBoard.entry_count !== allTimeBoard.entries.length) {
    throw new Error('Published all-time board does not satisfy the 1.0.0 public contract');
  }
  const allTimeHtml = await readFile(path.join(dist, 'all-time', 'index.html'), 'utf8');
  const expectedAllTimeIds = allTimeBoard.entries.map((entry) => String(entry.repository_id));
  if (JSON.stringify(rowIds(allTimeHtml)) !== JSON.stringify(expectedAllTimeIds)) {
    throw new Error('All-time page rows do not match the published all-time board');
  }
}

console.log(`Validated static build (${dataIndex.status})`);
