import { taskIdPattern } from './task-ids.mjs';

const taskStatuses = new Set(['todo', 'in_progress', 'blocked', 'complete']);
const checkConclusions = new Set([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
]);

function isFullSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

/**
 * Derive work completion and delivery from explicit source/GitHub evidence.
 * This function is deliberately pure: callers must obtain all facts from
 * validated source files and GitHub metadata for the exact SHA under review.
 *
 * @param {{ taskId: string, status: 'todo'|'in_progress'|'blocked'|'complete', dependencyIds?: string[], incompleteDependencyIds?: string[], acceptanceVerified: boolean, evidenceSha?: string, sourceSha?: string, devHeadSha?: string, sourceInDev?: boolean, requiredChecks?: Array<{name: string, headSha: string, status: 'queued'|'in_progress'|'completed', conclusion: string|null}>, mainHeadSha?: string, sourceInMain?: boolean, releaseManifest?: {version: string, sourceSha: string, releaseSha: string}|null, releaseContainsSource?: boolean, issueState?: 'open'|'closed' }} input
 */
export function evaluateTaskLifecycle(input) {
  if (!taskIdPattern.test(input.taskId))
    throw new Error('taskId must be a stable roadmap task ID.');
  if (!taskStatuses.has(input.status)) throw new Error(`Unsupported task status: ${input.status}.`);
  if (typeof input.acceptanceVerified !== 'boolean')
    throw new Error('acceptanceVerified must be an explicit boolean.');

  const dependencyIds = input.dependencyIds ?? [];
  const incompleteDependencyIds = [...new Set(input.incompleteDependencyIds ?? [])];
  if (incompleteDependencyIds.some((id) => !dependencyIds.includes(id)))
    throw new Error('Incomplete dependency IDs must be declared task dependencies.');
  const blockers = incompleteDependencyIds.map((id) => `Dependency ${id} is not complete.`);

  if (input.status === 'complete' && !input.acceptanceVerified)
    throw new Error('A complete task requires verified acceptance evidence.');
  if (input.status !== 'complete' && input.acceptanceVerified)
    throw new Error('Verified acceptance evidence requires task status complete.');
  if (input.acceptanceVerified && !isFullSha(input.evidenceSha))
    throw new Error('Verified acceptance evidence must identify a full source SHA.');
  if (input.sourceSha !== undefined && !isFullSha(input.sourceSha))
    throw new Error('sourceSha must be a full lowercase Git commit SHA.');
  if (input.evidenceSha !== undefined && !isFullSha(input.evidenceSha))
    throw new Error('evidenceSha must be a full lowercase Git commit SHA.');

  let workStatus = input.status === 'todo' ? 'planned' : input.status;
  if (blockers.length && input.status !== 'complete') workStatus = 'blocked';

  const sourceSha = input.sourceSha;
  let deliveryStage = 'planned';
  let verifiedOnDevSha;
  if (input.acceptanceVerified && !sourceSha)
    blockers.push('No implementation source SHA is recorded for delivery verification.');
  if (
    input.acceptanceVerified &&
    sourceSha &&
    input.sourceInDev !== true &&
    input.sourceInMain !== true
  )
    blockers.push('Implementation source commit is not verified in dev or main.');
  if (input.sourceInDev === true && !input.devHeadSha)
    throw new Error('Verified dev ancestry requires the current dev head SHA.');
  if (sourceSha && input.devHeadSha !== undefined && input.devHeadSha !== null) {
    if (!isFullSha(input.devHeadSha))
      throw new Error('devHeadSha must be a full lowercase Git SHA.');
    if (input.sourceInDev === true) {
      const checks = input.requiredChecks ?? [];
      if (!checks.length)
        blockers.push('No required checks were supplied for the current dev SHA.');
      const seenNames = new Set();
      for (const check of checks) {
        if (!check.name || seenNames.has(check.name))
          throw new Error('Required check names must be non-empty and unique.');
        seenNames.add(check.name);
        if (
          !isFullSha(check.headSha) ||
          !['queued', 'in_progress', 'completed'].includes(check.status) ||
          (check.status === 'completed' && !checkConclusions.has(check.conclusion)) ||
          (check.status !== 'completed' && check.conclusion !== null)
        )
          throw new Error(`Required check ${check.name} has invalid SHA or conclusion metadata.`);
        if (
          check.headSha !== input.devHeadSha ||
          check.status !== 'completed' ||
          check.conclusion !== 'success'
        )
          blockers.push(`Required check ${check.name} did not succeed on the current dev SHA.`);
      }
      if (
        checks.length &&
        checks.every(
          (check) =>
            check.headSha === input.devHeadSha &&
            check.status === 'completed' &&
            check.conclusion === 'success'
        )
      ) {
        deliveryStage = 'verified-dev';
        verifiedOnDevSha = input.devHeadSha;
      }
    }
  }

  if (input.sourceInMain === true) {
    if (!sourceSha || !isFullSha(input.mainHeadSha))
      throw new Error('Verified main ancestry requires sourceSha and full mainHeadSha.');
    deliveryStage = 'in-main';
  }

  let releaseVersion;
  if (input.releaseManifest) {
    const release = input.releaseManifest;
    if (!sourceSha || !isFullSha(release.sourceSha))
      throw new Error('Release provenance must contain the task source SHA.');
    if (!isFullSha(release.releaseSha))
      throw new Error('Release provenance must contain the full release tag commit SHA.');
    if (release.sourceSha !== sourceSha)
      throw new Error('Release provenance source SHA must match the task source SHA.');
    if (input.sourceInMain !== true)
      throw new Error('A release cannot be accepted before the source is verified in main.');
    if (
      !/^(?:v)?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(
        release.version
      )
    )
      throw new Error(`Invalid release version: ${release.version}.`);
    if (input.releaseContainsSource === true) {
      releaseVersion = release.version;
      deliveryStage = 'released';
    }
  }

  const issueState = input.issueState ?? 'open';
  if (issueState !== 'open' && issueState !== 'closed')
    throw new Error('issueState must be open or closed.');
  const needsTriage = issueState === 'closed' && workStatus !== 'complete';
  const shouldClose =
    issueState === 'open' &&
    workStatus === 'complete' &&
    blockers.length === 0 &&
    ['verified-dev', 'in-main', 'released'].includes(deliveryStage);

  return {
    taskId: input.taskId,
    workStatus,
    deliveryStage,
    issueState,
    needsTriage,
    shouldClose,
    blockers: [...new Set(blockers)],
    ...(verifiedOnDevSha ? { verifiedOnDevSha } : {}),
    ...(releaseVersion ? { releaseVersion } : {}),
  };
}
