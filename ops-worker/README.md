# 独立运行器（Cloudflare Workers + R2）

此服务与 auth-worker 独立，不替换站点登录服务、不访问其 D1。源码默认关闭自动恢复和 Issue 投递，部署不代表已完成无人值守验收。

## 行为

- 每15分钟检查固定数据提交、公开站点索引、真实采样窗口、补全摘要和R2备份。
- 今日有效采样缺失时，仅在北京时间00:00–03:00请求采集；已有今日原始记录可在窗口外请求离线恢复。数据已保存但网站版本落后时，只请求固定SHA的重新部署。
- 每天最多三次采样/发布恢复，间隔至少30分钟，有运行中任务则等待。备份另设每天三次、间隔至少一小时的补调度。预约次数先落盘，网络响应不确定也消耗一次，避免重复风暴。
- 前半小时为采集宽限期；首份真实基线公开显示积累状态。缺失数据不补零、不修改时间戳。
- /health为公开业务状态JSON；检查结果超过45分钟也返回503。包含真实采样进度、补全覆盖和备份版本。GitHub无法访问时保留失败状态；Cloudflare自身停机仍需要外部对/health的可用性监测。
- R2对象/manifest接口仅接受至少32字符共享密钥；按SHA-256寻址、条件写入并读回验证。上传器备份精确Git提交中的JSON，先在隔离目录完整恢复校验，再提升最新备份指针。每次备份都执行恢复演练；失败保留上一指针。
- 保留所有历史对象与清单，不配置自动删除规则。备份存储增长需要容量/费用管理；目前单文件上限16MiB、清单最多10万文件，超过上限明确失败，不能称为无限容量。
- 独立调度仍通过GitHub Actions执行采集。GitHub全平台故障期间无法保证不断档；恢复后延续真实记录。

## 启用顺序

1. 先验证并合并含本实现的源码到main；在此之前保持AUTO_RECOVERY=false。备份工作流、原始记录恢复和数据契约必须与调度器匹配。
2. 完成npx wrangler login，确认目标Cloudflare账号已启用R2。执行npx wrangler r2 bucket create open-source-star-rank-operations创建专用桶，再按wrangler.jsonc部署新Worker（默认只观察）。不要修改auth-worker资源。
3. 配置密钥：Worker的BACKUP_TOKEN与仓库Secret STAR_RANK_BACKUP_TOKEN使用同一个随机值（至少32字符）。通过wrangler secret put和gh secret set的标准输入安全设置，不写进源码/公开日志。仓库Variable STAR_RANK_BACKUP_ENDPOINT设为新Worker的HTTPS origin（无路径）。
4. 推荐建立仅安装于本仓库的GitHub App：Contents读取、Actions读写；需要自动故障Issue时才加Issues读写。Worker配置GITHUB_APP_ID、GITHUB_INSTALLATION_ID、GITHUB_APP_PRIVATE_KEY；它每轮签发短期安装令牌。Worker私钥需PKCS#8 PEM；GitHub下载的PKCS#1可用openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem在本地转换，文件仅本人可读，提交密钥后安全保管原件。临时替代为GITHUB_TOKEN，到期会告警，不能当作永久授权。
5. 采集工作流也支持同一App：仓库Variable STAR_RANK_APP_ID和Secret STAR_RANK_APP_PRIVATE_KEY；Action将权限收窄为Contents读取并在任务结束撤销短期令牌。可选STAR_RANK_READ_TOKEN作为专用采集令牌；均未配置时使用默认Actions令牌，额度不足则明确失败，不发布不完整采样。告警仍使用原job令牌。
6. 手动运行Verify independent Star Rank backup。确认日志报告固定数据SHA、manifest SHA、校验文件数量，并从/backup/latest（需鉴权）核对。首次备份较多，上传/读回最多8路并行，工作流60分钟超时。
7. 观察/health，确认固定数据提交与公开索引匹配；分别演练采样已存在的离线恢复、固定版本重新部署和新目录恢复。完成后把AUTO_RECOVERY改为true部署。ISSUE_ALERTS根据已授权的告警策略启用；默认不向外部系统发消息。
8. 连续观察至少31个自然日，核对31份有效样本、7/30日窗口、漏采/失败恢复次数、备份恢复结果和分类积压。真实断档必须重新积累，不能用模拟测试替代此验收。

## 本地检查与恢复

在ops-worker运行npm ci、npm run check、npm test、npm run preflight及npx wrangler deploy --dry-run。preflight检查仓库默认安全配置；启用后应检查部署覆盖配置，不能把开关未启用报告为生产完成。

仓库根目录执行（凭据由环境提供，不通过命令行参数传入）：

    python -m tools.backup_star_rank verify
    python -m tools.backup_star_rank restore --output /new/nonexistent/directory
    python -m tools.backup_star_rank restore --manifest SHA256 --output /another/new/directory

verify全量读回、校验后清理临时目录。restore拒绝覆盖已有目录，不推送数据分支、不部署站点。灾难恢复需核对源提交、有效采样时间和最新指针后，按运行手册以普通提交恢复。旧清单保存在R2 manifests/，本机与GitHub运行产物仅保存清单标识，不能代替R2完整备份。

Cron为UTC，配置每15分钟执行，不依赖本机在线。密钥撤销、账号计费停用、平台故障仍需要负责人处理；目标是免于日常盯守，并非永久零维护。
