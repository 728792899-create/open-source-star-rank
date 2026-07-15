# 开源星榜站点

这是公共事件新增榜与候选池净增榜共存的静态站点。Astro 在构建时读取机器生成的 JSON，把事件日榜、净增日榜、7/30 日榜、独立语言榜、项目历史、中文项目内容和公开数据接口一起静态发布。

## 本地验证

```bash
python3 -m pip install -r ../requirements-star-rank.txt
cd site
npm ci
npm test
npm run check
npm run build
npm run validate-build
```

默认数据是“等待首个基线”的真实初始化状态。完整测试夹具由 `scripts/create-e2e-data.mjs` 在临时目录生成，包含 40 个连续候选日期、7 个事件日期、2,000 个项目页、语言榜和周期榜，不会进入生产数据。验证旧 `1.1.0` 兼容页时仍可使用小型夹具：

```bash
STAR_RANK_DATA_DIR="$PWD/tests/fixtures/ready-data" npm run build
npm run validate-build
```

完整的浏览器、无障碍、可复现和 Lighthouse 验证：

```bash
npx playwright install chromium
npm run test:e2e
npm run test:reproducible
npm run lighthouse
```

Lighthouse CI 使用 desktop 预设并强制 Performance ≥ 90、Accessibility ≥ 95、SEO ≥ 95；390、768 和 1440 像素布局、键盘交互与 axe 无障碍检查由 Playwright 独立覆盖。

## 生产数据

`tools/star_rank.py` 维护候选池快照与净增数据；`tools/event_star_rank.py` 查询 GH Archive BigQuery 日表，按 repository ID 汇总并从 GitHub 补齐前 500 名元数据；`tools/localize_repositories.py` 使用 GitHub Models 为所有已上榜项目生成按 repository ID 缓存的中文功能名和简介。三个生产工作流共享同一并发组和 `star-rank-data` 分支，站点只读取该分支中的 `public/`。

GitHub Pages 使用 GitHub Actions 发布。手动工作流支持四种模式：

- `validate`：可在任意时间调用真实 API 并完成测试、数据校验和构建，但只写临时工作树，不提交、不部署。
- `collect_publish`：正常采集、提交数据分支并发布网站。
- `deploy_existing`：不调用 GitHub API，直接使用数据分支恢复部署。
- `replace_snapshot`：仅替换当天快照，必须同时填写当天北京时间日期，且只能在 00:00–03:00 有效窗口执行。

候选池接口保持 `1.2.0` 契约不变，同时兼容历史 `1.1.0`。事件榜和中文目录分别使用独立 `1.0.0` 契约；中文目录入口为 `/data/i18n/zh-CN/repositories.json`。没有目录或单个项目缺少译文时构建继续成功并显示 GitHub 原文。完整初始化、恢复和故障处理流程见 [运行手册](../docs/STAR_RANK_RUNBOOK.md)。
