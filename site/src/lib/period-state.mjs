export function periodState(index, days) {
  const period = index.periods?.[`${days}d`];
  const progress = index.sampling?.period_progress?.[`${days}d`];
  if (!period?.latest_date) return { kind: 'accumulating', label: '积累中', message: `近 ${days} 日榜正在积累有效窗口，已完成 ${progress?.completed ?? 0} / ${progress?.required ?? days}。` };
  if (index.latest_date && period.latest_date < index.latest_date) return {
    kind: 'historical', label: '历史',
    message: `当前展示历史 ${days} 日榜，统计截至 ${period.latest_date}；最新日榜为 ${index.latest_date}。新连续窗口已完成 ${progress?.completed ?? 0} / ${progress?.required ?? days}，条件满足后才发布新版，不补造缺失数据。`,
  };
  return { kind: 'current', label: '', message: `统计截至 ${period.latest_date}` };
}
