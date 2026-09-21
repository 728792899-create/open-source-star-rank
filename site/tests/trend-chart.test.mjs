import test from 'node:test';
import assert from 'node:assert/strict';
import { trendGeometry } from '../src/scripts/trend-chart.mjs';
test('signed trends preserve direction, zero baseline and missing samples', () => {
  const mixed=trendGeometry([-10, null, 0, 10]);
  assert.ok(mixed.points[0][1] > mixed.baseline);
  assert.equal(mixed.points[1], null);
  assert.equal(mixed.points[2][1], mixed.baseline);
  assert.ok(mixed.points[3][1] < mixed.baseline);
  assert.equal(trendGeometry([null,null]).points.every(p=>p===null),true);
  assert.equal(trendGeometry([0,0]).points[0][1],trendGeometry([0,0]).baseline);
  assert.equal(trendGeometry([-1,-2]).negative,true);
  assert.equal(trendGeometry([1,2]).negative,false);
  assert.deepEqual(trendGeometry([NaN,Infinity]).points,[null,null]);
});
