import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const preflightStages = new Set([
  'flaky-policy',
  'build-api',
  'build-ui',
  'reset-superadmin-password',
  'seed-knowledge-search-fixture',
  'start-playwright',
  'pnpm-invocation',
]);

const safeBuildDiagnosticPath =
  /^(?:apps|packages)\/[a-z0-9-]+\/(?:src|app|tests?|e2e|public|scripts|components|features|routes|commands|auth|config|lib|index)(?:\/[a-z0-9_./-]+)?$/u;
const safePackageName = /^@moonwitness\/[a-z0-9-]+$/u;

export function summarizePreflightDiagnostic(diagnostic) {
  if (
    !diagnostic ||
    typeof diagnostic.path !== 'string' ||
    !safeBuildDiagnosticPath.test(diagnostic.path) ||
    !Number.isSafeInteger(diagnostic.line) ||
    diagnostic.line < 1 ||
    !Number.isSafeInteger(diagnostic.column) ||
    diagnostic.column < 1 ||
    typeof diagnostic.code !== 'string' ||
    !/^TS\d+$/u.test(diagnostic.code)
  ) {
    return undefined;
  }
  return {
    path: diagnostic.path,
    line: diagnostic.line,
    column: diagnostic.column,
    code: diagnostic.code,
  };
}

export async function writeE2EPreflightFailure(directory, stage, exitCode, details = undefined) {
  if (!preflightStages.has(stage)) throw new Error('Unknown Board E2E preflight stage.');
  if (!Number.isInteger(exitCode) || exitCode === 0) {
    throw new Error('A failed Board E2E preflight requires a non-zero exit code.');
  }

  await mkdir(directory, { recursive: true });
  const packageName =
    typeof details?.failedPackage === 'string' && safePackageName.test(details.failedPackage)
      ? details.failedPackage
      : undefined;
  const diagnostics = Array.isArray(details?.diagnostics)
    ? details.diagnostics.map(summarizePreflightDiagnostic).filter((item) => item !== undefined)
    : [];
  const diagnosticSummary = diagnostics
    .map((item) => `${item.path}:${item.line}:${item.column} ${item.code}`)
    .join('; ');
  const safeDetails = [packageName, diagnosticSummary].filter(Boolean).join('; ');
  const message = `Preflight failed with exit code ${exitCode}${safeDetails ? `: ${safeDetails}` : ''}`;
  const junit = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites tests="1" failures="1" errors="0" skipped="0" time="0">',
    '  <testsuite name="Board E2E preflight" tests="1" failures="1" errors="0" skipped="0" time="0">',
    `    <testcase classname="preflight" name="${stage}" time="0">`,
    `      <failure message="${message}">The E2E harness stopped before Playwright started.</failure>`,
    '    </testcase>',
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');

  await Promise.all([
    writeFile(path.join(directory, 'board-e2e.xml'), junit, 'utf8'),
    writeFile(
      path.join(directory, 'board-e2e-retries.json'),
      `${JSON.stringify({ version: 1, runStatus: 'failed', retries: [] }, null, 2)}\n`,
      'utf8'
    ),
  ]);
}
