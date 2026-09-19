import { lazy, Suspense, useState } from 'react';
import { IconArrowLeft, IconArrowRight, IconArrowUpRight, IconBookmark, IconBookmarkFilled, IconBrandGithub, IconCheck, IconLayersSubtract, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import { compact, dates, repoUrl, signed, trendTone } from './data.js';
import { checkedOn, comparisonFields, insights, relatedProjects } from './insights.js';
import { LoadingState, ProjectLogo } from './ui.jsx';

const TrendChart = lazy(() => import('./TrendChart.jsx'));
const external = { target: '_blank', rel: 'noreferrer' };
const stateOptions = [{ id: 'ready', label: '正常快照' }, { id: 'error', label: '读取失败' }, { id: 'stale', label: '更新延迟' }, { id: 'partial', label: '缺失与负增长' }, { id: 'empty', label: '暂无数据' }];

export default function ProjectPanels(props) {
  const { route, resource, snapshot, saved, storageAvailable, toggleSave, toggleCompare, openDetail, openPicker, openCompare, returnPanel, dismiss, commit, updateFilters, retry, demoSignedIn, toggleAccount } = props;
  const { modal, compared, differences } = route;
  const [pickerQuery, setPickerQuery] = useState('');
  const selected = compared.map(id => snapshot.find(project => project.id === id)).filter(Boolean);
  const detail = snapshot.find(project => project.id === modal.id);
  if (['detail', 'compare', 'picker'].includes(modal.type)) {
    if (resource.status === 'loading') return <LoadingState />;
    if (resource.status === 'error' || !snapshot.length) return <div className="empty-state" role="alert"><h3>这个快照暂时不可用</h3><p>你的收藏和对比选择仍然保留。</p><button className="button primary" onClick={retry}>重新读取演示快照</button></div>;
  }
  if (modal.type === 'detail' && detail) {
    const chosen = compared.includes(detail.id);
    const atLimit = !chosen && compared.length >= 3;
    const info = insights[detail.id];
    return <>
      {modal.from === 'compare' && <button className="panel-back" onClick={() => returnPanel({ type: 'compare' })}><IconArrowLeft size={17} />返回项目对比</button>}
      <div className="detail-identity"><ProjectLogo project={detail} /><div><h3>{detail.name}</h3><a href={repoUrl(detail)} {...external}>{detail.owner} / {detail.repo}<IconArrowUpRight size={15} /></a></div></div>
      <p className="detail-description">{detail.description}</p><div className="detail-tags">{detail.tags.map(tag => <span key={tag}>{tag}</span>)}<span>{detail.language}</span>{detail.archived && <span className="archived-badge">归档示例</span>}</div>
      <p className="snapshot-caption">指标快照 {detail.asOf} · 演示数据{resource.data?.stale ? ' · 更新延迟' : ''}</p>
      <div className="detail-stats"><div><span>总 Star</span><strong>{compact(detail.stars)}</strong></div><div><span>昨日净增</span><strong className={trendTone(detail.day)}>{signed(detail.day)}</strong></div><div><span>7日净增</span><strong className={trendTone(detail.week)}>{signed(detail.week)}</strong></div></div>
      <div className="detail-switch" aria-label="详情内容"><button className={modal.tab !== 'activity' ? 'active' : ''} aria-pressed={modal.tab !== 'activity'} onClick={() => commit({ modal: { ...modal, tab: 'overview' } })}>项目概览</button><button className={modal.tab === 'activity' ? 'active' : ''} aria-pressed={modal.tab === 'activity'} onClick={() => commit({ modal: { ...modal, tab: 'activity' } })}>增长趋势</button></div>
      {modal.tab === 'activity' ? <div className="chart-panel"><div className="chart-title"><h4>近 7 日 Star 净增</h4><span className="demo-badge">演示数据</span></div><Suspense fallback={<LoadingState chart />}><TrendChart project={detail} /></Suspense><p className="chart-caption">缺失值不等于零；热度不代表项目质量。</p></div> : <div className="detail-overview">
        <h4>它能帮你做什么</h4><p>{detail.detail}</p><ul>{detail.features.map(text => <li key={text}><IconCheck size={17} />{text}</li>)}</ul>
        <div className="fit-note"><span>适合谁用</span><p>{detail.fit}</p></div>
        <dl className="metadata"><div><dt>部署方式</dt><dd>{info.deployment}</dd></div><div><dt>许可证名称</dt><dd>{detail.license}<a href={repoUrl(detail)} {...external}>核验许可条件<IconArrowUpRight size={13} /></a></dd></div><div><dt>最近活动</dt><dd>{detail.archived ? '已归档（示例）' : `${detail.activity}（演示）`}</dd></div></dl>
        <div className="resource-note"><h4>部署前需要了解</h4><p>{info.resources}</p><a href={info.docs} {...external}>官方项目说明<IconArrowUpRight size={15} /></a><a href={`${repoUrl(detail)}/releases`} {...external}>查看最新版本<IconArrowUpRight size={15} /></a></div>
        <p className="detail-caveat">定性概览查阅于 {checkedOn}。指标与活动为演示；实时版本尚未接入，部署和许可条件以仓库为准。</p>
      </div>}
      <div className="detail-bottom-wrap">
        <div className={`compare-limit ${atLimit ? 'at-limit' : ''}`} id="compare-limit-note"><span>{atLimit ? '已选满 3 项，替换一个后即可加入。' : `已选 ${compared.length} / 3 个对比项目`}</span><button onClick={() => openPicker(`detail:${detail.id}`)}>调整项目<IconArrowRight size={15} /></button></div>
        <div className="detail-bottom"><button className="button" aria-pressed={saved.includes(detail.id)} onClick={() => toggleSave(detail)}>{saved.includes(detail.id) ? <IconBookmarkFilled size={18} /> : <IconBookmark size={18} />}{saved.includes(detail.id) ? '取消收藏' : '收藏项目'}</button><button className="button" aria-describedby="compare-limit-note" disabled={atLimit} onClick={() => toggleCompare(detail)}>{chosen ? <IconCheck size={18} /> : <IconPlus size={18} />}{chosen ? '移出对比' : atLimit ? '对比已满' : '加入对比'}</button><a className="button primary" href={repoUrl(detail)} {...external}>访问 GitHub<IconArrowUpRight size={17} /></a></div>
      </div>
    </>;
  }
  if (modal.type === 'compare') {
    const fields = comparisonFields(selected, differences);
    const sharedTags = selected.length > 1 && selected[0].tags.some(tag => selected.every(project => project.tags.includes(tag)));
    return <>
      <p className="modal-intro">从能力、部署和使用条件，找到适合你的工具。<span className="demo-badge">指标为演示</span></p>
      {selected.length < 2 ? <div className="empty-state"><IconLayersSubtract size={36} /><h3>再选择 {2 - selected.length} 个项目，就能开始对比</h3><p>一次最多对比 3 个项目。</p><button className="button primary" onClick={() => openPicker('compare')}>选择项目<IconPlus size={18} /></button></div> : <>
        <div className="comparison-toolbar"><label className="difference-toggle"><input type="checkbox" checked={differences} onChange={event => commit({ differences: event.target.checked })} />只看差异</label><span>数据快照 {resource.data.date}</span><button className="button" onClick={() => openPicker('compare')}><IconPlus size={17} />调整项目</button></div>
        {!sharedTags && <p className="context-note">这些项目侧重不同场景，热度并不能直接衡量谁更适合你。</p>}
        <div className="comparison-grid" style={{ '--compare-count': selected.length }}>{selected.map(project => <article className="comparison-card" key={project.id} aria-label={`${project.name} 对比信息`}>
          <div className="comparison-card-top"><ProjectLogo project={project} /><button className="icon-button" aria-label={`移除对比 ${project.name}`} onClick={() => toggleCompare(project)}><IconX size={19} /></button></div>
          <h3>{project.name}</h3><p className="comparison-description">{project.description}</p><div className="comparison-tags">{project.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
          <div className="comparison-metrics"><span><small>总 Star</small><strong>{compact(project.stars)}</strong></span><span><small>7日净增 · 演示</small><strong className={trendTone(project.week)}>{signed(project.week)}</strong></span></div>
          <dl>{fields.map(field => <div className={`comparison-field field-${field.id}`} key={field.id}><dt>{field.label}</dt><dd>{field.value(project)}</dd></div>)}</dl>
          <div className="source-links"><a href={insights[project.id].docs} {...external}>官方文档<IconArrowUpRight size={14} /></a><a href={`${repoUrl(project)}/releases`} {...external}>最新版本<IconArrowUpRight size={14} /></a></div>
          <button className="button" data-detail-id={project.id} onClick={() => openDetail(project, 'compare')}>查看 {project.name} 详情<IconArrowRight size={16} /></button>
        </article>)}</div>
        <div className="comparison-footer"><p>概览查阅于 {checkedOn}。许可证名称不代表使用授权，请查看仓库条款；实时版本和资源实测暂未接入。</p></div>
      </>}
    </>;
  }
  if (modal.type === 'picker') {
    const choices = relatedProjects(snapshot, compared).filter(project => `${project.name} ${project.description}`.toLowerCase().includes(pickerQuery.trim().toLowerCase()));
    const selectedTags = new Set(selected.flatMap(project => project.tags));
    function done() {
      if (modal.back === 'compare') returnPanel({ type: 'compare' });
      else if (modal.back?.startsWith('detail:')) returnPanel({ type: 'detail', id: modal.back.slice(7), tab: 'overview' });
      else dismiss();
    }
    return <><p className="modal-intro">已选 {compared.length} / 3 个项目。相近场景优先显示；选满后可先取消一项。</p>
      <div className="picker-search global-search"><IconSearch size={20} /><input aria-label="搜索待对比项目" placeholder="搜索项目名称…" maxLength={200} value={pickerQuery} onChange={event => setPickerQuery(event.target.value)} /></div>
      <div className="picker-list">{choices.map(project => <label key={project.id} className={`picker-option ${compared.includes(project.id) ? 'checked' : ''}`}><ProjectLogo project={project} small /><span><strong>{project.name}</strong><small>{project.description}</small>{!compared.includes(project.id) && project.tags.some(tag => selectedTags.has(tag)) && <em>相近场景</em>}</span><input type="checkbox" aria-label={`选择对比 ${project.name}`} checked={compared.includes(project.id)} disabled={compared.length >= 3 && !compared.includes(project.id)} onChange={() => toggleCompare(project)} /></label>)}{!choices.length && <p className="picker-empty">没有匹配的项目，试试其他关键词。</p>}</div>
      <div className="modal-actions"><button className="button" onClick={done}>完成选择</button><button className="button primary" disabled={compared.length < 2} onClick={openCompare}>开始对比<IconArrowRight size={18} /></button></div>
    </>;
  }
  if (modal.type === 'filters') return <><p className="modal-intro">缩小范围，更快找到值得深入了解的项目。</p><fieldset className="filter-options"><legend>最低 Star 数</legend>{[{ value: 0, label: '不限', description: '探索所有候选项目' }, { value: 75000, label: '75,000 以上', description: '关注受到广泛关注的项目' }, { value: 100000, label: '100,000 以上', description: '查看累计关注较多的项目' }].map(option => <label key={option.value}><input type="radio" name="minimum-stars" value={option.value} checked={route.filters.minStars === option.value} onChange={() => updateFilters({ minStars: option.value })} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</fieldset><div className="modal-actions"><button className="button" onClick={() => updateFilters({ minStars: 0 })}>重置</button><button className="button primary" onClick={dismiss}>应用筛选<IconArrowRight size={18} /></button></div></>;
  if (modal.type === 'method') return <div className="method-content"><p className="modal-intro">一个轻量、透明的开源项目发现工具。</p>
    <div className="method-step"><span>01</span><div><h3>看清观测范围</h3><p>候选池不覆盖 GitHub 全站。这里展示 6 个示例项目，排名、日期和活动均为演示，不能直接用于实际选型。</p></div></div>
    <div className="method-step"><span>02</span><div><h3>区分总量、变化和缺失</h3><p>累计榜按快照总 Star 排序；日、周、月榜按对应净增排序。负数代表减少，“待补齐”表示缺失，不作为零参与排名。日快照按 UTC 日期展示。</p></div></div>
    <div className="method-step"><span>03</span><div><h3>留下收藏，分享发现</h3><p>收藏保存在当前浏览器，不上传到账户。链接可恢复筛选、详情和对比选择，但不会携带你的本机收藏；本地预览地址不能直接分享给另一台电脑。</p></div></div>
    <fieldset className="scenario-options"><legend>体验不同数据状态</legend><p>以下状态仅用于体验 Demo，均不连接真实数据服务。</p><div>{stateOptions.map(option => <label key={option.id}><input type="radio" name="data-state" checked={route.scenario === option.id} onChange={() => commit(previous => ({ ...previous, scenario: option.id, filters: { ...previous.filters, date: dates[0].value } }))} />{option.label}</label>)}</div></fieldset>
    <div className="modal-actions"><button className="button primary" onClick={dismiss}>查看当前状态<IconArrowRight size={18} /></button></div>
  </div>;
  if (modal.type === 'login') return <div className="login-content"><IconBrandGithub size={46} stroke={1.5} /><h3>{demoSignedIn ? '你正在使用演示账户' : '为下一次发现，留个位置'}</h3><p>当前 Demo 不连接 GitHub 登录。{storageAvailable ? '收藏已保存在本机，刷新后仍可继续查看。' : '浏览器存储不可用，收藏目前仅保留在本次会话。'}演示账户与本机收藏相互独立。</p><button className="button primary" onClick={toggleAccount}>{demoSignedIn ? '退出演示账户' : '体验演示账户'}<IconArrowRight size={18} /></button><button className="text-button" onClick={dismiss}>继续浏览项目</button></div>;
  return <div className="empty-state"><h3>未找到这个项目</h3><button className="button" onClick={dismiss}>返回榜单</button></div>;
}
