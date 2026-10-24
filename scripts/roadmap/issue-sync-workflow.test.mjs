import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maximumApplyBatchSize,
  maximumIssueSyncContinuations,
} from './issue-sync-continuation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(root, '.github/workflows/roadmap-issue-plan.yml');
// The anchors below are LF-only and a Windows checkout carries CRLF.
const source = (await readFile(workflowPath, 'utf8')).replaceAll('\r\n', '\n');

function section(start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing workflow anchor: ${start}`);
  const to = end === undefined ? source.length : source.indexOf(end, from);
  assert.notEqual(to, -1, `missing workflow anchor: ${end}`);
  return source.slice(from, to);
}

const dispatchInputs = section('      stale_sync_retry_count:', 'permissions:');
const applyJob = section('  apply:', undefined);
const applyStep = section(
  '      - name: Collect lifecycle evidence and apply selected tasks with fresh-state guards',
  '        env:'
);

test('the reviewed write bound stays five tasks per run and four bounded runs per selection', () => {
  assert.equal(maximumApplyBatchSize, 5);
  assert.equal(maximumIssueSyncContinuations, 3);
});

test('the batch is planned from the full selection before any remote state is read', () => {
  assert.match(applyStep, /SELECTION_TASK_IDS="\$CHANGED_TASK_IDS"/u);
  assert.match(applyStep, /SELECTION_TASK_IDS="\$BACKFILL_TASK_IDS"/u);
  assert.match(applyStep, /SELECTION_TASK_IDS="\$TASK_IDS"/u);
  assert.match(applyStep, /export ISSUE_SYNC_TASK_IDS="\$SELECTION_TASK_IDS"/u);
  assert.match(applyStep, /node scripts\/roadmap\/issue-sync-continuation\.mjs prepare/u);
  assert.match(applyStep, /TASK_IDS="\$\(jq -r '\.applyTaskIds \| join\(","\)' "\$batch_file"\)"/u);
  assert.ok(
    applyStep.indexOf('issue-sync-continuation.mjs prepare') <
      applyStep.indexOf('git fetch origin dev main')
  );
});

test('the unbounded shell refusal is replaced by a tested bound, not removed', () => {
  assert.doesNotMatch(applyStep, /awk -F, '\{print NF\}' <<<< "\$TASK_IDS" > 5/u);
  assert.doesNotMatch(applyStep, /limited to five task IDs per run/u);
  assert.match(applyStep, /--apply --task-ids "\$TASK_IDS"/u);
  assert.doesNotMatch(applyStep, /--apply --task-ids "\$SELECTION_TASK_IDS"/u);
});

test('every stale short-circuit resumes only the bounded batch, never the oversized selection', () => {
  const batchAssignment = applyStep.indexOf('.applyTaskIds');
  assert.ok(batchAssignment > -1);
  const staleGuards = applyStep.split('resume-stale-issue-sync.mjs').length - 1;
  assert.equal(staleGuards, 3);
  assert.ok(applyStep.indexOf('LATEST_DEV_SHA', batchAssignment) > batchAssignment);
});

test('the continuation dispatch happens only after the bounded batch was applied', () => {
  assert.match(applyStep, /node scripts\/roadmap\/issue-sync-continuation\.mjs dispatch/u);
  assert.ok(
    applyStep.indexOf('sync-issues.mjs --quiet --apply') <
      applyStep.indexOf('issue-sync-continuation.mjs dispatch')
  );
});

test('the continuation counter is a deliberate dispatch input with a bounded default', () => {
  assert.match(dispatchInputs, /batch_continuation_count:\n\s+description: /u);
  assert.match(dispatchInputs, /batch_continuation_count:[\s\S]{0,160}type: number/u);
  assert.match(
    applyJob,
    /BATCH_CONTINUATION_COUNT: \$\{\{ inputs\.batch_continuation_count \|\| 0 \}\}/u
  );
});

test('ephemeral batch and snapshot files are cleaned on every exit path', () => {
  assert.match(applyStep, /trap 'rm -f "\$batch_file" "\$snapshot_file"' EXIT/u);
});
