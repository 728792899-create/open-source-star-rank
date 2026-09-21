# Production UI assets

- `hero-star-{320,640}.webp`: unchanged copies of the original Image Gen artwork in `prototypes/starrank-ui/public/assets/`, documented by `prototypes/starrank-ui/evidence/asset-sources.json`. Decorative, empty alt text; responsive sources preserve the approved visual direction.
- SVG icons: rendered from official `@tabler/icons-react` components (MIT, `TABLER-LICENSE.txt`), including the same `IconStarFilled` used by the approved prototype. No custom logo reconstruction.
- `inter-latin.woff2`: Inter variable Latin font from the prototype's `@fontsource-variable/inter` package (SIL OFL, `INTER-LICENSE.txt`). Chinese text uses system PingFang SC / Microsoft YaHei fallbacks.
- Project avatars are the actual GitHub owner avatars from validated ranking data, restricted to `https://avatars.githubusercontent.com/`. The StarRank icon is a neutral fallback when the source omits an avatar; the six demo project logos are not assigned to unrelated real repositories.
