import { defineConfig, devices } from '@playwright/test';

const basePath = '/open-source-star-rank';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:4322${basePath}/`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/create-e2e-data.mjs && STAR_RANK_DATA_DIR=$PWD/.e2e-data SITE_URL=http://127.0.0.1:4322 BASE_PATH=${basePath} npm run build && PORT=4322 BASE_PATH=${basePath} node scripts/serve-static.mjs`,
    url: `http://127.0.0.1:4322${basePath}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
