import test from 'node:test';
import assert from 'node:assert/strict';
import { dates, projects, selectProjects, signed, snapshotFor, trendTone, weeklySeries } from '../src/data.js';
import { FAVORITES_KEY, defaultFilters, initializeHistory, parseRoute, readFavorites, serializeRoute, writeFavorites } from '../src/navigation.js';
import { loadSnapshot } from '../src/snapshot-service.js';
import { comparisonFields, relatedProjects } from '../src/insights.js';

test('shared links preserve Unicode filters, details, date and comparison choices', () => {
  const route = parseRoute('?view=trends&q=AI+工作流&language=TypeScript&category=工作流&minStars=75000&period=month&date=2026-09-18&sort=asc&compare=dify,n8n&panel=detail&project=dify&from=compare&tab=activity&differences=1&state=partial');
  assert.deepEqual(parseRoute(serializeRoute(route, { share: true })), route);
  assert.equal(serializeRoute(parseRoute('')), '');
  assert.equal(parseRoute('?view=trends').filters.period, 'week');
  assert.equal(parseRoute('?view=saved').filters.period, 'day');
});

test('untrusted route input is bounded and canonicalized', () => {
  const route = parseRoute(`?view=evil&period=invalid&date=yesterday&language=Ruby&minStars=-1&sort=bad&panel=detail&project=evil&compare=dify,dify,evil,n8n,astro,ollama&q=${'x'.repeat(500)}&state=oops`);
  assert.equal(route.view, 'discover');
  assert.equal(route.modal, null);
  assert.deepEqual(route.compared, ['dify', 'n8n', 'astro']);
  assert.equal(route.filters.query.length, 200);
  assert.deepEqual({ ...route.filters, query: '' }, defaultFilters());
  assert.equal(route.scenario, 'ready');
  assert.equal(parseRoute('?panel=picker&return=detail:invalid').modal.back, null);
  assert.equal(parseRoute('?panel=picker&return=detail:dify').modal.back, 'detail:dify');
  assert.equal(serializeRoute(parseRoute('?panel=filters'), { share: true }), '');
});

function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
test('opening a shared panel provides one list base without duplicating on reload', () => {
  const entries = [{ state: null, url: '/?panel=compare&compare=dify,n8n' }];
  const history = {
    get state() { return entries.at(-1).state; },
    replaceState(state, title, url) { entries[entries.length - 1] = { state, url }; },
    pushState(state, title, url) { entries.push({ state, url }); },
  };
  const route = parseRoute('?panel=compare&compare=dify,n8n');
  initializeHistory(route, history, '/');
  assert.equal(entries.length, 2);
  assert.equal(parseRoute(entries[0].url.slice(1)).modal, null);
  assert.deepEqual(parseRoute(entries[0].url.slice(1)).compared, ['dify', 'n8n']);
  assert.equal(history.state.starRank.depth, 1);
  initializeHistory(route, history, '/');
  assert.equal(entries.length, 2);
});
test('favorites persist an explicitly empty list and sanitize old project IDs', () => {
  const storage = memoryStorage();
  assert.deepEqual(readFavorites(storage), { ids: [], available: true });
  assert.equal(writeFavorites(storage, ['dify', 'dify', 'missing', 'n8n']), true);
  assert.deepEqual(readFavorites(storage), { ids: ['dify', 'n8n'], available: true });
  writeFavorites(storage, []);
  assert.deepEqual(readFavorites(storage), { ids: [], available: true });
});
test('corrupt, future-schema and unavailable storage degrade without crashing', () => {
  const storage = memoryStorage();
  for (const value of ['{', '{"version":2,"ids":[]}', '{"version":1,"ids":null}']) {
    storage.setItem(FAVORITES_KEY, value);
    assert.deepEqual(readFavorites(storage), { ids: [], available: false });
  }
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.equal(readFavorites(denied).available, false);
  assert.equal(writeFavorites(denied, ['dify']), false);
});

