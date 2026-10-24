import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTaskLifecycle } from './lifecycle.mjs';

const sourceSha = 'a'.repeat(40);
const devSha = 'b'.repeat(40);
const mainSha = 'c'.repeat(40);
const check = (name, headSha = devSha, conclusion = 'success') => ({
  name,
  headSha,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
});
const completed = {
  taskId: 'M11.07',
  status: 'complete',
  acceptanceVerified: true,
  evidenceSha: sourceSha,
  sourceSha,
  devHeadSha: devSha,
  sourceInDev: true,
  requiredChecks: [check('ci-technical-gate'), check('CodeQL')],
};

test('planned and in-progress work remain open and are not mistaken for delivery', () => {
  assert.deepEqual(
    evaluateTaskLifecycle({ taskId: 'M11.07', status: 'todo', acceptanceVerified: false }),
    {
      taskId: 'M11.07',
      workStatus: 'planned',
      deliveryStage: 'planned',
      issueState: 'open',
      needsTriage: false,
      shouldClose: false,
      blockers: [],
    }
  );
  assert.equal(
    evaluateTaskLifecycle({ taskId: 'M11.07', status: 'in_progress', acceptanceVerified: false })
      .workStatus,
    'in_progress'
  );
});

test('accepts stable K-series task IDs in the shared lifecycle contract', () => {
  const result = evaluateTaskLifecycle({
    taskId: 'K0-003',
    status: 'in_progress',
    acceptanceVerified: false,
    dependencyIds: ['K0-001'],
    incompleteDependencyIds: ['K0-001'],
  });
  assert.equal(result.taskId, 'K0-003');
  assert.equal(result.workStatus, 'blocked');
  assert.deepEqual(result.blockers, ['Dependency K0-001 is not complete.']);
});

test('unfinished declared hard dependencies block work and are listed explicitly', () => {
  const result = evaluateTaskLifecycle({
    taskId: 'M11.07',
    status: 'in_progress',
    acceptanceVerified: false,
    dependencyIds: ['M11.06', 'M2.10'],
    incompleteDependencyIds: ['M11.06'],
  });
  assert.equal(result.workStatus, 'blocked');
  assert.deepEqual(result.blockers, ['Dependency M11.06 is not complete.']);
  assert.equal(result.shouldClose, false);
});

test('completion needs acceptance evidence; incomplete dependencies prevent issue close', () => {
  assert.throws(
    () =>
      evaluateTaskLifecycle({ taskId: 'M11.07', status: 'complete', acceptanceVerified: false }),
    /requires verified acceptance/u
  );
  assert.throws(
    () => evaluateTaskLifecycle({ taskId: 'M11.07', status: 'complete', acceptanceVerified: true }),
    /full source SHA/u
  );
  const dependencyBlocked = evaluateTaskLifecycle({
    ...completed,
    incompleteDependencyIds: ['M11.06'],
    dependencyIds: ['M11.06'],
  });
  assert.equal(dependencyBlocked.workStatus, 'complete');
  assert.equal(dependencyBlocked.shouldClose, false);
  assert.deepEqual(dependencyBlocked.blockers, ['Dependency M11.06 is not complete.']);
  const evidenceOnly = evaluateTaskLifecycle({
    taskId: 'M11.07',
    status: 'complete',
    acceptanceVerified: true,
    evidenceSha: sourceSha,
  });
  assert.equal(evidenceOnly.workStatus, 'complete');
  assert.equal(evidenceOnly.deliveryStage, 'planned');
  assert.equal(evidenceOnly.shouldClose, false);
  assert.match(evidenceOnly.blockers[0], /source SHA is recorded/u);
});

test('verified-dev requires current dev ancestry and every required check on exact current SHA', () => {
  const result = evaluateTaskLifecycle(completed);
  assert.equal(result.deliveryStage, 'verified-dev');
  assert.equal(result.verifiedOnDevSha, devSha);
  assert.equal(result.shouldClose, true);
  assert.throws(
    () => evaluateTaskLifecycle({ ...completed, devHeadSha: undefined }),
    /current dev head SHA/u
  );
  assert.equal(
    evaluateTaskLifecycle({ ...completed, requiredChecks: [check('ci-technical-gate', sourceSha)] })
      .deliveryStage,
    'planned'
  );
  assert.equal(
    evaluateTaskLifecycle({
      ...completed,
      requiredChecks: [check('ci-technical-gate', devSha, 'failure')],
    }).shouldClose,
    false
  );
  assert.equal(
    evaluateTaskLifecycle({ ...completed, sourceInDev: false }).deliveryStage,
    'planned'
  );
  assert.equal(
    evaluateTaskLifecycle({
      ...completed,
      requiredChecks: [check('ci-technical-gate', devSha, null)],
    }).deliveryStage,
    'planned'
  );
  assert.equal(evaluateTaskLifecycle({ ...completed, requiredChecks: [] }).shouldClose, false);
});

