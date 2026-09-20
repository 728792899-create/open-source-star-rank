import { dates, snapshotFor } from './data.js';

// A cancellable demo adapter, not a live GitHub API. A future provider can keep
// this response contract while replacing only the source of snapshots.
export function loadSnapshot(date, { signal, scenario = 'ready', delay = 140 } = {}) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      if (scenario === 'error') { reject(new Error('演示快照暂时无法读取')); return; }
      const index = dates.findIndex(d => d.value === date);
      const actualDate = scenario === 'stale' ? dates[Math.min(index + 1, dates.length - 1)].value : date;
      let items = snapshotFor(actualDate);
      if (scenario === 'empty') items = [];
      if (scenario === 'partial') items = items.map((project, index) => {
        if (index === 0) return { ...project, day: null, week: null, month: null, dailyTrend: [] };
        if (index === 1) return { ...project, day: 0, week: project.week - project.day, month: project.month - project.day, dailyTrend: [...project.dailyTrend.slice(0, -1), 0] };
        if (index === 5) return { ...project, day: -28, week: -140, month: -360, dailyTrend: [-11, -20, -16, -24, -18, -23, -28], archived: true };
        return project;
      });
      resolve({ items, requestedDate: date, date: actualDate, stale: actualDate !== date, partial: scenario === 'partial' });
    }, delay);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
