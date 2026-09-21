import { test, expect } from '@playwright/test';

test('desktop sidebar remembers its state across routes without mobile state leaking', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('daily/');
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await expect(page.locator('.workspace-sidebar')).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开侧栏' })).toHaveAttribute('aria-expanded', 'false');
  await page.goto('repo/10001/');
  await expect(page.locator('.workspace-sidebar')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '展开导航' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '展开导航' })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.workspace-sidebar')).toBeHidden();
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(page.locator('.workspace-sidebar')).toBeVisible();
  await expect(page.getByRole('button', { name: '收起侧栏' })).toHaveAttribute('aria-expanded', 'true');
  await page.goBack({ waitUntil: 'commit' });
  await expect(page.locator('.workspace-sidebar')).toBeVisible();
});

test('ticker advances slowly, pauses, and keeps freshness visible on every slide', async ({ page }) => {
  await page.clock.install();
  await page.goto('daily/');
  const ticker = page.locator('[data-ranking-ticker]');
  await page.mouse.move(0, 800);
  await expect(ticker).toHaveAttribute('data-ticker-index', '0');
  await page.clock.fastForward(8100);
  await expect(ticker).toHaveAttribute('data-ticker-index', '1');
  await expect(page.locator('[data-freshness]')).toBeVisible();
  await page.getByRole('button', { name: '暂停信息轮播' }).click();
  await page.getByRole('heading', { level: 1 }).click();
  await page.clock.fastForward(17000);
  await expect(ticker).toHaveAttribute('data-ticker-index', '1');
  await page.getByRole('button', { name: '下一条信息' }).click();
  await expect(ticker).toHaveAttribute('data-ticker-index', '2');
  await expect(page.locator('[data-freshness]')).toBeVisible();
  await page.getByRole('button', { name: '上一条信息' }).click();
  await expect(ticker).toHaveAttribute('data-ticker-index', '1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-ticker-controls]')).toBeHidden();
  await expect(page.locator('[data-ticker-item][aria-hidden="false"]')).toHaveCount(3);
  await expect(page.locator('[data-update-countdown]')).toBeVisible();
});

for (const width of [320, 390, 1024, 1440]) {
  test(`compact ranking header fits ${width}px with one set of period links`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('daily/');
    await expect(page.getByRole('navigation', { name: '查看不同时间范围' }).getByRole('link')).toHaveCount(4);
    for (let index = 0; index < 3; index++) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.getByRole('button', { name: '下一条信息' }).click();
    }
    if (width === 1440) {
      const table = await page.locator('.ranking-table').boundingBox();
      expect(table.y).toBeLessThan(500);
      await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveCount(3);
    }
  });
}

test('ticker and range navigation remain readable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4322/open-source-star-rank/daily/');
    await expect(page.locator('[data-ticker-controls]')).toBeHidden();
    await expect(page.locator('[data-ticker-item]')).toHaveCount(3);
    for (const item of await page.locator('[data-ticker-item]').all()) await expect(item).toBeVisible();
    await page.getByRole('navigation', { name: '查看不同时间范围' }).getByRole('link', { name: '累计 Star' }).click();
    await expect(page.getByRole('navigation', { name: '查看不同时间范围' }).getByRole('link', { name: '昨日', exact: true })).toBeVisible();
  } finally { await context.close(); }
});
