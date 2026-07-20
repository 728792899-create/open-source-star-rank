import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'open-source-star-rank';
const site = process.env.SITE_URL ?? `https://728792899-create.github.io/${repository}`;
const base = process.env.BASE_PATH ?? '/';
const siteRoot = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(process.env.STAR_RANK_DATA_DIR ?? path.join(siteRoot, 'seed-data'));
const lastModifiedByPath = new Map();
const rememberLatest = (route, value) => {
  const next = new Date(value);
  const previous = lastModifiedByPath.get(route);
  if (!Number.isNaN(next.getTime()) && (!previous || next > previous)) lastModifiedByPath.set(route, next);
};
const rememberRankingPages = (route, ranking) => {
  const modified = new Date(ranking.window_end);
  lastModifiedByPath.set(route, modified);
  const pages = Math.ceil((ranking.entries?.length ?? 0) / 100);
  for (let page = 2; page <= pages; page += 1) lastModifiedByPath.set(`${route}page/${page}/`, modified);
};
try {
  const index = JSON.parse(readFileSync(path.join(dataRoot, 'index.json'), 'utf8'));
  if (index.updated_at) {
    rememberLatest('/status/', index.updated_at);
  }
  for (const date of index.available_dates ?? []) {
    const ranking = JSON.parse(readFileSync(path.join(dataRoot, 'daily', `${date}.json`), 'utf8'));
    rememberRankingPages(`/daily/${date}/`, ranking);
  }
  const eventIndexPath = path.join(dataRoot, 'events', 'index.json');
  if (existsSync(eventIndexPath)) {
    const eventIndex = JSON.parse(readFileSync(eventIndexPath, 'utf8'));
    if (eventIndex.updated_at) {
      rememberLatest('/', eventIndex.updated_at);
      rememberLatest('/status/', eventIndex.updated_at);
    }
    for (const date of eventIndex.available_dates ?? []) {
      const ranking = JSON.parse(readFileSync(path.join(dataRoot, 'events', 'daily', `${date}.json`), 'utf8'));
      rememberRankingPages(`/events/daily/${date}/`, ranking);
    }
  }
  for (const range of ['7d', '30d']) {
    for (const date of index.periods?.[range]?.available_dates ?? []) {
      const ranking = JSON.parse(readFileSync(path.join(dataRoot, 'period', range, `${date}.json`), 'utf8'));
      rememberRankingPages(`/period/${range}/${date}/`, ranking);
      if (date === index.periods?.[range]?.latest_date) lastModifiedByPath.set(`/period/${range}/`, new Date(ranking.window_end));
    }
  }
  const languages = JSON.parse(readFileSync(path.join(dataRoot, 'language', 'index.json'), 'utf8'));
  if (languages.updated_at) lastModifiedByPath.set('/language/', new Date(languages.updated_at));
  for (const language of languages.languages ?? []) {
    for (const date of language.available_dates ?? []) {
      const ranking = JSON.parse(readFileSync(path.join(dataRoot, 'language', language.slug, 'daily', `${date}.json`), 'utf8'));
      rememberRankingPages(`/language/${language.slug}/daily/${date}/`, ranking);
    }
  }
  const repositories = JSON.parse(readFileSync(path.join(dataRoot, 'repositories.json'), 'utf8'));
  for (const repository of repositories.repositories ?? []) {
    lastModifiedByPath.set(`/repo/${repository.repository_id}/`, new Date(repositories.updated_at));
  }
  const classification = JSON.parse(readFileSync(path.join(dataRoot, 'classification', 'index.json'), 'utf8'));
  if (classification.generated_at) {
    const classifiedAt = new Date(classification.generated_at);
    lastModifiedByPath.set('/category/', classifiedAt);
    for (const category of classification.categories ?? []) {
      lastModifiedByPath.set(`/category/${category.id}/`, classifiedAt);
    }
  }
} catch {
  // prepare-data and the build validator provide the actionable data error.
}

export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
  integrations: [sitemap({
    serialize(item) {
      const pathname = new URL(item.url).pathname;
      const basePrefix = base === '/' ? '' : base.replace(/\/$/, '');
      const route = basePrefix && pathname.startsWith(basePrefix) ? pathname.slice(basePrefix.length) : pathname;
      return lastModifiedByPath.has(route) ? { ...item, lastmod: lastModifiedByPath.get(route) } : item;
    },
  })],
});
