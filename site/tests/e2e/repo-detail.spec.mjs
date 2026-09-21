import { test, expect } from '@playwright/test';

for (const width of [320, 390, 1440]) {
  test(`compact detail remains readable and actionable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('repo/10017/');
    for (const language of ['original', 'zh']) {
      await page.getByRole('button', { name: language === 'original' ? '原文' : '中文', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      for (const action of await page.locator('.repo-actions button, .repo-actions a').all()) {
        const box = await action.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.height).toBeGreaterThanOrEqual(width < 760 ? 44 : 40);
      }
    }
    if (width === 1440) {
      const summary = await page.locator('.repo-summary-grid').boundingBox();
      expect(summary.y + summary.height).toBeLessThan(900);
    }
    await page.locator('[data-library-action="compare"]').click();
    await expect(page.locator('[data-library-action="compare"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.repo-history-details')).not.toHaveAttribute('open');
    await page.locator('.repo-history-details summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('table', { name: '近 30 日 Star 与排名记录' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(31);
  });
}

test('untranslated detail and full history remain usable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4322/open-source-star-rank/repo/12000/');
    await expect(page.getByText('中文待生成', { exact: true })).toBeVisible();
    await expect(page.getByText('分类待生成；这不影响项目排名和原始 GitHub 数据。')).toBeVisible();
    await expect(page.getByRole('link', { name: '阅读 README ↗' })).toBeVisible();
    await page.locator('.repo-history-details summary').click();
    await expect(page.getByRole('row')).toHaveCount(31);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally {
    await context.close();
  }
});
