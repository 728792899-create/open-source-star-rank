import { replaceRankingUrl } from './ranking-location';
  import { matchesEntry } from './filter-utils.mjs';

export function initializeAllTimeView(signal: AbortSignal) {
  const root = document.querySelector('[data-alltime]');
  if (root instanceof HTMLElement) {
    const search = document.querySelector('[data-search]');
    const language = root.querySelector('[data-language]');
    const category = root.querySelector('[data-category]');
    const projectType = root.querySelector('[data-project-type]');
    const scenario = root.querySelector('[data-scenario]');
    const advancedFilters = root.querySelector('[data-advanced-filters]');
    const advancedFilterSummary = root.querySelector('[data-advanced-filter-summary]');
    const visibleCount = root.querySelector('[data-visible-count]');
    const matchingCount = root.querySelector('[data-matching-count]');
    const emptyState = root.querySelector('[data-empty-state]');
    const actionStatus = root.querySelector('[data-action-status]');
    const filterStatus = root.querySelector('[data-filter-status]');
    const activeFilters = root.querySelector('[data-active-filters]');
    const activeFilterCopy = root.querySelector('[data-active-filter-copy]');
    const params = new URLSearchParams(window.location.search);
    const restore = (element: Element | null, value: string) => { if (element instanceof HTMLSelectElement && value && !Array.from(element.options).some(option => option.value === value)) {
          element.add(new Option(`${value}（本榜暂无）`, value));
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) element.value = value; };
    restore(search, params.get('q') ?? '');
    restore(language, params.get('language') ?? '');
    restore(category, params.get('category') ?? '');
    restore(projectType, params.get('type') ?? '');
    restore(scenario, params.get('scenario') ?? '');
    if (advancedFilters instanceof HTMLDetailsElement) {
      const restoreAdvanced = [params.get('language'), params.get('category'), params.get('type'), params.get('scenario')].some(Boolean);
      advancedFilters.open = restoreAdvanced || !window.matchMedia('(max-width: 680px)').matches;
    }

    let resultPage = Math.max(1, Number(params.get('result_page')) || 1);
    const pagination = root.querySelector('[data-alltime-pagination]');
    const apply = () => {
      if (signal.aborted || !root.isConnected) return;
      const query = search instanceof HTMLInputElement ? search.value : '';
      const selectedLanguage = language instanceof HTMLSelectElement ? language.value : '';
      const selectedCategory = category instanceof HTMLSelectElement ? category.value : '';
      const selectedProjectType = projectType instanceof HTMLSelectElement ? projectType.value : '';
      const selectedScenario = scenario instanceof HTMLSelectElement ? scenario.value : '';
      const activeCount = [selectedLanguage, selectedCategory, selectedProjectType, selectedScenario].filter(Boolean).length;
      const filtering = Boolean(query.trim() || activeCount);
      const rows = [...root.querySelectorAll<HTMLElement>('[data-ranking-row]')];
      const matching = rows.filter(row => matchesEntry({
        searchText: row.dataset.searchText ?? '', language: row.dataset.language ?? '',
        category: row.dataset.category ?? '', projectType: row.dataset.projectType ?? '',
        scenarios: (row.dataset.scenarios ?? '').split(',').filter(Boolean),
      }, query, selectedLanguage, selectedCategory, selectedProjectType, selectedScenario));
      const matched = matching.length;
      const available = filtering ? Math.min(500, matched) : matched;
      const pages = Math.max(1, Math.ceil(available / 100));
      resultPage = Math.min(pages, Math.max(1, Math.floor(resultPage)));
      const first = (resultPage - 1) * 100;
      const visible = new Map(matching.slice(first, Math.min(available, first + 100)).map((row, index) => [row, first + index + 1]));
      for (const row of rows) {
        const position = visible.get(row);
        row.hidden = !position;
        if (!position) continue;
        const rank = row.querySelector('.rank-number');
        if (rank) rank.textContent = String(filtering ? position : Number(row.dataset.sourceRank)).padStart(2, '0');
        const sourceRank = row.querySelector<HTMLElement>('.source-rank');
        if (sourceRank) sourceRank.hidden = !filtering;
        row.querySelector('.rank-cell')?.setAttribute('aria-label', filtering
          ? `筛选排名 ${position}，历史总榜排名 ${row.dataset.sourceRank}` : `历史排名 ${row.dataset.sourceRank}`);
        const share = row.querySelector<HTMLElement>('[data-share-project]');
        if (share) share.dataset.shareRank = String(filtering ? position : row.dataset.sourceRank);
      }
      const shown = visible.size;
      if (visibleCount) visibleCount.textContent = String(shown);
      if (matchingCount) matchingCount.textContent = String(matched);
      if (pagination instanceof HTMLElement) {
        pagination.hidden = pages <= 1;
        pagination.replaceChildren();
        for (let target = 1; target <= pages; target++) {
          const control = document.createElement(target === resultPage ? 'strong' : 'button');
          control.textContent = String(target);
          if (target === resultPage) control.setAttribute('aria-current', 'page');
          else { control.setAttribute('type', 'button'); control.addEventListener('click', () => { resultPage = target; apply(); }); }
          pagination.append(control);
        }
      }
      if (advancedFilterSummary) advancedFilterSummary.textContent = activeCount > 0 ? `${activeCount} 项已启用` : '未启用';
      const label = (control: Element | null, selected: string) => control instanceof HTMLSelectElement
        ? control.selectedOptions[0]?.textContent?.trim() || selected
        : selected;
      const selected = [
        query.trim() ? `搜索：${query.trim()}` : '',
        selectedLanguage ? label(language, selectedLanguage) : '',
        selectedCategory ? label(category, selectedCategory) : '',
        selectedProjectType ? label(projectType, selectedProjectType) : '',
        selectedScenario ? label(scenario, selectedScenario) : '',
      ].filter(Boolean);
      if (activeFilters instanceof HTMLElement) activeFilters.hidden = selected.length === 0;
      if (activeFilterCopy) activeFilterCopy.textContent = selected.length ? `当前条件：${selected.join(' × ')}` : '';
      if (filterStatus instanceof HTMLElement) {
        filterStatus.hidden = !filtering;
        filterStatus.textContent = filtering
          ? `当前条件匹配 ${matched} 个项目，按累计 Star 展示前 ${available} 项，本页 ${shown} 项；同时保留历史总榜名次。`
          : '';
      }
      if (emptyState instanceof HTMLElement) emptyState.hidden = rows.length === 0 || matched !== 0;
      const next = new URL(window.location.href);
      const sync = (key: string, value: string) => value ? next.searchParams.set(key, value) : next.searchParams.delete(key);
      sync('q', query.trim());
      sync('language', selectedLanguage);
      sync('category', selectedCategory);
      sync('type', selectedProjectType);
      sync('scenario', selectedScenario);
      sync('result_page', resultPage > 1 ? String(resultPage) : '');
      replaceRankingUrl(next);
    };
    for (const control of [search, language, category, projectType, scenario]) {
      control?.addEventListener('input', () => { resultPage = 1; apply(); });
      control?.addEventListener('change', () => { resultPage = 1; apply(); });
    }
    root.addEventListener('click', (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-clear-filters]')) return;
      resultPage = 1;
      if (search instanceof HTMLInputElement) search.value = '';
      if (language instanceof HTMLSelectElement) language.value = '';
      if (category instanceof HTMLSelectElement) category.value = '';
      if (projectType instanceof HTMLSelectElement) projectType.value = '';
      if (scenario instanceof HTMLSelectElement) scenario.value = '';
      if (advancedFilters instanceof HTMLDetailsElement && window.matchMedia('(max-width: 680px)').matches) advancedFilters.open = false;
      apply();
    });
    root.querySelector('[data-copy-ranking]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        if (actionStatus) actionStatus.textContent = '榜单链接已复制';
      } catch {
        if (actionStatus) actionStatus.textContent = '复制失败，请从地址栏复制';
      }
    });
    root.addEventListener('click', async event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-share-project]') : null;
      if (!button) return;
      const name = document.documentElement.dataset.projectLanguage === 'original' ? button.dataset.shareNameOriginal : button.dataset.shareNameZh;
      const url = new URL(location.href); url.hash = button.closest('[data-ranking-row]')?.id ?? '';
      try {
        if (navigator.share) await navigator.share({ title: `${name}｜累计 Star 第 ${button.dataset.shareRank} 名`, url: url.href });
        else await navigator.clipboard.writeText(url.href);
        if (actionStatus) actionStatus.textContent = '项目分享已完成';
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (actionStatus) actionStatus.textContent = '分享失败，请复制地址栏链接';
      }
    });
    apply();
  }

}
