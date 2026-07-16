export function normalizeSearch(value) {
  return value.trim().toLocaleLowerCase();
}

export function matchesEntry(entry, search, language, category = '', projectType = '', scenario = '') {
  const normalizedSearch = normalizeSearch(search);
  const matchesSearch = !normalizedSearch || normalizeSearch(entry.searchText).includes(normalizedSearch);
  const matchesLanguage = !language || entry.language === language;
  const matchesCategory = !category || entry.category === category;
  const matchesProjectType = !projectType || entry.projectType === projectType;
  const matchesScenario = !scenario || (entry.scenarios ?? []).includes(scenario);
  return matchesSearch && matchesLanguage && matchesCategory && matchesProjectType && matchesScenario;
}
