import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maximumApplyBatchSize,
  maximumIssueSyncContinuations,
  parseIssueSyncTaskIds,
  planIssueSyncContinuation,
  runIssueSyncContinuation,
} from './issue-sync-continuation.mjs';

// The measured oversized push selection that a five-task apply guard refused on 2026-10-23.
const twelveTaskIds = [
  'K3-007',
  'K4-005',
  'K5-004',
  'K5-005',
  'K7-004',
  'K8-002',
  'M0.01',
  'M0.07',
  'M1.09',
  'M10.06',
  'M7.14',
  'M9.05',
].join(',');

test('keeps the reviewed five-task apply bound for the batch written now', () => {
  assert.equal(maximumApplyBatchSize, 5);
  const plan = planIssueSyncContinuation({ taskIds: twelveTaskIds, continuationCount: '0' });
  assert.equal(plan.applyTaskIds.length, 5);
  assert.deepEqual(plan.applyTaskIds, ['K3-007', 'K4-005', 'K5-004', 'K5-005', 'K7-004']);
  assert.equal(plan.selectionCount, 12);
});

test('carries the remainder instead of dropping it, preserving deterministic order', () => {
  const plan = planIssueSyncContinuation({ taskIds: twelveTaskIds, continuationCount: '0' });
  assert.deepEqual(plan.dispatchTaskIds, [
    'K8-002',
    'M0.01',
    'M0.07',
    'M1.09',
    'M10.06',
    'M7.14',
    'M9.05',
  ]);
  assert.deepEqual(
    [...plan.applyTaskIds, ...plan.dispatchTaskIds],
    parseIssueSyncTaskIds(twelveTaskIds)
  );
});

test('a selection within the bound never dispatches a continuation', () => {
  const plan = planIssueSyncContinuation({
    taskIds: 'M11.03,M11.04,M11.06',
    continuationCount: '0',
  });
  assert.deepEqual(plan.dispatchTaskIds, []);
  assert.equal(plan.selectionCount, 3);
});

test('deduplicates repeated task IDs so one issue is written once per chain', () => {
  const plan = planIssueSyncContinuation({
    taskIds: 'M11.03,M11.03,M11.04,M11.04,M11.06,M11.06,M11.07',
    continuationCount: '0',
  });
  assert.deepEqual(plan.applyTaskIds, ['M11.03', 'M11.04', 'M11.06', 'M11.07']);
  assert.deepEqual(plan.dispatchTaskIds, []);
});

test('the continuation chain drains a twelve-task selection in three bounded runs', () => {
  const first = planIssueSyncContinuation({ taskIds: twelveTaskIds, continuationCount: '0' });
  const second = planIssueSyncContinuation({
    taskIds: first.dispatchTaskIds.join(','),
    continuationCount: String(first.nextContinuationCount),
  });
  const third = planIssueSyncContinuation({
    taskIds: second.dispatchTaskIds.join(','),
    continuationCount: String(second.nextContinuationCount),
  });
  assert.deepEqual(
    [...first.applyTaskIds, ...second.applyTaskIds, ...third.applyTaskIds].sort(),
    parseIssueSyncTaskIds(twelveTaskIds).sort()
  );
  assert.deepEqual(third.dispatchTaskIds, []);
});

test('fails closed before any write when the selection outgrows the bounded chain', () => {
  const twentyOne = Array.from(
    { length: 21 },
    (_value, index) => `M9.${String(index + 1).padStart(2, '0')}`
  ).join(',');
  assert.throws(
    () => planIssueSyncContinuation({ taskIds: twentyOne, continuationCount: '0' }),
    /no issue write was attempted/u
  );
  assert.throws(
    () =>
      planIssueSyncContinuation({
        taskIds: 'M9.01,M9.02,M9.03,M9.04,M9.05,M9.06',
        continuationCount: String(maximumIssueSyncContinuations),
      }),
    /no issue write was attempted/u
  );
});

test('the chain boundary is inclusive at twenty tasks from a fresh selection', () => {
  const twenty = Array.from(
    { length: 20 },
    (_value, index) => `M9.${String(index + 1).padStart(2, '0')}`
  );
  let pending = twenty.join(',');
  let count = '0';
  const applied = [];
  let runs = 0;
  while (pending) {
    const plan = planIssueSyncContinuation({ taskIds: pending, continuationCount: count });
    applied.push(...plan.applyTaskIds);
    pending = plan.dispatchTaskIds.join(',');
    count = String(plan.nextContinuationCount);
    runs += 1;
  }
  assert.equal(runs, maximumIssueSyncContinuations + 1);
  assert.deepEqual(applied.sort(), [...twenty].sort());
});

test('rejects a malformed continuation counter and unknown task IDs instead of coercing them', () => {
  assert.throws(
    () => planIssueSyncContinuation({ taskIds: 'M1.01', continuationCount: '-1' }),
    /from 0 to/u
  );
  assert.throws(
    () => planIssueSyncContinuation({ taskIds: 'M1.01', continuationCount: '4' }),
    /from 0 to/u
  );
  assert.throws(
    () => planIssueSyncContinuation({ taskIds: 'M1.01', continuationCount: '0.5' }),
    /from 0 to/u
  );
  assert.throws(() => parseIssueSyncTaskIds('M1.01,not-a-task'), /Invalid task ID/u);
  assert.throws(() => parseIssueSyncTaskIds('  , '), /at least one task ID/u);
});

test('dispatches the remainder against dev with the incremented counter and apply enabled', async () => {
  const dispatches = [];
  const result = await runIssueSyncContinuation({
    phase: 'dispatch',
    taskIds: twelveTaskIds,
    continuationCount: '0',
    repository: 'owner/repository',
    token: 'v',
    dispatch: async (inputs) => dispatches.push(inputs),
  });
  assert.equal(result.dispatched, true);
  assert.deepEqual(dispatches, [
    {
      apply: 'true',
      backfill_next_batch: 'false',
      batch_continuation_count: '1',
      task_ids: 'K8-002,M0.01,M0.07,M1.09,M10.06,M7.14,M9.05',
    },
  ]);
});

test('the dispatch phase writes nothing and spawns nothing when the selection already fits', async () => {
  let dispatches = 0;
  const result = await runIssueSyncContinuation({
    phase: 'dispatch',
    taskIds: 'M11.03,M11.06',
    continuationCount: '2',
    repository: 'owner/repository',
    token: 'v',
    dispatch: async () => {
      dispatches += 1;
    },
  });
  assert.equal(result.dispatched, false);
  assert.equal(dispatches, 0);
});

test('refuses to dispatch without a usable repository identity or token', async () => {
  await assert.rejects(
    () =>
      runIssueSyncContinuation({
        phase: 'dispatch',
        taskIds: twelveTaskIds,
        continuationCount: '0',
        repository: '',
        token: 'v',
        dispatch: async () => {},
      }),
    /owner\/repository/u
  );
  await assert.rejects(
    () =>
      runIssueSyncContinuation({
        phase: 'dispatch',
        taskIds: twelveTaskIds,
        continuationCount: '0',
        repository: 'owner/repository',
        token: '',
        dispatch: async () => {},
      }),
    /workflow token is required/u
  );
});

test('rejects an unknown phase instead of silently preparing nothing', async () => {
  await assert.rejects(
    () =>
      runIssueSyncContinuation({
        phase: 'apply',
        taskIds: 'M1.01',
        continuationCount: '0',
        repository: 'owner/repository',
        token: 'v',
        dispatch: async () => {},
      }),
    /Unknown issue sync continuation phase/u
  );
});
