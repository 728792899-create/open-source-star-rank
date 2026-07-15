# 开源星榜

[![数据采集与发布](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-pages.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-pages.yml)
[![质量校验](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-ci.yml/badge.svg)](https://github.com/728792899-create/open-source-star-rank/actions/workflows/star-rank-ci.yml)

开源星榜是独立的 GitHub 开源项目 Star 增长候选池观测榜。它使用北京时间零点附近的连续快照生成每日、7 日、30 日和独立语言排行，不宣称覆盖 GitHub 全站。

- 正式站点：https://728792899-create.github.io/open-source-star-rank/
- 采样状态：https://728792899-create.github.io/open-source-star-rank/status/
- 公开数据：https://728792899-create.github.io/open-source-star-rank/data/index.json
- 数据契约：https://728792899-create.github.io/open-source-star-rank/data/schema/index.schema.json
- 订阅：[RSS](https://728792899-create.github.io/open-source-star-rank/rss.xml) · [Atom](https://728792899-create.github.io/open-source-star-rank/atom.xml) · [JSON Feed](https://728792899-create.github.io/open-source-star-rank/feed.json)

## 数据边界

- 候选池最多 2,000 个公开仓库。
- 有效快照必须在北京时间 00:00–03:00 采集，相邻日期连续且间隔为 21–27 小时。
- 缺失日期不补采、不补零、不插值。
- 机器数据保存在独立的 `star-rank-data` 分支；公开日榜永久保留，完整候选快照保留最近 90 日。
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
