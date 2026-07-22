# 开源星榜运行手册

本手册面向拥有仓库 Actions、Pages 和 Issue 管理权限的维护者。当前唯一每日主榜为“昨日净增榜”，根据北京时间零点附近的 GitHub API 连续快照计算。生产榜单完全由工作流生成，不接受手工改数。

## 1. 产品与数据边界

- 首页和 `/daily/` 均展示最新“昨日净增榜”。
- “今日实时榜”和“昨日完整事件榜”已经下线；相关 GH Archive 历史 JSON 仅为审计兼容保留，不再采集、部署页面或出现在导航中。
- 7 日榜、30 日榜和语言榜均由连续有效零点快照派生。
- 全部历史星标榜使用 GitHub Search 累计 Star 排序，每周更新 Top 1000。
- 机器数据只进入 `star-rank-data` 分支的 `state/`、`snapshots/` 和 `public/`；不得合并进 `main`。

## 2. 首次初始化

1. 确认默认分支上的 `Validate Open Source Star Rank` 已通过。
2. 在 `Update and publish Open Source Star Rank` 中选择 `validate`。该模式调用真实 GitHub API，但不会写入数据分支或部署。
3. 验证成功后选择 `collect_publish`。工作流会创建或更新 `star-rank-data`、保存首个有效基线并部署 GitHub Pages。
4. 检查首页、`/daily/`、`/status/`、`/methodology/`、`/data/index.json`、`/data/repositories.json`、`/data/schema/`、三种 Feed 和分享图。
5. 首个有效快照只显示基线进度；第二个连续有效快照完成后才发布真实日榜。

## 3. 有效快照与每日运行

- 主任务在北京时间 00:20 调度，目标是在 01:00 前完成。
- 新建或替换的生产快照必须位于北京时间 `[00:00, 03:00)`。
- 相邻快照日期必须连续，实际间隔必须为 21–27 小时。
- 同一自然日普通重跑复用已有有效快照，不改变统计窗口。
- 缺失或无效日期不补采、不补零、不插值；周期榜等待重新形成足够的连续窗口。
- 01:15 watchdog 检查数据分支与公开网站；数据超过 36 小时、今日快照缺失、采集失败或部署失败时，创建或更新 `[开源星榜] 每日任务故障`。
- 采集、Schema、测试或站点构建任一失败时，不提交半成品，也不替换线上上一版。
- 每月检查数据分支体积；压缩后超过 500 MiB 时创建维护 Issue。

## 4. 手动工作流模式

### `validate`

只验证真实 GitHub API、限额、Schema 与完整构建。所有文件写入临时目录，不提交、不部署。

### `collect_publish`

执行候选发现、元数据刷新、快照校验、排行生成、Schema 校验、Astro 构建、原子数据提交和 Pages 部署。同日已有有效快照时复用原统计窗口。

### `deploy_existing`

不访问 GitHub API，不改变数据分支，只从指定数据提交重建网站。用于 Pages 故障恢复。成功重部署不代表数据已恢复新鲜，因此不会自动关闭采样告警。

### `replace_snapshot`

只在当天快照确实错误时使用，并显式提供北京时间日期。操作必须在 00:00–03:00 执行；采集器会在任何 API 请求前拒绝窗口外或历史日期替换。

## 5. 中文内容与项目分类

- 中文内容和分类通过独立补全工作流异步生成，榜单采集不依赖模型成功。
- 默认模型为 `openai/gpt-4.1-mini`，使用 Actions 的 `GITHUB_TOKEN` 与 `models: read`，不保存模型密钥，不启用付费额度。
- 可选变量：`LOCALIZATION_MODEL`、`LOCALIZATION_MAX_PROJECTS`、`CLASSIFICATION_MODEL`、`CLASSIFICATION_MAX_PROJECTS`。
- 补全顺序固定为先翻译、后分类；模型失败时保留旧缓存并回退 GitHub 原文。
- 人工中文修正在 `data/localization-overrides.zh-CN.json`；人工分类修正在 `data/classification-overrides.zh-CN.json`。
- 不得直接修改数据分支中的生成缓存。

