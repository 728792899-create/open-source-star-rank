import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  DailyRanking,
  LanguageIndex,
  LanguageRanking,
  PeriodRanking,
  RankingIndex,
  RepositoryCatalog,
} from '../types';

const dataRoot = path.resolve(process.cwd(), 'generated', 'data');

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
