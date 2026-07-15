export function normalizeSearch(value) {
  return value.trim().toLocaleLowerCase();
}

export function matchesEntry(entry, search, language) {
  const normalizedSearch = normalizeSearch(search);
  const matchesSearch = !normalizedSearch || normalizeSearch(entry.searchText).includes(normalizedSearch);
  const matchesLanguage = !language || entry.language === language;
  return matchesSearch && matchesLanguage;
}
