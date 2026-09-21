// Relevance precedes popularity. Reasons are derived from the published taxonomy,
// not generated claims about features, quality or compatibility.
export function relatedMatch(source, candidate) {
  if (!source || !candidate) return { score: 0, scenarios: [], category: false, type: false };
  const scenarios = [...new Set(source.use_cases)].filter((id) => candidate.use_cases.includes(id));
  const category = source.primary_category === candidate.primary_category && source.primary_category !== 'other';
  const type = source.project_type === candidate.project_type && source.project_type !== 'other';
  return { score: scenarios.length * 4 + (category ? 2 : 0) + (type ? 1 : 0), scenarios, category, type };
}
