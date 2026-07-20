import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type {
  DailyRanking,
  AllTimeBoard,
  AllTimeIndex,
  ClassificationIndex,
  ClassificationRepositoryCatalog,
  EventCategoryPool,
  EventDailyRanking,
  EventRankingIndex,
  ExplorationPool,
  LanguageIndex,
  LanguageRanking,
  LocalizationCatalog,
  PeriodRanking,
  RankingIndex,
  RepositoryCatalog,
  RepositoryProfile,
} from '../types';

const dataRoot = path.resolve(process.cwd(), 'generated', 'data');
let localizationCatalog: LocalizationCatalog | undefined;
let classificationIndex: ClassificationIndex | undefined;
let classificationRepositories: ClassificationRepositoryCatalog | undefined;

export function readRankingIndex(): RankingIndex {
  return JSON.parse(readFileSync(path.join(dataRoot, 'index.json'), 'utf8')) as RankingIndex;
}

export function readDailyRanking(date: string): DailyRanking {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid ranking date: ${date}`);
  return JSON.parse(readFileSync(path.join(dataRoot, 'daily', `${date}.json`), 'utf8')) as DailyRanking;
}

export function readPeriodRanking(days: 7 | 30, date: string): PeriodRanking {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid period date: ${date}`);
  return JSON.parse(readFileSync(path.join(dataRoot, 'period', `${days}d`, `${date}.json`), 'utf8')) as PeriodRanking;
}

export function readLanguageIndex(): LanguageIndex {
  const file = path.join(dataRoot, 'language', 'index.json');
  if (!existsSync(file)) return { schema_version: '1.1.0', updated_at: '', timezone: 'Asia/Shanghai', languages: [] };
  return JSON.parse(readFileSync(file, 'utf8')) as LanguageIndex;
}

export function readLanguageRanking(slug: string, date: string): LanguageRanking {
  if (!/^[a-z0-9-]+$/.test(slug) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Invalid language ranking path');
  }
  return JSON.parse(readFileSync(path.join(dataRoot, 'language', slug, 'daily', `${date}.json`), 'utf8')) as LanguageRanking;
}

export function readRepositoryCatalog(): RepositoryCatalog {
  const file = path.join(dataRoot, 'repositories.json');
  if (!existsSync(file)) {
    return { schema_version: '1.1.0', updated_at: '', timezone: 'Asia/Shanghai', candidate_count: 0, repositories: [] };
  }
  return JSON.parse(readFileSync(file, 'utf8')) as RepositoryCatalog;
}

export function readEventRankingIndex(): EventRankingIndex {
  const file = path.join(dataRoot, 'events', 'index.json');
  if (!existsSync(file)) {
    return {
      schema_version: '1.2.0', status: 'initializing', timezone: 'Asia/Shanghai', updated_at: null,
      latest_date: null, available_dates: [], methodology_version: 'gharchive-public-watch-events-v3',
      freshness_threshold_hours: 36, latest_source_metrics: null, ranking_limit: 500, page_size: 100,
    };
  }
  return JSON.parse(readFileSync(file, 'utf8')) as EventRankingIndex;
}

export function readEventDailyRanking(date: string): EventDailyRanking {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid event ranking date: ${date}`);
  return JSON.parse(readFileSync(path.join(dataRoot, 'events', 'daily', `${date}.json`), 'utf8')) as EventDailyRanking;
}

export function readEventCategoryPool(date: string): EventCategoryPool | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid category pool date: ${date}`);
  const file = path.join(dataRoot, 'events', 'category', `${date}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as EventCategoryPool;
}

export function readExplorationPool(
  kind: 'daily' | 'period_7d' | 'period_30d',
  date: string,
): ExplorationPool | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid exploration pool date: ${date}`);
  const relative = kind === 'daily'
    ? path.join('explore', 'daily', `${date}.json`)
    : path.join('explore', 'period', kind === 'period_7d' ? '7d' : '30d', `${date}.json`);
  const file = path.join(dataRoot, relative);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as ExplorationPool;
}

export function readLatestEventCategoryPool(): EventCategoryPool | null {
  const latest = readEventRankingIndex().latest_date;
  if (!latest) return null;
  return readEventCategoryPool(latest);
}

export function readAllTimeIndex(): AllTimeIndex {
  const file = path.join(dataRoot, 'alltime', 'index.json');
  if (!existsSync(file)) {
    return {
      schema_version: '1.0.0', status: 'initializing', updated_at: null,
      methodology_version: 'github-search-most-starred-v1', entry_count: 0, top_stars: null,
      freshness_threshold_hours: 192,
    };
  }
  return JSON.parse(readFileSync(file, 'utf8')) as AllTimeIndex;
}

