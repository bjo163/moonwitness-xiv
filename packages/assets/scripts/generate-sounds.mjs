import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceGeneratedAssets } from './manifest-ownership.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sampleRate = 16000;

function toneWav(frequencies, duration = 0.28) {
  const count = Math.floor(sampleRate * duration);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate;
    const fade = Math.min(1, t / 0.012) * Math.exp((-5.5 * t) / duration);
    const mixed =
      frequencies.reduce((sum, [frequency, start]) => {
        if (t < start) return sum;
        const local = t - start;
        return (
          sum + Math.sin(2 * Math.PI * frequency * local) * Math.exp((-4.5 * local) / duration)
        );
      }, 0) / frequencies.length;
    data.writeInt16LE(Math.round(mixed * fade * 0.2 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const sounds = [
  [
    'ui-success.wav',
    [
      [660, 0],
      [880, 0.11],
    ],
  ],
  [
    'ui-alert.wav',
    [
      [440, 0],
      [330, 0.1],
    ],
  ],
  [
    'ui-signal.wav',
    [
      [392, 0],
      [587, 0.08],
      [784, 0.16],
    ],
  ],
];
await mkdir(resolve(root, 'sounds'), { recursive: true });
for (const [name, notes] of sounds) await writeFile(resolve(root, 'sounds', name), toneWav(notes));
const manifestPath = resolve(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const soundAssets = sounds.map(([name]) => ({
  path: `sounds/${name}`,
  kind: 'sound',
  variant: 'ui',
  format: 'wav',
  durationSeconds: 0.28,
  license: 'ISC',
  source: 'scripts/generate-sounds.mjs',
}));
manifest.assets = replaceGeneratedAssets(
  manifest.assets,
  soundAssets,
  new Set(soundAssets.map(({ path }) => path))
);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const licensePath = resolve(root, 'licenses.json');
const licenses = JSON.parse(await readFile(licensePath, 'utf8'));
const soundLicenses = sounds.map(([name]) => ({
  path: `sounds/${name}`,
  creator: 'MoonWitness contributors',
  source: 'packages/assets/scripts/generate-sounds.mjs',
  license: 'ISC',
  modifications:
    'Original short synthesized interface cue; generated from PCM oscillators for this project.',
}));
licenses.soundEffects = replaceGeneratedAssets(
  licenses.soundEffects,
  soundLicenses,
  new Set(soundLicenses.map(({ path }) => path))
);
await writeFile(licensePath, `${JSON.stringify(licenses, null, 2)}\n`);
console.log(`Generated ${sounds.length} original, short interface sound effects.`);
