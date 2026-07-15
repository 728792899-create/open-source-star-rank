# 开源星榜站点

这是独立的 GitHub Star 候选池观测榜。Astro 在构建时读取机器生成的 JSON，把日榜、7/30 日榜、独立语言榜、项目历史和公开数据接口一起静态发布。

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

默认数据是“等待首个基线”的真实初始化状态。完整测试夹具由 `scripts/create-e2e-data.mjs` 在临时目录生成，包含 40 个连续日期、2,000 个项目页、语言榜和周期榜，不会进入生产数据。验证旧 `1.1.0` 兼容页时仍可使用小型夹具：

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

`tools/star_rank.py` 将候选池状态、最近 90 日完整快照、永久日榜、语言/周期榜、项目历史、采集覆盖指标和 JSON Schema 写入工作流挂载的数据目录。生产工作流使用独立的 `star-rank-data` 分支保存这些文件，站点只读取该分支中的 `public/`。

GitHub Pages 使用 GitHub Actions 发布。手动工作流支持四种模式：

- `validate`：可在任意时间调用真实 API 并完成测试、数据校验和构建，但只写临时工作树，不提交、不部署。
- `collect_publish`：正常采集、提交数据分支并发布网站。
- `deploy_existing`：不调用 GitHub API，直接使用数据分支恢复部署。
- `replace_snapshot`：仅替换当天快照，必须同时填写当天北京时间日期，且只能在 00:00–03:00 有效窗口执行。

公开接口使用 `1.2.0` 数据契约，同时兼容历史 `1.1.0` 日榜和快照。入口为 `/data/index.json`，项目目录为 `/data/repositories.json`，Schema 位于 `/data/schema/`。完整初始化、恢复和故障处理流程见 [运行手册](../docs/STAR_RANK_RUNBOOK.md)。
