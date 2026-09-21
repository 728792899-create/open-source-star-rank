import { rankingLocation } from './ranking-location';
import { initializeRankingView } from './ranking-view';
import { initializeAllTimeView } from './alltime-view';
import { initializeCountdowns } from './update-countdown';
import { initializeFreshness } from './freshness';
import { initializeTickers } from './ranking-ticker';
import { paintTrends } from './trend-chart.mjs';

let mounted = new AbortController();
let pending: AbortController | null = null;
let generation = 0;
const filterKeys = ['q', 'language', 'category', 'type', 'scenario'];
const mount = () => {
  const field = document.querySelector('main .filter-search');
  const slot = document.querySelector('[data-workspace-search]');
  if (field && slot) slot.replaceChildren(field);
  else if (document.querySelector('[data-ranking-waiting]') && slot) {
    const label = document.createElement('label'); label.className = 'filter-search';
    const text = document.createElement('span'); text.textContent = '搜索项目';
    const input = document.createElement('input'); input.type = 'search'; input.placeholder = '本榜积累中，请切换其他榜单'; input.disabled = true;
    label.append(text, input); slot.replaceChildren(label);
  }
  document.documentElement.classList.toggle('workspace-search-ready', Boolean(slot?.querySelector('.filter-search')));
  const ready = initializeRankingView(mounted.signal);
  initializeAllTimeView(mounted.signal);
  initializeCountdowns(mounted.signal);
  initializeFreshness(mounted.signal);
  initializeTickers(mounted.signal);
  paintTrends();
  const body = document.querySelector('[data-ranking-body]');
  if (body) {
    const observer = new MutationObserver(() => paintTrends(body));
    observer.observe(body, { childList: true });
    mounted.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  }
  document.querySelectorAll('[data-density-toggle]').forEach(button => {
    const compact = document.documentElement.dataset.rankingDensity === 'compact';
    button.textContent = compact ? '详细模式' : '紧凑模式';
    button.setAttribute('aria-pressed', String(compact));
  });
  return ready;
};

function scrollToRanking(url: URL, fallbackToTop = true) {
  let anchor: HTMLElement | null = null;
  try { anchor = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null; } catch { /* Malformed fragments have no target. */ }
  if (anchor) anchor.scrollIntoView({ behavior: 'instant' });
  else if (fallbackToTop) window.scrollTo({ top: 0, behavior: 'instant' });
}

const headSelectors = 'meta[name="description"],meta[name="robots"],meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"],link[rel="prev"],link[rel="next"],script[type="application/ld+json"]';
async function navigate(url: URL, historyMode: 'push' | 'pop') {
  const current = document.querySelector('main[data-ranking-navigation]');
  if (!(current instanceof HTMLElement)) { location.assign(url.href); return; }
  pending?.abort();
  mounted.abort();
  const request = new AbortController(); pending = request;
  const ticket = ++generation;
  current.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(url, { signal: request.signal, headers: { Accept: 'text/html' } });
    if (!response.ok || new URL(response.url).origin !== location.origin) throw new Error('Navigation unavailable');
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    const replacement = parsed.querySelector('main[data-ranking-navigation]');
    if (!replacement) throw new Error('Unsupported ranking page');
    if (ticket !== generation || request.signal.aborted) return;
    // Never execute fetched inline/module scripts. Controllers have explicit mount/dispose boundaries.
    replacement.querySelectorAll('script').forEach(script => script.remove());
    mounted.abort(); mounted = new AbortController();
    if (historyMode === 'push') history.pushState({ rankingNavigation: true }, '', url);
    current.replaceWith(replacement);
    document.title = parsed.title;
    document.head.querySelectorAll(headSelectors).forEach(node => node.remove());
    parsed.head.querySelectorAll(headSelectors).forEach(node => document.head.append(document.importNode(node, true)));
    const breadcrumb = document.querySelector('.workspace-breadcrumb strong');
    if (breadcrumb) breadcrumb.textContent = parsed.querySelector('.workspace-breadcrumb strong')?.textContent ?? '';
    const navigationState = new Map([...parsed.querySelectorAll('.workspace-sidebar nav a')].map(link => [link.getAttribute('href'), link.getAttribute('aria-current')]));
    document.querySelectorAll('.workspace-sidebar nav a').forEach(link => {
      const state = navigationState.get(link.getAttribute('href'));
      if (state) link.setAttribute('aria-current', state);
      else link.removeAttribute('aria-current');
    });
    rankingLocation.key = url.pathname + url.search;
    await mount();
    if (ticket !== generation || request.signal.aborted) return;
    const active = document.querySelector<HTMLElement>('.workspace-periods [aria-current="page"]');
    active?.focus({ preventScroll: true });
    scrollToRanking(url);
    document.dispatchEvent(new CustomEvent('starrank:navigated'));
  } catch {
    if (ticket !== generation || request.signal.aborted) return;
    // Normal navigation remains a complete fallback, including offline/cache and no-JS paths.
    location.assign(url.href);
  } finally {
    if (ticket === generation) { pending = null; current.removeAttribute('aria-busy'); }
  }
}

function initialize() {
  const initialUrl = new URL(location.href);
  const initialGeneration = generation;
  void Promise.resolve(mount()).then(() => {
    if (generation === initialGeneration && location.href === initialUrl.href && initialUrl.hash) scrollToRanking(initialUrl, false);
  });
  window.addEventListener('projectlanguagechange', () => {
    if (!pending) rankingLocation.key = location.pathname + location.search;
  });
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.workspace-periods a') : null;
    if (!link || link.target || link.hasAttribute('download') || !document.querySelector('main[data-ranking-navigation]')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin) return;
    const current = new URL(location.href);
    for (const key of filterKeys) { const value = current.searchParams.get(key); if (value) url.searchParams.set(key, value); }
    event.preventDefault();
    if (url.href !== location.href || pending) void navigate(url, 'push');
  });
  window.addEventListener('popstate', () => {
    const url = new URL(location.href);
    if (!pending && rankingLocation.key === url.pathname + url.search) return;
    if (document.querySelector('main[data-ranking-navigation]')) void navigate(url, 'pop');
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
