# 2026-09-19 审查修复记录

范围：针对提交 `01c37ee4698a01581d343b786eeb5aaffbb1cfcf` 的审查所确认的 16 项问题及 2 项历史链路问题，并补上验证过程中发现的本地 Schema 引用问题。原有项目目录及其本地提交不受此次修改影响。

## 修复对照

| 编号 | 问题 | 修复与回归证据 |
| --- | --- | --- |
| F01 | JSON-LD 可被仓库描述闭合脚本标签 | 统一转义 HTML 分隔符及 Unicode 行分隔符；单元测试保留原始 JSON 值，浏览器加载含攻击字符串的实际项目页验证不执行。 |
| F02 | 语言退出候选池后历史索引丢失 | 索引合并历史语言，允许当前候选数为 0；真实数据整树校验覆盖语言切换。 |
| F03 | 搜索、种子、跟踪入口可能收录私有仓库 | 搜索强制 `is:public`，所有详情入口再次拒绝 private/internal；分别覆盖入口。 |
| F04 | OAuth handoff 未绑定发起浏览器 | 当前标签页生成 verifier，仅发送 SHA-256 challenge；state/handoff 持续携带绑定，兑换必须提交原 verifier。 |
| F05 | 同日替换复用旧 Star | 仅本次 API 已获取的仓库可跳过详情请求；替换测试确认新计数。 |
| F06 | 部分发布失败无法自动恢复 | 所有写入前保存采样 journal；同日或次日重试先恢复完整批次；同步撤销替换日期失效的语言、周期和探索文件。覆盖写入及删除中断。 |
| F07 | 新 all-time 元数据被旧日期榜覆盖 | 统一按实际观测时间选择来源，来源优先级只用于同时间比较；翻译与分类共享修复。 |
| F08 | Top500 迁移降级 1.4 格式 | 识别现有 1.3/1.4 合同，保留版本；当前数据迁移验证为字节级无变化。 |
| F09 | 一次性凭证并发重复消费 | state/handoff 使用带有效期和浏览器绑定条件的单条 `DELETE RETURNING`；错误 verifier 不消耗有效凭证；SQLite 并发测试仅一次成功。 |
| F10 | 异步异常越过 Worker 错误处理 | 路由分发等待异步处理；数据库失败返回规范 JSON 与 CORS。 |
| F11 | 会话请求竞态、断网掉登录及过期 UI | 所有状态更新绑定请求版本与 token；回调等待初始化；5xx/离线保留有效 token；退出、401、自然过期同步清理；无会话刷新保持幂等。 |
| F12 | 超范围筛选分页出现假空结果 | 分页参数取有限整数，在切片前约束范围；覆盖极大值、Infinity、负数与小数。 |
| F13 | 部分 Python 工具不触发 CI | 改为覆盖 `tools/**` 与 `docs/**`。 |
| F14 | 排除 devDependencies 导致依赖审计无效 | CI 检查完整依赖树；更新 Astro、Playwright、Vitest、Wrangler，移除带过期传递依赖的 LHCI 包，以新版 Lighthouse 执行原有质量阈值并保留报告。 |
| F15 | 授权部署说明与真实协议不一致 | 统一 `/auth/callback`、`GITHUB_CLIENT_*`、`wrangler.jsonc` 与用户级 Starring 权限；增加本地 preflight；部署工作流先应用 D1 迁移。 |
| F16 | 停更分类榜被当作最新榜 | 旧路由保留历史记录，显示固定日期及停更说明、noindex、移出 sitemap、移除倒计时，并链接当前净增榜筛选。 |
| L01 | 历史实时榜无限复用陈旧元数据 | 只复用每日采集器一小时内实际采集的元数据；不以 live 再发布时间延长缓存；扫描最近 7 个日期。 |
| L02 | 补采未更新分类池趋势 | 重建受影响 7 日内分类池趋势；同日禁用扩展采集时，使用本轮已验证的 Top500 替换旧池。 |
| 附加 | JSON Schema 相对引用依赖线上旧版本 | 使用同一 checkout 的本地资源 Registry，禁止自动网络回退；事件回归测试阻断网络连接。 |

独立审查额外发现的“同日旧语言文件残留”“无会话刷新取消登录”“补采遗漏新榜首”已修复，并加入回归测试。

## 验证

- Python：110 项通过，包括 15 项新增审查回归。
- 前端逻辑：13 项通过；Worker：10 项通过，包括本地 SQLite 实际执行迁移与并发消费。
- Worker 类型检查、配置 preflight 与部署 dry-run：通过。
- 初始化数据构建及产物校验：通过。
- `site`、`auth-worker` 完整依赖树审计：均为 0 条已知漏洞。
- 完整静态构建：5,079 页及产物合同校验通过；两次构建的 30 类 HTML、JSON、订阅与分享图逐字节一致。
- Playwright：29 项通过，含真实生成页面的 XSS 回归、页码越界、归档标识、响应式和 axe 无障碍检查；本机使用 Google Chrome、2 个 worker。
- Lighthouse：两页均通过门槛。首页性能 99 / 无障碍 100 / SEO 100；日榜性能 100 / 无障碍 100 / SEO 100。
- Astro：59 个文件，0 errors / 0 warnings / 0 hints；`git diff --check` 通过。

测试中的 GitHub、Models、GH Archive、D1 数据均使用测试夹具或本地 SQLite；完整构建和浏览器检查使用 40 日夹具。先验证完整夹具可复现，再单独构建含原文注入载荷的安全夹具并执行浏览器检查。

## 升级顺序

1. 使用 Node.js >= 22.19，分别在 `site` 与 `auth-worker` 执行 `npm ci`。数据工具需要 Python 3.12+ 及 `requirements-star-rank.txt`。
2. 在 Worker 目录运行 `npm run preflight`、`npm run check`、`npm test`。
3. 上线前对现有 D1 执行 `npx wrangler d1 migrations apply open-source-star-rank-auth --remote`，确保 `0002_browser_binding.sql` 已应用。该迁移保留现有 session，但未绑定的旧授权中间状态需要重新登录。
4. 部署 Worker，并用同版本前端重新构建、发布 Pages。前后端授权协议需一起升级。
5. 实际验收 GitHub 登录、退出、Star/Unstar、断网恢复与定时过期清理。站点历史收藏不会被自动同步。

此次交付为本地源码修复与验证；没有执行远端 D1 迁移、部署或真实账号 Star 操作。测试通过不等于生产授权已验收，也不保证项目不存在其他未发现的问题。
