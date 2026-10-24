import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceGeneratedAssets } from '../scripts/manifest-ownership.mjs';

test('replaces prior outputs and preserves assets owned by another source', () => {
  const existing = [
    { path: 'illustrations/custom-hero.webp', kind: 'artwork' },
    { path: 'brand/old-logo.svg', kind: 'brand' },
    { path: 'sounds/original.wav', kind: 'sound' },
  ];
  const generated = [{ path: 'brand/old-logo.svg', kind: 'brand', revision: 2 }];

  assert.deepEqual(replaceGeneratedAssets(existing, generated, new Set(['brand/old-logo.svg'])), [
    { path: 'brand/old-logo.svg', kind: 'brand', revision: 2 },
    { path: 'illustrations/custom-hero.webp', kind: 'artwork' },
    { path: 'sounds/original.wav', kind: 'sound' },
  ]);
});

test('rejects generator output outside its declared path ownership', () => {
  assert.throws(
    () => replaceGeneratedAssets([], [{ path: 'illustrations/manual-art.svg' }], new Set()),
    /not declared as owned: illustrations\/manual-art\.svg/u
  );
});

test('rejects duplicate output and collisions with retained manual assets', () => {
  assert.throws(
    () =>
      replaceGeneratedAssets(
        [],
        [{ path: 'brand/a.svg' }, { path: 'brand/a.svg' }],
        new Set(['brand/a.svg'])
      ),
    /produced the same asset more than once: brand\/a\.svg/u
  );

  assert.throws(
    () =>
      replaceGeneratedAssets([{ path: 'manual/a.svg' }, { path: 'manual/a.svg' }], [], new Set()),
    /Duplicate asset manifest path after generator update: manual\/a\.svg/u
  );
});

test('sorts inventory deterministically without changing unrelated metadata', () => {
  const result = replaceGeneratedAssets(
    [{ path: 'z-last.svg' }, { path: 'a-first.svg' }],
    [{ path: 'm-generated.svg' }],
    new Set(['m-generated.svg'])
  );

  assert.deepEqual(
    result.map(({ path }) => path),
    ['a-first.svg', 'm-generated.svg', 'z-last.svg']
  );
});
