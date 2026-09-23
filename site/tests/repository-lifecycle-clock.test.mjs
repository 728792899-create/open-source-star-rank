import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../src/lib/repository-lifecycle.ts', import.meta.url).href;
const beforeMidnight = '2026-09-23T15:59:59Z';
const afterMidnight = '2026-09-23T16:00:01Z';
const epoch = String(Date.parse(beforeMidnight) / 1000);

function probe(sourceEpoch, wallClock = beforeMidnight) {
  const env = { ...process.env };
  if (sourceEpoch === undefined) delete env.SOURCE_DATE_EPOCH;
  else env.SOURCE_DATE_EPOCH = sourceEpoch;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    const NativeDate = Date;
    let wall = ${JSON.stringify(wallClock)};
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [wall])); }
      static now() { return NativeDate.parse(wall); }
    };
    const { repositoryAgeDays, repositoryAgeLabel } = await import(${JSON.stringify(moduleUrl)});
    const created = '2026-09-22T00:00:00+08:00';
    const first = repositoryAgeLabel(created);
    wall = ${JSON.stringify(afterMidnight)};
    console.log(JSON.stringify({
      first, second: repositoryAgeLabel(created),
      explicit: repositoryAgeDays(created, new Date(wall)),
      epochAge: repositoryAgeDays('1970-01-01T00:00:00Z'),
      missing: repositoryAgeLabel(null),
    }));
  `], { env, encoding: 'utf8' });
}

function result(run) {
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('fixed build epoch keeps HTML age stable across Beijing midnight', () => {
  const before = result(probe(epoch, beforeMidnight));
  const after = result(probe(epoch, afterMidnight));
  assert.deepEqual(before, after);
  assert.equal(before.first, '已发布 1 天');
  assert.equal(before.second, '已发布 1 天');
  assert.equal(before.explicit, 2);
  assert.equal(before.missing, '发布天数待补充');
});

test('an ordinary static build shares one clock across a midnight rollover', () => {
  const value = result(probe(undefined));
  assert.equal(value.first, '已发布 1 天');
  assert.equal(value.second, '已发布 1 天');
  assert.equal(value.explicit, 2);
});

test('epoch zero is valid rather than treated as the current time', () => {
  assert.equal(result(probe('0')).epochAge, 0);
});

test('invalid build epochs fail instead of silently using a different clock', () => {
  for (const value of ['', '-1', '1.5', 'invalid', 'Infinity', '9007199254740992', '8640000000001']) {
    const run = probe(value);
    assert.notEqual(run.status, 0, value);
    assert.match(run.stderr, /SOURCE_DATE_EPOCH must be/u);
  }
});
