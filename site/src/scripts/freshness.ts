
  import { freshnessState } from './freshness-utils.mjs';

export function initializeFreshness(signal: AbortSignal) {
  const updateFreshness = () => {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    for (const element of document.querySelectorAll('[data-freshness]')) {
      if (!(element instanceof HTMLElement)) continue;
      const updatedAt = element.dataset.updatedAt;
      if (!updatedAt) continue;
      const threshold = Number(element.dataset.thresholdHours || 36);
      const stale = freshnessState(updatedAt, threshold).status === 'stale';
      const warning = element.classList.contains('warning');
      const compact = element.classList.contains('compact');
      element.classList.toggle('stale', stale);
      const message = element.querySelector('[data-freshness-message]');
      if (message) {
        if (warning && !stale) continue;
        message.textContent = element.dataset.customStaleMessage || (stale
          ? `数据已超过 ${threshold} 小时未更新；当前仍展示最后一次成功发布（${formatter.format(new Date(updatedAt))}）。`
          : compact
            ? `数据正常 · 最近采样 ${formatter.format(new Date(updatedAt))}（北京时间）`
            : `最近采样：${formatter.format(new Date(updatedAt))}（北京时间），数据正常。`);
      }
    }
  };
  const timer = window.setTimeout(updateFreshness, 2000);
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

}