test('all fixed snapshots reconcile daily and weekly totals and adjacent dates', () => {
  const snapshots = dates.map(date => snapshotFor(date.value));
  for (const snapshot of snapshots) for (const project of snapshot) {
    assert.equal(project.dailyTrend.at(-1), project.day);
    assert.equal(project.dailyTrend.reduce((a, b) => a + b, 0), project.week);
    assert.equal(weeklySeries(project).length, 7);
  }
  for (let day = 0; day < snapshots.length - 1; day++) for (let index = 0; index < projects.length; index++) {
    assert.equal(snapshots[day][index].stars - snapshots[day + 1][index].stars, snapshots[day][index].day);
    assert.deepEqual(snapshots[day][index].dailyTrend.slice(0, -1), snapshots[day + 1][index].dailyTrend.slice(1));
  }
});
test('cancelled snapshot requests never replace a newer successful request', async () => {
  const controller = new AbortController();
  const older = loadSnapshot(dates[1].value, { signal: controller.signal, delay: 40 });
  const rejected = assert.rejects(older, { name: 'AbortError' });
  controller.abort();
  const newer = await loadSnapshot(dates[0].value, { delay: 0 });
  await rejected;
  assert.equal(newer.date, dates[0].value);
  const preCancelled = new AbortController(); preCancelled.abort();
  await assert.rejects(loadSnapshot(dates[0].value, { signal: preCancelled.signal }), { name: 'AbortError' });
});
test('stale, unavailable and empty states retain truthful snapshot identity', async () => {
  const stale = await loadSnapshot(dates[0].value, { scenario: 'stale', delay: 0 });
  assert.equal(stale.requestedDate, dates[0].value);
  assert.equal(stale.date, dates[1].value);
  assert.equal(stale.stale, true);
  assert.ok(stale.items.every(project => project.asOf === stale.date));
  assert.deepEqual(stale.items, snapshotFor(dates[1].value));
  await assert.rejects(loadSnapshot(dates[0].value, { scenario: 'error', delay: 0 }));
  assert.deepEqual((await loadSnapshot(dates[0].value, { scenario: 'empty', delay: 0 })).items, []);
});
test('missing, zero and negative changes are distinct and missing values rank last', async () => {
  const { items } = await loadSnapshot(dates[0].value, { scenario: 'partial', delay: 0 });
  assert.equal(signed(null), '待补齐'); assert.equal(signed(0), '0'); assert.equal(signed(-28), '−28');
  assert.equal(trendTone(null), 'neutral'); assert.equal(trendTone(0), 'neutral'); assert.equal(trendTone(-28), 'negative');
  for (const project of items.filter(project => project.dailyTrend.length)) {
    assert.equal(project.dailyTrend.at(-1), project.day);
    assert.equal(project.dailyTrend.reduce((a, b) => a + b, 0), project.week);
  }
  for (const ascending of [true, false]) {
    const list = selectProjects(items, { ...defaultFilters(), ascending, saved: [] });
    assert.equal(list.at(-1).id, 'dify');
    assert.ok(list.some(project => project.day === 0));
    assert.ok(list.some(project => project.day < 0));
  }
});
test('combined search filters and cumulative ranking select the intended projects', () => {
  const items = snapshotFor(dates[0].value);
  const options = { ...defaultFilters(), saved: [] };
  assert.deepEqual(selectProjects(items, { ...options, query: '  DIFY  ', language: 'TypeScript', category: '工作流' }).map(p => p.id), ['dify']);
  assert.deepEqual(selectProjects(items, { ...options, period: 'history', ascending: true }).map(p => p.id), ['astro', 'supabase', 'openwebui', 'ollama', 'n8n', 'dify']);
  assert.deepEqual(selectProjects(items, { ...options, savedOnly: true, saved: [] }), []);
  assert.deepEqual(selectProjects(items, { ...options, savedOnly: true, saved: ['n8n'] }).map(p => p.id), ['n8n']);
});
test('comparison hides shared fields and prioritizes related scenarios', () => {
  const selected = projects.filter(project => ['dify', 'n8n'].includes(project.id));
  const differences = comparisonFields(selected, true).map(field => field.id);
  assert.ok(!differences.includes('language')); assert.ok(!differences.includes('deployment'));
  assert.ok(differences.includes('license')); assert.ok(differences.includes('capabilities'));
  const ordered = relatedProjects(projects, ['dify']);
  assert.ok(ordered.findIndex(p => p.id === 'n8n') < ordered.findIndex(p => p.id === 'astro'));
});
