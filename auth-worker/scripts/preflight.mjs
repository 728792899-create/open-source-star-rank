import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const { SITE_ORIGIN, SITE_BASE_PATH, GITHUB_CLIENT_ID } = config.vars;
const origin = new URL(SITE_ORIGIN);
assert.equal(origin.protocol, 'https:', 'SITE_ORIGIN must use HTTPS');
assert.equal(origin.origin, SITE_ORIGIN, 'SITE_ORIGIN must contain only the origin');
assert.match(SITE_BASE_PATH, /^\/[A-Za-z0-9_/-]*$/u);
assert.ok(GITHUB_CLIENT_ID, 'GITHUB_CLIENT_ID is required');
const db = config.d1_databases.find((item) => item.binding === 'AUTH_DB');
assert.match(db?.database_id ?? '', /^[a-f0-9-]{36}$/iu, 'Set the D1 database_id');
for (const name of ['0001_sessions.sql', '0002_browser_binding.sql']) {
  assert.ok(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').length);
}
if (process.env.TOKEN_ENCRYPTION_KEY) {
  assert.match(process.env.TOKEN_ENCRYPTION_KEY, /^[A-Za-z0-9_-]{43}=?$/u);
  assert.equal(Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'base64url').length, 32);
}
console.log('Local configuration and migration files verified.');
console.log('Before deployment: apply D1 migrations, set GITHUB_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY as secrets.');
console.log('GitHub App callback: https://<worker-domain>/auth/callback; Account permissions: Starring read/write.');
console.log(`Pages callback: ${SITE_ORIGIN}${SITE_BASE_PATH}/auth/callback/`);
