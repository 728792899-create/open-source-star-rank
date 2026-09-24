# 开源星榜运行手册

本手册面向拥有仓库 Actions、Pages 和 Issue 管理权限的维护者。当前唯一每日主榜为“昨日净增榜”，根据北京时间零点附近的 GitHub API 连续快照计算。生产榜单完全由工作流生成，不接受手工改数。

## 1. 产品与数据边界

- 首页和 `/daily/` 均展示最新“昨日净增榜”。
- “今日实时榜”和“昨日完整事件榜”已经下线；相关 GH Archive 历史 JSON 为审计兼容保留，不再定时采集。旧 `/category/`、`/board/` 路由仅展示带日期的历史归档，不进入 sitemap、不提供更新倒计时；当前分类筛选使用净增榜。
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

- 主目标为北京时间 00:20，并在 00:07、00:47 增加两次触发机会；同日复用首次有效快照，目标是在 01:00 前完成。GitHub 定时调度可能延迟，这些重试降低漏采风险，不构成准点保证。
- 新建或替换的生产快照必须位于北京时间 `[00:00, 03:00)`。
- 相邻快照日期必须连续，实际间隔必须为 21–27 小时。
- 同一自然日普通重跑复用已有有效快照，不改变统计窗口；生产模式也会检查被复用的快照和待恢复 journal，无效历史材料会保留并报错。
- 缺失或无效日期不补采、不补零、不插值；周期榜等待重新形成足够的连续窗口。
- 01:15 与 03:15 watchdog 检查数据分支与公开网站；数据超过 36 小时、今日有效快照缺失、昨日榜未发布、采集失败或部署失败时，创建或更新 `[开源星榜] 每日任务故障`。
- 采集或 Schema 失败时不发布无效数据；已校验原始采样独立提交至 captures/，即使派生失败也保留。完整数据校验与提交在前端构建之前完成；站点构建失败不替换线上上一版。主任务只离线协调已有中文/分类缓存，新增内容暂用原文；在线模型补全由独立工作流完成，模型限流不阻塞每日快照。
- 每月检查数据分支体积；压缩后超过 500 MiB 时创建维护 Issue。

## 4. 手动工作流模式

### `validate`

只验证真实 GitHub API、限额、Schema 与完整构建。所有文件写入临时目录，不提交、不部署。

### `collect_publish`

执行候选发现、元数据刷新、快照校验、排行生成、Schema 校验、原子数据提交、Astro 构建和 Pages 部署。同日已有有效快照时复用原统计窗口。

### `deploy_existing`

不访问 GitHub API，不改变数据分支，只从指定数据提交重建网站。用于 Pages 故障恢复。成功重部署不代表数据已恢复新鲜，因此不会自动关闭采样告警。

### `replace_snapshot`

只在当天快照确实错误时使用，并显式提供北京时间日期。操作必须在 00:00–03:00 执行；采集器会在任何 API 请求前拒绝窗口外或历史日期替换。

## 5. 中文内容与项目分类