export function readAllTimeBoard(): AllTimeBoard | null {
  const file = path.join(dataRoot, 'alltime', 'top-1000.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as AllTimeBoard;
}

export function readLocalizationCatalog(): LocalizationCatalog {
  if (localizationCatalog) return localizationCatalog;
  const file = path.join(dataRoot, 'i18n', 'zh-CN', 'repositories.json');
  if (existsSync(file)) {
    localizationCatalog = JSON.parse(readFileSync(file, 'utf8')) as LocalizationCatalog;
    return localizationCatalog;
  }
  localizationCatalog = {
    schema_version: '1.0.0',
    locale: 'zh-CN',
    generated_at: null,
    model: 'openai/gpt-4.1-mini',
    prompt_version: 'repository-localization-v1',
    coverage: { eligible_count: 0, localized_count: 0, pending_count: 0, failed_count: 0, coverage_ratio: 1 },
    repositories: [],
  };
  return localizationCatalog;
}

export function readClassificationIndex(): ClassificationIndex {
  if (classificationIndex) return classificationIndex;
  const file = path.join(dataRoot, 'classification', 'index.json');
  if (existsSync(file)) {
    classificationIndex = JSON.parse(readFileSync(file, 'utf8')) as ClassificationIndex;
    return classificationIndex;
  }
  classificationIndex = {
    schema_version: '1.0.0', taxonomy_version: '1.0.0', locale: 'zh-CN', generated_at: null,
    model: 'openai/gpt-4.1-mini', prompt_version: 'repository-classification-v1',
    coverage: { eligible_count: 0, classified_count: 0, pending_count: 0, failed_count: 0, coverage_ratio: 1 },
    categories: [], project_types: [], use_cases: [],
  };
  return classificationIndex;
}

export function readClassificationRepositories(): ClassificationRepositoryCatalog {
  if (classificationRepositories) return classificationRepositories;
  const file = path.join(dataRoot, 'classification', 'repositories.json');
  if (existsSync(file)) {
    classificationRepositories = JSON.parse(readFileSync(file, 'utf8')) as ClassificationRepositoryCatalog;
    return classificationRepositories;
  }
  classificationRepositories = {
    schema_version: '1.0.0', taxonomy_version: '1.0.0', generated_at: null, repositories: [],
  };
  return classificationRepositories;
}

function datedJsonFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) found.push(full);
    }
  };
  visit(root);
  return found.sort();
}

/** Build one stable project profile for every repository visible anywhere on the site. */
export function readRepositoryProfiles(): RepositoryProfile[] {
  type WorkingProfile = { profile: RepositoryProfile; metadataKey: string; eventByDate: Map<string, { stars_added: number; rank: number }> };
  const working = new Map<number, WorkingProfile>();
  const ensure = (entry: {
    repository_id: number; full_name: string; description?: string | null; language?: string | null;
    stars_total: number; html_url: string; owner_avatar_url?: string | null;
  }, metadataKey: string) => {
    let current = working.get(entry.repository_id);
    if (!current) {
      current = {
        metadataKey: '', eventByDate: new Map(),
        profile: {
          repository_id: entry.repository_id, full_name: entry.full_name, description: entry.description ?? null,
          language: entry.language ?? null, stars_total: entry.stars_total, html_url: entry.html_url,
          owner_avatar_url: entry.owner_avatar_url ?? null, knowledge_url: null,
          first_seen_date: null, last_seen_date: null, history_30d: [], event_history: [], all_time_rank: null,
        },
      };
      working.set(entry.repository_id, current);
    }
    if (metadataKey >= current.metadataKey) {
      Object.assign(current.profile, {
        full_name: entry.full_name, description: entry.description ?? null, language: entry.language ?? null,
        stars_total: entry.stars_total, html_url: entry.html_url, owner_avatar_url: entry.owner_avatar_url ?? null,
      });
      current.metadataKey = metadataKey;
    }
    return current;
  };

  for (const repository of readRepositoryCatalog().repositories) {
    const current = ensure(repository, repository.last_seen_date ?? '');
    Object.assign(current.profile, repository);
  }

  const registerRankingFiles = (root: string, sourcePriority: number) => {
    for (const file of datedJsonFiles(root)) {
      const payload = JSON.parse(readFileSync(file, 'utf8')) as { date?: string; entries?: Array<Record<string, unknown>> };
      const date = payload.date ?? path.basename(file, '.json');
      for (const raw of payload.entries ?? []) {
        if (typeof raw.repository_id !== 'number' || typeof raw.full_name !== 'string'
          || typeof raw.stars_total !== 'number' || typeof raw.html_url !== 'string') continue;
        ensure(raw as never, `${date}:${sourcePriority}`);
      }
    }
  };
  registerRankingFiles(path.join(dataRoot, 'daily'), 1);
  registerRankingFiles(path.join(dataRoot, 'period'), 2);
  registerRankingFiles(path.join(dataRoot, 'language'), 3);
  registerRankingFiles(path.join(dataRoot, 'explore'), 4);

  const eventFiles = [
    ...datedJsonFiles(path.join(dataRoot, 'events', 'daily')),
    ...datedJsonFiles(path.join(dataRoot, 'events', 'category')),
  ];
  for (const file of eventFiles) {
    const payload = JSON.parse(readFileSync(file, 'utf8')) as EventDailyRanking | EventCategoryPool;
    for (const entry of payload.entries) {
      const current = ensure(entry, `${payload.date}:5`);
      const existing = current.eventByDate.get(payload.date);
      if (!existing || entry.rank < existing.rank) {
        current.eventByDate.set(payload.date, { stars_added: entry.stars_added, rank: entry.rank });
      }
    }
  }

  const allTime = readAllTimeBoard();
  if (allTime) {
    for (const entry of allTime.entries) {
      const current = ensure(entry, `${allTime.generated_at}:0`);
      current.profile.all_time_rank = entry.rank;
    }
  }

  return [...working.values()]
    .map((current) => ({
      ...current.profile,
      event_history: [...current.eventByDate.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, item]) => ({ date, ...item })),
    }))
    .sort((left, right) => left.repository_id - right.repository_id);
}
