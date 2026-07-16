import type {
  ClassificationIndex, ClassificationRepositoryCatalog, RepositoryClassification,
} from '../types';

const classificationCache = new WeakMap<ClassificationRepositoryCatalog, Map<number, RepositoryClassification>>();

export function classificationMap(
  catalog: ClassificationRepositoryCatalog,
): Map<number, RepositoryClassification> {
  const cached = classificationCache.get(catalog);
  if (cached) return cached;
  const result = new Map(catalog.repositories.map((entry) => [entry.repository_id, entry]));
  classificationCache.set(catalog, result);
  return result;
}

export function classificationLabels(index: ClassificationIndex) {
  return {
    categories: new Map(index.categories.map((term) => [term.id, term.label])),
    projectTypes: new Map(index.project_types.map((term) => [term.id, term.label])),
    useCases: new Map(index.use_cases.map((term) => [term.id, term.label])),
  };
}
