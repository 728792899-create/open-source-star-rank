import { test, expect } from '@playwright/test';

const periods = page => page.getByRole('navigation', { name: '查看不同时间范围' });

test('period switches keep the document, workspace preferences, and filters', async ({ page }) => {
  await page.goto('daily/');
  await page.evaluate(() => { window.__rankingDocument = 'same-document'; });
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await page.getByRole('button', { name: '紧凑模式', exact: true }).click();
  await page.getByRole('button', { name: '原文', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索项目' }).fill('unlikely-project-xyz');
  for (const [name, path] of [[/7 日/, '/period/7d/'], [/30 日/, '/period/30d/'], ['累计 Star', '/all-time/'], ['昨日', '/daily/']]) {
    await periods(page).getByRole('link', { name, exact: typeof name === 'string' }).click();
    await expect(page).toHaveURL(new RegExp(`${path}\\?q=unlikely-project-xyz$`));
    await expect(periods(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(periods(page).getByRole('link')).toHaveCount(4);
    expect(await page.evaluate(() => window.__rankingDocument)).toBe('same-document');
    await expect(page.locator('html')).toHaveAttribute('data-project-language', 'original');
    await expect(page.locator('.workspace-sidebar')).toBeHidden();
    if (await page.locator('[data-search]').count()) await expect(page.locator('[data-search]')).toHaveValue('unlikely-project-xyz');
  }
  await page.goBack({ waitUntil: 'commit' });
  await expect(page.locator('[data-alltime]')).toBeVisible();
  expect(await page.evaluate(() => window.__rankingDocument)).toBe('same-document');
  await page.goForward({ waitUntil: 'commit' });
  await expect(page.locator('[data-ranking-mode="daily"]')).toBeVisible();
});

test('latest period request wins during rapid switching', async ({ page }) => {
  await page.goto('daily/');
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route('**/period/7d/', async route => { await hold; try { await route.continue(); } catch {} });
  await periods(page).getByRole('link', { name: /7 日/ }).click();
  await periods(page).getByRole('link', { name: '累计 Star', exact: true }).click();
  await expect(page.locator('[data-alltime]')).toBeVisible();
  release();
  await expect(page).toHaveURL(/all-time\/$/);
  await expect(page.locator('[data-alltime] .workspace-project-avatar').first()).toBeVisible();
  await expect(page.locator('[data-ranking-row]:visible').first().getByRole('link', { name: '查看项目 →' })).toBeVisible();
  await expect(page.locator('[data-ranking-row]:visible').first().getByRole('button', { name: /分享/ })).toBeVisible();
});

test('all-time pagination keeps every item accessible and row actions consistent', async ({ page }) => {
  await page.goto('all-time/');
  const total = await page.locator('[data-ranking-row]').count();
  expect(total).toBeGreaterThan(100);
  await expect(page.locator('[data-ranking-row]:visible')).toHaveCount(100);
  await page.getByRole('navigation', { name: '榜单分页', exact: true }).getByRole('button', { name: '2', exact: true }).click();
  await expect(page.locator('[data-ranking-row]:visible').first().locator('.rank-number')).toHaveText('101');
  await expect(page).toHaveURL(/result_page=2/);
  await page.reload();
  await expect(page.locator('[data-ranking-row]:visible').first().locator('.rank-number')).toHaveText('101');
  expect(await page.locator('[data-ranking-row]:visible').first().locator('.stars-cell').textContent()).not.toContain('+');
});

for (const width of [390, 1440]) {
  test(`four ranking views retain navigation and fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('daily/');
    for (const name of [/30 日/, '累计 Star', /7 日/, '昨日']) {
      await periods(page).getByRole('link', { name, exact: typeof name === 'string' }).click();
      await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
      await expect(periods(page).getByRole('link')).toHaveCount(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect((await page.getByRole('heading', { level: 1 }).boundingBox()).height).toBeLessThan(70);
    }
  });
}

test('ranking links and cumulative projects remain usable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4322/open-source-star-rank/period/30d/');
  await expect(periods(page).getByRole('link')).toHaveCount(4);
  await periods(page).getByRole('link', { name: '累计 Star', exact: true }).click();
  await expect(page.getByRole('heading', { name: '累计 Star 排行' })).toBeVisible();
  expect(await page.locator('[data-ranking-row]:visible').count()).toBeGreaterThan(100);
  await expect(page.locator('[data-ranking-row]').first().getByRole('link', { name: '查看项目 →' })).toBeVisible();
  await context.close();
});

test('back navigation isolates delayed filters from the destination URL', async ({ page }) => {
  await page.goto('daily/?q=earlier');
  await periods(page).getByRole('link', { name: /7 日/ }).click();
  await expect(page.locator('[data-ranking-mode="period"]')).toBeVisible();
  const pool = await page.locator('[data-ranking]').getAttribute('data-exploration-path');
  expect(pool).toBeTruthy();
  // Existing metadata may be cached, so reload this route once before capturing its first filter request.
  await page.getByRole('searchbox', { name: '搜索项目' }).fill('');
  await page.reload();
  let releaseData, releaseHtml, signalData, signalHtml;
  const dataGate = new Promise(resolve => { releaseData = resolve; });
  const htmlGate = new Promise(resolve => { releaseHtml = resolve; });
  const dataStarted = new Promise(resolve => { signalData = resolve; });
  const htmlStarted = new Promise(resolve => { signalHtml = resolve; });
  await page.route(url => url.pathname === pool, async route => {
    signalData(); await dataGate;
    try { await route.continue(); } catch {}
  });
  await page.getByRole('searchbox', { name: '搜索项目' }).fill('later');
  await dataStarted;
  await page.route(url => url.pathname.endsWith('/daily/') && url.searchParams.get('q') === 'earlier', async route => {
    signalHtml(); await htmlGate;
    try { await route.continue(); } catch {}
  });
  await page.goBack({ waitUntil: 'commit' });
  await htmlStarted;
  releaseData();
  await expect(page).toHaveURL(/daily\/\?q=earlier$/);
  releaseHtml();
  await expect(page.locator('[data-ranking-mode="daily"]')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索项目' })).toHaveValue('earlier');
});

test('clicking the current period cancels a pending different destination', async ({ page }) => {
  await page.goto('daily/');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/period/7d/', async route => { await gate; try { await route.continue(); } catch {} });
  await periods(page).getByRole('link', { name: /7 日/ }).click();
  await periods(page).getByRole('link', { name: '昨日', exact: true }).click();
  await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page).toHaveURL(/daily\/$/);
  await expect(periods(page).getByRole('link', { name: '昨日', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('switching from a category archive refreshes the persistent sidebar selection', async ({ page }) => {
  await page.goto('board/scenario/ai-coding/');
  const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
  await expect(navigation.getByRole('link', { name: '分类目录' })).toHaveAttribute('aria-current', 'page');
  await periods(page).getByRole('link', { name: '昨日', exact: true }).click();
  await expect(page.locator('[data-ranking-mode="daily"]')).toBeVisible();
  await expect(navigation.getByRole('link', { name: '项目榜单' })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('link', { name: '分类目录' })).not.toHaveAttribute('aria-current');
});

test('failed partial requests fall back to a usable normal ranking page', async ({ page }) => {
  await page.goto('daily/');
  await page.evaluate(() => { window.__rankingDocument = 'before-fallback'; });
  await page.route('**/all-time/', async route => {
    if (route.request().resourceType() === 'fetch') await route.abort('failed');
    else await route.continue();
  });
  await periods(page).getByRole('link', { name: '累计 Star', exact: true }).click();
  await expect(page.getByRole('heading', { name: '累计 Star 排行' })).toBeVisible();
  await expect(periods(page).getByRole('link')).toHaveCount(4);
  expect(await page.evaluate(() => window.__rankingDocument)).toBeUndefined();
});
