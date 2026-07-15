import assert from 'node:assert/strict';
import test from 'node:test';
import { eventRankingIsFresh } from '../src/scripts/event-freshness-utils.mjs';

const candidate = { updated_at: '2026-07-15T00:30:00+08:00' };
const ready = {
  status: 'ready', latest_date: '2026-07-14', updated_at: '2026-07-14T07:45:00+08:00',
  freshness_threshold_hours: 36,
};

test('event ranking is selected when it is ready and within 36 hours of the candidate snapshot', () => {
  assert.equal(eventRankingIsFresh(ready, candidate), true);
});

test('missing, invalid, or relatively stale event data falls back to the candidate ranking', () => {
  assert.equal(eventRankingIsFresh({ ...ready, status: 'initializing' }, candidate), false);
  assert.equal(eventRankingIsFresh({ ...ready, updated_at: null }, candidate), false);
  assert.equal(eventRankingIsFresh({ ...ready, updated_at: '2026-07-13T00:00:00+08:00' }, candidate), false);
  assert.equal(eventRankingIsFresh({ ...ready, updated_at: 'not-a-date' }, candidate), false);
});
