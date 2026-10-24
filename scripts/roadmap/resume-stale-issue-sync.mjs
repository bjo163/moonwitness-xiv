import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { taskIdPattern } from './task-ids.mjs';

export const maxStaleSyncRetries = 2;

function isFullSha(value) {
  return /^[a-f0-9]{40}$/u.test(value);
}

export function parseStaleSyncTaskIds(value) {
  const taskIds = [
    ...new Set(
      value
        .split(',')
        .map((taskId) => taskId.trim())
        .filter(Boolean)
    ),
  ];
  if (taskIds.length === 0) throw new Error('A stale issue sync requires at least one task ID.');
  if (taskIds.length > 5) throw new Error('A resumed issue sync is limited to five task IDs.');
  const invalid = taskIds.find((taskId) => !taskIdPattern.test(taskId));
  if (invalid) throw new Error(`Invalid task ID in stale issue sync: ${invalid}`);
  return taskIds;
}

export async function resumeStaleIssueSync({
  sourceSha,
  latestDevSha,
  taskIds,
  retryCount,
  dispatch,
}) {
  if (!isFullSha(sourceSha) || !isFullSha(latestDevSha))
    throw new Error('Stale issue sync requires full lowercase source and dev SHAs.');
  if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > maxStaleSyncRetries)
    throw new Error(`Stale issue sync retry count must be from 0 to ${maxStaleSyncRetries}.`);
  const selectedTaskIds = parseStaleSyncTaskIds(taskIds);
  if (sourceSha === latestDevSha) return { status: 'current', taskIds: selectedTaskIds };
  if (retryCount >= maxStaleSyncRetries)
    throw new Error(
      `Stale issue sync exhausted ${maxStaleSyncRetries} automatic resumes; no issue write was attempted.`
    );

  const nextRetryCount = retryCount + 1;
  await dispatch({
    ref: 'dev',
    inputs: {
      apply: 'true',
      backfill_next_batch: 'false',
      stale_sync_retry_count: String(nextRetryCount),
      task_ids: selectedTaskIds.join(','),
    },
  });
  return { status: 'resumed', retryCount: nextRetryCount, taskIds: selectedTaskIds };
}

function dispatchWorkflow({ repository, token, request }) {
  const response = execFileSync(
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
      input: JSON.stringify(request),
      env: { ...process.env, GH_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  return response;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('GITHUB_REPOSITORY must identify owner/repository.');
  if (!token) throw new Error('A workflow token is required to resume a stale issue sync.');

  const sourceSha = process.env.SOURCE_SHA ?? '';
  const latestDevSha = process.env.LATEST_DEV_SHA ?? '';
  const retryCount = Number(process.env.STALE_SYNC_RETRY_COUNT ?? '0');
  const result = await resumeStaleIssueSync({
    sourceSha,
    latestDevSha,
    taskIds: process.env.TASK_IDS ?? '',
    retryCount,
    dispatch: (request) =>
      dispatchWorkflow({ repository, token, request: { ...request, ref: 'dev' } }),
  });

  if (result.status === 'resumed')
    process.stdout.write(
      `Resumed stale issue sync on latest dev with ${result.taskIds.length} task(s), retry ${result.retryCount}.\n`
    );
  else process.stdout.write('Issue sync source is still current; no resume dispatch was needed.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
