import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { stdout } from 'node:process';
import { replaceGeneratedAssets } from './manifest-ownership.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, 'illustrations');
const manifestPath = resolve(root, 'manifest.json');
const entries = [
  [
    'empty',
    'Nothing here yet',
    '<rect x="38" y="43" width="60" height="70" rx="4"/><path d="M52 62h30M52 74h22M52 86h17"/><circle cx="108" cy="48" r="20"/><path d="M108 16v8m0 48v8M76 48h8m48 0h8M85 25l6 6m34 34 6 6m0-46-6 6m-34 34-6 6"/>',
  ],
  [
    'no-results',
    'No matching results',
    '<circle cx="82" cy="73" r="33"/><path d="m106 97 24 24m-59-59 22 22m0-22L71 82"/><circle cx="82" cy="73" r="48" stroke-dasharray="2 8"/>',
  ],
  [
    'no-activity',
    'No recent activity',
    '<path d="M32 82h25l13-27 20 49 14-29h25"/><circle cx="104" cy="48" r="7"/><circle cx="48" cy="48" r="4"/><path d="M48 35v-7m0 40v-7m-13-13h-7m40 0h-7"/>',
  ],
  [
    'access-denied',
    'Access restricted',
    '<path d="M82 29 119 43v26c0 25-15 43-37 54-22-11-37-29-37-54V43z"/><rect x="66" y="67" width="32" height="27" rx="4"/><path d="M73 67v-8a9 9 0 0 1 18 0v8m-9 10v7"/>',
  ],
  [
    'not-found',
    'Page not found',
    '<circle cx="82" cy="76" r="48" stroke-dasharray="22 9 4 9"/><path d="M66 66a16 16 0 1 1 25 13c-7 5-9 7-9 14m0 14h.01"/><circle cx="42" cy="38" r="5"/>',
  ],
  [
    'offline',
    'Connection unavailable',
    '<path d="M37 74a65 65 0 0 1 90 0m-73 18a40 40 0 0 1 56 0m-38 18a14 14 0 0 1 20 0"/><path d="m47 39 70 75M111 37l-8 23 20 3-27 35"/><circle cx="82" cy="121" r="3"/>',
  ],
  [
    'onboarding',
    'Start exploring',
    '<circle cx="82" cy="76" r="21"/><ellipse cx="82" cy="76" rx="57" ry="23" transform="rotate(-28 82 76)"/><circle cx="128" cy="52" r="7"/><path d="M82 38v-9m0 94v-9M44 76h-9m94 0h-9"/><circle cx="45" cy="43" r="4"/>',
  ],
];

await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const themes = ['light', 'dark'];
const ownedAssetPaths = new Set([
  ...entries.flatMap(([name]) => themes.map((theme) => `illustrations/${name}-${theme}.svg`)),
  ...themes.map((theme) => `illustrations/orbit-pattern-${theme}.svg`),
]);
const generatedAssetEntries = [];

for (const [name, label, content] of entries) {
  for (const theme of themes) {
    const ink = theme === 'dark' ? '#f3efe4' : '#0d0d0d';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 164 152" width="164" height="152" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label}"><title>${label}</title><circle cx="82" cy="76" r="67" stroke="${ink}" stroke-opacity=".12" stroke-dasharray="1 8"/>${content}<path d="M31 127h102" stroke="${theme === 'dark' ? '#ffe031' : '#ff2e88'}" stroke-width="4"/></svg>`;
    const path = `illustrations/${name}-${theme}.svg`;
    await writeFile(resolve(root, path), `${svg}\n`);
    generatedAssetEntries.push({
      path,
      kind: 'illustration',
      variant: theme,
      format: 'svg',
      width: 164,
      height: 152,
    });
  }
}

for (const theme of themes) {
  const ink = theme === 'dark' ? '#f3efe4' : '#0d0d0d';
  const path = `illustrations/orbit-pattern-${theme}.svg`;
  const patternId = `mw-illustrations-orbit-pattern-${theme}-svg-texture`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="MoonWitness orbit pattern"><title>MoonWitness orbit pattern</title><pattern id="${patternId}" width="80" height="80" patternUnits="userSpaceOnUse"><circle cx="40" cy="40" r="17" fill="none" stroke="${ink}" stroke-opacity=".12"/><circle cx="40" cy="40" r="2" fill="${theme === 'dark' ? '#ffe031' : '#ff2e88'}"/><path d="M8 40h8m48 0h8M40 8v8m0 48v8" stroke="${ink}" stroke-opacity=".12"/></pattern><rect width="160" height="160" fill="url(#${patternId})"/></svg>`;
  await writeFile(resolve(root, path), `${svg}\n`);
  generatedAssetEntries.push({
    path,
    kind: 'pattern',
    variant: theme,
    format: 'svg',
    width: 160,
    height: 160,
  });
}

manifest.assets = replaceGeneratedAssets(manifest.assets, generatedAssetEntries, ownedAssetPaths);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
stdout.write(
  `Generated ${entries.length * 2 + 2} accessible themed illustration and pattern assets.\n`
);
