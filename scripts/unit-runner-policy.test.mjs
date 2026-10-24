import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { URL } from 'node:url';
import { unitRunnerChecks } from './unit-runner-policy.mjs';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

describe('unit runner CI ownership', () => {
  it('owns every shared contract because CI has a single job', () => {
    assert.deepEqual(
      unitRunnerChecks.map(({ name, args }) => [name, args.join(' ')]),
      [
        ['Board bundle budget contract', 'run test:board-budget'],
        ['Board production bundle budget', 'run board:budget'],
        ['Versioned documentation', 'run test:versioned-docs'],
        ['brand asset contracts', 'run test:assets'],
        ['shared UI token contracts', 'run test:ui'],
      ]
    );
  });

  it('runs those contracts from the job the branch ruleset requires', () => {
    const jobsBlock = workflow.split(/\njobs:\r?\n/u)[1];
    assert.ok(jobsBlock);
    const jobNames = [...jobsBlock.matchAll(/^ {2}([a-z][\w-]+):\r?$/gmu)].map(([_, name]) => name);
    assert.deepEqual(jobNames, ['ci-gate']);
    assert.match(jobsBlock, /name: ci-gate\r?\n/u);
    assert.match(jobsBlock, /run: pnpm test:unit:ci/u);
  });

  it('keeps the asset scripts split the way the checks expect', () => {
    assert.match(
      rootPackage.scripts['test:assets'],
      /test:assets:source && pnpm assets:check:docs/u
    );
    assert.match(rootPackage.scripts['test:assets:source'], /export-doc-assets\.test\.mjs/u);
  });
});
