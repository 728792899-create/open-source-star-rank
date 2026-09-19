import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { IconArrowDown, IconArrowRight, IconArrowUp, IconArrowUpRight, IconBookmark, IconBookmarkFilled, IconBrandGithub, IconCalendarWeek, IconChartBar, IconCheck, IconChevronDown, IconCommand, IconDatabase, IconFilter, IconHeart, IconInfoCircle, IconLayersSubtract, IconLink, IconPlus, IconRefresh, IconSearch, IconStarFilled, IconX } from '@tabler/icons-react';
import { compact, dates, periods, selectProjects, signed, trendTone } from './data.js';
import { categories, FAVORITES_KEY, languages, readFavorites, serializeRoute, viewNames, writeFavorites } from './navigation.js';
import { useNavigation } from './useNavigation.js';
import { useSnapshot } from './useSnapshot.js';
import { easing, Feedback, LoadingState, Modal, PanelBoundary, ProjectLogo, ShareFallback, Sparkline } from './ui.jsx';

const ProjectPanels = lazy(() => import('./ProjectPanels.jsx'));
const navItems = [{ id: 'discover', label: '发现项目', icon: IconSearch }, { id: 'trends', label: '趋势榜单', icon: IconChartBar }, { id: 'saved', label: '我的收藏', icon: IconHeart }, { id: 'compare', label: '项目对比', icon: IconLayersSubtract }];
const headings = { discover: ['发现下一个值得用的开源项目', '用真实趋势，找到适合你的工具。'], trends: ['看见热度背后的新趋势', '关注持续增长，而不只是此刻的热门。'], saved: ['好项目，值得留下来', '把灵感收进收藏，让下一次选择更简单。'] };
function initialFavorites() { try { return readFavorites(window.localStorage); } catch { return { ids: [], available: false }; } }

