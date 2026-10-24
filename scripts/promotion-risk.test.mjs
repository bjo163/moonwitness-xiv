import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPromotionRisk } from './promotion-risk.mjs';

const commit = (sha, subject) => ({ sha, parents: ['parent'], subject });

test('compatible changes in ordinary app code remain eligible for automatic promotion', () => {
  const result = classifyPromotionRisk({
    commits: [commit('a1', 'fix(board): handle empty search results')],
    changes: [{ status: 'M', path: 'apps/board/src/components/search.tsx' }],
  });

  assert.equal(result.requiresApproval, false);
  assert.equal(result.changeKind, 'patch');
  assert.equal(result.riskTier, undefined);
  assert.deepEqual(result.reasons, []);
});

test('a patch-labeled auth change requires approval based on the changed path', () => {
  const result = classifyPromotionRisk({
    commits: [commit('b2', 'fix: tighten login checks')],
    changes: [{ status: 'M', path: 'packages/auth/src/token.ts' }],
    labels: ['patch'],
  });

  assert.equal(result.changeKind, 'patch');
  assert.equal(result.requiresApproval, true);
  assert.equal(result.riskTier, 'runtime-data');
  assert.deepEqual(result.reasons, [
    'risk-tier:runtime-data',
    'sensitive-path:packages/auth/src/token.ts',
  ]);
});

test('schema, workflow, and dependency changes require approval regardless of compatible labels', () => {
  const expectedTiers = new Map([
    ['packages/orm-base/src/models/user.ts', 'runtime-data'],
    ['.github/workflows/promote.yml', 'release-surface'],
    ['pnpm-lock.yaml', 'runtime-data'],
  ]);
  for (const [filePath, tier] of expectedTiers) {
    const result = classifyPromotionRisk({
      commits: [commit('c3', 'fix: keep current behavior')],
      changes: [{ status: 'M', path: filePath }],
    });
    assert.equal(result.requiresApproval, true, filePath);
    assert.equal(result.riskTier, tier, filePath);
  }
});

test('the release surface outranks product code within one diff', () => {
  const result = classifyPromotionRisk({
    commits: [commit('c4', 'fix(api): keep the response shape')],
    changes: [
      { status: 'M', path: 'apps/api/src/routes/partner.routes.ts' },
      { status: 'M', path: '.github/actions/setup-pnpm/action.yml' },
    ],
  });

  assert.equal(result.riskTier, 'release-surface');
});

test('automation logic is a tier of its own below product code', () => {
  const result = classifyPromotionRisk({
    commits: [commit('c5', 'ci: widen the planner')],
    changes: [{ status: 'M', path: 'scripts/select-affected.mjs' }],
  });

  assert.equal(result.requiresApproval, true);
  assert.equal(result.riskTier, 'automation-logic');
});

test('test-only automation and documentation stay out of the path tiers', () => {
  for (const filePath of [
    'scripts/promotion-risk.test.mjs',
    'scripts/docs/update-readme.test.mjs',
    'docs/engineering/feature-coverage.md',
    'docs/roadmap/evidence/M8.03.md',
    'README.md',
    'ROADMAP.md',
  ]) {
    const result = classifyPromotionRisk({
      commits: [commit('c6', 'docs: refresh the audit trail')],
      changes: [{ status: 'M', path: filePath }],
    });
    assert.equal(result.requiresApproval, false, filePath);
    assert.deepEqual(result.reasons, [], filePath);
  }
});

test('deleting documentation alone does not require approval', () => {
  const result = classifyPromotionRisk({
    commits: [commit('c7', 'docs: retire a closed audit note')],
    changes: [{ status: 'D', path: 'docs/roadmap/evidence/M1.12.md' }],
  });

  assert.equal(result.requiresApproval, false);
  assert.deepEqual(result.reasons, []);
});

test('API routes, add-on manifests, and operational scripts require a CODEOWNER', () => {
  for (const change of [
    { status: 'M', path: 'apps/api/src/routes/partner.routes.ts' },
    { status: 'A', path: 'packages/base-addon/addons/base/manifest.ts' },
    { status: 'M', path: 'scripts/restore-postgres.sh' },
  ]) {
    const result = classifyPromotionRisk({
      commits: [commit('d1', 'fix(core): keep behavior')],
      changes: [change],
    });
    assert.equal(result.requiresApproval, true, change.path);
    assert.ok(result.riskTier, change.path);
  }
});

test('breaking, security, and destructive changes require approval', () => {
  const result = classifyPromotionRisk({
    commits: [
      commit('d4', 'feat(api)!: remove legacy response shape'),
      commit('e5', 'security(auth): rotate session tokens'),
    ],
    changes: [{ status: 'D', path: 'apps/board/src/legacy-view.tsx' }],
  });

  assert.equal(result.requiresApproval, true);
  assert.equal(result.changeKind, 'major');
  assert.equal(result.riskTier, 'commit-signal');
  assert.ok(result.reasons.includes('breaking-change'));
  assert.ok(result.reasons.includes('file-deletion:apps/board/src/legacy-view.tsx'));
});

test('renames consider both removed and added paths', () => {
  const result = classifyPromotionRisk({
    commits: [commit('f6', 'refactor: rename login module')],
    changes: [
      {
        status: 'R',
        previousPath: 'apps/board/src/login.ts',
        path: 'packages/auth/src/login.ts',
      },
    ],
  });

  assert.equal(result.requiresApproval, true);
  assert.equal(result.riskTier, 'runtime-data');
  assert.ok(result.reasons.includes('sensitive-path:packages/auth/src/login.ts'));
});

test('a rename out of a sensitive path is still a sensitive promotion', () => {
  const result = classifyPromotionRisk({
    commits: [commit('f7', 'refactor: move the generated client')],
    changes: [
      {
        status: 'R',
        previousPath: 'packages/auth/src/generated.ts',
        path: 'apps/board/src/generated.ts',
      },
    ],
  });

  assert.equal(result.requiresApproval, true);
  assert.equal(result.riskTier, 'runtime-data');
});

test('invalid source commit messages fail closed', () => {
  const result = classifyPromotionRisk({
    commits: [{ sha: 'g7', parents: ['parent'], subject: 'change auth rules' }],
    changes: [],
  });

  assert.equal(result.requiresApproval, true);
  assert.equal(result.changeKind, 'invalid');
  assert.equal(result.riskTier, 'commit-signal');
  assert.deepEqual(result.reasons, ['invalid-commit-message', 'risk-tier:commit-signal']);
});
