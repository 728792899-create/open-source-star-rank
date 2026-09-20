# 暖橙工作台 UI 验收记录

验收日期：2026-09-19。以下浏览器证据来自本轮本地原型验收；纳入仓库时仅调整目录、运行说明与开发规范，没有修改 UI 实现。构建与 15 项自动测试已在仓库新路径重新执行。

## 设计与范围

用户选择图一的侧栏、搜索、筛选与榜单排版，融合图三的暖白、橙色、圆角与柔和材质。[选定融合稿](evidence/visual-target.png)是视觉依据。

这是独立 React 原型：六个固定演示项目、三个日期快照。本机收藏、分享链接和演示账户不代表真实账号、GitHub Star 或实时数据；生产 Astro 页面仍在 `../../site/`，真实数据迁移尚未完成。

## 已完成改进

| 问题 | 当前行为与验证 |
| --- | --- |
| 对比超额与反馈被面板遮挡 | 最多三项；满额禁用并说明原因，可移除或替换；反馈显示在原生 dialog 内。 |
| 窄屏溢出与文字过小 | 移除最小宽度，响应式缩列、放大正文和触控区域；约 319–1486 CSS px 均无 document 横向溢出。 |
| 导航、标题及返回路径不一致 | 视图与面包屑同步；筛选、日期、面板、比较项写入校验后的 URL，直接分享进入的面板也能一次关闭到榜单。 |
| 收藏与默认状态误导 | 初次打开无预选收藏或比较项；本机收藏刷新后保留，空收藏也正确保存；存储不可用时回退当前会话。 |
| 累计榜重复总量、方向含义不清 | 累计榜主列为总 Star、次列为七日净增；累计、零、缺失使用中性色，负增长有独立表达。 |
| 对比内容不足 | 补充能力、部署、语言、许可名称、资源、活动和适用人群；支持只看差异及官方来源，不推断商用许可。 |
| 加载与异常状态缺失 | 可取消快照请求，支持重试、延迟、缺失、零、负增长、归档和空快照演示；周期聚合与日期保持一致。 |
| 首屏资源偏大 | 响应式 WebP 插画；面板与 Recharts 延迟加载；行内趋势使用真实演示序列绘制。 |
| 手机详情底栏裁切 | 底部操作区与安全区域适配，约 319 px 下按钮完整可见。 |

## 可复查证据

截图与数据在 [evidence/optimization-20260919](evidence/optimization-20260919/)：

- [桌面最终页](evidence/optimization-20260919/desktop-final.png)、[手机最终页](evidence/optimization-20260919/mobile-final.png)、[窄屏详情](evidence/optimization-20260919/mobile-320-detail-fixed.png)。桌面截图为 1487 × 1058 的密度归一图，未经内容修改；实际 CSS 约 1486 × 1058。
- [对比面板](evidence/optimization-20260919/comparison-desktop.png)、[面板内反馈](evidence/optimization-20260919/dialog-feedback.png)、[边界数据](evidence/optimization-20260919/boundary-data-desktop.png)。
- [折叠对比栏](evidence/optimization-20260919/mobile-collapsed.png)、[展开对比栏](evidence/optimization-20260919/mobile-expanded.png)。
- [尺寸检查](evidence/optimization-20260919/responsive-checks.json)、[浏览器验证](evidence/optimization-20260919/browser-verification.json)、[原验收测试记录](evidence/optimization-20260919/tests.txt)、[资源大小](evidence/optimization-20260919/build-sizes.json)。
- [素材来源](evidence/asset-sources.json)：官方项目头像与生成插画的 WebP 衍生记录。

原型实现期间完成了浏览器前进/后退、分享进入面板、筛选、收藏、比较、日期切换、键盘及减少动态效果检查。未出现应用错误；强制模拟减少动态效果时有一条 Motion 开发提示。桌面截图中的 Dify 收藏与两个对比项是验收操作结果，并非产品默认选择。

## 自动验证及性能数据

从本目录运行 `npm run build && npm test`：构建通过，15/15 测试通过，包括 11 项 URL、状态、快照数据回归和四项打包适配测试。

主 JS 从 732,440 B 降至 373,475 B（约减少 49%，gzip 约 120 KB）；面板 16,569 B、趋势图 365,139 B 按需加载。插画由 1,420,151 B PNG 转为 1,740 B / 5,150 B WebP，原图仅保留来源用途。文件体积不等于真实网络性能评分。

## 未完成事项

尚未做真实手机、完整屏幕阅读器或无障碍认证；未接入真实 GitHub 数据、OAuth、云端收藏，也未部署。后续正式接入与业务缺陷见 [项目进度](../../docs/DEVELOPMENT_PROGRESS.md) 和 [待办清单](../../docs/KNOWN_ISSUES.md)。
