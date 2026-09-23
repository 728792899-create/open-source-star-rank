import test from 'node:test';
import assert from 'node:assert/strict';
import { periodState } from '../src/lib/period-state.mjs';
test('period entry distinguishes current data, old history and unfinished windows', () => {
  const index = { latest_date: '2026-09-20', periods: { '7d': { latest_date: '2026-08-20' } }, sampling: { period_progress: { '7d': { completed: 1, required: 7 } } } };
  assert.equal(periodState(index, 7).kind, 'historical');
  assert.match(periodState(index, 7).message, /2026-08-20/);
  assert.match(periodState(index, 7).message, /1 \/ 7/);
  assert.equal(periodState(index, 30).kind, 'accumulating');
  index.periods['7d'].latest_date = '2026-09-20';
  assert.equal(periodState(index, 7).kind, 'current');
});
