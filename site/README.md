# 开源星榜站点

这是全站公开事件新增榜与候选池净增榜共存的静态站点。Astro 在构建时读取机器生成的 JSON，生成榜单、全站历史星标 Top 1000、项目介绍、中文内容、分类和公开数据接口。榜单页支持深度池组合筛选、更新倒计时和紧凑模式；项目页展示作者、GitHub 创建日期、最近代码推送与公开天数。不登录时收藏、最近查看和对比只存于浏览器；可选 GitHub App 登录通过独立 Worker 把收藏同步为用户的 GitHub Star。

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

默认数据是“等待首个基线”的真实初始化状态。完整测试夹具由 `scripts/create-e2e-data.mjs` 在临时目录生成，包含 40 个连续候选日期、7 个事件日期、1,000 项事件筛选池、1,000 项历史星标榜、2,000 个候选项目页、中文内容、分类、语言榜和周期榜，不会进入生产数据。验证旧版本兼容页时仍可使用小型夹具：

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

Lighthouse CI 使用 desktop 预设并强制 Performance ≥ 90、Accessibility ≥ 95、SEO ≥ 95；390、768、1024 和 1440 像素布局、键盘交互与 axe 无障碍检查由 Playwright 独立覆盖。

## 生产数据

`tools/star_rank.py` 维护候选池快照与净增数据；`tools/event_star_rank.py` 扫描 GH Archive BigQuery 日表中的全部公开 `WatchEvent`，再按全局顺序补齐元数据直至获得严格 Top 500；`tools/alltime_star_rank.py` 按 Star 区间分段查询并发布恰好 1,000 个有效历史榜项目。中文与分类是可降级展示层。机器数据工作流共享同一并发组和 `star-rank-data` 分支，站点只读取该分支中的 `public/`。

GitHub Pages 使用 GitHub Actions 发布。手动工作流支持四种模式：

- `validate`：可在任意时间调用真实 API 并完成测试、数据校验和构建，但只写临时工作树，不提交、不部署。
- `collect_publish`：正常采集、提交数据分支并发布网站。
- `deploy_existing`：不调用 GitHub API，直接使用数据分支恢复部署。
- `replace_snapshot`：仅替换当天快照，必须同时填写当天北京时间日期，且只能在 00:00–03:00 有效窗口执行。

当前候选池榜单契约为 `1.4.0`，仓库目录为 `1.3.0`，事件日榜为 `1.3.0`，实时榜和历史 Top 1000 为 `1.1.0`；校验器继续兼容已发布的旧版文件。新版排名条目增加 `created_at` 与 `pushed_at`，用于展示 GitHub 创建日期和最近代码推送。没有有效译文或分类时构建仍继续成功。完整初始化、授权、恢复和故障处理流程见 [运行手册](../docs/STAR_RANK_RUNBOOK.md)。
