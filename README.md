# 开源星榜

[![数据采集与发布](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-pages.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-pages.yml)
[![全站公开事件榜](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-events.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-events.yml)
[![中文内容与分类](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-localization.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-localization.yml)
[![质量校验](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-ci.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-ci.yml)

开源星榜同时发布两种独立信号：扫描 GH Archive 实际归档的全部 GitHub 公开事件生成的每日新增榜，以及用北京时间连续快照生成的候选池净增榜。前者的“全站”严格指 GH Archive 捕获到的 GitHub 公开事件全站，不是 GitHub 官方内部统计；后者是候选池观测榜。

- 正式站点：https://728792899-create.github.io/open-source-star-rank/
- 采样状态：https://728792899-create.github.io/open-source-star-rank/status/
- 公开数据：https://728792899-create.github.io/open-source-star-rank/data/index.json
- 全站公开事件数据：https://728792899-create.github.io/open-source-star-rank/data/events/index.json
- 中文项目内容：https://728792899-create.github.io/open-source-star-rank/data/i18n/zh-CN/repositories.json
- 项目分类：https://728792899-create.github.io/open-source-star-rank/category/
- 分类数据：https://728792899-create.github.io/open-source-star-rank/data/classification/index.json
- 数据契约：https://728792899-create.github.io/open-source-star-rank/data/schema/index.schema.json
- 订阅：[RSS](https://728792899-create.github.io/open-source-star-rank/rss.xml) · [Atom](https://728792899-create.github.io/open-source-star-rank/atom.xml) · [JSON Feed](https://728792899-create.github.io/open-source-star-rank/feed.json)

## 数据边界

- 全站公开事件新增定义为北京时间自然日内唯一 `(repository_id, actor_id)` 数量；同一用户对同一仓库每天最多计一次。
- GH Archive 是第三方公共事件归档；事件榜扫描其实际归档的全部公开事件，但不包含私有活动、无法证明 GitHub 官方内部事件无遗漏，也不扣除取消 Star，因此不是全站净增榜。
- 每次发布必须证明统计窗口 24/24 小时均有源事件，并在全局排序后获得完整 100 个有效公开仓库；任一小时缺失或检查 900 个仓库后仍不足 100 个即整次失败。
- 候选池最多 2,000 个公开仓库。
- 有效快照必须在北京时间 00:00–03:00 采集，相邻日期连续且间隔为 21–27 小时。
- 缺失日期不补采、不补零、不插值。
- 机器数据保存在独立的 `star-rank-data` 分支；公开日榜永久保留，完整候选快照保留最近 90 日。
- 事件查询先 dry-run，单次最多扫描 24 GiB；全量仓库精简聚合仅在数据分支保留最近 30 天，公开接口只发布 Top 100 与汇总指标。生产要求使用未绑定结算账号的 BigQuery Sandbox 项目。
- 项目中文功能名与简介由 GitHub Models 生成并按 repository ID 缓存；页面始终保留原始仓库名，模型不可用时回退 GitHub 原文，不阻塞榜单。
- GitHub Models 只使用 Actions 自带令牌和免费额度，不启用付费额度；人工修订位于 `data/localization-overrides.zh-CN.json`。
- 项目方向、产品形态和 1–4 个适用场景从版本化固定词表中选择；分类页只是当前默认榜 Top 100 的子集，保留全局排名，不是独立分类榜。
- 分类人工修正位于 `data/classification-overrides.zh-CN.json`；词表位于 `data/classification-taxonomy.zh-CN.json`，调整标签含义必须升级 `taxonomy_version`。
- 本仓库不包含、依赖或链接任何私有知识库内容；固定种子仅保存公开 GitHub 仓库名。

## 本地开发

```bash
python3 -m pip install -r requirements-star-rank.txt
python3 -m unittest discover -s tests -v
cd site
npm ci
npm test
npm run check
npm run build
npm run validate-build
```

完整采集、恢复和故障处理流程见 [运行手册](docs/STAR_RANK_RUNBOOK.md)，站点实现说明见 [site/README.md](site/README.md)。
