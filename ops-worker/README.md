# 独立运行器（Cloudflare Workers + D1，备份可选）

默认使用专用 D1 保存检查结果、并发锁及重试计数，与 auth-worker 独立，不访问登录数据库。BACKUP_MODE=disabled 不要求 R2 订阅；自动恢复和 Issue 投递默认关闭。部署不代表无人值守验收完成。

## 行为与边界

- 每15分钟检查固定数据提交、公开站点索引、真实采样窗口和补全摘要。仅 BACKUP_MODE=r2 时检查、补调度独立备份。
- 今日有效采样缺失时，仅在北京时间00:00–03:00请求采集；已有今日原始记录可在窗口外请求离线恢复。数据已保存但站点落后时，只请求固定SHA重新部署。
- 每天最多三次采样/发布恢复，间隔至少30分钟，有运行中任务则等待。预约次数在请求发送前落盘；网络响应不确定也消耗一次。D1以单条SQL条件写入及revision实现并发锁；不使用最终一致的缓存替代锁。
- 首份有效基线显示积累状态；前半小时为采集宽限期。真实缺口不补零、不修改时间戳。
- /health公开state_backend、auto_recovery、dispatch_authorized、backup_enabled、backup_status和limitations。检查超过45分钟、D1不可用、检查未初始化或业务故障返回503。备份禁用时不当作运行故障，但明确提示缺少跨平台完整备份，不能把健康视为灾备就绪。
- D1只保存小型operations_state表，单记录最多64KiB；不存项目历史、大文件、凭据或登录数据。历史仍在GitHub数据分支，同仓库历史不等于独立灾备。
- 独立调度通过GitHub Actions执行采集；GitHub全平台故障时无法保证不断档。免费方案有资源额度，平台故障、额度耗尽及授权撤销仍需要负责人处理，并非永久零维护。

## 不订阅 R2 的启用顺序

1. 验证并合并本实现到main；在此之前保持AUTO_RECOVERY=false。调度器与主分支工作流必须匹配。
2. 完成Wrangler授权，执行 `npx wrangler d1 create open-source-star-rank-operations` 创建独立数据库。ID写入wrangler.jsonc的STATE_DB，保持BACKUP_MODE=disabled、无R2 binding。不要修改auth-worker资源。
3. 执行 `npx wrangler d1 migrations apply open-source-star-rank-operations --remote`，然后 `npm run deploy`，先观察。只对专用数据库应用operations迁移。
4. 建立仅安装于本仓库的GitHub App：Contents读取、Actions读写；仅在另行授权故障Issue投递后才加Issues读写。Worker配置GITHUB_APP_ID、GITHUB_INSTALLATION_ID、GITHUB_APP_PRIVATE_KEY（PKCS#8 PEM），每轮签发短期安装令牌。私钥通过 `wrangler secret put` 标准输入设置，不进入源码或聊天。不要把个人gh登录令牌当作永久系统凭据。
5. 同一App可用于采集：仓库Variable STAR_RANK_APP_ID、Secret STAR_RANK_APP_PRIVATE_KEY。工作流收窄为Contents读取，结束撤销令牌；未配置则沿用现有令牌路径，预算不足时拒绝发布半批结果。
6. 检查/health、真实Cron时间、数据SHA及站点索引；授权和主分支就绪后，以 `npx wrangler deploy --var AUTO_RECOVERY:true` 启用受限恢复，其余变量沿用配置。每次部署都检查auto_recovery；默认配置仍关闭。分别验证已有采样离线恢复与固定版本发布，不伪造新采样验收。
7. 仓库Variable STAR_RANK_BACKUP_ENABLED=false（未设置也视为false）；备份工作流只报告未启用，不请求R2、不生成伪备份成功报告。/health的backup_status=disabled，保留“没有独立灾备”的限制。
8. 连续观察至少31个自然日，核对有效样本、7/30日窗口、漏采与失败恢复、分类积压。这个模式没有跨平台完整备份验收。

## 以后启用独立 R2 备份

R2保留为可选能力。开通后创建专用桶open-source-star-rank-operations、增加STORE binding，保留STATE_DB；BACKUP_MODE设为r2。备份按SHA-256寻址、条件写入并读回校验，保留所有历史对象，不自动删除。单对象上限16MiB，清单最多10万文件；需要管理容量与费用，不能称为无限存储。

Worker Secret BACKUP_TOKEN与仓库Secret STAR_RANK_BACKUP_TOKEN使用同一个至少32字符随机值，通过标准输入设置。仓库Variable STAR_RANK_BACKUP_ENDPOINT为Worker HTTPS origin（无路径），STAR_RANK_BACKUP_ENABLED=true。启用后缺少密钥/地址属于错误，工作流必须失败。

手动运行Verify independent Star Rank backup，核对固定数据SHA、manifest SHA、校验数量及需鉴权的/backup/latest。上传器从精确Git提交取JSON，最多8路并发，每次隔离全量恢复通过才提升指针；失败保留旧指针。该真实验收通过前不声称独立备份完成。停用时同步关闭仓库Variable及Worker BACKUP_MODE，不删除已有对象。

## 本地验证与恢复

在ops-worker执行npm test、npm run check、npm run preflight、npx wrangler deploy --dry-run。需要npm ci时，若本地node_modules与预览共享，先建隔离依赖目录，避免影响运行中的服务。测试覆盖真实SQLite条件写入、并发锁、重试持久计数、失败预约及禁用备份的状态。

以下命令仅用于已启用并验证R2的部署；D1调度模式不提供完整仓库恢复。凭据由环境提供，不经命令行参数：

    python -m tools.backup_star_rank verify
    python -m tools.backup_star_rank restore --output /new/nonexistent/directory
    python -m tools.backup_star_rank restore --manifest SHA256 --output /another/new/directory

verify全量读回校验后清理临时目录。restore拒绝覆盖现有目录，不推送数据分支、不部署站点；按运行手册核对有效采样时间后普通提交恢复。GitHub Actions中的报告产物不是完整备份。

Cron使用UTC，每15分钟执行，不依赖本机在线。Cloudflare自身停机仍需要外部对/health的可用性监测。
