import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedMatch } from '../src/lib/related-projects.mjs';
test('shared use cases outrank broad category and form matches', () => {
  const source = { primary_category: 'ai', project_type: 'app', use_cases: ['coding'] };
  const focused = relatedMatch(source, { primary_category: 'dev', project_type: 'tool', use_cases: ['coding'] });
  const broad = relatedMatch(source, { primary_category: 'ai', project_type: 'app', use_cases: ['images'] });
  assert.ok(focused.score > broad.score);
  assert.deepEqual(focused.scenarios, ['coding']);
  assert.equal(relatedMatch(undefined, source).score, 0);
  assert.equal(relatedMatch({ primary_category: 'other', project_type: 'other', use_cases: [] }, { primary_category: 'other', project_type: 'other', use_cases: [] }).score, 0);
});
