import { writeFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';

const escapeXml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function cardSvg(ranking, label, eventMode = false) {
  const rows = ranking.entries.slice(0, 5).map((entry, index) => {
    const y = 270 + index * 54;
    const name = entry.full_name.length > 42 ? `${entry.full_name.slice(0, 40)}…` : entry.full_name;
    const growth = eventMode ? entry.stars_added : entry.stars_gained;
    const gained = `${growth >= 0 ? '+' : ''}${growth.toLocaleString('en-US')}`;
    return `<text x="94" y="${y}" font-size="28" font-weight="750" fill="#171814">${String(entry.rank).padStart(2, '0')}  ${escapeXml(name)}</text><text x="1100" y="${y}" text-anchor="end" font-size="27" font-weight="800" fill="#1c7650">${gained}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#f3efe4"/><path d="M0 70H1200M0 560H1200" stroke="#cbc4b4"/>
    <circle cx="88" cy="83" r="27" fill="#171814"/><path d="M88 65l5 12 13 1-10 9 3 13-11-7-11 7 3-13-10-9 13-1z" fill="#f2dcae"/>
    <text x="132" y="94" font-family="sans-serif" font-size="29" font-weight="800" fill="#171814">OPEN SOURCE STAR RANK</text>
    <text x="1110" y="92" text-anchor="end" font-family="monospace" font-size="20" font-weight="700" fill="#c98b18">${escapeXml(label.toUpperCase())}</text>
    <text x="88" y="178" font-family="sans-serif" font-size="56" font-weight="850" letter-spacing="-2" fill="#171814">${escapeXml(ranking.date)} · ${eventMode ? 'NEW STARS' : 'NET STAR GROWTH'}</text>
    <text x="90" y="222" font-family="sans-serif" font-size="20" fill="#68685e">${eventMode ? 'GH ARCHIVE PUBLIC WATCH EVENTS' : 'CANDIDATE POOL SIGNAL'} · ${ranking.eligible_count.toLocaleString('en-US')} ${eventMode ? 'ELIGIBLE' : 'COMPARABLE'} REPOSITORIES · UTC+8</text>
    <g font-family="Arial,sans-serif">${rows}</g>
    <text x="90" y="595" font-family="sans-serif" font-size="18" fill="#68685e">${eventMode ? 'PUBLIC EVENT SIGNAL · UNIQUE ACTORS · NOT GITHUB OFFICIAL GLOBAL STATISTICS' : 'GITHUB PUBLIC API · VALID MIDNIGHT SNAPSHOTS · NO ZERO-FILL · NO INTERPOLATION'}</text>
  </svg>`;
}

parentPort.on('message', async ({ ranking, label, output, fontFile, eventMode = false }) => {
  try {
    const rendered = new Resvg(cardSvg(ranking, label, eventMode), {
      fitTo: { mode: 'width', value: 1200 },
      font: fontFile ? { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: 'sans-serif' } : undefined,
    }).render();
    await writeFile(output, rendered.asPng());
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
