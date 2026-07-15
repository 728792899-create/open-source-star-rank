import type { APIRoute } from 'astro';
import { readDailyRanking, readLocalizationCatalog, readRankingIndex } from '../lib/data';
import { localizedRepositoryContent } from '../lib/localization';
import { withBase } from '../lib/paths';

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL('https://728792899-create.github.io/open-source-star-rank/');
  const index = readRankingIndex();
  const localization = readLocalizationCatalog();
  const self = new URL(withBase('/atom.xml'), origin).toString();
  const home = new URL(withBase('/'), origin).toString();
  const entries = index.available_dates.slice(0, 30).map((date) => {
    const ranking = readDailyRanking(date);
    const link = new URL(withBase(`/daily/${date}/`), origin).toString();
    const top = ranking.entries.slice(0, 10).map((entry) => {
      const content = localizedRepositoryContent(localization, entry.repository_id, entry.full_name, entry.description);
      return `#${entry.rank} ${content.displayName}（${entry.full_name}，${entry.stars_gained >= 0 ? '+' : ''}${entry.stars_gained}）`;
    }).join('；');
    return `<entry><id>${xml(link)}</id><title>${date} GitHub Star 净增排行</title><link href="${xml(link)}"/><updated>${new Date(ranking.window_end).toISOString()}</updated><summary>${xml(`当日 Top 10：${top}`)}</summary></entry>`;
  }).join('');
  const updated = index.updated_at ? new Date(index.updated_at).toISOString() : new Date(0).toISOString();
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>${xml(home)}</id><title>开源星榜</title><link href="${xml(home)}"/><link rel="self" href="${xml(self)}"/><updated>${updated}</updated>${entries}</feed>\n`, { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } });
};
