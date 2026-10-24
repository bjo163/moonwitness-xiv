import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maxStaleSyncRetries,
  parseStaleSyncTaskIds,
  resumeStaleIssueSync,
} from './resume-stale-issue-sync.mjs';

const sourceSha = 'a'.repeat(40);
const latestDevSha = 'b'.repeat(40);

test('does not dispatch when the issue sync source is still the current dev head', async () => {
  let dispatches = 0;
  const result = await resumeStaleIssueSync({
    sourceSha,
    latestDevSha: sourceSha,
    taskIds: 'M1.08,M11.14',
    retryCount: 0,
    dispatch: async () => dispatches++,
  });

  assert.deepEqual(result, { status: 'current', taskIds: ['M1.08', 'M11.14'] });
  assert.equal(dispatches, 0);
});

test('resumes stale issue sync on dev with only the selected bounded task IDs', async () => {
  const dispatches = [];
  const result = await resumeStaleIssueSync({
    sourceSha,
    latestDevSha,
    taskIds: 'M1.08,M11.14,M1.08',
    retryCount: 0,
    dispatch: async (request) => dispatches.push(request),
  });

  assert.deepEqual(result, { status: 'resumed', retryCount: 1, taskIds: ['M1.08', 'M11.14'] });
  assert.deepEqual(dispatches, [
    {
      ref: 'dev',
      inputs: {
        apply: 'true',
        backfill_next_batch: 'false',
        stale_sync_retry_count: '1',
        task_ids: 'M1.08,M11.14',
      },
    },
  ]);
});

test('fails closed after the bounded automatic resume count is exhausted', async () => {
  let dispatches = 0;
  await assert.rejects(
    resumeStaleIssueSync({
      sourceSha,
      latestDevSha,
      taskIds: 'M11.14',
      retryCount: maxStaleSyncRetries,
      dispatch: async () => dispatches++,
    }),
    /exhausted 2 automatic resumes/u
  );
  assert.equal(dispatches, 0);
});

test('rejects invalid SHAs, retries, and issue batches before dispatch', async () => {
  const input = {
    sourceSha,
    latestDevSha,
    taskIds: 'M11.14',
    retryCount: 0,
    dispatch: async () => assert.fail('invalid resume request must not dispatch'),
  };
  await assert.rejects(
    resumeStaleIssueSync({ ...input, sourceSha: 'not-a-sha' }),
    /full lowercase/u
  );
  await assert.rejects(resumeStaleIssueSync({ ...input, retryCount: 3 }), /retry count/u);
  await assert.rejects(resumeStaleIssueSync({ ...input, taskIds: '' }), /at least one task/u);
  await assert.rejects(
    resumeStaleIssueSync({ ...input, taskIds: 'M1.01,M1.02,M1.03,M1.04,M1.05,M1.06' }),
    /limited to five/u
  );
  await assert.rejects(resumeStaleIssueSync({ ...input, taskIds: 'unknown' }), /Invalid task ID/u);
});

test('parses unique bounded roadmap task IDs', () => {
  assert.deepEqual(parseStaleSyncTaskIds(' M1.08, M11.14, M1.08 '), ['M1.08', 'M11.14']);
});
