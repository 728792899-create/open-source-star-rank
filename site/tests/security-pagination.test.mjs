import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeJsonForHtml } from '../src/lib/serialize-json.mjs';
import { clampResultPage } from '../src/scripts/filter-utils.mjs';

test('JSON-LD cannot close its script element and preserves the original data', () => {
  const data = { description: '</script><script>globalThis.auditProof=1</script>&\u2028\u2029' };
  const serialized = serializeJsonForHtml(data);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/u);
  assert.deepEqual(JSON.parse(serialized), data);
});

test('pagination clamps before slicing and handles invalid query parameters', () => {
  const entries = Array.from({ length: 125 }, (_, index) => index);
  for (const [value, expected] of [['999', 2], ['Infinity', 1], ['NaN', 1], ['-1', 1], ['1.8', 1]]) {
    const page = clampResultPage(value, entries.length, 100);
    assert.equal(page, expected);
    assert.ok(entries.slice((page - 1) * 100, page * 100).length > 0);
  }
  assert.equal(clampResultPage(999, 0, 100), 1);
});
