import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const masterPath = resolve(packageRoot, 'brand/source/moonwitness-master.svg');
const fontPath = resolve(packageRoot, 'source/fonts/RoadRage-Regular.ttf');
const master = await readFile(masterPath, 'utf8');
const fontBytes = await readFile(fontPath);
const exactArrayBuffer = fontBytes.buffer.slice(
  fontBytes.byteOffset,
  fontBytes.byteOffset + fontBytes.byteLength
);
const font = opentype.parse(exactArrayBuffer);
// Build each outlined glyph separately. opentype.js may emit malformed SVG
// coordinates for this font when it serializes the entire string at once;
// individual glyph paths stay valid and preserve the exact spelling.
const wordmark = 'MOONWITNESS';
const glyphs = font.stringToGlyphs(wordmark);
let x = 0;
const glyphPaths = glyphs
  .map((glyph, index) => {
    const path = glyph.getPath(0, 70, 108);
    const pathData = path.toPathData(2);
    if (/NaN|Infinity/u.test(pathData)) {
      throw new Error(`Road Rage produced invalid vector data for glyph ${wordmark[index]}.`);
    }
    const element = `<path transform="translate(${x.toFixed(2)} 0)" d="${pathData}"/>`;
    x += (glyph.advanceWidth * 108) / font.unitsPerEm;
    if (index < glyphs.length - 1) {
      x += (font.getKerningValue(glyph, glyphs[index + 1]) * 108) / font.unitsPerEm;
    }
    return element;
  })
  .join('');
if (glyphs.length !== wordmark.length || x < 400 || x > 440) {
  throw new Error(
    `Unexpected MOONWITNESS outline metrics: ${glyphs.length} glyphs, ${x.toFixed(2)}px.`
  );
}
const wordmarkGroup = `<g id="mw-brand-source-moonwitness-master-svg-wordmark" fill="currentColor" transform="translate(76 0) skewX(-5)">${glyphPaths}</g>`;
const result = master.replace(
  /<g id="mw-brand-source-moonwitness-master-svg-wordmark"[\s\S]*?<\/g>/u,
  wordmarkGroup
);
if (!/id="mw-brand-source-moonwitness-master-svg-wordmark"/u.test(master)) {
  throw new Error('Canonical master is missing its wordmark group.');
}
if (result !== master) await writeFile(masterPath, result);
process.stdout.write(`Generated vector wordmark outlines from Road Rage in ${masterPath}.\n`);
