import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('profile Star and date come from the same winning source', async () => {
  const original = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'starrank-profile-date-'));
  const data = path.join(root, 'generated/data');
  const entry = { repository_id: 1, full_name: 'owner/repo', stars_total: 10, html_url: 'https://github.com/owner/repo', last_seen_date: '2026-09-19' };
  try {
    await mkdir(path.join(data, 'daily'), { recursive: true });
    await mkdir(path.join(data, 'alltime'));
    await writeFile(path.join(data, 'repositories.json'), JSON.stringify({ repositories: [entry] }));
    await writeFile(path.join(data, 'daily/2026-09-20.json'), JSON.stringify({ date: '2026-09-20', entries: [{ ...entry, stars_total: 20 }] }));
    process.chdir(root);
    const { readRepositoryProfiles } = await import('../src/lib/data.ts?profile-date-test');
    assert.equal(readRepositoryProfiles()[0].metadata_date, '2026-09-20');
    assert.equal(readRepositoryProfiles()[0].stars_total, 20);
    await writeFile(path.join(data, 'alltime/top-1000.json'), JSON.stringify({ generated_at: '2026-09-21T10:00:00Z', entries: [{ ...entry, stars_total: 30 }] }));
    assert.equal(readRepositoryProfiles()[0].metadata_date, '2026-09-21');
    assert.equal(readRepositoryProfiles()[0].stars_total, 30);
  } finally { process.chdir(original); await rm(root, { recursive: true, force: true }); }
});
