import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const latestPath = 'daily/2026-07-14/';
const latestEventPath = 'events/daily/2026-07-14/';

test('keeps the latest full-site public event ranking as the homepage default', async ({ page }) => {
  await page.goto('');
  await expect(page.getByRole('heading', { name: '全站公开事件新增 Star 排行' })).toBeVisible();
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.locator('main h2')).toHaveCount(0);
  await expect(page.locator('.freshness-status.compact')).toContainText('数据正常');
  await expect(page.locator('[data-ranking-mode="event"] [data-ranking-row]')).toHaveCount(100);
  await expect(page.getByRole('link', { name: /查看候选池净增榜/ })).toBeVisible();
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /social\/events-daily-2026-07-14\.png$/);
});

test('keeps a stale full-site event ranking visible instead of changing ranking scope', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-07-18T00:00:00Z'));
  await page.goto('');
  await page.waitForTimeout(2_100);
  await expect(page.locator('[data-ranking-mode="event"] [data-ranking-row]')).toHaveCount(100);
  await expect(page.locator('.freshness-status.stale')).toContainText('当前仍展示最后一次成功发布');
  await expect(page.getByRole('link', { name: /查看候选池净增榜/ })).toBeVisible();
});

test('publishes the public event archive with internal project links and source metrics', async ({ page }) => {
  await page.goto(latestEventPath);
  await expect(page.getByRole('heading', { name: '全站公开事件新增 Star 排行' })).toBeVisible();
  await expect(page.locator('[data-ranking-row]')).toHaveCount(100);
  await page.getByText(/查看数据详情：GH Archive/).click();
  await expect(page.getByText('0.88 GiB')).toBeVisible();
  await expect(page.locator('.collection-details').getByText('24 / 24 小时')).toBeVisible();
  await expect(page.locator('.collection-details').getByText('120,000')).toBeVisible();
  await expect(page.getByRole('link', { name: /测试项目 30001/ })).toHaveAttribute('href', '/open-source-star-rank/repo/30001/');
  await expect(page.getByRole('link', { name: '在 GitHub 打开 public-event-labs/project-001' })).toHaveAttribute('href', 'https://github.com/public-event-labs/project-001');
  await expect(page.locator('.project-source-name').filter({ hasText: 'public-event-labs/project-001' })).toBeVisible();
});

