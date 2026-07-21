# 开源星榜运行手册

本手册面向拥有仓库 Actions、Pages 和 Issue 管理权限的维护者。生产榜单完全由工作流生成，不接受手工改数。

## 1. 首次初始化

1. 确认默认分支上的 `Validate Open Source Star Rank` 已通过。
2. 在 `Update and publish Open Source Star Rank` 中选择 `validate`。该模式调用真实 GitHub API，但不会写入数据分支或部署。
3. 验证模式成功后选择 `collect_publish`。工作流会创建 `star-rank-data`、保存首个基线并启用 GitHub Pages。
4. 检查站点、`/status/`、`/methodology/`、`/data/index.json`、`/data/repositories.json`、`/data/schema/`、三种 Feed 和分享图。首日必须显示有效基线进度，不得出现测试项目。
5. 第二个北京时间自然日采集后，确认首页和 `/daily/YYYY-MM-DD/` 出现首个真实榜单。

## 2. 公共事件榜 GCP Sandbox 初始化

全站公开事件新增榜必须使用一个专用、未绑定结算账号的 GCP 项目。BigQuery Sandbox 在没有信用卡或结算账号的情况下可查询公共数据集，并具有每月 1 TiB 查询免费额度。不得为该项目启用结算；不创建自有 BigQuery 表、不执行 DML、不使用流式写入或数据传输服务。

### 2.1 创建最小权限身份

以下命令中的 `PROJECT_ID` 由维护者替换。仓库的固定数字 ID 为 `1301467867`，所有者数字 ID 为 `230279308`；这些数字 ID 不会因改名而被他人复用。

```bash
export PROJECT_ID="your-sandbox-project-id"
export POOL_ID="github-actions"
export PROVIDER_ID="star-rank-events"
export SERVICE_ACCOUNT_NAME="star-rank-events"
export SERVICE_ACCOUNT="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  bigquery.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project "$PROJECT_ID"
gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
  --project "$PROJECT_ID" \
  --display-name "Open Source Star Rank event collector"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role roles/bigquery.jobUser
```

服务账号在项目级只能拥有 `roles/bigquery.jobUser`。IAM、Service Account Credentials 和 STS API 只用于 GitHub OIDC 联邦与短期服务账号凭据，不为服务账号增加项目角色。GH Archive 仍从公共数据集直接读取，不复制到自己的项目。

### 2.2 配置 GitHub OIDC 与 Workload Identity Federation

```bash
gcloud iam workload-identity-pools create "$POOL_ID" \
  --project "$PROJECT_ID" \
  --location global \
  --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project "$PROJECT_ID" \
  --location global \
  --workload-identity-pool "$POOL_ID" \
  --display-name "Open Source Star Rank events" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref" \
  --attribute-condition "assertion.repository_id=='1301467867' && assertion.repository_owner_id=='230279308' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='728792899-create/open-source-star-rank/.github/workflows/star-rank-events.yml@refs/heads/main'"

export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export POOL_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
  --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/${POOL_RESOURCE}/attribute.repository_id/1301467867"

export PROVIDER_RESOURCE="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project "$PROJECT_ID" --location global --workload-identity-pool "$POOL_ID" --format='value(name)')"
```

提供者条件同时限制了仓库数字 ID、所有者数字 ID、`main` 分支和 `.github/workflows/star-rank-events.yml`。不得为整个身份池授予服务账号模拟权限，不得创建或上传 JSON 私钥。

### 2.3 配置 GitHub 变量并确认零费用边界

在仓库 Settings → Secrets and variables → Actions 中创建三个 **Variables**，不是 Secrets：

- `GCP_PROJECT_ID`：`$PROJECT_ID`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`：`$PROVIDER_RESOURCE`
- `GCP_SERVICE_ACCOUNT`：`$SERVICE_ACCOUNT`

启用工作流前必须检查结算状态、项目权限和服务账号密钥：

```bash
gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)'
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${SERVICE_ACCOUNT}" \
  --format='table(bindings.role)'
gcloud iam service-accounts keys list \
  --iam-account "$SERVICE_ACCOUNT" \
  --filter='keyType=USER_MANAGED'
