// SVG masters contain outlines, so exports do not depend on installed fonts.
import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const assets = new URL('../public/assets/brand/', import.meta.url);
for (const [source, output, width] of [
  ['kingai-logo.svg', 'favicon-32.png', 32],
  ['kingai-logo.svg', 'apple-touch-icon.png', 180],
  ['kingai-logo.svg', 'kingai-logo.png', 640],
  ['kingai-social.svg', '../../og.png', 1200],
]) {
  const svg = await readFile(new URL(source, assets));
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render();
  await writeFile(new URL(output, assets), image.asPng());
}
console.log('Rendered King AI favicon, touch icon, transparent logo and social card.');
