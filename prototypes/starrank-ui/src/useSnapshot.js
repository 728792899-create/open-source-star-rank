import { useEffect, useState } from 'react';
import { loadSnapshot } from './snapshot-service.js';

export function useSnapshot(date, scenario) {
  const key = `${date}:${scenario}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ key, status: 'loading', data: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, status: 'loading', data: null });
    loadSnapshot(date, { scenario, signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ key, status: 'ready', data });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ key, status: 'error', data: null, error });
    });
    return () => controller.abort();
  }, [date, scenario, key, attempt]);
  return { ...(state.key === key ? state : { key, status: 'loading', data: null }), retry: () => setAttempt(n => n + 1) };
}
