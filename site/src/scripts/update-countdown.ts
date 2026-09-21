
export function initializeCountdowns(signal: AbortSignal) {
    const units = (milliseconds: number) => {
      const seconds = Math.max(0, Math.floor(milliseconds / 1000));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainder = seconds % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    };
    for (const root of document.querySelectorAll('[data-update-countdown]')) {
      if (!(root instanceof HTMLElement) || root.dataset.enhanced === 'true') continue;
      root.dataset.enhanced = 'true';
      const value = root.querySelector('[data-countdown-value]');
      const refresh = root.querySelector('[data-countdown-refresh]');
      const target = new Date(root.dataset.nextAt || '').getTime();
      let polling = false;
      let lastPoll = 0;
      const check = async () => {
        if (polling || Date.now() - lastPoll < 60_000 || !root.dataset.indexPath) return;
        polling = true;
        lastPoll = Date.now();
        try {
          const response = await fetch(root.dataset.indexPath, { cache: 'no-store', signal });
          if (!response.ok) return;
          const payload = await response.json();
          if (signal.aborted || !root.isConnected) return;
          const marker = payload.updated_at || payload.generated_at || '';
          const next = payload.next_refresh_at || payload.sampling?.next_scheduled_at || '';
          if ((marker && marker !== root.dataset.updatedAt) || (next && next !== root.dataset.nextAt)) {
            if (value) value.textContent = '新数据已发布';
            if (refresh instanceof HTMLButtonElement) refresh.hidden = false;
          }
        } catch {} finally { polling = false; }
      };
      const render = () => {
        const remaining = target - Date.now();
        if (value) value.textContent = remaining > 0 ? units(remaining) : '已到计划时间，等待自动发布';
        if (remaining <= 0) check();
      };
      refresh?.addEventListener('click', () => window.location.reload());
      render();
      const timer = window.setInterval(render, 1000);
      signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    }
}
