import { readDiscoveryCatalog, readClassificationIndex, readClassificationRepositories } from './data';
import { classificationMap } from './classification';
import { BOARD_DIMENSIONS, CATEGORY_DIMENSION, facetValueSlug } from './facet-rankings';
import type { RepositoryDetail } from '../types';

export function readCurrentDirectory() {
  const catalog = readDiscoveryCatalog();
  const taxonomy = readClassificationIndex();
  const classifications = classificationMap(readClassificationRepositories());
  const entries = [...catalog.repositories].sort((a, b) => b.stars_total - a.stars_total || a.full_name.localeCompare(b.full_name));
  const sections = [CATEGORY_DIMENSION, ...BOARD_DIMENSIONS].map((meta) => {
    const values = meta.dimension === 'category' ? taxonomy.categories
      : meta.dimension === 'type' ? taxonomy.project_types
      : meta.dimension === 'scenario' ? taxonomy.use_cases : [];
    const labels = new Map(values.map((value) => [value.id, value.label]));
    const groups = new Map<string, RepositoryDetail[]>();
    for (const entry of entries) {
      const classification = classifications.get(entry.repository_id);
      const ids = meta.dimension === 'language' ? [entry.language || 'Other']
        : meta.dimension === 'category' ? [classification?.primary_category || 'unclassified']
        : meta.dimension === 'type' ? [classification?.project_type || 'unclassified']
        : classification?.use_cases.length ? classification.use_cases : ['unclassified'];
      for (const id of new Set(ids)) {
        const group = groups.get(id) ?? [];
        group.push(entry); groups.set(id, group);
      }
    }
    return { meta, items: [...groups].map(([id, projects]) => ({
      id, label: labels.get(id) || (id === 'unclassified' ? '待分类' : id), entries: projects,
      path: `${meta.dimension}/${facetValueSlug(meta.dimension, id)}`,
    })).sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label)) };
  });
  return { catalog, entries, sections };
}