test('renders 100 static rows and passes automated accessibility checks', async ({ page }) => {
  await page.goto(latestPath);
  await expect(page.getByRole('heading', { name: 'Star 净增排行' })).toBeVisible();
  await expect(page.locator('[data-ranking-row]')).toHaveCount(100);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('restores search and language filters from the URL and shows an empty state', async ({ page }) => {
  await page.goto(latestPath);
  const search = page.getByRole('searchbox', { name: '搜索项目' });
  await search.fill('repo-042');
  await expect(page).toHaveURL(/q=repo-042/);
  await expect(page.locator('[data-ranking-row]:visible')).toHaveCount(1);
  await page.reload();
  await expect(search).toHaveValue('repo-042');
  await search.fill('missing-project');
  await expect(page.locator('[data-empty-state]')).toBeVisible();
  await search.fill('');
  await page.getByLabel('编程语言').selectOption('Python');
  await expect(page).toHaveURL(/language=Python/);
  await expect(page.locator('[data-ranking-row]:visible')).toHaveCount(75);
});

test('combines direction, product type and scenario filters and re-ranks the deep pool', async ({ page }) => {
  await page.goto(latestPath);
  const firstRow = page.locator('[data-ranking-row]').first();
  const category = await firstRow.getAttribute('data-category') ?? '';
  const projectType = await firstRow.getAttribute('data-project-type') ?? '';
  const scenario = (await firstRow.getAttribute('data-scenarios') ?? '').split(',')[0];
  await page.getByLabel('项目方向').selectOption(category);
  await page.getByLabel('产品形态').selectOption(projectType);
  await page.getByLabel('适用场景').selectOption(scenario);
  await expect(page).toHaveURL(new RegExp(`category=${category}.*type=${projectType}.*scenario=${scenario}`));
  const visible = page.locator('[data-ranking-row]:visible');
  await expect(visible.first()).toHaveAttribute('data-category', category);
  await expect(visible.first()).toHaveAttribute('data-project-type', projectType);
  await expect(visible.first().locator('.rank-number')).toHaveText('01');
  await expect(visible.first().locator('.source-rank')).toContainText('总榜 #');
  await page.reload();
  await expect(page.getByLabel('项目方向')).toHaveValue(category);
  await expect(page.getByLabel('产品形态')).toHaveValue(projectType);
  await expect(page.getByLabel('适用场景')).toHaveValue(scenario);
  await expect(page.locator('[data-ranking-row]:visible').first().locator('.rank-number')).toHaveText('01');
});

test('navigates historical dates and keeps direct no-JavaScript content readable', async ({ page, browser }) => {
  await page.goto(latestPath);
  await page.getByLabel('选择历史榜单日期').selectOption('/open-source-star-rank/daily/2026-07-13/');
  await expect(page).toHaveURL(/daily\/2026-07-13\/$/);
  await expect(page.getByRole('link', { name: '查看同日全站公开事件新增榜 →' }))
    .toHaveAttribute('href', '/open-source-star-rank/events/daily/2026-07-13/');
  await page.goto('events/daily/2026-07-13/');
  await expect(page.getByRole('link', { name: '查看同日候选池净增榜 →' }))
    .toHaveAttribute('href', '/open-source-star-rank/daily/2026-07-13/');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const noScriptPage = await context.newPage();
  await noScriptPage.goto(latestPath);
  await expect(noScriptPage.locator('[data-ranking-row]')).toHaveCount(100);
  await expect(noScriptPage.getByRole('link', { name: /测试项目 10001/ })).toBeVisible();
  await expect(noScriptPage.locator('.project-source-name').filter({ hasText: 'fixture-labs/repo-001' })).toBeVisible();
  await context.close();
});

test('copies ranking and project links with stable repository anchors', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: undefined }));
  await page.goto(latestPath);
  await page.getByRole('button', { name: '复制榜单链接' }).click();
  await expect(page.locator('[data-action-status]')).toContainText('已复制');
  const rankingLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(rankingLink).toContain('/daily/2026-07-14/');
  await page.getByRole('button', { name: /分享 fixture-labs\/repo-001/ }).click();
  await expect(page.locator('[data-action-status]')).toContainText('已复制');
  const projectLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(projectLink).toContain('#repo-10001');
});

test('defaults project content to Chinese and persists the original-content switch', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => { window.__lastShareData = data; },
    });
  });
  await page.goto(latestPath);
  await expect(page.getByRole('link', { name: /测试项目 10001/ })).toBeVisible();
  await expect(page.locator('.project-source-name').filter({ hasText: 'fixture-labs/repo-001' })).toBeVisible();
  await page.getByRole('button', { name: /分享 fixture-labs\/repo-001/ }).click();
  await expect.poll(() => page.evaluate(() => window.__lastShareData?.title)).toContain('测试项目 10001');
  await page.getByRole('button', { name: '原文' }).click();
  await expect(page).toHaveURL(/display=original/);
  await expect(page.getByRole('link', { name: 'fixture-labs/repo-001', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /分享 fixture-labs\/repo-001/ }).click();
  await expect.poll(() => page.evaluate(() => window.__lastShareData?.title)).toContain('fixture-labs/repo-001');
  await page.reload();
  await expect(page.getByRole('button', { name: '原文' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '中文' }).click();
  await expect(page).not.toHaveURL(/display=/);
  const search = page.getByRole('searchbox', { name: '搜索项目' });
  await search.fill('中文功能名');
  await expect(page.locator('[data-ranking-row]:visible')).toHaveCount(100);
});

