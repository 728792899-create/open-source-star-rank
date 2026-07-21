import type { APIRoute } from 'astro';
import { readDailyRanking, readLocalizationCatalog, readRankingIndex } from '../lib/data';
import { localizedRepositoryContent } from '../lib/localization';
import { withBase } from '../lib/paths';

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL('https://728792899-create.github.io/open-source-star-rank/');
  const index = readRankingIndex();
  const localization = readLocalizationCatalog();
  const home = new URL(withBase('/'), origin).toString();
  const feed = new URL(withBase('/feed.json'), origin).toString();
  const items = index.available_dates.slice(0, 30).map((date) => {
    const ranking = readDailyRanking(date);
    const url = new URL(withBase(`/daily/${date}/`), origin).toString();
    const top = ranking.entries.slice(0, 10).map((entry) => {
      const content = localizedRepositoryContent(localization, entry.repository_id, entry.full_name, entry.description);
      return `#${entry.rank} ${content.displayName}（${entry.full_name}，${entry.stars_gained >= 0 ? '+' : ''}${entry.stars_gained}）`;
    }).join('；');
    return { id: url, url, title: `${date} GitHub 昨日 Star 净增排行`, content_text: `昨日 Top 10：${top}`, date_published: new Date(ranking.window_end).toISOString() };
  });
  return Response.json({ version: 'https://jsonfeed.org/version/1.1', title: '开源星榜', home_page_url: home, feed_url: feed, language: 'zh-CN', items }, { headers: { 'Content-Type': 'application/feed+json; charset=utf-8' } });
};
