import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const runner = await readFile(new URL('./run-unit-tests.mjs', import.meta.url), 'utf8');
const releaseWorkflow = await readFile(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8'
);
const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

describe('WhatsApp release gate integration', () => {
  it('runs the maintained WhatsApp suite in release and local unit runners', () => {
    assert.match(runner, /run\(\['run', 'test:whatsapp'\], 'WhatsApp integration'\)/u);
    assert.doesNotMatch(runner, /@moonwitness\/whatsapp/u);
    assert.match(rootPackage.scripts['test:whatsapp'], /tests\/whatsapp\.config\.test\.ts/u);
    assert.match(rootPackage.scripts['test:whatsapp'], /tests\/whatsapp\.routes\.test\.ts/u);
    assert.match(rootPackage.scripts['test:unit:built'], /pnpm test:whatsapp/u);
    assert.ok(
      rootPackage.scripts['test:unit:built'].indexOf('pnpm test:whatsapp') <
        rootPackage.scripts['test:unit:built'].indexOf(
          'pnpm --filter @moonwitness/api exec vitest run'
        ),
      'the WhatsApp suite must run before the broader API suite can fail early'
    );
    assert.match(releaseWorkflow, /run: pnpm test:unit:built/u);
  });
});
