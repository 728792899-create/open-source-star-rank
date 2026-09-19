# 开源星榜开发协作规范

## 项目边界

- `site/`：生产 Astro 站点；`tools/`：Python 数据管线；`auth-worker/`：可选 GitHub 授权服务。
- `prototypes/starrank-ui/`：选定的 React UI 原型，当前仅六项目演示；接入真实数据和迁移到业务页面是后续工作。该目录另有设计约束。
- 已完成修复、验证和已知问题分别见 `docs/AUDIT_FIXES_2026-09-19.md`、`prototypes/starrank-ui/design-qa.md`、`docs/KNOWN_ISSUES.md`。

## 每个步骤同步 GitHub

用户已要求把每一步开发成果同步到公开仓库 `728792899-create/open-source-star-rank`。

1. 每完成一个可独立审查、验证的步骤，先运行与变更相应的检查，再形成范围清楚的提交并推送当前开发分支。不要把数轮已完成成果只留在本地，也不要把每次保存或未完成试验当作里程碑。
2. 在 `docs/DEVELOPMENT_PROGRESS.md` 记录本步行为、检查结果、剩余限制和下一步，并更新当前 PR 的说明。用户已授权常规源码同步，不需要每次重复征求同意。
3. 修改前检查 Git 状态及仓库指令；保留其他工作目录和未提交内容。只暂存属于本步的文件，不使用 force push、reset 或 clean 清理用户工作。
4. 推送后核对远端提交与本地 HEAD，查看相应 CI。报告实际状态；失败先修复，未完成则明确保留为待验证。
5. 源码推送不等于合并或上线。当前工作走公开开发分支和 PR；合并主分支、部署 Pages/Worker、远程 D1 迁移及真实账号操作，按对应任务范围执行，不在常规同步步骤中附带进行。
6. 不提交凭据、`.env`、依赖目录、生成构建、采集状态、个人绝对路径或临时诊断缓存。用于解释 UI 的截图与来源记录可随源码提交；不要把本机测试夹具作为正式数据发布。

## 验证

- Python：在安装 `requirements-star-rank.txt` 的 Python 3.12+ 环境执行 `python -m unittest discover -s tests`。
- 业务站：Node.js 22.19+，`cd site && npm ci && npm test && npm run check && npm run build && npm run validate-build`；构建调用的 Python 也必须使用上述环境。
- Worker：`cd auth-worker && npm ci && npm test && npm run check && npm run preflight`。
- 原型：`cd prototypes/starrank-ui && npm ci && npm run build && npm test`；先构建，打包适配测试依赖产物。
- 数据、授权、构建契约或跨文件行为变化使用独立只读审查；UI 行为变化补充真实浏览器检查。已有全套验证通过后，仅在变更或失败需要时重复。
- 真正部署前遵循 `docs/STAR_RANK_RUNBOOK.md` 与授权服务升级顺序；本地模拟测试不能代替生产 OAuth/D1 验收。
