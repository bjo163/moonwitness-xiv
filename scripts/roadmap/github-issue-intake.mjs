import { planMaintainerIssueIntake } from './issue-intake.mjs';
import { taskIdCaptureSource, taskIdPattern } from './task-ids.mjs';

const markerPattern = new RegExp(
  `^<!-- moonwitness-task: ([1-9][0-9]*):${taskIdCaptureSource} -->$`,
  'gmu'
);
const commandPattern = /^\/mw (status|scope|close|reopen)(?: ([a-z_]+))? -- ([\s\S]{1,2000})$/u;

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function positiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Turn a raw GitHub `issue_comment` webhook payload into the inert event schema
 * accepted by `planMaintainerIssueIntake`. GitHub Actions authenticates the
 * webhook delivery; this adapter performs shape/identity checks only and has
 * no network or mutation capability.
 *
 * @param {{payload: unknown, expectedRepositoryId: string, expectedRepositoryName?: string}} input
 * @returns {{disposition: 'event', event: Record<string, unknown>} | {disposition: 'ignored'|'rejected', reason: string}}
 */
export function normalizeGitHubIssueComment({
  payload,
  expectedRepositoryId,
  expectedRepositoryName,
}) {
  if (typeof expectedRepositoryId !== 'string' || !/^[1-9][0-9]*$/u.test(expectedRepositoryId))
    return { disposition: 'rejected', reason: 'invalid-expected-repository-id' };
  const root = record(payload);
  if (!root) return { disposition: 'rejected', reason: 'invalid-payload' };
  if (root.action !== 'created')
    return { disposition: 'ignored', reason: 'unsupported-event-action' };

  const repository = record(root.repository);
  const issue = record(root.issue);
  const comment = record(root.comment);
  const actor = record(comment?.user);
  const repositoryId = repository?.id;
  if (!positiveSafeInteger(repositoryId) || String(repositoryId) !== expectedRepositoryId)
    return { disposition: 'ignored', reason: 'repository-mismatch' };
  if (
    expectedRepositoryName !== undefined &&
    (typeof repository?.full_name !== 'string' ||
      repository.full_name.toLowerCase() !== expectedRepositoryName.toLowerCase())
  )
    return { disposition: 'ignored', reason: 'repository-name-mismatch' };
  if (!positiveSafeInteger(issue?.number) || !positiveSafeInteger(comment?.id))
    return { disposition: 'rejected', reason: 'invalid-github-identity' };
  if (record(issue?.pull_request)) return { disposition: 'ignored', reason: 'pull-request' };
  if (actor?.type === 'Bot') return { disposition: 'ignored', reason: 'bot-echo' };
  if (typeof actor?.login !== 'string' || actor.login.trim().length === 0)
    return { disposition: 'rejected', reason: 'invalid-actor' };
  if (typeof issue?.body !== 'string')
    return { disposition: 'rejected', reason: 'missing-issue-body' };

  const markers = [...issue.body.matchAll(markerPattern)];
  if (markers.length !== 1 || markers[0][1] !== expectedRepositoryId)
    return { disposition: 'ignored', reason: 'unmanaged-or-ambiguous-issue' };
  const taskId = markers[0][2];
  if (!taskIdPattern.test(taskId)) return { disposition: 'rejected', reason: 'invalid-task-id' };

  if (typeof comment.body !== 'string')
    return { disposition: 'rejected', reason: 'invalid-comment' };
  const command = commandPattern.exec(comment.body);
  if (!command) return { disposition: 'ignored', reason: 'not-an-intake-command' };
  const [, action, argument, rationale] = command;
  if ((action === 'status' && !argument) || (action !== 'status' && argument))
    return { disposition: 'rejected', reason: 'invalid-command-arguments' };

  return {
    disposition: 'event',
    event: {
      repositoryId: expectedRepositoryId,
      deliveryId: `issue_comment_${comment.id}`,
      issueNumber: issue.number,
      taskId,
      actor: actor.login,
      isBot: false,
      pullRequest: false,
      action,
      rationale,
      ...(action === 'status' ? { status: argument } : {}),
      ...(action === 'scope' ? { proposal: rationale } : {}),
    },
  };
}

/**
 * Normalize an issue-comment payload, verify the actor's current repository
 * permission using GitHub's read-only collaborator API, then create an inert
 * proposal. Any permission lookup failure other than a definitive 404 fails
 * closed by throwing; no event text is included in the error.
 *
 * @param {{payload: unknown, expectedRepositoryId: string, owner: string, repo: string, token: string, fetchImpl?: typeof fetch}} input
 */
export async function planAuthorizedGitHubIssueComment({
  payload,
  expectedRepositoryId,
  owner,
  repo,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repo)
  )
    throw new Error('GitHub repository owner/name is invalid.');
  if (typeof token !== 'string' || token.length === 0)
    throw new Error('GitHub token is required to verify current actor permission.');

  const normalized = normalizeGitHubIssueComment({
    payload,
    expectedRepositoryId,
    expectedRepositoryName: `${owner}/${repo}`,
  });
  if (normalized.disposition !== 'event') return normalized;

  const permissionUrl =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/collaborators/${encodeURIComponent(normalized.event.actor)}/permission`;
  const response = await fetchImpl(permissionUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status === 404)
    return { disposition: 'ignored', reason: 'actor-not-repository-collaborator' };
  if (!response.ok)
    throw new Error(`GitHub actor permission could not be verified (HTTP ${response.status}).`);

  let permissionPayload;
  try {
    permissionPayload = record(await response.json());
  } catch {
    throw new Error('GitHub actor permission response was invalid.');
  }
  if (!permissionPayload || typeof permissionPayload.permission !== 'string')
    throw new Error('GitHub actor permission response was invalid.');
  const permission = permissionPayload?.permission;
  if (permission !== 'admin' && permission !== 'write')
    return { disposition: 'ignored', reason: 'actor-lacks-maintainer-permission' };

  const result = planMaintainerIssueIntake({
    event: normalized.event,
    expectedRepositoryId,
    maintainerLogins: new Set([normalized.event.actor]),
  });
  return result.disposition === 'proposal'
    ? {
        disposition: 'proposal',
        deliveryId: normalized.event.deliveryId,
        proposal: result.proposal,
      }
    : result;
}
