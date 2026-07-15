# 开源星榜运行手册

本手册面向拥有仓库 Actions、Pages 和 Issue 管理权限的维护者。生产榜单完全由工作流生成，不接受手工改数。

## 1. 首次初始化

1. 确认默认分支上的 `Validate Open Source Star Rank` 已通过。
2. 在 `Update and publish Open Source Star Rank` 中选择 `validate`。该模式调用真实 GitHub API，但不会写入数据分支或部署。
3. 验证模式成功后选择 `collect_publish`。工作流会创建 `star-rank-data`、保存首个基线并启用 GitHub Pages。
4. 检查站点、`/status/`、`/methodology/`、`/data/index.json`、`/data/repositories.json`、`/data/schema/`、三种 Feed 和分享图。首日必须显示有效基线进度，不得出现测试项目。
5. 第二个北京时间自然日采集后，确认首页和 `/daily/YYYY-MM-DD/` 出现首个真实榜单。

## 2. 公共事件榜 GCP Sandbox 初始化

公共事件榜必须使用一个专用、未绑定结算账号的 GCP 项目。BigQuery Sandbox 在没有信用卡或结算账号的情况下可查询公共数据集，并具有每月 1 TiB 查询免费额度。不得为该项目启用结算；不创建自有 BigQuery 表、不执行 DML、不使用流式写入或数据传输服务。

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

1. 手动运行 `Update and publish public event star rank`，选择 `validate`。该模式只完成 OIDC 身份验证、BigQuery dry-run、全部测试、Schema 与站点构建，不查询正式结果、不写数据、不部署。
2. 在日志中确认 `estimated_bytes` 不超过 `25769803776`。
3. 手动选择 `collect_publish`采集昨日，检查 `star-rank-data` 中的 `public/events/`、`state/events/`与 `public/schema/`。
4. 核对 `/data/events/index.json`、`/data/events/daily/YYYY-MM-DD.json`、`/events/daily/YYYY-MM-DD/`、首页、状态页与事件分享图。
5. 保留 07:30 定时任务与 08:15 watchdog，连续观察 7 天的扫描字节、事件延迟、排名变化与趋势空值。

## 3. 日常运行与告警

- 主任务在北京时间 00:20 调度，目标是在 01:00 前完成。
- 新建或替换的生产快照必须位于北京时间 `[00:00, 03:00)`；相邻快照须日期连续且间隔 21–27 小时。
- 01:15 watchdog 同时检查 `star-rank-data` 和公开网站；二者必须是今日版本且内容一致。
- 数据超过 36 小时、今日快照缺失、采集失败或部署失败时，工作流创建或更新 `[开源星榜] 每日任务故障`。
- 采集和网站恢复后，同一 Issue 自动关闭。不要另建重复故障 Issue。
- 每月检查 Git 对象体积；超过 500 MiB 时创建 `[开源星榜] 数据分支需要压缩`。
- 事件任务在北京时间 07:30 汇总前一日，目标 08:00 前发布；08:15 watchdog 检查数据分支与站点的事件日期和完整文件哈希。
- 事件身份、dry-run、24 GiB 上限、正式查询、GitHub 元数据、Schema 或部署任一失败时，同一 `[开源星榜] 公共事件榜故障` Issue 会打开或更新；不提交残缺事件数据，候选池榜继续可用。

## 4. 手动模式

### 验证真实链路

使用 `validate`。数据只写入 Actions 临时目录，任何结果都不会进入生产分支。

### 同日安全重跑

使用 `collect_publish`。若当日快照已存在，采集器复用原始采样时间和统计窗口，只重新验证并部署，不重复生成数据。

从 `1.1.0` 升级到 `1.2.0` 时，同日重跑会保留原快照用于审计，仅重建公开索引、项目目录和 Schema。零点窗口外的旧快照不会被计入有效基线。

### 仅恢复部署

使用 `deploy_existing`。该模式不调用 GitHub API、不改变数据分支，适用于 Pages 临时故障或部署产物丢失。默认使用数据分支最新提交；恢复演练时可在 `data_ref` 输入该分支历史中的指定 commit SHA，工作流会校验它确实属于 `star-rank-data`。

事件工作流也提供 `deploy_existing`：不进行 Google 身份验证、不访问 BigQuery，只用数据分支当前成功内容恢复站点。

### 替换当天错误快照

仅当当天采样确实不可用时使用 `replace_snapshot`，并在 `snapshot_date` 输入当天北京时间日期。操作必须在 00:00–03:00 执行；采集器会在任何 GitHub API 请求前拒绝窗口外的替换。采集器也拒绝替换历史日期，防止用当前 Star 数伪造历史窗口。

### 回补或替换事件日榜

事件工作流使用 `replace_day`，并必须显式填写单个北京时间日期。采集器只接受昨日或最近 7 天内的日期，拒绝未来日期、第八天及更早日期和批量跨月扫描。普通 `collect_publish` 重跑会复用已有日榜；只有 `replace_day` 才会重新查询，并由 Git 历史保留变更记录。

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
- 事件榜连续 7 天在 08:00 前发布；单次实际扫描不超过 24 GiB，服务账号无 JSON 私钥，项目结算仍为禁用。

GitHub 定时任务属于尽力调度，01:00 是服务目标而非平台保证；01:15 watchdog 是漏跑和延迟的兜底发现机制。
