import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findNodeVersionDrift,
  findPnpmVersionDrift,
  findUnpinnedActions,
  pnpmSetupOrderValid,
  workflowInstallsFrozenWorkspaceAfterSetup,
} from './check-action-pins.mjs';

test('requires one exact pnpm version across workflow setup and the workspace manifest', () => {
  assert.deepEqual(
    findPnpmVersionDrift(
      [
        {
          path: '.github/actions/setup-pnpm/action.yml',
          content: "default: '11.17.0'",
        },
        {
          path: '.github/workflows/ci.yml',
          content: "pnpm-version: '11.17.0'",
        },
        {
          path: '.github/workflows/candidate.yml',
          content: 'corepack prepare pnpm@11.17.0 --activate',
        },
      ],
      'pnpm@11.17.0'
    ),
    []
  );
  assert.equal(
    findPnpmVersionDrift(
      [{ path: '.github/workflows/ci.yml', content: "pnpm-version: '11'" }],
      'pnpm@11.17.0'
    )[0]?.reason,
    'must match the root packageManager pnpm@11.17.0'
  );
});

test('installs pnpm 11 with a Node runtime and required frozen lockfile', () => {
  assert.equal(
    pnpmSetupOrderValid(
      [
        '- uses: pnpm/setup@pnpm-sha # v3',
        '  with:',
        '    runtime: node@${{ inputs.node-version }}',
        '    install: false',
      ].join('\n')
    ),
    true
  );
  assert.equal(
    pnpmSetupOrderValid(
      ['- uses: actions/setup-node@node-sha # v7', '- uses: pnpm/action-setup@pnpm-sha # v6'].join(
        '\n'
      )
    ),
    true
  );
  assert.equal(
    pnpmSetupOrderValid(
      ['- uses: pnpm/action-setup@pnpm-sha # v6', '- uses: actions/setup-node@node-sha # v7'].join(
        '\n'
      )
    ),
    false
  );
});

test('keeps frozen dependency installation visible after toolchain setup', () => {
  assert.equal(
    workflowInstallsFrozenWorkspaceAfterSetup(
      [
        '      - uses: ./.github/actions/setup-pnpm',
        '        with:',
        "          node-version: '22'",
        "          pnpm-version: '11.17.0'",
        '      - name: Install frozen workspace dependencies',
        '        run: pnpm install --frozen-lockfile --no-runtime',
        '      - run: pnpm test',
      ].join('\n')
    ),
    true
  );
  assert.equal(
    workflowInstallsFrozenWorkspaceAfterSetup(
      ['      - uses: ./.github/actions/setup-pnpm', '      - run: pnpm test'].join('\n')
    ),
    false
  );
  assert.equal(
    workflowInstallsFrozenWorkspaceAfterSetup(
      [
        '  plan:',
        '    steps:',
        '      - uses: ./.github/actions/setup-pnpm',
        '      - run: node scripts/select-affected.mjs',
        '  quality:',
        '    steps:',
        '      - uses: ./.github/actions/setup-pnpm',
        '      - name: Install frozen workspace dependencies',
        '        run: pnpm install --frozen-lockfile --no-runtime',
      ].join('\n'),
      '.github/workflows/ci.yml'
    ),
    true
  );
  assert.equal(
    workflowInstallsFrozenWorkspaceAfterSetup(
      [
        '  plan:',
        '    steps:',
        '      - uses: ./.github/actions/setup-pnpm',
        '  quality:',
        '    steps:',
        '      - uses: ./.github/actions/setup-pnpm',
        '      - name: Install frozen workspace dependencies',
        '        run: pnpm install --frozen-lockfile --no-runtime',
      ].join('\n'),
      '.github/workflows/ci.yml'
    ),
    true
  );
});

test('accepts immutable external actions with version comments and local actions', () => {
  const findings = findUnpinnedActions([
    {
      path: '.github/workflows/ci.yml',
      content: [
        '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4',
        '        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2',
        '      - uses: ./.github/actions/setup-pnpm',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(findings, []);
});

test('rejects mutable tags, short SHAs, and missing version comments', () => {
  const findings = findUnpinnedActions([
    {
      path: '.github/workflows/example.yml',
      content: [
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@11d5960a326750d5838078e36cf38b85af67726 # v4',
        '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      ].join('\n'),
    },
  ]);
  assert.equal(findings.length, 3);
  assert.match(findings[0].reason, /full 40-character commit SHA/);
  assert.match(findings[1].reason, /full 40-character commit SHA/);
  assert.match(findings[2].reason, /human-readable action version/);
});

test('rejects expressions and malformed external action references', () => {
  const findings = findUnpinnedActions([
    {
      path: '.github/actions/composite/action.yml',
      content: ['    - uses: actions/checkout@${{ inputs.ref }} # v4', '    - uses: checkout'].join(
        '\n'
      ),
    },
  ]);
  assert.equal(findings.length, 2);
});
test('requires every workflow and image Node pin to match the root engines major', () => {
  const matching = [
    {
      path: '.github/workflows/ci.yml',
      content: [
        "          node-version: '22'",
        '          node-version: ${{ inputs.node-version }}',
      ].join('\n'),
    },
    {
      path: 'Dockerfile',
      content: ['FROM node:22-bookworm-slim AS build', 'FROM node:22.11.0-slim AS runtime'].join(
        '\n'
      ),
    },
  ];
  assert.deepEqual(findNodeVersionDrift(matching, '22.x'), []);
  const drift = findNodeVersionDrift(
    [
      { path: '.github/workflows/ci.yml', content: "          node-version: '20'" },
      { path: 'Dockerfile', content: 'FROM node:lts AS build' },
    ],
    '22.x'
  );
  assert.equal(drift.length, 2);
  assert.match(drift[0].reason, /Node 22\.x line pinned by the root engines field/);
  assert.equal(drift[1].reference, 'lts');
});

test('rejects a missing or imprecise engines declaration instead of guessing a major', () => {
  for (const spec of [undefined, '', '>=22', '22']) {
    const findings = findNodeVersionDrift([], spec);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, 'package.json');
  }
});
