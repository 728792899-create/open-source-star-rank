export function initializeTickers(signal: AbortSignal) {
for (const root of document.querySelectorAll<HTMLElement>('[data-ranking-ticker]')) {
  const items = [...root.querySelectorAll<HTMLElement>('[data-ticker-item]')];
  const controls = root.querySelector<HTMLElement>('[data-ticker-controls]');
  const pause = root.querySelector<HTMLButtonElement>('[data-ticker-pause]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0;
  let paused = false;
  let timer: number | undefined;
  const render = () => {
    const enabled = !reduced.matches && items.length > 1;
    root.classList.toggle('ticker-enhanced', enabled);
    root.dataset.tickerIndex = String(current);
    if (controls) controls.hidden = !enabled;
    items.forEach((item, index) => {
      const hidden = enabled && index !== current;
      item.setAttribute('aria-hidden', String(hidden));
      item.inert = hidden;
    });
    if (pause) {
      pause.textContent = paused ? '播放' : '暂停';
      pause.setAttribute('aria-label', paused ? '播放信息轮播' : '暂停信息轮播');
      pause.setAttribute('aria-pressed', String(paused));
    }
  };
  const move = (step: number) => { current = (current + step + items.length) % items.length; render(); };
  const stop = () => { window.clearInterval(timer); timer = undefined; };
  const start = () => {
    stop();
    if (!reduced.matches && items.length > 1 && !document.hidden && !paused) {
      timer = window.setInterval(() => {
        if (!root.matches(':hover, :focus-within')) move(1);
      }, 8000);
    }
  };
  root.querySelector('[data-ticker-prev]')?.addEventListener('click', () => { move(-1); start(); });
  root.querySelector('[data-ticker-next]')?.addEventListener('click', () => { move(1); start(); });
  pause?.addEventListener('click', () => { paused = !paused; render(); start(); }, { signal });
  reduced.addEventListener('change', () => { render(); start(); }, { signal });
  document.addEventListener('visibilitychange', start, { signal });
  window.addEventListener('pagehide', stop, { signal });
  window.addEventListener('pageshow', start, { signal });
  signal.addEventListener('abort', stop, { once: true });
  render();
  start();
}

}
