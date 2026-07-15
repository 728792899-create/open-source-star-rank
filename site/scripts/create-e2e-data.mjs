import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(siteRoot, '..');
const outputRoot = path.join(siteRoot, '.e2e-data');
const schemaRoot = path.join(repositoryRoot, 'schemas', 'star-rank');
const latestDate = new Date('2026-07-14T12:00:00Z');
const isoDate = (value) => value.toISOString().slice(0, 10);
const shift = (value, days) => new Date(value.getTime() + days * 86_400_000);
const utcCapture = (rankingDate, end = false) => `${isoDate(shift(rankingDate, end ? 0 : -1))}T16:20:00Z`;
const languages = [
  { name: 'TypeScript', slug: 'typescript-ed0504f7' },
  { name: 'Python', slug: 'python-18885f27' },
  { name: 'Go', slug: 'go-6cc8519b' },
  { name: 'Rust', slug: 'rust-d9aa89fd' },
];
const collection = {
  search_result_counts: { recent_created: 1_000, recent_active: 500, established_active: 500 },
  unique_discovered_count: 1_812,
  candidate_added_count: 83,
  candidate_removed_count: 51,
  api_request_count: 42,
  api_retry_count: 1,
  snapshot_expected_count: 2_000,
  snapshot_complete_count: 2_000,
  snapshot_completeness: 1,
};

function rankingEntries(dayOffset, limit = 100, language = null, multiplier = 1) {
  return Array.from({ length: limit }, (_, offset) => {
    const rank = offset + 1;
    const repositoryId = language ? 10_000 + languages.findIndex((item) => item.name === language) * 100 + rank : 10_000 + rank;
    const padded = String(repositoryId - 10_000).padStart(3, '0');
    const gained = Math.round((2_000 - offset * 17 + dayOffset * 3) * multiplier);
    return {
      repository_id: repositoryId,
      full_name: rank === 17 && !language
        ? `long-organization-name/repository-with-an-intentionally-long-name-${padded}`
        : `fixture-labs/repo-${padded}`,
      description: rank === 17
        ? 'An intentionally long repository description used to verify responsive wrapping, truncation, touch targets, and card layout without horizontal overflow on narrow screens.'
        : `Recorded test repository ${padded} for static ranking interaction checks.`,
      language: language ?? languages[offset % languages.length].name,
      stars_total: 100_000 - offset * 137 + dayOffset * Math.max(1, 100 - offset),
      stars_gained: gained,
      rank,
      rank_change: rank % 7 === 0 ? null : (rank % 5) - 2,
      trend_7d: [gained - 6, gained - 5, null, gained - 3, gained - 2, gained - 1, gained],
      html_url: `https://github.com/fixture-labs/repo-${padded}`,
      owner_avatar_url: null,
      knowledge_url: null,
    };
  });
}

function dailyRanking(date, dayOffset) {
  return {
    schema_version: '1.2.0', date: isoDate(date), timezone: 'Asia/Shanghai',
    window_start: utcCapture(date), window_end: utcCapture(date, true),
    window_quality: { duration_minutes: 1_440, valid_for_ranking: true, reason: 'valid' },
    candidate_count: 2_000, eligible_count: 1_842, collection,
    entries: rankingEntries(dayOffset),
  };
}

function periodRanking(days) {
  const date = latestDate;
  return {
    ...dailyRanking(date, 39),
    period_days: days,
    window_start: `${isoDate(shift(date, -days))}T16:20:00Z`,
    window_quality: { duration_minutes: days * 1_440, valid_for_ranking: true, reason: 'valid' },
    entries: rankingEntries(39, 100, null, days),
  };
}

await rm(outputRoot, { recursive: true, force: true });
for (const directory of ['daily', 'events/daily', 'language', 'period/7d', 'period/30d']) {
  await mkdir(path.join(outputRoot, directory), { recursive: true });
}

const dates = Array.from({ length: 40 }, (_, offset) => isoDate(shift(latestDate, -offset)));
for (let offset = 39; offset >= 0; offset -= 1) {
  const date = shift(latestDate, -offset);
  const ranking = dailyRanking(date, 39 - offset);
  await writeFile(path.join(outputRoot, 'daily', `${ranking.date}.json`), `${JSON.stringify(ranking, null, 2)}\n`);
}

