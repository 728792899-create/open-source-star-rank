import type { APIRoute } from 'astro';
import { readDailyRanking, readLocalizationCatalog, readRankingIndex } from '../lib/data';
import { localizedRepositoryContent } from '../lib/localization';
import { withBase } from '../lib/paths';

const escapeXml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL('https://728792899-create.github.io/open-source-star-rank/');
  const index = readRankingIndex();
  const localization = readLocalizationCatalog();
  const channelUrl = new URL(withBase('/'), origin).toString();
  const feedUrl = new URL(withBase('/rss.xml'), origin).toString();
  const items = index.available_dates.slice(0, 30).map((date) => {
    const ranking = readDailyRanking(date);
    const link = new URL(withBase(`/daily/${date}/`), origin).toString();
    const top = ranking.entries.slice(0, 10).map((entry) => {
      const content = localizedRepositoryContent(localization, entry.repository_id, entry.full_name, entry.description);
      return `#${entry.rank} ${content.displayName}（${entry.full_name}，${entry.stars_gained >= 0 ? '+' : ''}${entry.stars_gained}）`;
    }).join('；');
    return [
      '<item>',
      `<title>${escapeXml(`${date} GitHub 昨日 Star 净增排行`)}</title>`,
      `<link>${escapeXml(link)}</link>`,
      `<guid isPermaLink="true">${escapeXml(link)}</guid>`,
      `<pubDate>${new Date(ranking.window_end).toUTCString()}</pubDate>`,
      `<description>${escapeXml(`当日 Top 10：${top}`)}</description>`,
      '</item>',
    ].join('');
  }).join('');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>开源星榜｜GitHub 开源项目昨日 Star 净增排行</title><link>${escapeXml(channelUrl)}</link><description>GitHub 开源项目候选池昨日 Star 净增观测榜</description><language>zh-CN</language><atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>${items}</channel></rss>\n`;
  return new Response(body, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};
