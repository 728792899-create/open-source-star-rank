// Fixed demonstration snapshots, never live GitHub data.
export const projects = [
  { id: 'dify', name: 'Dify', owner: 'langgenius', repo: 'dify', description: '搭建 AI 应用与智能体工作流', tags: ['AI', '工作流'], language: 'TypeScript', stars: 124800, day: 1248, week: 6805, month: 21640, license: 'Dify Open Source License', activity: '3 小时前', series: [17, 22, 25, 36, 35, 42, 48, 41, 53, 55, 70, 74], detail: '把模型、知识库与工具串联起来。从一个对话应用开始，逐步构建可观察、可迭代的智能体工作流。', features: ['可视化编排 AI 工作流', '接入多种大语言模型', '知识库检索与应用发布'], fit: '希望快速验证 AI 产品的开发者与产品团队' },
  { id: 'n8n', name: 'n8n', owner: 'n8n-io', repo: 'n8n', description: '连接工具，自动完成重复工作', tags: ['自动化', '工作流'], language: 'TypeScript', stars: 104200, day: 932, week: 7274, month: 24510, license: 'Sustainable Use License', activity: '1 小时前', series: [14, 18, 31, 25, 43, 40, 51, 47, 55, 61, 64, 73], detail: '用可视化节点把常用服务连接起来，让数据同步、消息通知和日常业务流程自动运行。支持自托管。', features: ['可视化节点与代码节点', '服务集成与自动化任务', '自托管与工作流调试'], fit: '需要连接业务工具、自动化重复任务的团队' },
  { id: 'ollama', name: 'Ollama', owner: 'ollama', repo: 'ollama', description: '在本地运行和管理大语言模型', tags: ['AI', '本地部署'], language: 'Go', stars: 96500, day: 681, week: 4360, month: 15180, license: 'MIT', activity: '5 小时前', series: [12, 24, 23, 34, 31, 43, 38, 46, 56, 55, 69, 73], detail: '在自己的设备上下载、运行和管理语言模型。通过简洁的命令行和 API，把本地模型接入你正在构建的应用。', features: ['本地模型运行与管理', '统一的模型调用接口', '支持多种开源模型'], fit: '关注本地实验、隐私与模型部署的开发者' },
  { id: 'openwebui', name: 'Open WebUI', owner: 'open-webui', repo: 'open-webui', description: '为本地模型提供易用的聊天界面', tags: ['AI', '用户界面'], language: 'Python', stars: 73100, day: 540, week: 3650, month: 13020, license: 'Open WebUI License', activity: '2 小时前', series: [12, 16, 13, 27, 32, 30, 45, 38, 47, 56, 51, 69], detail: '为模型提供友好的交互入口，支持会话、知识库和多种模型连接方式，便于构建自己的 AI 工作空间。', features: ['多模型对话界面', '知识库与文件问答', '适合自托管的工作空间'], fit: '希望为团队提供统一模型交互入口的组织' },
  { id: 'supabase', name: 'Supabase', owner: 'supabase', repo: 'supabase', description: '构建应用所需的开源后端', tags: ['数据库', '后端服务'], language: 'TypeScript', stars: 71400, day: 420, week: 3990, month: 17650, license: 'Apache-2.0', activity: '2 小时前', series: [15, 25, 24, 38, 36, 47, 42, 55, 52, 61, 68, 73], detail: '围绕 PostgreSQL 构建应用后端，将数据库、身份认证、存储和实时能力放在一个开发工作流中。', features: ['PostgreSQL 数据库', '认证、存储与实时能力', '面向应用开发的管理界面'], fit: '需要快速构建应用后端的开发团队' },
  { id: 'astro', name: 'Astro', owner: 'withastro', repo: 'astro', description: '构建快速、以内容为中心的网站', tags: ['前端', '开发工具'], language: 'TypeScript', stars: 54600, day: 316, week: 2170, month: 9240, license: 'MIT', activity: '4 小时前', series: [13, 18, 20, 32, 34, 39, 48, 43, 52, 49, 60, 66], detail: '面向内容网站的 Web 框架。通过按需加载的交互组件，让博客、文档和营销网站保持轻快。', features: ['内容优先的开发方式', '按需加载的交互组件', '灵活的 UI 框架集成'], fit: '构建文档、博客与内容网站的开发者' },
];
export const periods = [{ id: 'day', label: '昨日', metric: '昨日净增' }, { id: 'week', label: '7日', metric: '7日净增' }, { id: 'month', label: '30日', metric: '30日净增' }, { id: 'history', label: '累计榜', metric: '总 Star' }];
export const dates = [{ value: '2026-09-19', label: '2026-09-19（周六）', day: '09-18', offset: 0 }, { value: '2026-09-18', label: '2026-09-18（周五）', day: '09-17', offset: 1 }, { value: '2026-09-17', label: '2026-09-17（周四）', day: '09-16', offset: 2 }];
export const compact = n => Number.isFinite(n) ? Math.abs(n) < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k` : '待补齐';
export const formatNumber = n => Number.isFinite(n) ? n.toLocaleString('en-US') : '待补齐';
export const signed = n => Number.isFinite(n) ? n > 0 ? `+${formatNumber(n)}` : n < 0 ? `−${formatNumber(Math.abs(n))}` : '0' : '待补齐';
export const trendTone = n => !Number.isFinite(n) || n === 0 ? 'neutral' : n < 0 ? 'negative' : 'positive';
export const repoUrl = project => `https://github.com/${project.owner}/${project.repo}`;
function splitTotal(total, weights) {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const values = weights.map(weight => Math.round(total * weight / weightTotal));
  values[0] += total - values.reduce((sum, value) => sum + value, 0);
  return values;
}
function dailyHistory(project) {
  const recent = [...splitTotal(project.week - project.day, project.series.slice(-7, -1)), project.day];
  const earlier = splitTotal(project.month - project.week, Array.from({ length: 23 }, (_, i) => .55 + i / 23));
  return [Math.round(earlier[0] * .9), Math.round(earlier[0] * .95), ...earlier, ...recent];
}
export function snapshotFor(date) {
  const offset = dates.find(d => d.value === date)?.offset ?? 0;
  return projects.map(p => {
    const history = dailyHistory(p);
    const cut = history.length - offset;
    const throughDate = history.slice(0, cut);
    const sum = values => values.reduce((total, value) => total + value, 0);
    return { ...p, asOf: date, dailyTrend: throughDate.slice(-7), stars: p.stars - sum(history.slice(cut)), day: throughDate.at(-1), week: sum(throughDate.slice(-7)), month: sum(throughDate.slice(-30)) };
  });
}

export function weeklySeries(project) {
  return project.dailyTrend.map((value, index) => {
    const date = new Date(`${project.asOf}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 7 + index);
    return { day: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`, value };
  });
}
export function selectProjects(items, { query, language, category, period, ascending, minStars, savedOnly, saved }) {
  const term = query.trim().toLocaleLowerCase();
  const metric = period === 'history' ? 'stars' : period;
  return items.filter(p => (!term || [p.name, p.owner, p.repo, p.description, p.language, ...p.tags].join(' ').toLocaleLowerCase().includes(term)) && (!language || p.language === language) && (!category || p.tags.includes(category)) && p.stars >= minStars && (!savedOnly || saved.includes(p.id)))
    .sort((a, b) => {
      if (!Number.isFinite(a[metric])) return Number.isFinite(b[metric]) ? 1 : 0;
      if (!Number.isFinite(b[metric])) return -1;
      return (ascending ? 1 : -1) * (a[metric] - b[metric]) || a.name.localeCompare(b.name);
    });
}