for (const { width, maximumFirstRowTop } of [
  { width: 390, maximumFirstRowTop: 900 },
  { width: 768, maximumFirstRowTop: 900 },
  { width: 1024, maximumFirstRowTop: 760 },
  { width: 1440, maximumFirstRowTop: 760 },
]) {
  test(`has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(latestPath);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const summaryHeight = await page.locator('.ranking-summary').evaluate((element) => element.getBoundingClientRect().height);
    const firstRowTop = await page.locator('[data-ranking-row]').first().evaluate((element) => element.getBoundingClientRect().top);
    expect(summaryHeight).toBeLessThanOrEqual(190);
    expect(firstRowTop).toBeLessThanOrEqual(maximumFirstRowTop);
    await page.goto('');
    const homepageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(homepageOverflow).toBeLessThanOrEqual(0);
    const homepageSummaryHeight = await page.locator('.ranking-summary').evaluate((element) => element.getBoundingClientRect().height);
    const homepageFirstRowTop = await page.locator('[data-ranking-row]').first().evaluate((element) => element.getBoundingClientRect().top);
    expect(homepageSummaryHeight).toBeLessThanOrEqual(190);
    expect(homepageFirstRowTop).toBeLessThanOrEqual(maximumFirstRowTop);
  });
  test(`category page has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('category/ai-machine-learning/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('collapses advanced filters on mobile and reopens them for restored URL state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(latestPath);
  const filters = page.locator('[data-advanced-filters]');
  await expect(filters).not.toHaveAttribute('open', '');
  const summary = page.getByText('更多筛选', { exact: false });
  await summary.focus();
  await expect(summary).toBeFocused();
  await summary.click();
  await expect(filters).toHaveAttribute('open', '');
  await page.getByLabel('编程语言').selectOption('Python');
  await expect(page).toHaveURL(/language=Python/);
  await expect(summary).toContainText('1 项已启用');
  await page.reload();
  await expect(filters).toHaveAttribute('open', '');
  await expect(page.getByLabel('编程语言')).toHaveValue('Python');
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('provides a useful 404 page and keyboard focus', async ({ page }) => {
  await page.goto('/not-a-real-page/');
  await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
  await page.goto(latestPath);
  const copyButton = page.getByRole('button', { name: '复制榜单链接' });
  await copyButton.focus();
  await expect(copyButton).toBeFocused();
});

test('publishes status, period, language and stable repository history routes', async ({ page }) => {
  await page.goto('status/');
  await expect(page.getByRole('heading', { name: '候选池采样质量' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '全站公开事件与费用保护' })).toBeVisible();
  await expect(page.getByText('零点窗口内，可用于排行')).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目分类覆盖' })).toBeVisible();

  await page.goto('period/7d/');
  await expect(page.getByRole('heading', { name: '7 日 Star 净增排行' })).toBeVisible();
  await expect(page.locator('[data-ranking-row]')).toHaveCount(100);

  await page.goto('language/');
  await page.getByRole('link', { name: /TypeScript/ }).click();
  await expect(page.getByRole('heading', { name: 'TypeScript Star 净增排行' })).toBeVisible();
  await expect(page.locator('[data-ranking-row]')).toHaveCount(50);

  await page.goto('repo/10001/');
  await expect(page.getByRole('heading', { name: /测试项目 10001/ })).toBeVisible();
  await expect(page.locator('.repo-source-name').filter({ hasText: 'fixture-labs/repo-001' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '真实历史' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '方向与适用场景' })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(31);

  await page.goto('repo/30001/');
  await expect(page.getByRole('heading', { name: /测试项目 30001/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '公开事件新增历史' })).toBeVisible();
});

test('publishes independent category boards with renumbered ranks and empty noindex policy', async ({ page, browser }) => {
  await page.goto('category/');
  await expect(page.getByRole('heading', { name: '项目方向' })).toBeVisible();
  await expect(page.locator('.category-cards > a')).toHaveCount(13);

  await page.goto('category/ai-machine-learning/');
  const rows = page.locator('[data-ranking-row]');
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row).toHaveAttribute('data-category', 'ai-machine-learning');
  const ranks = (await rows.locator('.rank-number').allTextContents()).map((rank) => Number(rank.trim()));
  expect(ranks).toEqual(ranks.map((_, index) => index + 1));
  const gains = (await rows.locator('.stars-cell').allTextContents())
    .map((text) => Number(text.split('+')[1]?.replaceAll(/[^0-9]/g, '') ?? '0'));
  expect(gains).toEqual([...gains].sort((left, right) => right - left));
  await expect(page.getByRole('link', { name: '返回全部榜单 →' })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/category\/ai-machine-learning\/$/);

  const noScriptContext = await browser.newContext({ javaScriptEnabled: false });
  const noScriptPage = await noScriptContext.newPage();
  await noScriptPage.goto('category/ai-machine-learning/');
  expect(await noScriptPage.locator('[data-ranking-row]').count()).toBeGreaterThan(0);
  await noScriptContext.close();

  await page.goto('category/other/');
  await expect(page.locator('[data-ranking-row]')).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow');
});

test('publishes the unified board hub with per-dimension independent boards', async ({ page }) => {
  await page.goto('board/');
  await expect(page.getByRole('heading', { name: /每个分类/ })).toBeVisible();
  for (const section of ['项目方向', '编程语言', '产品形态', '适用场景']) {
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: /← 返回全部榜单/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /全部历史星标 Top 1000/ })).toBeVisible();

  await page.locator('.language-cards a', { hasText: 'TypeScript' }).first().click();
  await expect(page).toHaveURL(/board\/language\/typescript-[0-9a-f]{8}\/$/);
  const rows = page.locator('[data-ranking-row]');
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row).toHaveAttribute('data-language', 'TypeScript');
  const ranks = (await rows.locator('.rank-number').allTextContents()).map((rank) => Number(rank.trim()));
  expect(ranks).toEqual(ranks.map((_, index) => index + 1));

  await page.goto('board/scenario/ai-coding/');
  const scenarioRows = page.locator('[data-ranking-row]');
  expect(await scenarioRows.count()).toBeGreaterThan(0);
  const scenarios = await Promise.all((await scenarioRows.all()).map((row) => row.getAttribute('data-scenarios')));
  for (const value of scenarios) expect((value ?? '').split(',')).toContain('ai-coding');
});

