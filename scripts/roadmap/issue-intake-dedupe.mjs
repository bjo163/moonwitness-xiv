import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';

const MAX_RUN_PAGES = 100;
const MAX_DELIVERY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEARCH_RESULTS = 1000;
const API_ORIGIN = 'https://api.github.com';
const WORKFLOW_PATH = '/actions/workflows/roadmap-issue-intake.yml/runs';

function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nextPageUrl(linkHeader, expectedPath, expectedQuery) {
  if (!linkHeader) return undefined;
  for (const link of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/u.exec(link);
    if (!match || match[2] !== 'next') continue;
    const url = new URL(match[1]);
    if (url.origin !== API_ORIGIN || url.pathname !== expectedPath) {
      throw new Error('GitHub returned an unexpected workflow-run pagination link.');
    }
    for (const name of ['created', 'event', 'per_page']) {
      if (url.searchParams.get(name) !== expectedQuery.get(name))
        throw new Error('GitHub changed the workflow-run pagination query.');
    }
    return url.toString();
  }
  return undefined;
}

function isPreviouslyReportedRun(run, commentId, currentRunId) {
  return (
    positiveInteger(run.id) &&
    String(run.id) !== currentRunId &&
    run.event === 'issue_comment' &&
    run.display_title === `Roadmap intake comment ${commentId}` &&
    run.status === 'completed' &&
    run.conclusion === 'success'
  );
}

/**
 * Query retained Actions run history as an idempotency ledger. A successful earlier
 * run is sufficient to suppress a redelivery; API or pagination uncertainty fails closed.
 * @param {{repository: string, commentId: string, commentCreatedAt: string, currentRunId: string, token: string, fetchImpl?: typeof fetch, now?: number}} input
 */
export async function hasReportedIssueIntakeDelivery({
  repository,
  commentId,
  commentCreatedAt,
  currentRunId,
  token,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('GitHub repository identity is invalid.');
  if (!/^[1-9][0-9]*$/u.test(commentId)) throw new Error('Issue comment ID is invalid.');
  const createdAt = Date.parse(commentCreatedAt);
  if (!Number.isFinite(createdAt)) throw new Error('Issue comment creation time is invalid.');
  if (createdAt > now) throw new Error('Issue comment creation time is in the future.');
  if (now - createdAt > MAX_DELIVERY_AGE_MS)
    throw new Error('Issue comment is outside the seven-day intake deduplication window.');
  if (!/^[1-9][0-9]*$/u.test(currentRunId)) throw new Error('Current workflow run ID is invalid.');
  if (typeof token !== 'string' || token.length === 0) throw new Error('GitHub token is required.');

  const path = `/repos/${repository}${WORKFLOW_PATH}`;
  const rangeEnd = new Date(createdAt + MAX_DELIVERY_AGE_MS).toISOString();
  const query = new URLSearchParams({
    created: `${new Date(createdAt).toISOString()}..${rangeEnd}`,
    event: 'issue_comment',
    per_page: '100',
  });
  let url = `${API_ORIGIN}${path}?${query}`;
  let scannedRuns = 0;
  let expectedRunCount;
  for (let page = 0; page < MAX_RUN_PAGES; page += 1) {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub workflow-run lookup failed (${response.status}).`);
    const body = await response.json();
    if (
      !body ||
      !Array.isArray(body.workflow_runs) ||
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 0
    )
      throw new Error('GitHub workflow-run lookup returned an invalid response.');
    if (expectedRunCount === undefined) expectedRunCount = body.total_count;
    else if (body.total_count !== expectedRunCount)
      throw new Error('GitHub workflow-run history changed during pagination.');
    for (const run of body.workflow_runs) {
      if (
        !run ||
        typeof run !== 'object' ||
        typeof run.event !== 'string' ||
        typeof run.display_title !== 'string' ||
        typeof run.status !== 'string'
      ) {
        throw new Error('GitHub workflow-run lookup returned an invalid run record.');
      }
      if (isPreviouslyReportedRun(run, commentId, currentRunId)) return true;
    }
    scannedRuns += body.workflow_runs.length;
    if (body.total_count < scannedRuns)
      throw new Error('GitHub workflow-run pagination returned overlapping or inconsistent pages.');

    const next = nextPageUrl(response.headers.get('link'), path, query);
    if (!next) {
      if (body.total_count > scannedRuns || scannedRuns >= MAX_SEARCH_RESULTS)
        throw new Error('GitHub workflow-run history is truncated; refusing an unverified intake.');
      return false;
    }
    url = next;
  }
  throw new Error(`GitHub workflow-run history exceeded the ${MAX_RUN_PAGES}-page safety limit.`);
}

async function main() {
  const reported = await hasReportedIssueIntakeDelivery({
    repository: process.env.GITHUB_REPOSITORY ?? '',
    commentId: process.env.GITHUB_COMMENT_ID ?? '',
    commentCreatedAt: process.env.GITHUB_COMMENT_CREATED_AT ?? '',
    currentRunId: process.env.GITHUB_RUN_ID ?? '',
    token: process.env.GITHUB_TOKEN ?? '',
  });
  process.stdout.write(`skip=${reported ? 'true' : 'false'}\n`);
}

const isDirectExecution =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