- 中文内容和分类通过独立补全工作流异步生成，榜单采集不依赖模型成功。
- GitHub Models 已于 2026-07-30 退役（[官方说明](https://docs.github.com/en/github-models)）。旧地址返回 HTTP 200 文本 `OK`，不能当作模型结果。补全不再使用 `GITHUB_TOKEN` 或 `models: read`。
- 接入已确认的兼容服务：仓库变量 `ENRICHMENT_API_URL` 为完整 HTTPS `/chat/completions` 地址（通常为基础地址加 `/chat/completions`），`LOCALIZATION_MODEL`、`CLASSIFICATION_MODEL` 必须是该服务准确的模型 ID；密钥只放仓库 Secret `ENRICHMENT_API_KEY`。本机同名环境变量可用；不要把密钥写入源码、命令参数或聊天。
- 通用接口需要支持非流式 Chat Completions、`response_format: json_schema`、`finish_reason: stop`。DeepSeek 官方 `https://api.deepseek.com/chat/completions` 使用 `json_object`，关闭 thinking，并把完整 Schema 放入系统提示；收到结果后仍在本地严格校验原 Schema。当前已通过官方 `/models` 与小批量真实调用验证 `deepseek-flash`。不会自动降级为自由文本、修补截断 JSON 或发送到备用服务。最多两次请求，401/403/429 与重定向立即停止；错误日志不回显响应体、提示词或密钥。
- 未配置完整时，定时补全仅做离线验证并在 Actions 摘要标记等待配置，不发布、不请求旧接口。日榜及累计榜只协调缓存；新增项目交给独立补全任务。停用补全时清空 `ENRICHMENT_API_URL` 即可，不影响采样。
- 新结果标记 `model_api`，已有 `github_models`/`manual` 保留；离线构建不改写原模型元数据。先合并本次 Schema/读取器更新，再配置密钥并启用真实补全。新枚举被写入后，回滚旧代码需同时恢复匹配的旧补全数据，不能用旧验证器直接发布新数据。
- 接入验收：先用少量项目验证两类结构化结果、专名/ID/分类词表与缓存保留，再运行 `backfill_publish`，核对数据分支、公开覆盖率及 Pages 发布。不以工作流绿色代替补全成功。
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
- Callback URL：`https://<worker-domain>/auth/callback`。
- Webhook：关闭。
- Repository permissions：Metadata 只读；Account permissions：Starring 读写；不申请代码、Issue、组织或管理权限。

### Worker 与 D1

1. 在 `auth-worker/` 执行 `npx wrangler d1 create open-source-star-rank-auth`。
2. 把返回的数据库 ID 写入 `wrangler.jsonc` 的 D1 binding。
3. 执行 `npx wrangler d1 migrations apply open-source-star-rank-auth --remote`。
4. 配置 `GITHUB_CLIENT_ID`、`SITE_ORIGIN`、`SITE_BASE_PATH`（vars），通过 `wrangler secret put` 设置 `GITHUB_CLIENT_SECRET`、`TOKEN_ENCRYPTION_KEY`（secret）。
5. 执行 `npm run preflight` 校验配置与迁移文件，再部署 Worker，并把其 HTTPS Origin 写入仓库变量 `PUBLIC_AUTH_API_URL`。
6. 重新部署 Pages，验证登录、退出、收藏、取消收藏和“同步到 GitHub”二次确认。

GitHub access token 必须使用 AES-GCM 加密后存入 D1；D1 只保存站点会话令牌的 SHA-256 摘要。浏览器仅在当前标签页的 `sessionStorage` 保存不透明会话，最长 8 小时。首次登录不得自动同步历史本地收藏。

已有 D1 必须先应用 `0002_browser_binding.sql` 再部署新版 Worker；进行中的旧登录需重新发起。前端登录生成仅保存在当前标签页的 verifier，Worker 保存其 SHA-256 challenge；回调 handoff 只能由发起登录的标签页兑换。state 与 handoff 均以单条 DELETE RETURNING 原子消费。每小时清理过期授权记录；5xx/离线保留有效会话，401、主动退出与自然过期才清除。前端与 Worker 应在同次发布中更新。

## 8. 数据分支恢复

若采集进程在文件写入中断，保留 `state/pending-update.json` 并重跑同一命令；采集器会先恢复该批次的全部派生文件与索引，再采集新日期。不要手工删除 journal，也不要把不完整的工作树提交为数据版本。


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

## 11. 断档恢复验收

在有效窗口内手动触发 collect_publish，可接上前一天的有效快照；如果前一天缺失，只能建立新基线，等待第二天。不能修改时间戳或扩大采样窗口来补造昨日榜。关闭每日故障前必须同时满足今日有效快照、latest_date 为北京时间昨日、公开索引与数据分支一致。7 日/30 日榜按真实连续采样进度恢复。

超过 03:00 且当天无有效快照时停止补采，保留上一版并等待下一窗口。若 GitHub 多次触发仍全部延迟出窗口，应接入独立可靠调度器调用 workflow_dispatch；这需要单独配置服务授权，现有 Actions 无法保证准点。

## 连续观察池与发现目录升级（state 1.3 / directory 1.0）

`repositories.json`、日榜索引和快照继续表示最多 2,000 个实际每日观察成员；新增 `directory.json` 独立表示最多 5,000 个已发现项目，包含所有观察成员。等待项目按最近发现日期、固定种子、Star 优先保留；达到目录上限后较旧等待项会退出目录。等待项不会被补写进快照，其元数据日期保持实际发现日期，也不保证永远保留或已持续检查其可访问性。

观察起点、30 日保护截止日、最近有效样本日期随内部状态与发布 journal 保存。连续性要求真实有效日窗口；断档后重新积累，历史快照不改写。完成 30 日观察后可轮换，每天最多接纳容量的 5%（不足一项按一项）；首次建池可填满。保护中及当前固定的既有成员优先保留，新固定项目遇满池也排队。失效、转私有、归档成员退出，同批不额外请求候补项目，空位下一次采样再补。主动缩容小于现有有效成员时拒绝，需要另行制定迁移。

同日重放沿用已保存的目录、观察记录和容量；显式替换同日样本不再次接纳新成员。所有目录状态纳入同一个发布 journal，失败先完成原批次。旧 state/journal 无目录字段时按原契约重放，下一次新采集才开始拆池。回滚到不认识 state 1.3 的代码时必须一起恢复兼容的精确数据提交，不能只回滚源码。

先执行只读检查：`python -m tools.inspect_observation_pool --data-dir <data-checkout>`。报告只规划现有成员与请求预算，不查询 GitHub、不预言未来 Star 或连续覆盖。真实 7 日和 30 日验收仍需等待相应数量的有效窗口。默认刷新预算最多 2,000 次仓库请求，加 20 页发现搜索、种子解析及有限重试；任务应继续监控实际请求数、限流和采样时段，失败不发布半批快照。

## 翻译与分类来源版本迁移（1.0 → 1.1）

翻译目录、分类索引和分类仓库目录的 `schema_version=1.0.0` 保留既有榜单来源集合；`1.1.0` 扩展为榜单与当前发现目录（无独立发现目录时使用观察目录）的并集。每个条目的真实采样日期参与元数据选择，旧等待项目不会因目录重新生成而变成新数据。已迁移的数据在后续离线或在线任务中保持该版本；普通旧数据校验、`deploy_existing` 和 Top500 历史迁移不隐式扩大来源范围。

1. 固定完整数据提交并确认没有待恢复的 `state/pending-update.json`。先用新版代码运行旧数据校验。
2. 执行 `python -m tools.migrate_enrichment_scope --data-dir <fixed-data-checkout> --output-dir <new-isolated-directory>`。输出必须不存在且不在输入目录内；工具校验输入、复制到新目录、离线协调两类缓存、校验输出并核对输入摘要没有变化。失败输出不可发布，应修复后使用新的输出目录重试。
3. 核对报告中的实际 eligible/pending 数量和源/输出摘要。迁移只纳入补全队列，保留源哈希仍匹配的缓存；新项目或元数据变化项保持待处理，不调用模型、不伪造分类。人工覆盖继续由仓库配置管理。
4. 源码合并后可手动运行内容工作流的 `migrate_scope` 模式：在隔离副本验证后提交新的数据版本，**该模式不部署 Pages**。已有 `deploy_existing` 路径仍支持旧版数据；新数据使用 Pages 工作流和精确 `data_ref` 发布。线上补全随后走原有预算受限的 `backfill_publish`。
5. 同一版本重复迁移不改变内容；工具测试包括旧/新版本直接校验、Top500 入口、迁移幂等、仅目录项目进入真实待处理队列、模拟模型预算及输入不变。回滚 1.1 数据必须同时使用兼容代码，或恢复迁移前的精确数据提交。源码推送与生产数据迁移是两个独立步骤。

## 原始采样恢复

原始记录保存在 captures/YYYY-MM-DD/<SHA-256>.json，latest.json 指定该日最后一次明确保存的版本；替换保留原版本。采集器先恢复 journal，再按日期重放尚未完成的原始记录。同日已有有效记录时，窗口外可离线恢复；没有记录时仍禁止窗口外补采。工作流故障步骤仅提交通过结构、身份及摘要校验的 captures/，不会提交派生半成品。远端推送失败后再次执行 tools.capture_checkpoint 会补推，遇远端分叉或无关未发布提交则停止。

恢复完整数据时同时保留 captures/。原始记录目前不自动删除；R2 备份启用与恢复演练通过前，不压缩或改写数据分支历史。硬件断电和远端服务不可用仍需独立备份与监测补足。

## Cloudflare 独立运行与备份

完整启用步骤、权限和故障边界见[独立运行器](../ops-worker/README.md)。默认观察模式，恢复与Issue开关关闭。GitHub仍保存源码、数据和部署站点；Cloudflare默认使用专用D1负责独立检查与受限补调度，不要求R2；D1只保存运行状态，不保存项目历史。跨平台完整备份默认停用，GitHub数据分支历史不是独立灾备。备份工作流每日北京时间03:30触发，STAR_RANK_BACKUP_ENABLED不为true时只报告停用；显式启用后才读取固定提交并上传R2，缺少密钥/地址时必须失败。/health公开备份停用状态与限制，不声称已有备份。

主采集使用实际待刷新数量检查API剩余额度，近期限流按Retry-After/reset等待，累计最多90秒；生产请求不得越过03:00边界。GitHub App短期令牌优先于专用只读令牌和默认Actions令牌。配额预检在离线恢复之后执行，恢复已有采样不需要API额度。

在线翻译、分类使用独立持久重试队列：失败项目1小时起指数退避、最多24小时；较久未尝试项目优先，同一失败批次不长期占据预算。上游服务不可用即停止后续批次，只记录实际尝试项。源哈希变化和人工完成会清除旧失败等待；离线流程不请求模型，public-only不写队列。队列与已校验结果在前端构建前提交，站点构建失败后可直接重建。

public/operations.json是小型、有来源时间戳的业务摘要，复用数据校验后生成，不把更新时间伪装成采样时间。独立监测同时读取采样进度、翻译/分类覆盖和最后验证备份；长期积压与恢复失败必须保留为待处理状态。31日连续真实验收需在服务启用后开始。
