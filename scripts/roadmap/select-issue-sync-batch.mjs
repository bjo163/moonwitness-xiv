import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { taskIdPattern } from './task-ids.mjs';

const maximumBatchSize = 5;

/**
 * Selects deterministic pending create/update operations without crossing the write cap.
 * Conflicts are intentionally left for maintainer triage.
 * @param {{operations: Array<{taskId: string, operation: string}>}} plan
 * @param {number} [limit]
 * @returns {string[]}
 */
export function selectIssueSyncBatch(plan, limit = maximumBatchSize) {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumBatchSize)
    throw new Error(`Batch limit must be between 1 and ${maximumBatchSize}.`);
  if (!plan || !Array.isArray(plan.operations))
    throw new Error('Issue sync plan must contain an operations array.');
  const selected = [];
  const seen = new Set();
  for (const operation of plan.operations) {
    if (!operation || !taskIdPattern.test(operation.taskId))
      throw new Error('Issue sync plan contains an invalid task ID.');
    if (seen.has(operation.taskId))
      throw new Error(`Duplicate task operation: ${operation.taskId}.`);
    seen.add(operation.taskId);
    if (operation.operation === 'create' || operation.operation === 'update')
      selected.push(operation.taskId);
  }
  return selected.slice(0, limit);
}

async function main() {
  const planPath = process.argv[2];
  if (!planPath || process.argv.length !== 3)
    throw new Error('Usage: node select-issue-sync-batch.mjs <plan.json>');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  process.stdout.write(selectIssueSyncBatch(plan).join(','));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
