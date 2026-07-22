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
  'data/schema/event-live.schema.json',
  'data/schema/event-category-pool.schema.json',
  'data/schema/alltime.schema.json',
  'data/schema/alltime-index.schema.json',
  'data/schema/localization.schema.json',
  'data/schema/classification-index.schema.json',
  'data/schema/classification-repositories.schema.json',
  'data/events/index.json',
  'events/live/index.html',
  'events/yesterday/index.html',
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
for (const marker of [
  'https://github.com/728792899-create/open-source-star-rank',
  'GitHub 仓库 ↗',
  '复用声明 ↗',
]) {
  if (!indexHtml.includes(marker)) throw new Error(`Homepage is missing repository disclosure ${marker}`);
}

const dataIndex = JSON.parse(await readFile(path.join(dist, 'data/index.json'), 'utf8'));
if (!['1.1.0', '1.2.0', '1.3.0', '1.4.0'].includes(dataIndex.schema_version) || dataIndex.freshness_threshold_hours !== 36) {
  throw new Error('Published index does not satisfy a supported public contract');
}
const eventIndex = JSON.parse(await readFile(path.join(dist, 'data/events/index.json'), 'utf8'));
if (!['1.0.0', '1.1.0', '1.2.0', '1.3.0'].includes(eventIndex.schema_version) || eventIndex.freshness_threshold_hours !== 36) {
  throw new Error('Published event index does not satisfy a supported public contract');
}
const eventLivePath = path.join(dist, 'data/events/live.json');
const eventLive = existsSync(eventLivePath) ? JSON.parse(await readFile(eventLivePath, 'utf8')) : null;
if (eventLive) {
  if (!['1.0.0', '1.1.0'].includes(eventLive.schema_version) || eventLive.provisional !== true
    || eventLive.methodology_version !== 'gharchive-hourly-public-watch-events-live-v1') {
    throw new Error('Published live event ranking does not satisfy the 1.0.0 contract');
  }
  if (eventLive.source_metrics.observed_hour_count < 1 || eventLive.source_metrics.observed_hour_count >= 24
    || eventLive.source_metrics.source_files.length !== eventLive.source_metrics.observed_hour_count
    || eventLive.source_metrics.missing_completed_hours.length !== 0) {
    throw new Error('Published live event ranking has invalid completed-hour coverage');
  }
  if (eventLive.entry_count !== eventLive.entries.length || eventLive.entries.length > eventLive.ranking_limit) {
    throw new Error('Published live event ranking has inconsistent entry counts');
  }
  for (const [offset, entry] of eventLive.entries.entries()) {
    if (entry.rank !== offset + 1) throw new Error('Published live event ranking has non-contiguous ranks');
  }
  const expectedLivePages = Math.ceil(eventLive.entries.length / 100);
  for (let page = 2; page <= expectedLivePages; page += 1) {
    if (!existsSync(path.join(dist, 'events', 'live', 'page', String(page), 'index.html'))) {
      throw new Error(`Published live event ranking is missing page ${page}`);
    }
  }
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
if (['1.2.0', '1.3.0'].includes(eventIndex.schema_version) && eventIndex.status === 'ready') {
  if (eventIndex.methodology_version !== 'gharchive-public-watch-events-v3') {
    throw new Error('Event index is missing the v3 methodology');
  }
  if (eventIndex.ranking_limit !== 500 || eventIndex.page_size !== 100) {
    throw new Error('Event index does not declare Top 500 pagination');
  }
  const metrics = eventIndex.latest_source_metrics;
  if (metrics?.expected_hour_count !== 24 || metrics?.observed_hour_count !== 24 || metrics?.missing_hours?.length !== 0) {
    throw new Error('Event index does not prove complete WatchEvent hourly coverage');
  }
  if (metrics?.ranking_complete !== true || metrics?.metadata_success_count !== 500) {
    throw new Error('Event index is not a complete Top 500');
  }
  if (!['calibrating', 'passed'].includes(metrics?.quality_status)) {
    throw new Error('Event index has no valid historical quality status');
  }
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
if (['1.2.0', '1.3.0', '1.4.0'].includes(dataIndex.schema_version)) {
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
if (['1.3.0', '1.4.0'].includes(dataIndex.schema_version)
  && (dataIndex.ranking_limit !== 500 || dataIndex.page_size !== 100)) {
  throw new Error('Published index does not declare Top 500 pagination');
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
  const dailyRanking = JSON.parse(await readFile(dailyJson, 'utf8'));
  if (['1.3.0', '1.4.0'].includes(dailyRanking.schema_version)) {
    if (dailyRanking.ranking_limit !== 500 || dailyRanking.entry_count !== dailyRanking.entries.length) {
      throw new Error('Latest daily ranking does not satisfy the Top 500 contract');
    }
    const expectedPages = Math.ceil(dailyRanking.entry_count / 100);
    for (let page = 1; page <= expectedPages; page += 1) {
      const pagePath = page === 1
        ? dailyPage
        : path.join(dist, 'daily', date, 'page', String(page), 'index.html');
      if (!existsSync(pagePath)) throw new Error(`Latest daily ranking is missing page ${page}`);
      const html = await readFile(pagePath, 'utf8');
      const ranks = [...html.matchAll(/data-rank="(\d+)"/g)].map((match) => Number(match[1]));
      const expectedStart = (page - 1) * 100 + 1;
      if (ranks.length !== Math.min(100, dailyRanking.entry_count - expectedStart + 1) || ranks[0] !== expectedStart) {
        throw new Error(`Latest daily ranking page ${page} has incorrect global ranks`);
      }
    }
  }
  const sitemap = await readFile(path.join(dist, 'sitemap-0.xml'), 'utf8');
  if (!sitemap.includes(`<lastmod>${new Date(JSON.parse(await readFile(dailyJson, 'utf8')).window_end).toISOString()}</lastmod>`)) {
    throw new Error('Historical sitemap entry is missing the ranking window lastmod');
  }
}
if (dataIndex.status === 'initializing' && dataIndex.sampling?.next_scheduled_at) {
  for (const relative of ['daily/index.html', 'period/7d/index.html', 'period/30d/index.html']) {
    const html = await readFile(path.join(dist, relative), 'utf8');
    if (!html.includes('data-update-countdown') || !html.includes(dataIndex.sampling.next_scheduled_at)) {
      throw new Error(`Initializing ranking page is missing its next-update countdown: ${relative}`);
    }
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
  if (['1.2.0', '1.3.0'].includes(eventRanking.schema_version)) {
    if (eventRanking.ranking_limit !== 500 || eventRanking.entry_count !== 500 || eventRanking.entries.length !== 500) {
      throw new Error('Latest event ranking is not a complete Top 500');
    }
    const seen = new Set();
    for (let page = 1; page <= 5; page += 1) {
      const pagePath = page === 1
        ? path.join(dist, 'events', 'daily', date, 'index.html')
        : path.join(dist, 'events', 'daily', date, 'page', String(page), 'index.html');
      if (!existsSync(pagePath)) throw new Error(`Latest event ranking is missing page ${page}`);
      const html = await readFile(pagePath, 'utf8');
      const ranks = [...html.matchAll(/data-rank="(\d+)"/g)].map((match) => Number(match[1]));
      if (ranks.length !== 100 || ranks[0] !== (page - 1) * 100 + 1 || ranks.at(-1) !== page * 100) {
        throw new Error(`Latest event ranking page ${page} has incorrect global ranks`);
      }
      for (const rank of ranks) {
        if (seen.has(rank)) throw new Error(`Latest event ranking duplicates global rank ${rank}`);
        seen.add(rank);
      }
      if (page > 1 && (!html.includes('rel="prev"') || (page < 5 && !html.includes('rel="next"')))) {
        throw new Error(`Latest event ranking page ${page} is missing prev/next relations`);
      }
    }
  }
  const sitemap = await readFile(path.join(dist, 'sitemap-0.xml'), 'utf8');
  if (!sitemap.includes(`<lastmod>${new Date(eventRanking.window_end).toISOString()}</lastmod>`)) {
    throw new Error('Event sitemap entry is missing the ranking window lastmod');
  }
}

const eventIsDefault = Boolean(eventLive?.entries.length) || (eventIndex.status === 'ready' && Boolean(eventIndex.latest_date));
const eventYesterdayHtml = await readFile(path.join(dist, 'events', 'yesterday', 'index.html'), 'utf8');
if (eventLive?.entries.length) {
  const eventLiveHtml = await readFile(path.join(dist, 'events', 'live', 'index.html'), 'utf8');
  for (const marker of ['data-ranking-mode="event"', '今日实时新增 Star 排行', '每小时更新', 'GH Archive']) {
    if (!eventLiveHtml.includes(marker)) throw new Error(`Live-event page is missing ${marker}`);
  }
} else if (eventIsDefault) {
  for (const marker of ['data-ranking-mode="event"', '昨日完整新增 Star 排行', 'GH Archive']) {
    if (!eventYesterdayHtml.includes(marker)) throw new Error(`Complete-event page is missing ${marker}`);
  }
} else {
  for (const marker of ['GitHub public events · 完整榜初始化', '全站公开事件', '24 小时覆盖']) {
    if (!eventYesterdayHtml.includes(marker)) throw new Error(`Event initialization page is missing ${marker}`);
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
  if (!['1.0.0', '1.1.0'].includes(allTimeIndex.schema_version)
    || !['1.0.0', '1.1.0'].includes(allTimeBoard.schema_version)
    || allTimeBoard.entry_count !== allTimeBoard.entries.length) {
    throw new Error('Published all-time board does not satisfy a supported public contract');
  }
  if (allTimeBoard.schema_version === '1.1.0'
    && (allTimeBoard.ranking_limit !== 1000 || allTimeBoard.entry_count !== 1000 || allTimeBoard.entries.length !== 1000)) {
    throw new Error('Published all-time board 1.1.0 is not a complete Top 1000');
  }
  const allTimeHtml = await readFile(path.join(dist, 'all-time', 'index.html'), 'utf8');
  const expectedAllTimeIds = allTimeBoard.entries.map((entry) => String(entry.repository_id));
  if (JSON.stringify(rowIds(allTimeHtml)) !== JSON.stringify(expectedAllTimeIds)) {
    throw new Error('All-time page rows do not match the published all-time board');
  }
}

console.log(`Validated static build (${dataIndex.status})`);
