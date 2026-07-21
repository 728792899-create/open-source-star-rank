# 开源星榜 GitHub 授权 Worker

该 Worker 为 GitHub Pages 静态站点提供可选 GitHub App 登录和 Star / Unstar 同步。榜单、搜索、本地收藏与项目对比不依赖 Worker，服务不可用时仍可完整读取站点。

## 安全边界

- 使用 GitHub App 授权码流程、PKCE 和一次性 state。
- GitHub access / refresh token 只存在 Worker 与 D1，使用 32 字节 AES-GCM 密钥加密。
- 浏览器只接收最长 8 小时的不透明站点会话，保存在 `sessionStorage`。
- CORS 只允许 `SITE_ORIGIN`，返回路径必须位于 `SITE_BASE_PATH`。
- GitHub App 只需 `Metadata: read` 与用户级 `Starring: read and write`；不需要 private key、webhook 或仓库内容权限。

## 本地校验

```bash
npm ci
npm run check
npm test
npx wrangler deploy --dry-run
```

## 首次部署

```bash
npx wrangler login
npx wrangler d1 create open-source-star-rank-auth
# 把返回的 database_id 写入 wrangler.jsonc
npx wrangler d1 migrations apply open-source-star-rank-auth --remote
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler deploy
```

`TOKEN_ENCRYPTION_KEY` 必须是恰好 32 字节的 base64url 字符串。GitHub App Callback URL 是 `https://<worker>/auth/callback`。部署后在 GitHub 仓库 Actions Variables 中设置 `PUBLIC_AUTH_API_URL=https://<worker>`，再重新构建 Pages。

完整配置、免费限额、验收和故障恢复见 [`docs/STAR_RANK_RUNBOOK.md`](../docs/STAR_RANK_RUNBOOK.md#27-github-登录与-star-同步)。
