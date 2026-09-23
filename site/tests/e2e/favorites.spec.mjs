import { test, expect } from '@playwright/test';

async function mockAuth(page, handler) {
  await page.addInitScript(() => sessionStorage.setItem('star-rank-github-session-v1', JSON.stringify({ token: 'browser-fixture', expiresAt: Date.now() + 3600_000 })));
  await page.route('**/repo/10001/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/data-auth-api-url(?:="[^"]*")?/u, 'data-auth-api-url="https://auth.fixture.invalid"') });
  });
  await page.route('https://auth.fixture.invalid/**', async (route) => {
    const req = route.request();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4322', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const result = req.url().endsWith('/api/session')
      ? { status: 200, body: { user: { id: 1, login: 'fixture', avatar_url: '' }, expires_at: new Date(Date.now() + 3600_000).toISOString() } }
      : await handler(req);
    return route.fulfill({ status: result.status ?? 200, headers, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
}

for (const status of [403, 429, 502]) test(`unknown Star after ${status} retries GET without changing the remote favorite`, async ({ page }) => {
  const methods = [];
  let failed = true;
  await mockAuth(page, (req) => {
    methods.push(req.method());
    return failed ? { status, body: { error: 'github_api_error' } } : { body: { starred: false } };
  });
  await page.addInitScript(() => localStorage.setItem('star-rank-user-library-v1', JSON.stringify({ favorites: [{ id: 10001, name: 'local favorite' }], compare: [], recent: [] })));
  await page.goto('repo/10001/');
  const favorite = page.locator('[data-library-action="favorite"]');
  await expect(favorite).toHaveText('状态未知 · 点击重查');
  await expect(favorite).not.toHaveAttribute('aria-pressed');
  failed = false;
  await favorite.click();
  await expect(favorite).toHaveText('加星到 GitHub');
  expect(methods.every((method) => method === 'GET')).toBe(true);
});

test('batch sync refreshes this repository button before its next toggle', async ({ page }) => {
  const writes = [];
  let starred = false;
  await mockAuth(page, (req) => {
    if (req.url().endsWith('/api/stars/sync')) {
      starred = true;
      return { body: { results: req.postDataJSON().repositories.map((full_name) => ({ full_name, starred: true })) } };
    }
    if (req.method() !== 'GET') { writes.push(req.method()); starred = req.method() === 'PUT'; }
    return { body: { starred } };
  });
  await page.goto('repo/10001/');
  const favorite = page.locator('[data-library-action="favorite"]');
  await expect(favorite).toHaveText('加星到 GitHub');
  await page.evaluate(() => {
    const project = window.starRankLibrary.read().recent[0];
    return window.starRankAuth.syncFavorites([project.fullName]);
  });
  await expect(favorite).toHaveText('GitHub 已加星');
  await favorite.click();
  await expect(favorite).toHaveText('加星到 GitHub');
  expect(writes).toEqual(['DELETE']);
});

for (const confirm of [true, false]) test(`returned favorite intent is ${confirm ? 'confirmed once' : 'cancelled without a write'}`, async ({ page }) => {
  const methods = [];
  await mockAuth(page, (req) => { methods.push(req.method()); return { body: { starred: req.method() === 'PUT' } }; });
  await page.addInitScript(() => sessionStorage.setItem('star-rank-favorite-intent-v1', JSON.stringify({ fullName: 'fixture-labs/repo-001', token: 'browser-fixture', expiresAt: Date.now() + 600_000 })));
  page.on('dialog', (dialog) => confirm ? dialog.accept() : dialog.dismiss());
  await page.goto('repo/10001/');
  await expect(page.locator('[data-library-action="favorite"]')).toHaveText(confirm ? 'GitHub 已加星' : '加星到 GitHub');
  expect(methods).toEqual([confirm ? 'PUT' : 'GET']);
  expect(await page.evaluate(() => sessionStorage.getItem('star-rank-favorite-intent-v1'))).toBeNull();
});