```

第一条必须返回 `False`（或明确表示未绑定结算账号），第二条只能显示 `roles/bigquery.jobUser`，第三条不得有用户管理的私钥。

### 2.4 事件榜首次发布

1. 手动运行 `Update and publish public event star rank`，选择 `validate`。该模式先 dry-run，再执行真实全量聚合并验证 24/24 小时覆盖；不调用 GitHub 元数据 API、不写数据、不部署。
2. 在日志中确认 `estimated_bytes` 和 `bytes_processed` 均不超过 `25769803776`，`observed_hours` 为 `24`。
3. 手动选择 `collect_publish` 采集昨日；若昨日已经存在旧版 `1.0.0` 日榜，则改用 `replace_day` 显式替换该日期。检查 `star-rank-data` 中的 `public/events/`、`state/events/`与 `public/schema/`。
4. 核对 `/data/events/index.json`、`/data/events/daily/YYYY-MM-DD.json`、`/events/daily/YYYY-MM-DD/`、第 2–5 页、首页、状态页与事件分享图。新版事件契约必须为 `1.2.0`、方法论为 `gharchive-public-watch-events-v3`，且恰好包含 500 项。
5. 确认 `source_metrics` 的小时覆盖为 24/24、`ranking_complete` 为 `true`、公开条目恰好 100；全量仓库精简聚合只保存于 `state/events/daily/` 并保留最近 30 天。
6. 保留 07:30 定时任务与 08:15 watchdog，连续观察 7 天的扫描字节、事件延迟、排名变化与趋势空值。

## 2.5 中文项目内容与分类初始化

中文项目内容使用 GitHub Models 和 Actions 自带的 `GITHUB_TOKEN`，不创建模型 API 密钥。两个采集任务和独立补全任务只申请 `models: read`；模型限流、免费额度耗尽或单批响应不合格时保留已有缓存并显示 GitHub 原文，不得让榜单采集失败。

1. 在仓库 Actions 中确认 GitHub Models 可用，但不要启用付费使用。
2. 可选创建仓库变量 `LOCALIZATION_MODEL`，默认值为 `openai/gpt-4.1-mini`。
3. 可选创建仓库变量 `LOCALIZATION_MAX_PROJECTS`，两个采集工作流默认每次处理 200 个，独立补全任务默认处理 400 个。
4. 手动运行 `Backfill and publish Chinese project content` 的 `validate`，确认缓存、Schema 和站点构建通过；此模式不调用模型、不提交、不部署。
5. 运行 `backfill_publish`，核对 `state/localization/zh-CN/repositories.json`、`public/i18n/zh-CN/repositories.json` 和 `/status/` 的覆盖率。
6. 同一任务会在翻译后运行分类；可选仓库变量为 `CLASSIFICATION_MODEL`（默认 `openai/gpt-4.1-mini`）和 `CLASSIFICATION_MAX_PROJECTS`（采集任务默认 200，补全任务默认 400）。
7. 核对 `state/classification/repositories.json`、`public/classification/index.json`、`public/classification/repositories.json` 与 `/status/` 的覆盖数字。
8. 检查最新 Top 500 的中文内容、分类标签与“中文 / 原文”切换；缺失内容允许回退 GitHub 原文，补全工作流随后继续处理。

需要人工修正时，在主分支的 `data/localization-overrides.zh-CN.json` 按 repository ID 增加 `display_name_zh` 和 `description_zh`。人工修正优先于模型缓存；合并后运行 `backfill_publish`。不得直接编辑数据分支中的公开译文。

分类人工修正写入 `data/classification-overrides.zh-CN.json`，每项必须提供 `repository_id`、`primary_category`、`project_type` 和 1–4 个 `use_cases`，且值必须来自 `data/classification-taxonomy.zh-CN.json`。修改词表含义时必须升级 `taxonomy_version`并全量重新分类，不得静默改变旧标签语义。

## 2.6 榜单内组合筛选与全站历史星标榜

组合筛选不使用独立分类榜入口。事件任务严格发布 Top 500 后继续生成最多 1,000 项的永久扩展池 `public/events/category/YYYY-MM-DD.json`；候选池任务同步生成 `public/explore/daily/` 与 `public/explore/period/{7d|30d}/` 深度池（最多 2,000 项）。页面按语言、方向、形态和场景取交集，最多返回 500 项并用 `result_page` 分页；扩展池 500 项以后的补全不足上限时按实际数量发布，不影响已验证的公开 Top 500。

全站历史星标榜（`/all-time/`）由 `Collect and publish all-time star board` 工作流生成：

1. 手动运行 `validate`，确认 GitHub 搜索采集、Schema 与站点构建通过；此模式不提交、不部署。
2. 运行 `collect_publish`，核对 `public/alltime/top-1000.json` 与 `public/alltime/index.json`，并确认 `/all-time/` 页面条目与 JSON 一致。
3. 该任务默认每周一北京时间 10:00 运行；数据来自 GitHub Search 按 star 降序的前 1,000 个未 fork、未归档公开仓库（约 10 次 API 请求），采集后会触发中文内容与分类补全，使新入榜项目获得中文与分类标签。

## 3. 日常运行与告警

- 主任务在北京时间 00:20 调度，目标是在 01:00 前完成。
- 新建或替换的生产快照必须位于北京时间 `[00:00, 03:00)`；相邻快照须日期连续且间隔 21–27 小时。
- 01:15 watchdog 同时检查 `star-rank-data` 和公开网站；二者必须是今日版本且内容一致。
- 数据超过 36 小时、今日快照缺失、采集失败或部署失败时，工作流创建或更新 `[开源星榜] 每日任务故障`。
- 新采集和网站均恢复后，同一 Issue 自动关闭。不要另建重复故障 Issue；`deploy_existing` 不改变数据新鲜度，因此成功重部署不会关闭仍在生效的新鲜度告警，须由 watchdog 或下一次真实采集确认恢复。
- 每月检查 Git 对象体积；超过 500 MiB 时创建 `[开源星榜] 数据分支需要压缩`。
- 事件任务在北京时间 07:30 汇总前一日，目标 08:00 前发布；08:15 watchdog 检查数据分支与站点的事件日期和完整文件哈希。
- 今日实时榜在北京时间 01:45–23:45 每小时运行；每次只新增读取尚未缓存的 GH Archive 小时文件，累计结果写入 `public/events/live.json`，私有小时去重状态写入 `state/events/live-hours/`。
- 实时榜的排名变化是相对上一次成功的小时刷新；到次日后以 24/24 小时 BigQuery 完整榜为权威历史版。小时文件不可用时保留上一版并维护 `[开源星榜] 今日实时榜故障` Issue。
- 事件身份、dry-run、24 GiB 上限、24 小时覆盖、正式查询、GitHub 元数据、Schema 或部署任一失败时，同一 `[开源星榜] 公共事件榜故障` Issue 会打开或更新；不提交残缺事件数据，首页保留最近一次成功的全站公开事件榜并显示过期警告，候选池榜继续在 `/daily/` 独立可用。
- 中文与分类补全任务在北京时间 09:00 检查所有已进入公开榜单的项目（含扩展分类池与历史星标榜），先翻译、后分类。模型失败保留旧缓存或待处理状态，不触发核心榜单故障 Issue；Schema 或站点构建失败时不提交、不部署。
- 全站历史星标榜任务每周一北京时间 10:00 重新采集前 1,000 名；失败时保留上一版榜单，站点显示旧数据与更新时间，不影响每日榜单发布。

## 4. 手动模式

### 验证真实链路

使用 `validate`。数据只写入 Actions 临时目录，任何结果都不会进入生产分支。

### 同日安全重跑

使用 `collect_publish`。若当日快照已存在，采集器复用原始采样时间和统计窗口，只重新验证并部署，不重复生成数据。

从 `1.1.0` 升级到 `1.2.0` 时，同日重跑会保留原快照用于审计，仅重建公开索引、项目目录和 Schema。零点窗口外的旧快照不会被计入有效基线。

### 仅恢复部署

使用 `deploy_existing`。该模式不调用 GitHub API、不改变数据分支，适用于 Pages 临时故障或部署产物丢失。默认使用数据分支最新提交；恢复演练时可在 `data_ref` 输入该分支历史中的指定 commit SHA，工作流会校验它确实属于 `star-rank-data`。

成功的 `deploy_existing` 只证明构建和 Pages 部署恢复，不证明数据已经变新，因此不会自动关闭采样新鲜度故障 Issue。

事件工作流也提供 `deploy_existing`：不进行 Google 身份验证、不访问 BigQuery，只用数据分支当前成功内容恢复站点。首页不会因事件数据超过 36 小时而切换口径，而是保留旧事件榜并显示醒目的过期状态。

中文与分类补全工作流的 `deploy_existing` 同样不访问 GitHub Models，只使用数据分支中已经通过校验的翻译和分类缓存重建网站。

### 替换当天错误快照

仅当当天采样确实不可用时使用 `replace_snapshot`，并在 `snapshot_date` 输入当天北京时间日期。操作必须在 00:00–03:00 执行；采集器会在任何 GitHub API 请求前拒绝窗口外的替换。采集器也拒绝替换历史日期，防止用当前 Star 数伪造历史窗口。

### 回补或替换事件日榜

事件工作流使用 `replace_day`，并必须显式填写单个北京时间日期。采集器只接受昨日或最近 7 天内的日期，拒绝未来日期、第八天及更早日期和批量跨月扫描。普通 `collect_publish` 重跑会复用已有日榜；只有 `replace_day` 才会重新查询，并由 Git 历史保留变更记录。替换后会重算后续可用日榜的排名变化与 7 日趋势。

## 5. 数据分支恢复

当最新数据提交损坏但历史提交仍可靠时，使用非强制恢复：

1. 找到最后一个可靠的 `star-rank-data` 提交。
2. 从该提交恢复 `state/`、`snapshots/` 和 `public/` 到数据分支工作树。
3. 创建普通恢复提交并推送，不改写已有历史。
4. 执行 `deploy_existing`，确认公开索引与恢复提交一致。
5. 下一次正常采集前检查恢复后的最后快照日期；日期不连续时允许跳过该日榜，禁止补零。

如果数据分支完全丢失，从最近可靠备份恢复；没有备份时重新执行 `collect_publish` 建立新基线，等待第二个真实快照，不得从页面展示值反推快照。

## 6. 数据分支压缩

只有月度维护 Issue 触发且已建立远端备份标签后才允许压缩历史：

1. 保存当前数据分支提交为不可变备份标签。
2. 创建新的孤立分支，只复制当前 `state/`、全部 `public/`和最近 90 个北京时间自然日的 `snapshots/`。
3. 在临时分支运行数据 Schema、站点构建和可复现测试。
4. 使用带租约保护的分支替换操作更新 `star-rank-data`，保留备份标签至少 30 天。
5. 执行 `deploy_existing` 并关闭维护 Issue。

该流程会改写机器数据分支历史，必须由仓库管理员单独审核；主分支和永久公开日榜不得删除。

## 7. 故障演练与发布门槛

正式宣布稳定前，完成并记录以下演练：

- 使用夹具触发 API 限流和 `incomplete_results`，确认没有数据提交。
- 临时阻断部署步骤，确认线上旧版本仍可访问且故障 Issue 打开。
- 使用 `deploy_existing` 恢复同一数据提交。
- 使用相同源代码和数据提交连续构建两次，核心 HTML 与 JSON 哈希一致。
- 连续 14 个北京时间自然日无人工改数；页面、公开 JSON 和数据分支统计一致。
- 全站公开事件榜连续 7 天在 08:00 前发布；每天 24/24 个 WatchEvent 小时覆盖、公开 Top 500 完整、历史数量基线正常、五页与 JSON 一致；单次实际扫描不超过 24 GiB，服务账号无 JSON 私钥，项目结算仍为禁用。

## Top 500 历史迁移

迁移必须先生成只读清单，不允许直接覆盖历史：

```bash
python -m tools.migrate_star_rank_top500 \
  --data-dir /path/to/star-rank-data \
  --manifest /tmp/top500-migration.json
```

人工核对清单后，只有同日深度池足以复现的候选日榜、周期榜和语言榜可执行 `--apply`。旧事件榜即使存在较深元数据池，也必须证明 v3 的 WatchEvent 专属 24 小时覆盖；无法证明时继续保留旧 Top 100，禁止用当前元数据补造历史。

```bash
python -m tools.migrate_star_rank_top500 \
  --data-dir /path/to/star-rank-data \
  --manifest /tmp/top500-migration.json \
  --apply
```

迁移后的文件保留原 `window_start`、`window_end` 与采集时间，只增加 `recomputed_at`。新旧 Schema 混合存在是正常状态。
- 使用测试夹具移除一个源小时，确认任务在元数据 API、数据提交和 Pages 部署前失败，线上仍保留上一版。

GitHub 定时任务属于尽力调度，01:00 是服务目标而非平台保证；01:15 watchdog 是漏跑和延迟的兜底发现机制。