test('publishes the all-time top 1000 board with cumulative star ordering and filters', async ({ page }) => {
  await page.goto('all-time/');
  await expect(page.getByRole('heading', { name: '全部历史星标 Top 1000' })).toBeVisible();
  const rows = page.locator('[data-ranking-row]');
  await expect(rows).toHaveCount(200);
  const ranks = (await rows.locator('.rank-number').allTextContents()).map((rank) => Number(rank.trim()));
  expect(ranks).toEqual(ranks.map((_, index) => index + 1));
  await page.getByLabel('编程语言').selectOption('Python');
  await expect(page).toHaveURL(/language=Python/);
  await expect(page.locator('[data-ranking-row]:visible')).toHaveCount(50);
  await page.getByLabel('编程语言').selectOption('');
  const search = page.getByRole('searchbox', { name: '搜索项目' });
  await search.fill('project-001');
  await expect(page.locator('[data-ranking-row]:visible')).toHaveCount(1);
});

test('publishes canonical ranking pages and three feed formats', async ({ page, request }) => {
  await page.goto(latestPath);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/daily\/2026-07-14\/$/);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /social\/daily-2026-07-14\.png$/);
  for (const feed of ['rss.xml', 'atom.xml', 'feed.json']) {
    const response = await request.get(feed);
    expect(response.ok()).toBeTruthy();
    const body = await response.text();
    expect(body.length).toBeGreaterThan(100);
    expect(body).toContain('测试项目 10001');
  }
});