## 6. 全部历史星标 Top 1000

- `Update all-time most-starred ranking` 每周一北京时间 10:00 执行。
- 榜单必须发布恰好 1000 个有效公开仓库；Fork、归档、禁用、不可用仓库被过滤后继续向后补位。
- GitHub Search 的单次 1000 结果上限不等于有效项目上限，采集器应使用多个不重叠的 Star 分片组成候选，再统一去重和排序。
- 失败时保留上一版并显示原更新时间，不影响每日净增榜。

## 7. GitHub 登录与 Star 同步

登录与收藏同步由 GitHub App、Cloudflare Worker 和 D1 提供；未配置或服务故障时，静态榜单、项目页、本地收藏和对比仍必须完整可用。

### GitHub App

- Homepage URL：正式 Pages 地址。
- Callback URL：`https://<worker-domain>/auth/github/callback`。
- Webhook：关闭。
- Repository permissions：Metadata 只读、Starring 读写；不申请代码、Issue、组织或管理权限。

### Worker 与 D1

1. 在 `auth-worker/` 执行 `npx wrangler d1 create open-source-star-rank-auth`。
2. 把返回的数据库 ID 写入 `wrangler.toml` 的 D1 binding。
3. 执行 `npx wrangler d1 migrations apply open-source-star-rank-auth --remote`。
4. 配置 `GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CLIENT_SECRET`、`TOKEN_ENCRYPTION_KEY`、`SITE_ORIGIN`。
5. 部署 Worker，并把其 HTTPS Origin 写入仓库变量 `PUBLIC_AUTH_API_URL`。
6. 重新部署 Pages，验证登录、退出、收藏、取消收藏和“同步到 GitHub”二次确认。

GitHub access token 必须使用 AES-GCM 加密后存入 D1；D1 只保存站点会话令牌的 SHA-256 摘要。浏览器仅在当前标签页的 `sessionStorage` 保存不透明会话，最长 8 小时。首次登录不得自动同步历史本地收藏。

## 8. 数据分支恢复

当最新数据提交损坏但历史提交可靠时：

1. 找到最后一个可靠的 `star-rank-data` 提交。
2. 恢复该提交的 `state/`、`snapshots/` 和 `public/` 到数据分支工作树。
3. 创建普通恢复提交并推送，不改写已有历史。
4. 执行 `deploy_existing`，确认公开索引与恢复提交一致。
5. 下一次采集前检查最后快照日期；不连续时跳过该日榜，禁止补零。

若数据分支完全丢失且无备份，重新执行 `collect_publish` 建立新基线，等待第二个真实快照；不得从页面展示值反推快照。

## 9. 数据分支压缩

只有维护 Issue 触发且已建立远端备份标签后才可压缩：

1. 保存当前数据分支提交为不可变备份标签。
2. 创建孤立分支，只复制当前 `state/`、全部 `public/` 和最近 90 个北京时间自然日的 `snapshots/`。
3. 运行 Schema、站点构建和可复现测试。
4. 使用带租约保护的分支替换更新 `star-rank-data`，保留备份标签至少 30 天。
5. 执行 `deploy_existing` 并关闭维护 Issue。

## 10. 发布验收

- Python 数据测试、Node 测试、Astro 检查、静态构建、Playwright/axe、可复现构建全部通过。
- 首页和 `/daily/` 只出现“昨日净增榜”，旧事件榜 URL 返回 404。
- 页面、公开 JSON、数据分支中的日期、统计窗口、条目数和排名一致。
- 禁用 JavaScript 时仍可读取每页完整榜单、项目链接和统计窗口。
- 390、768、1024、1440 像素无横向溢出。
- 至少完成一次采集失败、部署失败和 `deploy_existing` 恢复演练。
