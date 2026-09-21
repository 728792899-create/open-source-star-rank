// A shared signed scale: missing days stay gaps and zero stays on the baseline.
export function trendGeometry(values) {
  const series = Array.isArray(values) ? values.map(v => typeof v === 'number' && Number.isFinite(v) ? v : null) : [];
  const min = Math.min(0, ...series.filter(v => v !== null));
  const max = Math.max(0, ...series.filter(v => v !== null));
  const span = max - min || 1;
  const y = value => 34 - (value - min) / span * 28;
  return { baseline: y(0), points: series.map((value, i) => value === null ? null : [4 + i * 88 / Math.max(1, series.length - 1), y(value)]), negative: (series.findLast(v => v !== null) ?? 0) < 0 };
}
const paintedCanvases = new WeakSet();
/** @param {ParentNode} root */
export function paintTrends(root = document) {
  for (const cell of root.querySelectorAll('[data-trend-values]')) {
    const canvas = cell.querySelector('canvas');
    if (!canvas || paintedCanvases.has(canvas)) continue;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    let geometry;
    try { geometry = trendGeometry(JSON.parse(cell.dataset.trendValues)); } catch { continue; }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = 96 * ratio; canvas.height = 40 * ratio; ctx.scale(ratio, ratio);
    ctx.strokeStyle = '#d4d7ce'; ctx.lineWidth = .75;
    ctx.beginPath(); ctx.moveTo(2, geometry.baseline); ctx.lineTo(94, geometry.baseline); ctx.stroke();
    ctx.strokeStyle = geometry.negative ? '#a34936' : '#287044'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1.8;
    let previous = null;
    for (const point of geometry.points) {
      if (point) { ctx.beginPath(); if (previous) { ctx.moveTo(...previous); ctx.lineTo(...point); ctx.stroke(); } ctx.beginPath(); ctx.arc(...point, 1.5, 0, 2 * Math.PI); ctx.fill(); }
      previous = point;
    }
    paintedCanvases.add(canvas);
    canvas.dataset.painted = 'true';
  }
}
