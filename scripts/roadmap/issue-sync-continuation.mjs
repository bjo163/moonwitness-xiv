import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { taskIdPattern } from './task-ids.mjs';

export const maximumApplyBatchSize = 5;
export const maximumIssueSyncContinuations = 3;

export function parseIssueSyncTaskIds(value) {
  const taskIds = [
    ...new Set(
      value
        .split(',')
        .map((taskId) => taskId.trim())
        .filter(Boolean)
    ),
  ];
  if (taskIds.length === 0) throw new Error('Issue sync continuation needs at least one task ID.');
  const invalid = taskIds.find((taskId) => !taskIdPattern.test(taskId));
  if (invalid) throw new Error(`Invalid task ID in issue sync continuation: ${invalid}`);
  return taskIds;
}

function parseContinuationCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > maximumIssueSyncContinuations)
    throw new Error(
      `Issue sync continuation count must be from 0 to ${maximumIssueSyncContinuations}.`
    );
  return count;
}

export function planIssueSyncContinuation({ taskIds, continuationCount }) {
  const selected = parseIssueSyncTaskIds(taskIds);
  const count = parseContinuationCount(continuationCount);
  const applyTaskIds = selected.slice(0, maximumApplyBatchSize);
  const dispatchTaskIds = selected.slice(maximumApplyBatchSize);
  const capacity = (maximumIssueSyncContinuations - count + 1) * maximumApplyBatchSize;
  if (selected.length > capacity)
    throw new Error(
      `Issue sync selection of ${selected.length} task(s) exceeds the ${capacity} task(s) one bounded chain can cover; no issue write was attempted.`
    );
  return {
    applyTaskIds,
    dispatchTaskIds,
    continuationCount: count,
    nextContinuationCount: count + 1,
    selectionCount: selected.length,
  };
}

function dispatchWorkflow({ repository, token, inputs }) {
  return execFileSync(
    'gh',
    [
      'api',
      '--method',
      'POST',
      '--input',
      '-',
      `repos/${repository}/actions/workflows/roadmap-issue-plan.yml/dispatches`,
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify({ ref: 'dev', inputs }),
      env: { ...process.env, GH_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
}

export async function runIssueSyncContinuation({
  phase,
  taskIds,
  continuationCount,
  repository,
  token,
  dispatch,
}) {
  const plan = planIssueSyncContinuation({ taskIds, continuationCount });
  if (phase === 'prepare') return plan;
  if (phase !== 'dispatch') throw new Error(`Unknown issue sync continuation phase: ${phase}.`);
  if (plan.dispatchTaskIds.length === 0) return { ...plan, dispatched: false };
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('GITHUB_REPOSITORY must identify owner/repository.');
  if (!token) throw new Error('A workflow token is required to continue an issue sync batch.');
  await dispatch({
    apply: 'true',
    backfill_next_batch: 'false',
    batch_continuation_count: String(plan.nextContinuationCount),
    task_ids: plan.dispatchTaskIds.join(','),
  });
  return { ...plan, dispatched: true };
}

async function main() {
  const [phase] = process.argv.slice(2);
  if (!['prepare', 'dispatch'].includes(phase))
    throw new Error('Usage: node issue-sync-continuation.mjs <prepare|dispatch>');

  const result = await runIssueSyncContinuation({
    phase,
    taskIds: process.env.ISSUE_SYNC_TASK_IDS ?? '',
    continuationCount: process.env.BATCH_CONTINUATION_COUNT ?? '0',
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    dispatch: (inputs) =>
      Promise.resolve(
        dispatchWorkflow({
          repository: process.env.GITHUB_REPOSITORY,
          token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
          inputs,
        })
      ),
  });
  if (phase === 'prepare') {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      process.env.ISSUE_SYNC_BATCH_FILE ?? '.roadmap-issue-batches.json',
      JSON.stringify(result, null, 2),
      'utf8'
    );
    process.stdout.write(
      `Issue sync batch: apply ${result.applyTaskIds.join(',')} of ${result.selectionCount} selected task(s).\n`
    );
    return;
  }
  process.stdout.write(
    result.dispatched
      ? `Dispatched continuation ${result.nextContinuationCount} for ${result.dispatchTaskIds.length} task(s).\n`
      : 'Issue sync selection is fully applied; no continuation dispatch was needed.\n'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
