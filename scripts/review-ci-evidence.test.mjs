import assert from 'node:assert/strict';
import test from 'node:test';
import { selectReviewCiRun, verifyReviewCiEvidence } from './review-ci-evidence.mjs';

const run = (overrides = {}) => ({
  id: 42,
  event: 'pull_request',
  head_sha: 'a'.repeat(40),
  status: 'completed',
  conclusion: 'failure',
  created_at: '2026-10-15T10:00:00Z',
  run_attempt: 1,
  pull_requests: [{ number: 24 }],
  ...overrides,
});
const jobs = [{ name: 'ci-technical-gate', status: 'completed', conclusion: 'success' }];

test('selects completed CI evidence for the exact PR and head SHA, even if approval alone failed', () => {
  const selected = selectReviewCiRun(
    [[{ workflow_runs: [run({ event: 'push' }), run({ head_sha: 'b'.repeat(40) }), run()] }]],
    'a'.repeat(40),
    24
  );
  assert.equal(selected.id, 42);
  assert.match(verifyReviewCiEvidence([run()], [{ jobs }], 'a'.repeat(40), 24, 42), /run 42/u);
});

test('rejects missing, stale, wrong-PR, or unfinished CI evidence', () => {
  assert.throws(() => selectReviewCiRun([], 'a'.repeat(40), 24), /No pull_request CI run/u);
  assert.throws(
    () => selectReviewCiRun([run({ pull_requests: [{ number: 25 }] })], 'a'.repeat(40), 24),
    /No pull_request CI run/u
  );
  assert.throws(
    () => selectReviewCiRun([run({ status: 'in_progress' })], 'a'.repeat(40), 24),
    /still in_progress/u
  );
  assert.throws(
    () => verifyReviewCiEvidence([run()], jobs, 'b'.repeat(40), 24, 42),
    /No pull_request CI run/u
  );
});

test('requires the latest matching completed run and a successful technical gate job', () => {
  const older = run({ id: 41 });
  const newerFailure = run({
    id: 43,
    created_at: '2026-10-15T10:01:00Z',
  });
  assert.throws(
    () => verifyReviewCiEvidence([older, newerFailure], jobs, 'a'.repeat(40), 24, 41),
    /not the latest run/u
  );
  assert.throws(
    () =>
      verifyReviewCiEvidence(
        [run()],
        [{ name: 'ci-technical-gate', status: 'completed', conclusion: 'failure' }],
        'a'.repeat(40),
        24,
        42
      ),
    /did not succeed/u
  );
});
