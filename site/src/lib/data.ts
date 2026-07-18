import { existsSync, readFileSync } from 'node:fs';
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
  LanguageIndex,
  LanguageRanking,
  LocalizationCatalog,
  PeriodRanking,
  RankingIndex,
  RepositoryCatalog,
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
      schema_version: '1.1.0', status: 'initializing', timezone: 'Asia/Shanghai', updated_at: null,
      latest_date: null, available_dates: [], methodology_version: 'gharchive-public-watch-events-v2',
      freshness_threshold_hours: 36, latest_source_metrics: null,
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
