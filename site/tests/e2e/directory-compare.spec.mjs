import { test, expect } from '@playwright/test';

test('current directory covers every candidate exactly once across static pages', async ({ page }) => {
  const catalog = await (await page.request.get('data/repositories.json')).json();
  await page.goto('board/');
  await expect(page.locator('[data-directory-scope]')).toContainText(catalog.repositories.length.toLocaleString('zh-CN'));
  await page.getByRole('link', { name: '浏览全部当前项目 →' }).click();
  const seen = [];
  do {
    seen.push(...await page.locator('[data-directory-project] h2 a').evaluateAll((links) => links.map((link) => Number(link.pathname.match(/repo\/(\d+)/)[1]))));
    const next = page.getByRole('link', { name: '下一页 →', exact: true });
    if (!await next.count()) break;
    await next.click();
  } while (true);
  expect(seen.length).toBe(catalog.repositories.length);
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort((a, b) => a - b)).toEqual(catalog.repositories.map((entry) => entry.repository_id).sort((a, b) => a - b));
});

test('current category directory works without JavaScript and at mobile width', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4322/open-source-star-rank/board/');
  await page.locator('.language-cards a').first().click();
  expect(await page.locator('[data-directory-project]').count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator('.workspace-menu img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: '/tmp/starrank-current-directory-mobile.png', fullPage: false });
  await context.close();
});

async function oldComparison(page) {
  const catalog = await (await page.request.get('data/repositories.json')).json();
  const repository = catalog.repositories.find((entry) => entry.stars_total > 1);
  await page.addInitScript((entry) => localStorage.setItem('star-rank-user-library-v1', JSON.stringify({ favorites: [], recent: [], compare: [
    { id: entry.repository_id, name: 'Old project', fullName: entry.full_name, stars: 1, url: '/untrusted-old-url' },
  ] })), repository);
  return repository.repository_id;
}

test('comparison refresh replaces old metadata and gives an explicit fallback on failure', async ({ page }) => {
  const id = await oldComparison(page);
  let failing = true;
  await page.route(`**/repo/${id}/`, (route) => failing ? route.fulfill({ status: 503, body: 'offline' }) : route.continue());
  await page.goto('compare/');
  await expect(page.locator('[data-comparison-status]')).toContainText('1 个项目更新失败');
  await expect(page.locator('.compare-card')).toContainText('本机保存 Star');
  await expect(page.locator('.compare-card')).toContainText('旧记录未保存日期');
  failing = false;
  await page.getByRole('button', { name: '刷新项目数据' }).click();
  await expect(page.locator('[data-comparison-status]')).toContainText('已核对站点最新快照');
  await expect(page.locator('.compare-card')).toContainText('站点快照 Star');
  await expect(page.locator('.compare-card')).not.toContainText('旧记录未保存日期');
  await expect(page.locator('.compare-card h2 a')).not.toHaveText('Old project');
  expect(await page.evaluate(() => window.starRankLibrary.read().compare[0].stars)).toBeGreaterThan(1);
  await expect.poll(() => page.locator('.kingai-logo').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: '/tmp/starrank-current-comparison.png', fullPage: true });
});

test('a delayed comparison refresh does not restore a removed project', async ({ page }) => {
  const id = await oldComparison(page);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  await page.route(`**/repo/${id}/`, async (route) => { await wait; await route.continue(); });
  await page.goto('compare/');
  await page.getByRole('button', { name: '移出对比' }).click();
  release();
  await expect(page.locator('[data-comparison-status]')).not.toContainText('正在核对');
  await expect(page.locator('.compare-card')).toHaveCount(0);
  expect(await page.evaluate(() => window.starRankLibrary.read().compare)).toEqual([]);
});
