# 开源星榜

[![数据采集与发布](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-pages.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-pages.yml)
[![公共事件榜](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-events.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-events.yml)
[![质量校验](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-ci.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-ci.yml)

开源星榜同时发布两种独立信号：基于 GH Archive 公开 `WatchEvent` 的每日新增榜，以及用北京时间连续快照生成的候选池净增榜。两者都是观测信号，不宣称是 GitHub 官方全站完整榜。

- 正式站点：https://728792899-create.github.io/open-source-star-rank/
- 采样状态：https://728792899-create.github.io/open-source-star-rank/status/
- 公开数据：https://728792899-create.github.io/open-source-star-rank/data/index.json
- 公共事件数据：https://728792899-create.github.io/open-source-star-rank/data/events/index.json
- 数据契约：https://728792899-create.github.io/open-source-star-rank/data/schema/index.schema.json
- 订阅：[RSS](https://728792899-create.github.io/open-source-star-rank/rss.xml) · [Atom](https://728792899-create.github.io/open-source-star-rank/atom.xml) · [JSON Feed](https://728792899-create.github.io/open-source-star-rank/feed.json)

## 数据边界

- 事件新增定义为北京时间自然日内对同一仓库产生 `WatchEvent` 的唯一用户数；它不扣除取消 Star。
- GH Archive 是第三方公共事件归档；事件榜只覆盖其实际捕获的公开事件。
- 候选池最多 2,000 个公开仓库。
- 有效快照必须在北京时间 00:00–03:00 采集，相邻日期连续且间隔为 21–27 小时。
- 缺失日期不补采、不补零、不插值。
- 机器数据保存在独立的 `star-rank-data` 分支；公开日榜永久保留，完整候选快照保留最近 90 日。
- 事件查询先 dry-run，单次最多扫描 24 GiB；生产要求使用未绑定结算账号的 BigQuery Sandbox 项目。
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
