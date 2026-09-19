import { dates, periods, projects } from './data.js';

export const viewNames = { discover: '发现项目', trends: '趋势榜单', saved: '我的收藏' };
export const languages = ['TypeScript', 'Python', 'Go'];
export const categories = [...new Set(projects.flatMap(p => p.tags))];
export const scenarios = ['ready', 'error', 'stale', 'partial', 'empty'];
const projectIds = new Set(projects.map(p => p.id));
const panelNames = new Set(['detail', 'compare', 'picker', 'filters', 'method', 'login']);
const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;

export function validIds(ids, limit = projects.length) {
  return [...new Set(Array.isArray(ids) ? ids.filter(id => projectIds.has(id)) : [])].slice(0, limit);
}
export function defaultFilters(view = 'discover') {
  return { query: '', language: '', category: '', minStars: 0, period: view === 'trends' ? 'week' : 'day', date: dates[0].value, ascending: false };
}
export function parseRoute(search = '') {
  const params = new URLSearchParams(search);
  const view = oneOf(params.get('view'), Object.keys(viewNames), 'discover');
  const defaults = defaultFilters(view);
  const type = params.get('panel');
  const projectId = params.get('project');
  let modal = panelNames.has(type) ? { type } : null;
  if (type === 'detail') modal = projectIds.has(projectId) ? {
    type, id: projectId, from: params.get('from') === 'compare' ? 'compare' : null,
    tab: params.get('tab') === 'activity' ? 'activity' : 'overview',
  } : null;
  if (type === 'picker') {
    const back = params.get('return');
    modal.back = back === 'compare' || (back?.startsWith('detail:') && projectIds.has(back.slice(7))) ? back : null;
  }
  return {
    view,
    filters: {
      query: (params.get('q') || '').slice(0, 200),
      language: oneOf(params.get('language'), languages, ''),
      category: oneOf(params.get('category'), categories, ''),
      minStars: oneOf(Number(params.get('minStars')), [0, 75000, 100000], 0),
      period: oneOf(params.get('period'), periods.map(p => p.id), defaults.period),
      date: oneOf(params.get('date'), dates.map(d => d.value), defaults.date),
      ascending: params.get('sort') === 'asc',
    },
    compared: validIds((params.get('compare') || '').split(','), 3),
    modal,
    differences: params.get('differences') === '1',
    scenario: oneOf(params.get('state'), scenarios, 'ready'),
  };
}
export function serializeRoute(route, { share = false } = {}) {
  const params = new URLSearchParams();
  const { filters, modal } = route;
  if (route.view !== 'discover') params.set('view', route.view);
  const defaults = defaultFilters(route.view);
  for (const [key, param] of [['query', 'q'], ['language', 'language'], ['category', 'category'], ['minStars', 'minStars'], ['period', 'period'], ['date', 'date']]) {
    if (filters[key] !== defaults[key] && filters[key] !== '') params.set(param, String(filters[key]));
  }
  if (filters.ascending) params.set('sort', 'asc');
  if (route.compared.length) params.set('compare', route.compared.join(','));
  if (route.differences) params.set('differences', '1');
  if (route.scenario !== 'ready') params.set('state', route.scenario);
  if (modal && (!share || ['detail', 'compare'].includes(modal.type))) {
    params.set('panel', modal.type);
    if (modal.type === 'detail') {
      params.set('project', modal.id);
      if (modal.from === 'compare') params.set('from', 'compare');
      if (modal.tab === 'activity') params.set('tab', 'activity');
    }
    if (modal.type === 'picker' && modal.back) params.set('return', modal.back);
  }
  return params.size ? `?${params}` : '';
}

export function initializeHistory(route, history, pathname) {
  // A shared panel needs its own list entry so Close can always leave the whole
  // panel stack, while Back can still return from a detail to its comparison.
  if (route.modal && !history.state?.starRank) {
    history.replaceState({ ...history.state, starRank: { depth: 0 } }, '', pathname + serializeRoute({ ...route, modal: null }));
    history.pushState({ ...history.state, starRank: { depth: 1 } }, '', pathname + serializeRoute(route));
  } else history.replaceState(history.state, '', pathname + serializeRoute(route));
}

export const FAVORITES_KEY = 'starrank-demo:favorites:v1';
export function readFavorites(storage) {
  try {
    const raw = storage.getItem(FAVORITES_KEY);
    if (raw === null) return { ids: [], available: true };
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.ids)) return { ids: [], available: false };
    return { ids: validIds(data.ids), available: true };
  } catch { return { ids: [], available: false }; }
}
export function writeFavorites(storage, ids) {
  try { storage.setItem(FAVORITES_KEY, JSON.stringify({ version: 1, ids: validIds(ids) })); return true; }
  catch { return false; }
}