for (const language of languages) {
  await mkdir(path.join(outputRoot, 'language', language.slug, 'daily'), { recursive: true });
  for (let offset = 39; offset >= 0; offset -= 1) {
    const date = shift(latestDate, -offset);
    const base = dailyRanking(date, 39 - offset);
    const ranking = {
      ...base,
      language: language.name,
      slug: language.slug,
      eligible_count: 400,
      entries: rankingEntries(39 - offset, 50, language.name),
    };
    await writeFile(path.join(outputRoot, 'language', language.slug, 'daily', `${ranking.date}.json`), `${JSON.stringify(ranking, null, 2)}\n`);
  }
}

for (const days of [7, 30]) {
  const ranking = periodRanking(days);
  await writeFile(path.join(outputRoot, 'period', `${days}d`, `${ranking.date}.json`), `${JSON.stringify(ranking, null, 2)}\n`);
}

const eventDates = dates.slice(0, 7);
const eventSourceMetrics = (date) => {
  const localDate = new Date(`${date}T00:00:00+08:00`);
  const startUtc = new Date(localDate.getTime());
  const endUtc = new Date(localDate.getTime() + 86_400_000 - 1);
  return {
    provider: 'gh_archive_bigquery',
    dataset: 'githubarchive.day',
    table_dates: [isoDate(startUtc), isoDate(endUtc)].map((item) => item.replaceAll('-', '')),
    estimated_bytes: 1_073_741_824,
    bytes_processed: 943_718_400,
    maximum_bytes_billed: 25_769_803_776,
    observed_watch_event_count: 18_432,
    observed_repository_count: 7_614,
    metadata_attempted_count: 105,
    metadata_success_count: 100,
    metadata_not_found_count: 3,
    metadata_filtered_count: 2,
    api_request_count: 105,
    api_retry_count: 1,
  };
};
const eventEntries = (dayOffset) => Array.from({ length: 100 }, (_, offset) => {
  const rank = offset + 1;
  const repositoryId = 30_001 + offset;
  const starsAdded = 1_500 - offset * 11 + dayOffset;
  return {
    repository_id: repositoryId,
    full_name: `public-event-labs/project-${String(rank).padStart(3, '0')}`,
    description: `Public WatchEvent fixture project ${rank} for event ranking checks.`,
    language: languages[offset % languages.length].name,
    stars_total: 250_000 - offset * 151,
    stars_added: starsAdded,
    watch_events: starsAdded + (offset % 5),
    rank,
    rank_change: dayOffset === 0 ? null : (rank % 5) - 2,
    trend_7d: Array.from({ length: 7 }, (_, trendOffset) => {
      const observedDay = dayOffset - (6 - trendOffset);
      return observedDay < 0 ? null : 1_500 - offset * 11 + observedDay;
    }),
    html_url: `https://github.com/public-event-labs/project-${String(rank).padStart(3, '0')}`,
    owner_avatar_url: null,
  };
});
for (const [reverseOffset, date] of [...eventDates].reverse().entries()) {
  const localStart = new Date(`${date}T00:00:00+08:00`);
  const localEnd = new Date(localStart.getTime() + 86_400_000);
  const generatedAt = new Date(localEnd.getTime() + 7.75 * 3_600_000).toISOString();
  const ranking = {
    schema_version: '1.0.0',
    date,
    timezone: 'Asia/Shanghai',
    window_start: localStart.toISOString(),
    window_end: localEnd.toISOString(),
    generated_at: generatedAt,
    methodology_version: 'gharchive-public-watch-events-v1',
    source_metrics: eventSourceMetrics(date),
    eligible_count: 100,
    entries: eventEntries(reverseOffset),
  };
  await writeFile(path.join(outputRoot, 'events', 'daily', `${date}.json`), `${JSON.stringify(ranking, null, 2)}\n`);
}

