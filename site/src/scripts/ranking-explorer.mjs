import { matchesEntry } from './filter-utils.mjs';

export function metadataMaps(localization, classifications, taxonomy) {
  const localized = new Map((localization?.repositories ?? []).map((item) => [Number(item.repository_id), item]));
  const classified = new Map((classifications?.repositories ?? []).map((item) => [Number(item.repository_id), item]));
  const labels = {
    categories: new Map((taxonomy?.categories ?? []).map((item) => [item.id, item.label])),
    projectTypes: new Map((taxonomy?.project_types ?? []).map((item) => [item.id, item.label])),
    useCases: new Map((taxonomy?.use_cases ?? []).map((item) => [item.id, item.label])),
  };
  return { localized, classified, labels };
}

export function searchableEntry(entry, maps) {
  const localization = maps.localized.get(Number(entry.repository_id));
  const classification = maps.classified.get(Number(entry.repository_id));
  const category = classification ? maps.labels.categories.get(classification.primary_category) ?? '' : '';
  const projectType = classification ? maps.labels.projectTypes.get(classification.project_type) ?? '' : '';
  const scenarios = classification?.use_cases ?? [];
  const scenarioLabels = scenarios.map((item) => maps.labels.useCases.get(item) ?? '').join(' ');
  return {
    searchText: [
      entry.full_name, entry.description ?? '', localization?.display_name_zh ?? '',
      localization?.description_zh ?? '', category, projectType, scenarioLabels,
    ].join(' ').toLocaleLowerCase(),
    language: entry.language ?? '',
    category: classification?.primary_category ?? '',
    projectType: classification?.project_type ?? '',
    scenarios,
  };
}

export function filteredRanking(entries, previousEntries, maps, filters, limit = 500) {
  const matches = (entry) => matchesEntry(
    searchableEntry(entry, maps),
    filters.query ?? '',
    filters.language ?? '',
    filters.category ?? '',
    filters.projectType ?? '',
    filters.scenario ?? '',
  );
  const previousRanks = new Map(
    (previousEntries ?? []).filter(matches).map((entry, index) => [Number(entry.repository_id), index + 1]),
  );
  const matching = entries.filter(matches);
  return {
    total: matching.length,
    available: Math.min(matching.length, limit),
    entries: matching.slice(0, limit).map((entry, index) => {
      const rank = index + 1;
      const previousRank = previousRanks.get(Number(entry.repository_id));
      return {
        ...entry,
        source_rank: Number(entry.rank),
        filtered_rank: rank,
        filtered_rank_change: previousRank === undefined ? null : previousRank - rank,
      };
    }),
  };
}