test('main and release are distinct delivery stages and release provenance must match', () => {
  const inMain = evaluateTaskLifecycle({ ...completed, sourceInMain: true, mainHeadSha: mainSha });
  assert.equal(inMain.deliveryStage, 'in-main');
  const released = evaluateTaskLifecycle({
    ...completed,
    sourceInMain: true,
    mainHeadSha: mainSha,
    releaseManifest: { version: '1.2.0', sourceSha, releaseSha: 'e'.repeat(40) },
    releaseContainsSource: true,
  });
  assert.equal(released.deliveryStage, 'released');
  assert.equal(released.releaseVersion, '1.2.0');
  assert.equal(
    evaluateTaskLifecycle({
      ...completed,
      sourceInMain: true,
      mainHeadSha: mainSha,
      releaseManifest: { version: '1.2.0', sourceSha, releaseSha: 'e'.repeat(40) },
      releaseContainsSource: false,
    }).deliveryStage,
    'in-main'
  );
  assert.throws(
    () =>
      evaluateTaskLifecycle({
        ...completed,
        sourceInMain: true,
        mainHeadSha: mainSha,
        releaseManifest: { version: '1.2.0', sourceSha, releaseSha: 'bad-sha' },
        releaseContainsSource: true,
      }),
    /full release tag commit SHA/u
  );
  assert.throws(
    () =>
      evaluateTaskLifecycle({
        ...completed,
        sourceInMain: true,
        mainHeadSha: mainSha,
        releaseManifest: { version: '1.2.0', sourceSha: mainSha, releaseSha: 'e'.repeat(40) },
        releaseContainsSource: true,
      }),
    /Release provenance source SHA must match/u
  );
  assert.throws(
    () =>
      evaluateTaskLifecycle({
        ...completed,
        sourceInMain: true,
        mainHeadSha: mainSha,
        releaseManifest: { version: 'invalid', sourceSha, releaseSha: 'e'.repeat(40) },
        releaseContainsSource: true,
      }),
    /Invalid release version/u
  );
  assert.throws(
    () =>
      evaluateTaskLifecycle({
        ...completed,
        releaseManifest: { version: '1.0.0', sourceSha, releaseSha: 'e'.repeat(40) },
        releaseContainsSource: true,
      }),
    /before the source is verified in main/u
  );
});

test('manual issue close without accepted evidence requests triage and is never reopened automatically', () => {
  const result = evaluateTaskLifecycle({
    taskId: 'M11.07',
    status: 'todo',
    acceptanceVerified: false,
    issueState: 'closed',
  });
  assert.equal(result.needsTriage, true);
  assert.equal(result.issueState, 'closed');
  assert.equal(result.shouldClose, false);
});

test('rejects malformed identities, SHAs, check names, conclusions, and dependency claims', () => {
  assert.throws(
    () => evaluateTaskLifecycle({ taskId: 'M11.x', status: 'todo', acceptanceVerified: false }),
    /task ID/u
  );
  assert.throws(() => evaluateTaskLifecycle({ ...completed, sourceSha: 'abc' }), /sourceSha/u);
  assert.throws(
    () =>
      evaluateTaskLifecycle({
        ...completed,
        requiredChecks: [check('ci-technical-gate'), check('ci-technical-gate')],
      }),
    /unique/u
  );
  assert.throws(
    () =>
      evaluateTaskLifecycle({
        ...completed,
        requiredChecks: [
          check('ci-technical-gate', devSha, 'queued'),
          { name: 'other', headSha: devSha, status: 'completed', conclusion: 'impossible' },
        ],
      }),
    /invalid SHA or conclusion/u
  );
  assert.throws(
    () =>
      evaluateTaskLifecycle({
        taskId: 'M11.07',
        status: 'todo',
        acceptanceVerified: false,
        incompleteDependencyIds: ['M11.06'],
      }),
    /declared task dependencies/u
  );
});
