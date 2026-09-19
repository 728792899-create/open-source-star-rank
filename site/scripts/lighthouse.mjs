import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from '@playwright/test';

const { ci } = JSON.parse(await readFile(new URL('../lighthouserc.json', import.meta.url), 'utf8'));
const output = new URL(`../${ci.upload.outputDir}/`, import.meta.url);
await mkdir(output, { recursive: true });
const firstUrl = new URL(ci.collect.url[0]);
const server = spawn(process.execPath, ['scripts/serve-static.mjs'], {
  env: { ...process.env, PORT: firstUrl.port, BASE_PATH: firstUrl.pathname.replace(/\/$/u, '') },
  stdio: 'inherit',
});
let chrome;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error('Lighthouse server failed to start');
    ready = await fetch(firstUrl).then((response) => response.ok).catch(() => false);
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw new Error('Lighthouse server timed out');
  const requested = process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const bundled = chromium.executablePath();
  const chromePath = requested || await access(bundled).then(() => bundled).catch(() => undefined);
  chrome = await chromeLauncher.launch({ chromePath, chromeFlags: ['--no-sandbox', '--headless'] });
  const failures = [];
  for (let index = 0; index < ci.collect.url.length; index += 1) {
    for (let run = 0; run < ci.collect.numberOfRuns; run += 1) {
      const result = await lighthouse(ci.collect.url[index], {
        port: chrome.port, output: ['html', 'json'], logLevel: 'error',
        onlyCategories: ['performance', 'accessibility', 'seo'],
      }, ci.collect.settings.preset === 'desktop' ? desktopConfig : undefined);
      if (!result || result.lhr.runtimeError) throw new Error(result?.lhr.runtimeError?.message || 'No Lighthouse result');
      await writeFile(new URL(`report-${index}-${run}.html`, output), result.report[0]);
      await writeFile(new URL(`report-${index}-${run}.json`, output), result.report[1]);
      for (const [assertion, [, { minScore }]] of Object.entries(ci.assert.assertions)) {
        const name = assertion.replace('categories:', '');
        const score = result.lhr.categories[name]?.score;
        console.log(`${ci.collect.url[index]} ${name}: ${score} (required ${minScore})`);
        if (score === null || score === undefined || score < minScore) failures.push(`${name}: ${score} < ${minScore}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
} finally {
  chrome?.kill();
  server.kill('SIGTERM');
}
