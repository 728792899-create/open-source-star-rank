import { useEffect, useRef, useState } from 'react';
import { defaultFilters, initializeHistory, parseRoute, serializeRoute } from './navigation.js';

export function useNavigation() {
  const [route, setRoute] = useState(() => parseRoute(window.location.search));
  const current = useRef(route);
  const viewFilters = useRef({ [route.view]: route.filters });

  useEffect(() => {
    // Canonicalize invalid or obsolete parameters without adding a history entry.
    initializeHistory(current.current, window.history, window.location.pathname);
    const onPop = event => {
      const next = parseRoute(window.location.search);
      // Compare choices are a working selection, like a basket. Internal Back/Forward
      // changes the screen while retaining edits made in a child panel.
      if (event.state?.starRank) {
        next.compared = current.current.compared;
        if (current.current.modal && next.view === current.current.view) {
          next.filters = current.current.filters;
          next.scenario = current.current.scenario;
          next.differences = current.current.differences;
        }
      }
      current.current = next;
      viewFilters.current[next.view] = next.filters;
      window.history.replaceState(event.state, '', window.location.pathname + serializeRoute(next));
      setRoute(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function commit(change, mode = 'replace') {
    const previous = current.current;
    const next = typeof change === 'function' ? change(previous) : { ...previous, ...change };
    const previousMeta = window.history.state?.starRank || { depth: 0 };
    let meta = previousMeta;
    if (mode === 'push') {
      window.history.replaceState({ ...window.history.state, starRank: previousMeta }, '');
      meta = { depth: next.modal ? (previous.modal ? previousMeta.depth + 1 : 1) : 0 };
    }
    window.history[mode === 'push' ? 'pushState' : 'replaceState'](
      { ...window.history.state, starRank: meta }, '', window.location.pathname + serializeRoute(next),
    );
    current.current = next;
    viewFilters.current[next.view] = next.filters;
    setRoute(next);
  }
  function navigate(view) {
    commit(previous => ({ ...previous, view, modal: null, filters: viewFilters.current[view] || defaultFilters(view) }), 'push');
  }
  function openModal(modal) { commit({ modal }, 'push'); }
  function dismiss() {
    const depth = window.history.state?.starRank?.depth || 0;
    if (depth > 0) window.history.go(-depth);
    else commit({ modal: null });
  }
  function returnPanel(fallback) {
    if ((window.history.state?.starRank?.depth || 0) > 1) window.history.back();
    else commit({ modal: fallback });
  }
  return { route, commit, navigate, openModal, dismiss, returnPanel };
}
