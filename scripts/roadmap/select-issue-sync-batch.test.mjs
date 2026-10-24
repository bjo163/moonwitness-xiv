import assert from 'node:assert/strict';
import test from 'node:test';
import { selectIssueSyncBatch } from './select-issue-sync-batch.mjs';

test('selects pending creates and updates in roadmap order within the five-write cap', () => {
  const plan = {
    operations: [
      { taskId: 'M0.01', operation: 'noop' },
      { taskId: 'M0.02', operation: 'create' },
      { taskId: 'M0.03', operation: 'update' },
      { taskId: 'M0.04', operation: 'conflict' },
      { taskId: 'M0.05', operation: 'create' },
      { taskId: 'M0.06', operation: 'create' },
      { taskId: 'M0.07', operation: 'update' },
      { taskId: 'M0.08', operation: 'create' },
      { taskId: 'M1.01', operation: 'create' },
    ],
  };
  assert.deepEqual(selectIssueSyncBatch(plan), ['M0.02', 'M0.03', 'M0.05', 'M0.06', 'M0.07']);
  assert.deepEqual(selectIssueSyncBatch(plan, 2), ['M0.02', 'M0.03']);
});

test('returns an empty selection for a fully synchronized plan', () => {
  assert.deepEqual(
    selectIssueSyncBatch({
      operations: [
        { taskId: 'M0.01', operation: 'noop' },
        { taskId: 'M0.02', operation: 'conflict' },
      ],
    }),
    []
  );
});

test('selects K-series issue writes within the same bounded batch contract', () => {
  assert.deepEqual(
    selectIssueSyncBatch({
      operations: [
        { taskId: 'K0-001', operation: 'create' },
        { taskId: 'K0-002', operation: 'update' },
        { taskId: 'K1-001', operation: 'noop' },
      ],
    }),
    ['K0-001', 'K0-002']
  );
});

test('fails closed for malformed plans, duplicate IDs, and unsafe batch limits', () => {
  assert.throws(() => selectIssueSyncBatch(undefined), /operations array/u);
  assert.throws(
    () => selectIssueSyncBatch({ operations: [{ taskId: 'M0.01;echo bad', operation: 'create' }] }),
    /invalid task ID/u
  );
  assert.throws(
    () =>
      selectIssueSyncBatch({
        operations: [
          { taskId: 'M0.01', operation: 'create' },
          { taskId: 'M0.01', operation: 'noop' },
        ],
      }),
    /Duplicate task operation/u
  );
  assert.throws(() => selectIssueSyncBatch({ operations: [] }, 6), /between 1 and 5/u);
});
