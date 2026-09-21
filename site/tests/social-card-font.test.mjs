import test from 'node:test';
import assert from 'node:assert/strict';
import { requireCjkFont, validateCjkFont } from '../scripts/social-card-font.mjs';

test('social card build refuses Latin-only hosts instead of silently drawing tofu', () => {
  const installed = new Set(['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Helvetica.ttc']);
  assert.throws(() => requireCjkFont((file) => installed.has(file)), /fonts-noto-cjk/);
});

test('actual renderer resolves distinct Chinese glyphs without system fonts', () => {
  assert.doesNotThrow(() => validateCjkFont(requireCjkFont()));
  assert.throws(() => validateCjkFont({ file: '/missing/social-font.ttf', family: 'Missing' }), /Chinese glyphs/);
});

test('social cards select a concrete CJK family on Linux and macOS', () => {
  for (const [file, family] of [
    ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'Noto Sans CJK SC'],
    ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf', 'Arial Unicode MS'],
  ]) assert.deepEqual(requireCjkFont((candidate) => candidate === file), { file, family });
});
