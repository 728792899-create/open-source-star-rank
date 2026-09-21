# king AI 产品标识

最终方向为纯字标：小写 `king` 在上、大写 `AI` 在下，两行字号与字重相同，均为 66px 字形轮廓；`AI` 自然较窄，不放大或拉伸。保留橙色和圆角暖白底板，取消皇冠与独立 K 图形。中文产品名仍为「开源星榜」。

- `selected-reference.png`：用户提供的圆角底板与配色参考。
- `refined-concept.png`：按最终指示通过内置 Image Gen 生成的参考稿。
- `prompts.json`：四方向探索与最终调整的原始提示词；未调用外部模型 API。
- [正式矢量标识](../../../site/public/assets/brand/kingai-logo.svg)：橙色 `#ef6938`、暖白底 `#faf8f4`、边框 `#e6e2da`。字标为 Arial Black 字形轮廓，运行时不依赖字体文件。与生成参考稿在字体细节上有区别。
- [透明边角 PNG](../../../site/public/assets/brand/kingai-logo.png)：640 × 640 导出，可直接下载使用；暖白底板保留。
- [通用分享卡片矢量源](../../../site/public/assets/brand/kingai-social.svg)：与榜单分享卡片使用同一完整组合标。

生产 Astro 的桌面侧栏、手机展开导航、浏览器图标和主屏幕图标使用同一标识。仓库头像与功能星标继续使用原图标，避免把 king AI 误作第三方项目标识。

在 `site/` 执行 `node scripts/render-brand-assets.mjs` 可从无字体依赖的 SVG 母版重新导出 PNG、32px favicon、180px Apple touch icon 和通用 `og.png`。榜单卡片由既有构建流程自动嵌入标识。

上线状态与验证证据见 [开发进度](../../DEVELOPMENT_PROGRESS.md)。
