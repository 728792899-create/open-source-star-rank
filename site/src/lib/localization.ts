import type { LocalizationCatalog, RepositoryLocalization } from '../types';

export interface LocalizedRepositoryContent {
  displayName: string;
  description: string | null;
  originalName: string;
  originalDescription: string | null;
  localized: boolean;
  provenance: RepositoryLocalization['provenance'] | null;
}

const mapCache = new WeakMap<LocalizationCatalog, Map<number, RepositoryLocalization>>();

export function localizationMap(catalog: LocalizationCatalog): Map<number, RepositoryLocalization> {
  const cached = mapCache.get(catalog);
  if (cached) return cached;
  const result = new Map(catalog.repositories.map((entry) => [entry.repository_id, entry]));
  mapCache.set(catalog, result);
  return result;
}

export function localizedRepositoryContent(
  catalog: LocalizationCatalog,
  repositoryId: number,
  fullName: string,
  description: string | null,
): LocalizedRepositoryContent {
  const localized = localizationMap(catalog).get(repositoryId);
  return {
    displayName: localized?.display_name_zh ?? fullName,
    description: localized?.description_zh ?? description,
    originalName: fullName,
    originalDescription: description,
    localized: Boolean(localized),
    provenance: localized?.provenance ?? null,
  };
}
