import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function flattenPages(value, key) {
  const values = Array.isArray(value) ? value.flat(Infinity) : [value];
  return values.flatMap((entry) => {
    if (Array.isArray(entry)) return flattenPages(entry, key);
    if (entry && typeof entry === 'object' && key in entry && Array.isArray(entry[key])) {
      return entry[key];
    }
    return entry && typeof entry === 'object' ? [entry] : [];
  });
}

function matchingRuns(runs, headSha, pullRequestNumber) {
  return flattenPages(runs, 'workflow_runs')
    .filter(
      (run) =>
        run.event === 'pull_request' &&
        run.head_sha === headSha &&
        Array.isArray(run.pull_requests) &&
        run.pull_requests.some((pullRequest) => pullRequest.number === pullRequestNumber)
    )
    .sort((left, right) => {
      const timeDifference = Date.parse(right.created_at) - Date.parse(left.created_at);
      return timeDifference || (right.run_attempt ?? 0) - (left.run_attempt ?? 0);
    });
}

export function selectReviewCiRun(runs, headSha, pullRequestNumber) {
  const run = matchingRuns(runs, headSha, pullRequestNumber)[0];
  if (!run) {
    throw new Error(`No pull_request CI run exists for PR #${pullRequestNumber} at ${headSha}.`);
  }
  if (run.status !== 'completed') {
    throw new Error(`The latest matching pull_request CI run ${run.id} is still ${run.status}.`);
  }
  return run;
}

export function verifyReviewCiEvidence(runs, jobs, headSha, pullRequestNumber, runId) {
  const run = selectReviewCiRun(runs, headSha, pullRequestNumber);
  if (String(run.id) !== String(runId)) {
    throw new Error(
      `The supplied CI run ${runId} is not the latest run for this exact PR and SHA.`
    );
  }
  const technicalGate = flattenPages(jobs, 'jobs').find((job) => job.name === 'ci-technical-gate');
  if (technicalGate?.status !== 'completed' || technicalGate.conclusion !== 'success') {
    throw new Error(
      `The exact-head technical gate for CI run ${runId} did not succeed (status: ${technicalGate?.status ?? 'missing'}, conclusion: ${technicalGate?.conclusion ?? 'missing'}).`
    );
  }
  return `Verified successful ci-technical-gate for PR #${pullRequestNumber} at ${headSha} (run ${runId}).`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main(args) {
  const [command, headSha, pullRequestNumberText, ...paths] = args;
  const pullRequestNumber = Number(pullRequestNumberText);
  if (!headSha || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error('A head SHA and positive pull request number are required.');
  }

  if (command === 'select' && paths.length === 1) {
    const run = selectReviewCiRun(await readJson(paths[0]), headSha, pullRequestNumber);
    process.stdout.write(`${run.id}\n`);
    return;
  }
  if (command === 'verify' && paths.length === 3) {
    const [runId, runsPath, jobsPath] = paths;
    const message = verifyReviewCiEvidence(
      await readJson(runsPath),
      await readJson(jobsPath),
      headSha,
      pullRequestNumber,
      runId
    );
    process.stdout.write(`${message}\n`);
    return;
  }
  throw new Error(
    'Usage: node scripts/review-ci-evidence.mjs select <head-sha> <pr-number> <runs.json> | verify <head-sha> <pr-number> <run-id> <runs.json> <jobs.json>'
  );
}

const isDirectExecution =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
