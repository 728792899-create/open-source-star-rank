import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesEntry, normalizeSearch } from '../src/scripts/filter-utils.mjs';
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
  const entry = { searchText: 'Owner/Repo A useful toolkit', language: 'TypeScript' };
  assert.equal(matchesEntry(entry, 'useful', 'TypeScript'), true);
  assert.equal(matchesEntry(entry, 'owner/repo', 'Python'), false);
  assert.equal(matchesEntry(entry, 'missing', ''), false);
});
