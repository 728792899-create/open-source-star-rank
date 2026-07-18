import type {
  ClassificationIndex,
  EventCategoryPool,
  EventCategoryPoolEntry,
  EventRankingEntry,
  FacetDimension,
  RepositoryClassification,
} from '../types';

export const FACET_TOP_LIMIT = 100;

export interface FacetRanking {
  date: string;
  timezone: string;
  window_start: string;
  window_end: string;
  generated_at: string;
  eligible_count: number;
  pool_size: number;
  matched_count: number;
  total_gain: number;
  entries: EventRankingEntry[];
}

export interface FacetDimensionMeta {
  dimension: FacetDimension;
  routeSegment: string;
  labelZh: string;
  eyebrow: string;
  selectLabel: string;
}

/** Dimensions served by the unified /board/[dimension]/[value] route. */
export const BOARD_DIMENSIONS: FacetDimensionMeta[] = [
  { dimension: 'language', routeSegment: 'language', labelZh: '编程语言', eyebrow: 'Language board', selectLabel: '编程语言' },
  { dimension: 'type', routeSegment: 'type', labelZh: '产品形态', eyebrow: 'Product-form board', selectLabel: '产品形态' },
  { dimension: 'scenario', routeSegment: 'scenario', labelZh: '适用场景', eyebrow: 'Scenario board', selectLabel: '适用场景' },
];

export const CATEGORY_DIMENSION: FacetDimensionMeta = {
  dimension: 'category', routeSegment: 'category', labelZh: '项目方向', eyebrow: 'Direction board', selectLabel: '项目方向',
};

function facetMatches(
  entry: EventCategoryPoolEntry,
  classification: RepositoryClassification | undefined,
  dimension: FacetDimension,
  value: string,
): boolean {
  switch (dimension) {
    case 'language':
      return (entry.language ?? '') === value;
    case 'category':
      return classification?.primary_category === value;
    case 'type':
      return classification?.project_type === value;
    case 'scenario':
      return Boolean(classification?.use_cases.includes(value));
  }
}

function poolEntryToRankingEntry(entry: EventCategoryPoolEntry, rank: number): EventRankingEntry {
  return {
    repository_id: entry.repository_id,
    full_name: entry.full_name,
    description: entry.description,
    language: entry.language,
    stars_total: entry.stars_total,
    stars_added: entry.stars_added,
    watch_events: entry.watch_events,
    rank,
    rank_change: null,
    trend_7d: [null, null, null, null, null, null, null],
    html_url: entry.html_url,
    owner_avatar_url: entry.owner_avatar_url,
  };
}

function sortPoolEntries(entries: EventCategoryPoolEntry[]): EventCategoryPoolEntry[] {
  return [...entries].sort((left, right) =>
    right.stars_added - left.stars_added
    || right.watch_events - left.watch_events
    || right.stars_total - left.stars_total
    || left.full_name.toLocaleLowerCase().localeCompare(right.full_name.toLocaleLowerCase()));
}

export function buildFacetRanking(
  pool: EventCategoryPool,
  classifications: Map<number, RepositoryClassification>,
  dimension: FacetDimension,
  value: string,
): FacetRanking {
  const matched = pool.entries.filter((entry) => facetMatches(entry, classifications.get(entry.repository_id), dimension, value));
  const ranked = sortPoolEntries(matched).slice(0, FACET_TOP_LIMIT);
  const entries = ranked.map((entry, index) => poolEntryToRankingEntry(entry, index + 1));
  return {
    date: pool.date,
    timezone: pool.timezone,
    window_start: pool.window_start,
    window_end: pool.window_end,
    generated_at: pool.generated_at,
    eligible_count: entries.length,
    pool_size: pool.pool_size,
    matched_count: matched.length,
    total_gain: entries.reduce((sum, entry) => sum + entry.stars_added, 0),
    entries,
  };
}

/** Count how many pooled repositories fall into each value of a dimension. */
export function facetCounts(
  pool: EventCategoryPool,
  classifications: Map<number, RepositoryClassification>,
  dimension: FacetDimension,
  values: string[],
): Map<string, number> {
  const counts = new Map(values.map((value) => [value, 0]));
  for (const entry of pool.entries) {
    const classification = classifications.get(entry.repository_id);
    for (const value of values) {
      if (facetMatches(entry, classification, dimension, value)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** Distinct languages present in the pool, most-populated first. */
export function poolLanguages(pool: EventCategoryPool): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of pool.entries) {
    const language = entry.language;
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

/** URL-safe, collision-resistant slug for a raw language name (e.g. "C#" → "c-…"). */
export function languageSlug(language: string): string {
  const base = language.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  let hash = 5381;
  for (let index = 0; index < language.length; index += 1) {
    hash = ((hash << 5) + hash + language.charCodeAt(index)) >>> 0;
  }
  return `${base || 'lang'}-${hash.toString(16).padStart(8, '0').slice(0, 8)}`;
}

/** The URL segment for a facet value: taxonomy ids are already slug-safe; languages are hashed. */
export function facetValueSlug(dimension: FacetDimension, value: string): string {
  return dimension === 'language' ? languageSlug(value) : value;
}

export function dimensionValues(
  meta: FacetDimensionMeta,
  classificationIndex: ClassificationIndex,
  pool: EventCategoryPool | null,
): Array<{ id: string; label: string }> {
  switch (meta.dimension) {
    case 'language':
      return pool ? poolLanguages(pool).map(({ value }) => ({ id: value, label: value })) : [];
    case 'category':
      return classificationIndex.categories.map((term) => ({ id: term.id, label: term.label }));
    case 'type':
      return classificationIndex.project_types.map((term) => ({ id: term.id, label: term.label }));
    case 'scenario':
      return classificationIndex.use_cases.map((term) => ({ id: term.id, label: term.label }));
  }
}