export function App() {
  const reduced = useReducedMotion();
  const { route, commit, navigate, openModal, dismiss, returnPanel } = useNavigation();
  const { view, filters, compared, modal } = route;
  const { query, language, category, period, date, ascending, minStars } = filters;
  const [favorites, setFavorites] = useState(initialFavorites);
  const favoritesRef = useRef(favorites.ids);
  const saved = favorites.ids;
  const [toast, setToast] = useState(null);
  const [shareFallback, setShareFallback] = useState('');
  const [demoSignedIn, setDemoSignedIn] = useState(false);
  const [trayCollapsed, setTrayCollapsed] = useState(true);
  const [visibleCount, setVisibleCount] = useState(20);
  const searchRef = useRef(null);
  const tabRefs = useRef([]);
  const lastDetail = useRef(null);
  const tabId = useId();
  const resource = useSnapshot(date, route.scenario);
  const snapshot = resource.data?.items || [];
  const activePeriod = periods.find(item => item.id === period);
  const activeDate = dates.find(item => item.value === (resource.data?.date || date));
  const visible = selectProjects(snapshot, { ...filters, savedOnly: view === 'saved', saved });
  const selectedProjects = compared.map(id => snapshot.find(project => project.id === id)).filter(Boolean);
  const filtered = Boolean(query.trim() || language || category || minStars);
  const screenKey = modal ? `${modal.type}:${modal.id || ''}` : '';

  useEffect(() => {
    const onKey = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
        event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select();
      }
    };
    const onStorage = event => {
      if (event.key === FAVORITES_KEY || event.key === null) {
        const next = initialFavorites(); favoritesRef.current = next.ids; setFavorites(next);
      }
    };
    document.addEventListener('keydown', onKey); window.addEventListener('storage', onStorage);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('storage', onStorage); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => { setShareFallback(''); }, [screenKey]);
  useEffect(() => { setVisibleCount(20); }, [query, language, category, period, date, view, minStars, ascending]);
  useEffect(() => { document.title = `${modal?.type === 'detail' ? snapshot.find(p => p.id === modal.id)?.name || '项目详情' : viewNames[view]} · 开源星榜`; }, [view, modal?.type, modal?.id, snapshot]);

  function notify(text, kind = 'success') { setToast({ text, kind, id: Date.now() }); }
  function toggleSave(project) {
    const exists = favoritesRef.current.includes(project.id);
    const ids = exists ? favoritesRef.current.filter(id => id !== project.id) : [...favoritesRef.current, project.id];
    let available = false;
    try { available = writeFavorites(window.localStorage, ids); } catch { /* disabled storage keeps this session usable */ }
    favoritesRef.current = ids; setFavorites({ ids, available });
    notify(`${exists ? '已取消收藏' : '已收藏'} ${project.name}${available ? '，已保存到本机' : '，当前仅保留在本次会话'}`, available ? 'success' : 'error');
  }
  function toggleCompare(project) {
    commit(previous => {
      const exists = previous.compared.includes(project.id);
      if (!exists && previous.compared.length >= 3) { notify('已选满 3 项，请先在调整项目中替换一项。', 'error'); return previous; }
      notify(exists ? `已将 ${project.name} 移出对比` : `已将 ${project.name} 加入对比`);
      return { ...previous, compared: exists ? previous.compared.filter(id => id !== project.id) : [...previous.compared, project.id] };
    });
  }
  function updateFilters(change) { commit(previous => ({ ...previous, filters: { ...previous.filters, ...change } })); }
  function clearFilters() { updateFilters({ query: '', language: '', category: '', minStars: 0 }); }
  function openDetail(project, from = null) { lastDetail.current = project.id; setToast(null); openModal({ type: 'detail', id: project.id, from, tab: 'overview' }); }
  function openPicker(back = null) { setToast(null); openModal({ type: 'picker', back }); }
  function openCompare() {
    setToast(null);
    if (modal?.type === 'picker') commit({ modal: { type: 'compare' } });
    else openModal({ type: 'compare' });
  }
  function retry() {
    if (route.scenario !== 'ready') commit({ scenario: 'ready' });
    else resource.retry();
  }
  function changeTab(event, index) {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % periods.length;
    if (event.key === 'ArrowLeft') next = (index + periods.length - 1) % periods.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = periods.length - 1;
    if (next !== undefined) { event.preventDefault(); updateFilters({ period: periods[next].id }); tabRefs.current[next]?.focus(); }
  }
  async function share() {
    const url = window.location.origin + window.location.pathname + serializeRoute(route, { share: true });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      notify(`链接已复制${['127.0.0.1', 'localhost'].includes(window.location.hostname) ? '，当前预览地址仅本机可用' : ''}`);
    } catch { setShareFallback(url); notify('请在链接框中选择并复制地址。', 'error'); }
  }
  const panelTitle = !modal ? '' : modal.type === 'detail' ? '项目详情' : modal.type === 'compare' ? '找到更适合你的那一个' : modal.type === 'picker' ? '选择对比项目' : modal.type === 'filters' ? '细化你的发现' : modal.type === 'login' ? '你的发现空间' : '让每一个数字都有来处';
  const panelProps = { route, resource, snapshot, saved, storageAvailable: favorites.available, toggleSave, toggleCompare, openDetail, openPicker, openCompare, returnPanel, dismiss, commit, updateFilters, retry, demoSignedIn,
    toggleAccount: () => { setDemoSignedIn(value => !value); dismiss(); notify(demoSignedIn ? '已退出演示账户，本机收藏仍保留' : '已进入演示账户'); } };

  return <MotionConfig reducedMotion="user" transition={{ duration: reduced ? 0 : 0.24, ease: easing }}>
    <a className="skip-link" href="#main-content">跳到项目榜单</a>
    <div data-view={view} className={`app-shell ${compared.length ? 'has-comparison' : ''}`}>
      <aside className="sidebar">
        <button className="brand" aria-label="开源星榜首页" onClick={() => navigate('discover')}><IconStarFilled size={46} className="brand-star" /><span><strong>开源星榜</strong><small>StarRank</small></span></button>
        <nav className="main-nav" aria-label="主导航">{navItems.map(item => <button key={item.id} aria-label={item.label} aria-current={view === item.id && modal?.type !== 'compare' ? 'page' : undefined} onClick={() => item.id === 'compare' ? openCompare() : navigate(item.id)} className={`nav-link ${view === item.id ? 'active' : ''}`}>
          {view === item.id && <motion.span className="nav-active-bg" layoutId="navigation-indicator" />}<item.icon size={23} stroke={1.65} /><span>{item.label}</span>{item.id === 'compare' && compared.length > 0 && <span className="nav-count">{compared.length}</span>}
        </button>)}</nav>
        <div className="sidebar-bottom"><button className="sub-nav" onClick={() => openModal({ type: 'method' })}><IconDatabase size={20} />数据与方法</button><a className="sub-nav" href="https://github.com/728792899-create/open-source-star-rank" target="_blank" rel="noreferrer"><IconBrandGithub size={20} />在 GitHub 上查看源码<IconArrowUpRight size={16} /></a><p>用开源的力量<br />让更好的工具被看见。</p><span className="sidebar-edition">DESIGNED FOR DISCOVERY</span></div>
      </aside>
      <div className="workspace">
        <header className="topbar"><div className="breadcrumb"><span>发现</span><span className="slash">/</span><strong>{viewNames[view]}</strong></div>
          <div className="global-search"><IconSearch size={21} /><input ref={searchRef} aria-label="搜索项目" value={query} maxLength={200} onChange={event => updateFilters({ query: event.target.value })} placeholder={view === 'saved' ? '搜索我的收藏…' : '搜索项目、关键词或描述…'} />{query ? <button className="search-clear" aria-label="清空搜索" onClick={() => { updateFilters({ query: '' }); searchRef.current?.focus(); }}><IconX size={18} /></button> : <kbd><IconCommand size={13} /> K</kbd>}</div>
          {view !== 'saved' && <button className="icon-button share-button" aria-label="复制当前榜单链接" title="复制榜单链接" onClick={share}><IconLink size={21} /></button>}
          <button className="button login-button" aria-label={demoSignedIn ? '演示账户' : 'GitHub 登录'} onClick={() => openModal({ type: 'login' })}><IconBrandGithub size={23} /><span>{demoSignedIn ? '演示账户' : 'GitHub 登录'}</span></button>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {shareFallback && !modal && <ShareFallback url={shareFallback} />}
          <section className="hero" aria-labelledby="page-title"><motion.div className="hero-copy" key={view} initial={{ opacity: 0, y: reduced ? 0 : 6 }} animate={{ opacity: 1, y: 0 }}>
            <h1 id="page-title">{view === 'discover' ? <>发现下一个值得用的<span className="title-tail">开源项目</span></> : headings[view][0]}</h1><p className="hero-subtitle">{headings[view][1]}</p>
            <div className="scope"><strong>{view === 'saved' ? `已收藏 ${saved.length} 个项目` : <><b>6</b> 个演示项目 · 每日快照</>}</strong><button aria-label="了解数据范围" className="icon-button info-button" onClick={() => openModal({ type: 'method' })}><IconInfoCircle size={18} /></button></div>
            <p className="scope-note">{view === 'saved' ? favorites.available ? '收藏保存在本机浏览器，刷新后仍可继续。' : '本机存储不可用，当前收藏仅保留在本次会话。' : '候选池观测，不代表 GitHub 全站排行。'}</p>
          </motion.div>
          <img className="hero-art" src="/assets/hero-star-640.webp" srcSet="/assets/hero-star-320.webp 320w, /assets/hero-star-640.webp 640w" sizes="(max-width: 600px) 96px, (max-width: 1180px) 200px, 310px" alt="" width="310" height="207" decoding="async" />
          <div className="date-block"><label className="select-wrap date-select"><IconCalendarWeek size={22} /><select aria-label="榜单快照日期" value={date} onChange={event => updateFilters({ date: event.target.value })}>{dates.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><IconChevronDown size={17} /></label><p>截至 {resource.data?.date || date} · UTC <span className="demo-badge">演示数据</span></p></div></section>
          <section className="filterbar" aria-label="榜单筛选"><div className="period-tabs" role="tablist" aria-label="增长时间范围">{periods.map((item, index) => <button key={item.id} role="tab" ref={element => { tabRefs.current[index] = element; }} id={`${tabId}-${item.id}`} aria-controls={`${tabId}-results`} aria-selected={period === item.id} tabIndex={period === item.id ? 0 : -1} onKeyDown={event => changeTab(event, index)} onClick={() => updateFilters({ period: item.id })} className={period === item.id ? 'selected' : ''}>{period === item.id && <motion.span layoutId="period-indicator" className="period-active-bg" />}<span>{item.label}</span></button>)}</div>
            <label className="select-wrap"><select aria-label="筛选编程语言" value={language} onChange={event => updateFilters({ language: event.target.value })}><option value="">全部语言</option>{languages.map(item => <option key={item}>{item}</option>)}</select><IconChevronDown size={16} /></label>
            <label className="select-wrap"><select aria-label="筛选应用场景" value={category} onChange={event => updateFilters({ category: event.target.value })}><option value="">全部应用场景</option>{categories.map(item => <option key={item}>{item}</option>)}</select><IconChevronDown size={16} /></label>
            <button className={`button more-filters ${minStars ? 'applied' : ''}`} onClick={() => openModal({ type: 'filters' })}><IconFilter size={18} />筛选{minStars > 0 && <span className="filter-dot">1</span>}</button>
          </section>
          {filtered && <div className="filter-summary" role="status">{resource.status === 'ready' ? `找到 ${visible.length} 个项目` : '正在读取结果'}{query.trim() && <span>“{query}”</span>}{language && <span>{language}</span>}{category && <span>{category}</span>}{minStars > 0 && <span>Star ≥ {compact(minStars)}</span>}<button onClick={clearFilters}>重置筛选<IconX size={15} /></button></div>}
          {resource.data?.stale && <div className="data-notice" role="status"><IconInfoCircle size={20} /><span>{date} 的快照暂未就绪。当前展示截至 {resource.data.date} 的旧快照，所有指标均来自该日期。</span><button onClick={retry}>重新读取</button></div>}
          {resource.data?.partial && <div className="data-notice" role="status"><IconInfoCircle size={20} /><span>边界状态演示：包含缺失、零增长、负增长与归档示例，不代表这些项目的真实状态。</span><button onClick={retry}>恢复正常</button></div>}
          <section className="ranking" role="tabpanel" id={`${tabId}-results`} aria-labelledby={`${tabId}-${period}`} tabIndex={0} aria-busy={resource.status === 'loading'}>
            {resource.status === 'loading' ? <LoadingState /> : resource.status === 'error' ? <div className="empty-state" role="alert"><IconDatabase size={34} /><h2>暂时无法读取演示快照</h2><p>筛选、收藏与对比选择已保留，可以重新尝试。</p><button className="button primary" onClick={retry}><IconRefresh size={18} />重试读取</button></div> : !snapshot.length ? <div className="empty-state"><IconDatabase size={34} /><h2>这个日期还没有项目快照</h2><p>可以重新读取最近的演示数据。</p><button className="button primary" onClick={retry}>查看最近快照<IconArrowRight size={18} /></button></div> : <>
              <div className="ranking-head ranking-grid"><span>#</span><span>项目</span><span className="trend-col">7日趋势</span><span className="total-col">{period === 'history' ? '7日净增' : '总 Star'}</span><button className="sort-button" onClick={() => updateFilters({ ascending: !ascending })} aria-label={`${activePeriod.metric}，当前${ascending ? '升序' : '降序'}，点击切换`}>{activePeriod.metric}{ascending ? <IconArrowUp size={16} /> : <IconArrowDown size={16} />}</button><span className="action-col">操作</span></div>
              <div className="ranking-body"><AnimatePresence mode="popLayout" initial={false}>{visible.slice(0, visibleCount).map((project, index) => <motion.article key={project.id} layout="position" initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.1 } }} className={`project-row ranking-grid ${index === 0 ? 'featured' : ''}`} aria-label={project.name}>
                <span className="rank-number">{index + 1}<span aria-hidden="true">—</span></span>
                <div className="project-cell"><button className="project-identity" onClick={() => openDetail(project)} aria-label={`查看 ${project.name} 项目详情`}><ProjectLogo project={project} /><span className="project-copy"><strong>{project.name}{project.archived && <span className="archived-badge">归档示例</span>}</strong><span className="repo-name">{project.owner} / {project.repo}</span><span className="description">{project.description}</span></span></button><div className="project-tags">{project.tags.map(tag => <button key={tag} onClick={() => updateFilters({ category: tag })} aria-label={`筛选${tag}项目`}>{tag}</button>)}</div></div>
                <div className="trend-col"><Sparkline project={project} /></div><strong className={`total-col numeric ${period === 'history' ? trendTone(project.week) : ''}`}>{period === 'history' ? signed(project.week) : compact(project.stars)}</strong><strong className={`growth numeric ${period === 'history' ? 'neutral' : trendTone(project[period])}`}>{period === 'history' ? compact(project.stars) : signed(project[period])}</strong>
                <div className="row-actions"><motion.button className={`icon-button bookmark ${saved.includes(project.id) ? 'is-saved' : ''}`} whileTap={reduced ? undefined : { scale: 0.9 }} aria-label={`${saved.includes(project.id) ? '取消收藏' : '收藏'} ${project.name}`} aria-pressed={saved.includes(project.id)} onClick={() => toggleSave(project)}>{saved.includes(project.id) ? <IconBookmarkFilled size={25} /> : <IconBookmark size={25} stroke={1.55} />}</motion.button><button className={`button view-project ${index === 0 ? 'primary' : ''}`} onClick={() => openDetail(project)}>查看详情<IconArrowRight size={17} /></button></div>
              </motion.article>)}</AnimatePresence>
                {!visible.length && <div className="empty-state"><IconSearch size={34} stroke={1.4} /><h2>{view === 'saved' && !saved.length ? '收藏夹还是空的' : '没有找到匹配的项目'}</h2><p>{view === 'saved' && !saved.length ? '点击项目旁的收藏按钮，留下感兴趣的工具。' : '试试其他关键词，或清除筛选条件。'}</p><button className="button primary" onClick={() => view === 'saved' && !saved.length ? navigate('discover') : clearFilters()}>{view === 'saved' && !saved.length ? '去发现项目' : '清除筛选'}<IconArrowRight size={18} /></button></div>}
              </div>
            </>}
          </section>
          {resource.status === 'ready' && <div className="results-footer"><span>已展示 {Math.min(visibleCount, visible.length)} / {visible.length} 个演示项目</span>{visible.length > visibleCount && <button className="button" onClick={() => setVisibleCount(count => count + 20)}>加载更多</button>}<button onClick={() => openModal({ type: 'method' })}><IconInfoCircle size={16} />数据与方法</button></div>}
        </main>
      </div>
    </div>
    <AnimatePresence>{compared.length > 0 && <motion.aside className={`compare-tray ${trayCollapsed ? 'collapsed' : 'expanded'}`} aria-label="待对比项目" initial={{ y: reduced ? 0 : 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: reduced ? 0 : 20, opacity: 0 }}>
      <button className="tray-toggle" aria-expanded={!trayCollapsed} aria-controls="tray-items" onClick={() => setTrayCollapsed(value => !value)}><IconLayersSubtract size={20} /><strong>已选 {compared.length} 项</strong><span>{trayCollapsed ? '展开' : '收起'}</span><IconChevronDown size={16} /></button>
      <div id="tray-items" className="tray-items" hidden={trayCollapsed}>{selectedProjects.map(project => <div key={project.id} className="tray-chip"><ProjectLogo project={project} small /><span>{project.name}</span><button className="icon-button" aria-label={`从对比中移除 ${project.name}`} onClick={() => toggleCompare(project)}><IconX size={18} /></button></div>)}{compared.length < 3 && <button className="add-compare" aria-label="添加项目" onClick={() => openPicker()}><IconPlus size={20} /><span>添加项目</span></button>}</div>
      <button className="button primary compare-cta" onClick={() => compared.length < 2 ? openPicker() : openCompare()}>{compared.length < 2 ? '继续选择' : '对比项目'}<IconArrowRight size={18} /></button>
    </motion.aside>}</AnimatePresence>
    {!modal && <Feedback message={toast} onDismiss={() => setToast(null)} />}
    {modal && <Modal title={panelTitle} screenKey={screenKey} onDismiss={dismiss} drawer={modal.type === 'detail'} wide={modal.type === 'compare'} message={toast} clearMessage={() => setToast(null)} onShare={['detail', 'compare'].includes(modal.type) ? share : undefined} focusTarget={modal.type === 'compare' && lastDetail.current ? `[data-detail-id="${lastDetail.current}"]` : null} shareFallback={shareFallback}>
      <PanelBoundary key={screenKey}><Suspense fallback={<LoadingState />}><ProjectPanels key={screenKey} {...panelProps} /></Suspense></PanelBoundary>
    </Modal>}
  </MotionConfig>;
}
