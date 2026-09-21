  import { matchesEntry, clampResultPage } from './filter-utils.mjs';
  import { filteredRanking, metadataMaps } from './ranking-explorer.mjs';

export function initializeRankingView(signal: AbortSignal) {
  const root = document.querySelector('[data-ranking]');
  if (root instanceof HTMLElement) {
    const initializeRanking = () => {
      if (root.dataset.rankingEnhanced === 'true') return;
      root.dataset.rankingEnhanced = 'true';
      const search = document.querySelector('[data-search]');
      const language = root.querySelector('[data-language]');
      const category = root.querySelector('[data-category]');
      const projectType = root.querySelector('[data-project-type]');
      const scenario = root.querySelector('[data-scenario]');
      const advancedFilters = root.querySelector('[data-advanced-filters]');
      const advancedFilterSummary = root.querySelector('[data-advanced-filter-summary]');
      const visibleCount = root.querySelector('[data-visible-count]');
      const poolCount = root.querySelector('[data-pool-count]');
      const emptyState = root.querySelector('[data-empty-state]');
      const filterStatus = root.querySelector('[data-filter-status]');
      const retryFilters = root.querySelector('[data-retry-filters]');
      const activeFilters = root.querySelector('[data-active-filters]');
      const activeFilterCopy = root.querySelector('[data-active-filter-copy]');
      const actionStatus = root.querySelector('[data-action-status]');
      const body = root.querySelector('[data-ranking-body]');
      const staticPagination = root.querySelector('[data-static-pagination]');
      const filterPagination = root.querySelector('[data-filter-pagination]');
      const rankingDate = root.dataset.rankingDate ?? '';
      const fixedLanguage = root.dataset.fixedLanguage ?? '';
      const resultPageSize = Number(root.dataset.pageSize || 100);
      const staticMarkup = body?.innerHTML ?? '';
      const staticCount = root.querySelectorAll('[data-ranking-row]').length;
      const parameters = new URLSearchParams(window.location.search);
      let resultPage = Math.max(1, Number(parameters.get('result_page') || 1) || 1);
      const restore = (element: Element | null, value: string) => {
        if (element instanceof HTMLSelectElement && value && !Array.from(element.options).some(option => option.value === value)) {
          element.add(new Option(`${value}（本榜暂无）`, value));
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) element.value = value;
      };
      restore(search, parameters.get('q') ?? '');
      restore(language, fixedLanguage || parameters.get('language') || '');
      restore(category, parameters.get('category') ?? '');
      restore(projectType, parameters.get('type') ?? '');
      restore(scenario, parameters.get('scenario') ?? '');
      if (advancedFilters instanceof HTMLDetailsElement) {
        const restoreAdvanced = [parameters.get('language'), parameters.get('category'), parameters.get('type'), parameters.get('scenario')].some(Boolean);
        advancedFilters.open = restoreAdvanced || !window.matchMedia('(max-width: 680px)').matches;
      }

      const json = async (url: string | undefined, optional = false) => {
        if (!url) return null;
        const response = await fetch(url, { cache: 'force-cache', signal });
        if (!response.ok) {
          if (optional && response.status === 404) return null;
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      };
      let resourcesPromise: Promise<any> | null = null;
      const resources = () => {
        if (resourcesPromise) return resourcesPromise;
        resourcesPromise = Promise.all([
          json(root.dataset.explorationPath),
          json(root.dataset.previousExplorationPath, true),
          json(root.dataset.localizationPath),
          json(root.dataset.classificationPath),
          json(root.dataset.taxonomyPath),
        ]).then(([current, previous, localization, classifications, taxonomy]) => ({
          current: current?.entries ?? [], previous: previous?.entries ?? [],
          maps: metadataMaps(localization, classifications, taxonomy),
        })).catch(error => { resourcesPromise = null; throw error; });
        return resourcesPromise;
      };

      const filters = () => ({
        query: search instanceof HTMLInputElement ? search.value.trim() : '',
        language: fixedLanguage || (language instanceof HTMLSelectElement ? language.value : ''),
        category: category instanceof HTMLSelectElement ? category.value : '',
        projectType: projectType instanceof HTMLSelectElement ? projectType.value : '',
        scenario: scenario instanceof HTMLSelectElement ? scenario.value : '',
      });
      const explicitFilterActive = (value: ReturnType<typeof filters>) => Boolean(
        value.query || (!fixedLanguage && value.language) || value.category || value.projectType || value.scenario,
      );
      const syncUrl = (value: ReturnType<typeof filters>) => {
        const next = new URL(window.location.href);
        const sync = (key: string, selected: string) => selected ? next.searchParams.set(key, selected) : next.searchParams.delete(key);
        sync('q', value.query);
        sync('language', fixedLanguage ? '' : value.language);
        sync('category', value.category);
        sync('type', value.projectType);
        sync('scenario', value.scenario);
        explicitFilterActive(value) && resultPage > 1
          ? next.searchParams.set('result_page', String(resultPage))
          : next.searchParams.delete('result_page');
        if (!signal.aborted && root.isConnected) window.history.replaceState(window.history.state, '', next);
      };
      const updateSummary = (value: ReturnType<typeof filters>) => {
        const count = [!fixedLanguage && value.language, value.category, value.projectType, value.scenario].filter(Boolean).length;
        if (advancedFilterSummary) advancedFilterSummary.textContent = count ? `${count} 项已启用` : '未启用';
        const label = (control: Element | null, selected: string) => control instanceof HTMLSelectElement
          ? control.selectedOptions[0]?.textContent?.trim() || selected
          : selected;
        const selected = [
          value.query ? `搜索：${value.query}` : '',
          !fixedLanguage && value.language ? label(language, value.language) : '',
          value.category ? label(category, value.category) : '',
          value.projectType ? label(projectType, value.projectType) : '',
          value.scenario ? label(scenario, value.scenario) : '',
        ].filter(Boolean);
        if (activeFilters instanceof HTMLElement) activeFilters.hidden = selected.length === 0;
        if (activeFilterCopy) activeFilterCopy.textContent = selected.length ? `当前条件：${selected.join(' × ')}` : '';
      };
      const element = (tag: string, className?: string, text?: string) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
      const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
      const movement = (value: number | null) => value === null ? ['新入选', 'new'] : value > 0 ? [`↑${value}`, 'up'] : value < 0 ? [`↓${Math.abs(value)}`, 'down'] : ['—', 'flat'];
      const contentLanguage = () => document.documentElement.dataset.projectLanguage === 'original' ? 'original' : 'zh';
      const lifecycleDate = (value: string | null | undefined) => {
        if (!value) return null;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(date);
      };
      const lifecycleAge = (value: string | null | undefined) => {
        if (!value) return '发布天数待补充';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '发布天数待补充';
        const key = (item: Date) => new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(item);
        const days = Math.max(0, Math.floor((new Date(`${key(new Date())}T00:00:00+08:00`).getTime()
          - new Date(`${key(date)}T00:00:00+08:00`).getTime()) / 86_400_000));
        return days === 0 ? '今天发布' : `已发布 ${number(days)} 天`;
      };

      const renderFilterPagination = (available: number, onSelect: (page: number) => void) => {
        if (!(filterPagination instanceof HTMLElement)) return;
        const pages = Math.ceil(available / resultPageSize);
        resultPage = Math.min(Math.max(1, resultPage), Math.max(1, pages));
        filterPagination.hidden = pages <= 1;
        filterPagination.replaceChildren();
        if (pages <= 1) return;
        const add = (label: string, target: number, current = false) => {
          if (current) {
            const active = element('strong', '', label);
            active.setAttribute('aria-current', 'page');
            filterPagination.append(active);
            return;
          }
          const button = element('button', '', label) as HTMLButtonElement;
          button.type = 'button';
          button.addEventListener('click', () => onSelect(target));
          filterPagination.append(button);
        };
        add('首页', 1, resultPage === 1);
        if (resultPage > 1) add('← 上一页', resultPage - 1);
        for (let target = 1; target <= pages; target += 1) add(String(target), target, target === resultPage);
        if (resultPage < pages) add('下一页 →', resultPage + 1);
      };

      const renderRow = (entry: any, maps: any) => {
        const classification = maps.classified.get(Number(entry.repository_id));
        const localization = maps.localized.get(Number(entry.repository_id));
        const categoryLabel = classification ? maps.labels.categories.get(classification.primary_category) : null;
        const typeLabel = classification ? maps.labels.projectTypes.get(classification.project_type) : null;
        const scenarioLabels = (classification?.use_cases ?? []).map((item: string) => maps.labels.useCases.get(item)).filter(Boolean);
        const [movementText, movementClass] = movement(entry.filtered_rank_change);
        const row = element('div', 'ranking-row');
        row.id = `repo-${entry.repository_id}`;
        row.setAttribute('role', 'row');
        row.dataset.rankingRow = '';
        row.dataset.rank = String(entry.filtered_rank);
        row.dataset.sourceRank = String(entry.source_rank);
        row.dataset.language = entry.language ?? '';
        row.dataset.category = classification?.primary_category ?? '';
        row.dataset.projectType = classification?.project_type ?? '';
        row.dataset.scenarios = (classification?.use_cases ?? []).join(',');

        const rank = element('strong', `rank-cell ${movementClass}`);
        rank.setAttribute('role', 'cell');
        rank.dataset.movement = movementText;
        rank.setAttribute('aria-label', `筛选排名 ${entry.filtered_rank}，总榜排名 ${entry.source_rank}，变化 ${movementText}`);
        rank.append(element('span', 'rank-number', String(entry.filtered_rank).padStart(2, '0')));
        rank.append(element('small', 'source-rank', `总榜 #${entry.source_rank}`));
        row.append(rank);

        const project = element('div', 'project-cell');
        project.setAttribute('role', 'cell');
        const copy = element('div', 'project-copy');
        const profileUrl = `${root.dataset.repositoryBase}${entry.repository_id}/`;
        const link = (label: string, languageName?: string) => {
          const anchor = element('a', 'project-link', label) as HTMLAnchorElement;
          anchor.href = profileUrl;
          if (languageName) anchor.dataset.contentLanguage = languageName;
          return anchor;
        };
        if (localization) {
          copy.append(link(localization.display_name_zh, 'zh'), link(entry.full_name, 'original'));
          const source = element('span', 'project-source-row');
          source.dataset.contentLanguage = 'zh';
          source.append(element('span', 'project-source-name', entry.full_name));
          source.append(element('span', 'translation-badge', localization.provenance === 'manual' ? '人工校订' : 'AI 译'));
          copy.append(source);
          const description = element('p');
          const zh = element('span', '', localization.description_zh || 'GitHub 未提供项目描述。');
          zh.dataset.contentLanguage = 'zh';
          const original = element('span', '', entry.description || 'No description provided.');
          original.dataset.contentLanguage = 'original';
          description.append(zh, original);
          copy.append(description);
        } else {
          copy.append(link(entry.full_name));
          const pending = element('span', 'project-source-row');
          pending.append(element('span', 'translation-pending', '中文待生成'));
          copy.append(pending, element('p', '', entry.description || 'No description provided.'));
        }
        if (classification) {
          const tags = element('div', 'classification-tags');
          tags.setAttribute('aria-label', '项目分类');
          tags.append(element('span', 'primary-category-tag', categoryLabel ?? classification.primary_category));
          tags.append(element('span', '', typeLabel ?? classification.project_type));
          for (const label of scenarioLabels.slice(0, 2)) tags.append(element('span', '', label));
          copy.append(tags);
        } else copy.append(element('span', 'classification-pending', '分类待生成'));
        const lifecycle = element('p', 'project-lifecycle');
        lifecycle.append(
          element('span', '', `作者 ${String(entry.full_name).split('/')[0] || entry.full_name}`),
          element('span', '', entry.created_at ? `创建 ${lifecycleDate(entry.created_at)}` : '创建时间待补充'),
          element('span', '', entry.pushed_at ? `最近推送 ${lifecycleDate(entry.pushed_at)}` : '更新日期待补充'),
          element('span', '', lifecycleAge(entry.created_at)),
        );
        copy.append(lifecycle);
        const avatar = element('img', 'workspace-project-avatar') as HTMLImageElement;
        avatar.src = entry.owner_avatar_url?.startsWith('https://avatars.githubusercontent.com/') ? entry.owner_avatar_url : root.dataset.avatarFallback ?? '';
        avatar.alt = ''; avatar.width = 46; avatar.height = 46; avatar.loading = 'lazy';
        project.append(avatar, copy);
        const github = element('a', 'github-link', 'GitHub ↗') as HTMLAnchorElement;
        github.href = entry.html_url;
        github.target = '_blank';
        github.rel = 'noreferrer';
        github.setAttribute('aria-label', `在 GitHub 打开 ${entry.full_name}`);
        project.append(github);
        const share = element('button', 'share-project', '分享') as HTMLButtonElement;
        share.type = 'button';
        share.dataset.shareProject = '';
        share.dataset.shareNameZh = localization?.display_name_zh ?? entry.full_name;
        share.dataset.shareNameOriginal = entry.full_name;
        share.dataset.shareRank = String(entry.filtered_rank);
        share.setAttribute('aria-label', `分享 ${entry.full_name} 的筛选榜第 ${entry.filtered_rank} 名`);

        row.append(project);
        const lang = element('div', 'language-cell', entry.language || 'Other');
        lang.setAttribute('role', 'cell');
        row.append(lang);
        const trend = element('div', 'trend-cell');
        trend.setAttribute('role', 'cell');
        const trendValues = Array.isArray(entry.trend_7d) ? entry.trend_7d : Array(7).fill(null);
        trend.setAttribute('aria-label', `最近七日：${trendValues.map((item: number | null) => item ?? '无数据').join('、')}`);
        trend.dataset.trendValues = JSON.stringify(trendValues);
        const chart = element('canvas') as HTMLCanvasElement; chart.width = 96; chart.height = 40; chart.setAttribute('aria-hidden', 'true'); trend.append(chart);
        row.append(trend);
        const gain = Number(entry[root.dataset.gainField ?? 'stars_gained'] ?? 0);
        const stars = element('div', `stars-cell numeric${gain < 0 ? ' negative' : ''}`, `${compact(entry.stars_total)} · ${gain >= 0 ? '+' : ''}${number(gain)}`);
        stars.setAttribute('role', 'cell');
        stars.dataset.mobileLabel = `总 Star / ${root.dataset.gainLabel ?? '增量'}`;
        row.append(stars);
        const action = element('a', 'workspace-project-action', '查看项目 →') as HTMLAnchorElement;
        action.href = profileUrl;
        const actions = element('div', 'workspace-project-actions'); actions.setAttribute('role', 'cell'); actions.append(action, share); row.append(actions);
        return row;
      };

      let requestId = 0;
      const applyStaticFallback = (value: ReturnType<typeof filters>) => {
        let rank = 0;
        for (const row of root.querySelectorAll('[data-ranking-row]')) {
          if (!(row instanceof HTMLElement)) continue;
          const visible = matchesEntry({
            searchText: row.dataset.searchText ?? '', language: row.dataset.language ?? '',
            category: row.dataset.category ?? '', projectType: row.dataset.projectType ?? '',
            scenarios: (row.dataset.scenarios ?? '').split(',').filter(Boolean),
          }, value.query, value.language, value.category, value.projectType, value.scenario);
          row.hidden = !visible;
          if (!visible) continue;
          rank += 1;
          const numberNode = row.querySelector('.rank-number');
          if (numberNode) numberNode.textContent = String(rank).padStart(2, '0');
          const source = row.querySelector('.source-rank');
          if (source instanceof HTMLElement) source.hidden = false;
          if (rank >= 100) break;
        }
        if (visibleCount) visibleCount.textContent = String(rank);
        if (emptyState instanceof HTMLElement) emptyState.hidden = rank !== 0;
        if (staticPagination instanceof HTMLElement) staticPagination.hidden = true;
        if (filterPagination instanceof HTMLElement) filterPagination.hidden = true;
      };
      const apply = async () => {
        if (signal.aborted || !root.isConnected) return;
        const value = filters();
        syncUrl(value);
        updateSummary(value);
        const currentRequest = ++requestId;
        if (retryFilters instanceof HTMLElement) retryFilters.hidden = true;
        if (!explicitFilterActive(value)) {
          if (body) body.innerHTML = staticMarkup;
          if (visibleCount) visibleCount.textContent = String(staticCount);
          if (poolCount) poolCount.textContent = root.dataset.explorationSize ?? String(staticCount);
          if (emptyState instanceof HTMLElement) emptyState.hidden = true;
          if (filterStatus instanceof HTMLElement) filterStatus.hidden = true;
          if (staticPagination instanceof HTMLElement) staticPagination.hidden = false;
          if (filterPagination instanceof HTMLElement) filterPagination.hidden = true;
          return;
        }
        if (!root.dataset.explorationPath) {
          applyStaticFallback(value);
          if (filterStatus instanceof HTMLElement) {
            filterStatus.hidden = false;
            filterStatus.textContent = '该历史日期尚无深度池，当前仅在已发布榜单内筛选。';
          }
          return;
        }
        if (filterStatus instanceof HTMLElement) {
          filterStatus.hidden = false;
          filterStatus.textContent = '正在从深度池生成筛选榜…';
        }
        try {
          const loaded = await resources();
          if (signal.aborted || !root.isConnected || currentRequest !== requestId) return;
          const result = filteredRanking(loaded.current, loaded.previous, loaded.maps, value, 500);
          resultPage = clampResultPage(resultPage, result.available, resultPageSize);
          const first = (resultPage - 1) * resultPageSize;
          const pageEntries = result.entries.slice(first, first + resultPageSize);
          if (body) body.replaceChildren(...pageEntries.map((entry: any) => renderRow(entry, loaded.maps)));
          if (visibleCount) visibleCount.textContent = String(pageEntries.length);
          if (poolCount) poolCount.textContent = String(result.total);
          if (emptyState instanceof HTMLElement) emptyState.hidden = result.total !== 0;
          if (staticPagination instanceof HTMLElement) staticPagination.hidden = true;
          renderFilterPagination(result.available, (target) => { resultPage = target; apply(); });
          syncUrl(value);
          if (filterStatus instanceof HTMLElement) {
            filterStatus.hidden = false;
            filterStatus.textContent = result.total > 500
              ? `符合条件 ${result.total} 项，按当前榜单口径展示重新排名后的前 500。`
              : `符合条件 ${result.total} 项，已全部纳入重新排名。`;
          }
        } catch {
          if (signal.aborted || !root.isConnected || currentRequest !== requestId) return;
          if (body) body.innerHTML = staticMarkup;
          applyStaticFallback(value);
          if (filterStatus instanceof HTMLElement) {
            filterStatus.hidden = false;
            filterStatus.textContent = '深度池暂时不可用，已回退到公开榜单内筛选。';
            if (retryFilters instanceof HTMLElement) retryFilters.hidden = false;
          }
        }
      };
      retryFilters?.addEventListener('click', () => apply());
      for (const control of [search, language, category, projectType, scenario]) {
        control?.addEventListener('input', () => { resultPage = 1; apply(); });
        control?.addEventListener('change', () => { resultPage = 1; apply(); });
      }
      root.addEventListener('click', (event) => {
        if (!(event.target instanceof Element) || !event.target.closest('[data-clear-filters]')) return;
        if (search instanceof HTMLInputElement) search.value = '';
        if (language instanceof HTMLSelectElement && !fixedLanguage) language.value = '';
        if (category instanceof HTMLSelectElement) category.value = '';
        if (projectType instanceof HTMLSelectElement) projectType.value = '';
        if (scenario instanceof HTMLSelectElement) scenario.value = '';
        resultPage = 1;
        if (advancedFilters instanceof HTMLDetailsElement && window.matchMedia('(max-width: 680px)').matches) advancedFilters.open = false;
        apply();
      });

      const copyText = async (value: string) => {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(value);
      };
      const setStatus = (message: string) => { if (actionStatus) actionStatus.textContent = message; };
      const rankingUrl = () => {
        const url = new URL(window.location.href);
        url.hash = '';
        return url.toString();
      };
      root.addEventListener('click', async (event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest('[data-copy-ranking]')) {
          try { await copyText(rankingUrl()); setStatus('榜单链接已复制'); }
          catch { setStatus('复制失败，请从地址栏复制'); }
          return;
        }
        const button = event.target.closest('[data-share-project]');
        if (!(button instanceof HTMLButtonElement)) return;
        const name = contentLanguage() === 'original'
          ? button.dataset.shareNameOriginal ?? 'GitHub 项目'
          : button.dataset.shareNameZh ?? button.dataset.shareNameOriginal ?? 'GitHub 项目';
        const rank = button.dataset.shareRank ?? '';
        const row = button.closest('[data-ranking-row]');
        const url = `${rankingUrl()}#${row?.id ?? ''}`;
        const shareData = { title: `${name}｜开源星榜第 ${rank} 名`, text: `${name} 在 ${rankingDate} 开源星榜位列第 ${rank} 名。`, url };
        try {
          if (navigator.share) { await navigator.share(shareData); setStatus('分享面板已打开'); }
          else { await copyText(url); setStatus(`${name} 的排名链接已复制`); }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          try { await copyText(url); setStatus(`${name} 的排名链接已复制`); }
          catch { setStatus('分享失败，请稍后重试'); }
        }
      });
      apply();
    };
    root.addEventListener('change', (event) => {
      if (event.target instanceof HTMLSelectElement && event.target.matches('[data-date-selector]') && event.target.value) {
        window.location.assign(event.target.value);
      }
    });
    initializeRanking();
  }

}
