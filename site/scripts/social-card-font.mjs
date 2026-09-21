import { existsSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

// These fonts include Chinese glyphs. A Latin-only fallback silently produces
// tofu boxes, so missing build dependencies must fail before publishing cards.
export const cjkFonts = [
  { file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK SC' },
  { file: '/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf', family: 'Noto Sans CJK SC' },
  { file: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', family: 'Arial Unicode MS' },
  { file: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
];

export function requireCjkFont(exists = existsSync) {
  const font = cjkFonts.find(({ file }) => exists(file));
  if (!font) throw new Error('Chinese social cards require a CJK font. On Ubuntu install fonts-noto-cjk before building.');
  return font;
}

export function fontOptions(font) {
  return { fontFiles: [font.file], loadSystemFonts: false, defaultFontFamily: font.family, sansSerifFamily: font.family, monospaceFamily: font.family };
}

export function validateCjkFont(font) {
  const shapes = new Set();
  for (const char of '开源星榜净增仓库，。') {
    const svg = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text x="4" y="50" font-family="sans-serif" font-size="40">${char}</text></svg>`, { font: fontOptions(font) }).toString();
    // The renderer resolves text to paths. Missing glyphs are blank or reuse
    // the same .notdef outline, so neither may pass the publication preflight.
    if (!svg.includes('<path ') || shapes.has(svg)) throw new Error('Social card font has missing Chinese glyphs; install fonts-noto-cjk.');
    shapes.add(svg);
  }
}
