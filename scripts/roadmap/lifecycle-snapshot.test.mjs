import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { projectLifecycleSnapshot } from './lifecycle-snapshot.mjs';

const sourceSha = 'a'.repeat(40);
const devSha = 'b'.repeat(40);
const mainSha = 'c'.repeat(40);
const repositoryId = '123456';
const now = Date.parse('2026-10-07T10:00:00.000Z');
const dependencies = ['M11.01', 'M11.06', 'M2.10'];
const tasks = [
  ...dependencies.map((id) => ({ id, dependsOn: [] })),
  { id: 'M11.07', dependsOn: dependencies },
];
const completedDependencyRecords = dependencies.map((taskId) => ({
  taskId,
  status: 'complete',
  acceptanceVerified: true,
  evidenceSha: sourceSha,
}));
const taskRecord = {
  taskId: 'M11.07',
  status: 'complete',
  acceptanceVerified: true,
  evidenceSha: sourceSha,
  sourceSha,
  sourceInDev: true,
  requiredChecks: [{ name: 'CI', headSha: devSha, status: 'completed', conclusion: 'success' }],
};
const snapshot = {
  schemaVersion: 1,
  repositoryId,
  sourceSha,
  generatedAt: new Date(now - 30_000).toISOString(),
  branchHeads: { dev: devSha, main: mainSha },
  tasks: [...completedDependencyRecords, taskRecord],
};
const issues = [
  {
    number: 42,
    state: 'open',
    body: `<!-- moonwitness-task: ${repositoryId}:M11.07 -->\nMaintainer notes`,
  },
];

test('projects fresh exact-repository snapshot through lifecycle evaluator and current issue state', () => {
  const projected = projectLifecycleSnapshot({
    snapshot,
    tasks,
    issues,
    repositoryId,
    sourceSha,
    now,
  });
  assert.equal(projected.get('M11.07').workStatus, 'complete');
  assert.equal(projected.get('M11.07').deliveryStage, 'verified-dev');
  assert.equal(projected.get('M11.07').shouldClose, true);
});

test('projects a K-series task from exact-source lifecycle evidence and issue marker', () => {
  const kTasks = [{ id: 'K0-001', dependsOn: [] }];
  const kSnapshot = {
    ...snapshot,
    tasks: [
      {
        taskId: 'K0-001',
        status: 'complete',
        acceptanceVerified: true,
        evidenceSha: sourceSha,
        sourceSha,
        sourceInDev: true,
        requiredChecks: [
          { name: 'CI', headSha: devSha, status: 'completed', conclusion: 'success' },
        ],
      },
    ],
  };
  const kIssues = [
    {
      number: 43,
      state: 'open',
      body: `<!-- moonwitness-task: ${repositoryId}:K0-001 -->\nNotes`,
    },
  ];
  const projected = projectLifecycleSnapshot({
    snapshot: kSnapshot,
    tasks: kTasks,
    issues: kIssues,
    repositoryId,
    sourceSha,
    now,
  });
  assert.equal(projected.get('K0-001').workStatus, 'complete');
  assert.equal(projected.get('K0-001').deliveryStage, 'verified-dev');
  assert.equal(projected.get('K0-001').shouldClose, true);
});

test('keeps manually closed incomplete issue closed and flags maintainer triage', () => {
  const incomplete = {
    ...snapshot,
    tasks: [
      ...completedDependencyRecords,
      { taskId: 'M11.07', status: 'in_progress', acceptanceVerified: false },
    ],
  };
  const projected = projectLifecycleSnapshot({
    snapshot: incomplete,
    tasks,
    issues: [{ ...issues[0], state: 'closed' }],
    repositoryId,
    sourceSha,
    now,
  });
  assert.equal(projected.get('M11.07').needsTriage, true);
  assert.equal(projected.get('M11.07').shouldClose, false);
});

test('fails closed for stale, future, mismatched, malformed, duplicate, or unknown snapshot data', () => {
  const project = (candidate) =>
    projectLifecycleSnapshot({ snapshot: candidate, tasks, issues, repositoryId, sourceSha, now });
  assert.throws(
    () => project({ ...snapshot, generatedAt: new Date(now - 300_001).toISOString() }),
    /five minutes/u
  );
  assert.throws(
    () => project({ ...snapshot, generatedAt: new Date(now + 1).toISOString() }),
    /five minutes/u
  );
  assert.throws(() => project({ ...snapshot, repositoryId: '999' }), /repository ID/u);
  assert.throws(() => project({ ...snapshot, sourceSha: 'd'.repeat(40) }), /source SHA/u);
  assert.throws(() => project({ ...snapshot, schemaVersion: 2 }), /schemaVersion/u);
  assert.throws(
    () => project({ ...snapshot, branchHeads: { dev: 'bad', main: mainSha } }),
    /full dev and main head SHAs/u
  );
  assert.throws(
    () => project({ ...snapshot, tasks: [...snapshot.tasks, taskRecord] }),
    /Duplicate lifecycle record/u
  );
  assert.throws(
    () => project({ ...snapshot, tasks: [...snapshot.tasks, { ...taskRecord, taskId: 'M99.99' }] }),
    /unknown task/u
  );
  assert.throws(
    () =>
      project({ ...snapshot, tasks: snapshot.tasks.filter(({ taskId }) => taskId !== 'M11.07') }),
    /missing M11.07/u
  );
});

test('marks missing hard dependencies blocked and rejects duplicate matching remote issues', () => {
  const blocked = {
    ...snapshot,
    tasks: [
      ...completedDependencyRecords.map((record) =>
        record.taskId === 'M11.06'
          ? { taskId: 'M11.06', status: 'todo', acceptanceVerified: false }
          : record
      ),
      { ...taskRecord, status: 'in_progress', acceptanceVerified: false },
    ],
  };
  const result = projectLifecycleSnapshot({
    snapshot: blocked,
    tasks,
    issues,
    repositoryId,
    sourceSha,
    now,
  });
  assert.equal(result.get('M11.07').workStatus, 'blocked');
  assert.throws(
    () =>
      projectLifecycleSnapshot({
        snapshot,
        tasks,
        issues: [...issues, issues[0]],
        repositoryId,
        sourceSha,
        now,
      }),
    /duplicate issues/u
  );
});

test('CLI documents that bounded issue writes require lifecycle evidence for close transitions', () => {
  const scriptPath = fileURLToPath(new URL('./sync-issues.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--help',
      '--apply',
      '--task-ids',
      'M11.03',
      '--lifecycle-snapshot',
      'snapshot.json',
    ],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Lifecycle close transitions require a fresh exact-SHA snapshot/u);
  assert.equal(result.stderr, '');
});
