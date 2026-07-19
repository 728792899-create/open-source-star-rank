import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesEntry, normalizeSearch } from '../src/scripts/filter-utils.mjs';
import { filteredRanking, metadataMaps } from '../src/scripts/ranking-explorer.mjs';
import { freshnessState } from '../src/scripts/freshness-utils.mjs';

test('normalizes Chinese and ASCII search text', () => {
  assert.equal(normalizeSearch('  Owner/Repo AI 工具  '), 'owner/repo ai 工具');
});

test('marks data stale only after the configured threshold', () => {
  const updatedAt = '2026-07-15T00:00:00Z';
  assert.equal(freshnessState(updatedAt, 36, '2026-07-16T11:59:00Z').status, 'fresh');
  assert.equal(freshnessState(updatedAt, 36, '2026-07-16T12:01:00Z').status, 'stale');
  assert.equal(freshnessState(null, 36, '2026-07-16T12:01:00Z').status, 'initializing');
});

test('filters by repository text and language together', () => {
  const entry = {
    searchText: 'Owner/Repo A useful toolkit AI 编程', language: 'TypeScript',
    category: 'developer-tools', projectType: 'cli-developer-tool', scenarios: ['ai-coding', 'general-tools'],
  };
  assert.equal(matchesEntry(entry, 'useful', 'TypeScript'), true);
  assert.equal(matchesEntry(entry, 'owner/repo', 'Python'), false);
  assert.equal(matchesEntry(entry, 'missing', ''), false);
  assert.equal(matchesEntry(entry, 'AI 编程', '', 'developer-tools', 'cli-developer-tool', 'ai-coding'), true);
  assert.equal(matchesEntry(entry, '', '', 'security-privacy', '', ''), false);
  assert.equal(matchesEntry(entry, '', '', '', 'application', ''), false);
  assert.equal(matchesEntry(entry, '', '', '', '', 'self-hosting'), false);
});

test('re-ranks a deep pool and computes movement with the same filter', () => {
  const taxonomy = {
    categories: [{ id: 'developer-tools', label: '开发者工具' }],
    project_types: [{ id: 'application', label: '应用' }],
    use_cases: [{ id: 'ai-coding', label: 'AI 编程' }],
  };
  const classifications = { repositories: [1, 2, 3].map((repository_id) => ({
    repository_id, primary_category: 'developer-tools', project_type: 'application', use_cases: ['ai-coding'],
  })) };
  const maps = metadataMaps({ repositories: [] }, classifications, taxonomy);
  const entry = (repository_id, rank) => ({
    repository_id, rank, full_name: `owner/repo-${repository_id}`, description: null,
    language: repository_id === 2 ? 'Rust' : 'TypeScript', stars_total: 100, stars_gained: 10,
  });
  const result = filteredRanking(
    [entry(1, 1), entry(2, 2), entry(3, 3)],
    [entry(2, 1), entry(3, 2), entry(1, 3)],
    maps,
    { query: '', language: 'TypeScript', category: 'developer-tools', projectType: '', scenario: '' },
  );
  assert.equal(result.total, 2);
  assert.deepEqual(result.entries.map((item) => [item.repository_id, item.filtered_rank, item.source_rank, item.filtered_rank_change]), [
    [1, 1, 1, 1],
    [3, 2, 3, -1],
  ]);
});
