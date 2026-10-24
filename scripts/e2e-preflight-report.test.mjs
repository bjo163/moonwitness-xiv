import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertReportsAreSanitized, assertRequiredTestReports } from './scan-test-reports.mjs';
import { summarizeFailedTests } from './summarize-playwright-failures.mjs';
import { summarizePreflightDiagnostic, writeE2EPreflightFailure } from './e2e-preflight-report.mjs';

test('preflight failure creates sanitized JUnit and retry diagnostics for the failing stage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-e2e-preflight-'));
  try {
    await writeE2EPreflightFailure(directory, 'reset-superadmin-password', 1);
    const junit = await readFile(path.join(directory, 'board-e2e.xml'), 'utf8');
    const retries = await readFile(path.join(directory, 'board-e2e-retries.json'), 'utf8');

    assert.deepEqual(summarizeFailedTests(junit), ['preflight :: reset-superadmin-password']);
    assert.equal(JSON.parse(retries).runStatus, 'failed');
    assert.doesNotThrow(() => assertReportsAreSanitized(junit + retries));
    assert.doesNotThrow(() =>
      assertRequiredTestReports(['board-e2e.xml', 'board-e2e-retries.json'])
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preflight reports reject unknown stages and successful exit codes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-e2e-invalid-'));
  try {
    await assert.rejects(writeE2EPreflightFailure(directory, 'arbitrary-input', 1));
    await assert.rejects(writeE2EPreflightFailure(directory, 'build-api', 0));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('knowledge fixture failures are reported as a known preflight stage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-e2e-knowledge-preflight-'));
  try {
    await writeE2EPreflightFailure(directory, 'seed-knowledge-search-fixture', 1);
    const junit = await readFile(path.join(directory, 'board-e2e.xml'), 'utf8');
    assert.deepEqual(summarizeFailedTests(junit), ['preflight :: seed-knowledge-search-fixture']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('API build preflight report retains safe TypeScript locations but strips compiler messages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-e2e-diagnostic-'));
  try {
    await writeE2EPreflightFailure(directory, 'build-api', 1, {
      failedPackage: '@moonwitness/orm-request',
      diagnostics: [
        {
          path: 'packages/orm-request/src/manifest.ts',
          line: 3,
          column: 36,
          code: 'TS2307',
          message: 'Cannot find module private-token',
        },
        {
          path: 'packages/orm-request/secrets/private.ts',
          line: 1,
          column: 1,
          code: 'TS2307',
        },
      ],
    });
    const junit = await readFile(path.join(directory, 'board-e2e.xml'), 'utf8');
    assert.match(junit, /@moonwitness\/orm-request/u);
    assert.match(junit, /packages\/orm-request\/src\/manifest\.ts:3:36 TS2307/u);
    assert.doesNotMatch(junit, /private-token|Cannot find module|secrets/u);
    assert.doesNotThrow(() => assertReportsAreSanitized(junit));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preflight diagnostic formatter ignores untrusted paths and compiler messages', () => {
  assert.deepEqual(
    summarizePreflightDiagnostic({
      path: 'packages/orm-request/src/manifest.ts',
      line: 4,
      column: 9,
      code: 'TS2322',
      message: 'secret=private-token',
    }),
    {
      path: 'packages/orm-request/src/manifest.ts',
      line: 4,
      column: 9,
      code: 'TS2322',
    }
  );
  assert.equal(
    summarizePreflightDiagnostic({
      path: '../secrets.ts',
      line: 4,
      column: 9,
      code: 'TS2322',
    }),
    undefined
  );
});
