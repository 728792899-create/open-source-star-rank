// Qualitative summaries checked against the linked official repository READMEs.
// No benchmark, legal permission, or unverified latest-version claim is implied.
export const checkedOn = '2026-09-19';
export const insights = {
  dify: { deployment: '云服务 / 自托管', capabilities: 'AI 工作流、知识库检索、应用发布', resources: '官方自托管入门：至少 2 核 CPU、4 GiB 内存；模型资源另计。', docs: 'https://github.com/langgenius/dify#readme' },
  n8n: { deployment: '云服务 / 自托管', capabilities: '服务集成、可视化自动化、代码节点', resources: '随工作流、并发和执行数据变化；本页不提供固定配置建议。', docs: 'https://github.com/n8n-io/n8n#readme' },
  ollama: { deployment: '本地运行 / 自托管', capabilities: '模型下载、运行管理、推理 API', resources: '需结合模型大小、量化和推理设备评估；暂无统一配置。', docs: 'https://github.com/ollama/ollama#readme' },
  openwebui: { deployment: '自托管', capabilities: '多模型聊天、知识库、模型服务连接', resources: '界面服务与模型推理分别评估；本页尚无实测资源数据。', docs: 'https://github.com/open-webui/open-webui#readme' },
  supabase: { deployment: '云服务 / 自托管', capabilities: 'PostgreSQL、认证、存储、实时能力', resources: '随数据库规模、连接数和存储需求变化；尚无本页基准测试。', docs: 'https://github.com/supabase/supabase#readme' },
  astro: { deployment: '网站构建 / 托管部署', capabilities: '内容网站、按需交互、多框架集成', resources: '依赖构建方式与托管环境；静态站和服务端渲染需分别评估。', docs: 'https://github.com/withastro/astro#readme' },
};
export function comparableFields() {
  return [
    { id: 'capabilities', label: '核心能力', value: p => insights[p.id].capabilities },
    { id: 'deployment', label: '部署方式', value: p => insights[p.id].deployment },
    { id: 'language', label: '主要语言', value: p => p.language },
    { id: 'license', label: '许可证名称 · 核验条款', value: p => p.license },
    { id: 'resources', label: '资源与部署条件', value: p => insights[p.id].resources },
    { id: 'activity', label: '最近活动 · 演示', value: p => p.archived ? '已归档（边界示例）' : p.activity },
    { id: 'fit', label: '适合谁用', value: p => p.fit },
  ];
}
export function comparisonFields(items, onlyDifferences) {
  return comparableFields().filter(field => !onlyDifferences || new Set(items.map(field.value)).size > 1);
}
export function relatedProjects(items, selected) {
  const tags = new Set(items.filter(p => selected.includes(p.id)).flatMap(p => p.tags));
  return [...items].sort((a, b) => b.tags.filter(t => tags.has(t)).length - a.tags.filter(t => tags.has(t)).length);
}