const historyDates = Array.from({ length: 30 }, (_, offset) => isoDate(shift(latestDate, offset - 29)));
const repositories = Array.from({ length: 2_000 }, (_, offset) => {
  const repositoryId = 10_001 + offset;
  const padded = String(offset + 1).padStart(3, '0');
  const fullName = offset === 16
    ? `long-organization-name/repository-with-an-intentionally-long-name-${padded}`
    : `fixture-labs/repo-${padded}`;
  return {
    repository_id: repositoryId,
    full_name: fullName,
    description: offset === 16 ? 'A deliberately long description that exercises wrapping and readable static project history on narrow screens.' : `Fixture repository ${padded}`,
    language: languages[offset % languages.length].name,
    stars_total: 200_000 - offset * 31,
    html_url: `https://github.com/${fullName}`,
    owner_avatar_url: null,
    knowledge_url: null,
    first_seen_date: '2026-06-01',
    last_seen_date: '2026-07-15',
    history_30d: historyDates.map((date, historyOffset) => ({
      date,
      stars_total: historyOffset === 11 ? null : 200_000 - offset * 31 - (29 - historyOffset) * ((offset % 9) + 1),
      stars_gained: historyOffset === 11 ? null : (offset % 9) + 1,
      rank: historyOffset === 11 ? null : (offset < 100 ? offset + 1 : null),
    })),
  };
});

const updatedAt = '2026-07-14T16:20:00Z';
const index = {
  schema_version: '1.2.0', status: 'ready', timezone: 'Asia/Shanghai', updated_at: updatedAt,
  latest_date: isoDate(latestDate), available_dates: dates, candidate_count: 2_000,
  methodology_version: 'candidate-pool-snapshot-v1', freshness_threshold_hours: 36,
  latest_collection: collection,
  sampling: {
    target_local_time: '00:20', valid_window_start: '00:00', valid_window_end: '03:00',
    latest_snapshot_at: updatedAt, latest_snapshot_valid: true, latest_snapshot_reason: 'within_window',
    latest_valid_snapshot_at: updatedAt, consecutive_valid_snapshots: 2,
    next_scheduled_at: '2026-07-16T00:20:00+08:00', expected_first_ranking_at: null,
    period_progress: { '7d': { completed: 7, required: 7 }, '30d': { completed: 30, required: 30 } },
  },
  periods: {
    '7d': { latest_date: isoDate(latestDate), available_dates: [isoDate(latestDate)] },
    '30d': { latest_date: isoDate(latestDate), available_dates: [isoDate(latestDate)] },
  },
};
const languageIndex = {
  schema_version: '1.2.0', updated_at: updatedAt, timezone: 'Asia/Shanghai',
  languages: languages.map((language) => ({ ...language, language: language.name, candidate_count: 500, latest_date: isoDate(latestDate), available_dates: dates, status: 'ready' })).map(({ name, ...item }) => item),
};
const catalog = { schema_version: '1.2.0', updated_at: updatedAt, timezone: 'Asia/Shanghai', candidate_count: 2_000, repositories };
const latestEventDate = eventDates[0];
const latestEventGeneratedAt = new Date(new Date(`${latestEventDate}T00:00:00+08:00`).getTime() + 31.75 * 3_600_000).toISOString();
const eventIndex = {
  schema_version: '1.0.0', status: 'ready', timezone: 'Asia/Shanghai', updated_at: latestEventGeneratedAt,
  latest_date: latestEventDate, available_dates: eventDates,
  methodology_version: 'gharchive-public-watch-events-v1', freshness_threshold_hours: 36,
  latest_source_metrics: eventSourceMetrics(latestEventDate),
};

await writeFile(path.join(outputRoot, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
await writeFile(path.join(outputRoot, 'events', 'index.json'), `${JSON.stringify(eventIndex, null, 2)}\n`);
await writeFile(path.join(outputRoot, 'language', 'index.json'), `${JSON.stringify(languageIndex, null, 2)}\n`);
await writeFile(path.join(outputRoot, 'repositories.json'), `${JSON.stringify(catalog, null, 2)}\n`);
await cp(schemaRoot, path.join(outputRoot, 'schema'), { recursive: true });

console.log(`Prepared 40 candidate days, 7 public event days, 2,000 repositories, language and period rankings at ${outputRoot}`);
