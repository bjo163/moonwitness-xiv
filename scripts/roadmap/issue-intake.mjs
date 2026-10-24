import { taskIdPattern } from './task-ids.mjs';
const allowedActions = new Set(['status', 'scope', 'close', 'reopen']);
const allowedStatuses = new Set(['planned', 'in_progress', 'blocked', 'complete']);
const maximumProposalLength = 2000;

function boundedText(value, field, maximum = maximumProposalLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum)
    throw new Error(`${field} must be non-empty text no longer than ${maximum} characters.`);
  return value.trim();
}

/**
 * Convert a previously authenticated GitHub issue/comment event to a safe proposal.
 * This function does not call Git, GitHub, a shell, or the network.
 * @param {{event: Record<string, unknown>, expectedRepositoryId: string, maintainerLogins: ReadonlySet<string>, botLogins?: ReadonlySet<string>, lifecycle?: {acceptanceVerified: boolean, sourceSha?: string}}} input
 */
export function planMaintainerIssueIntake(input) {
  const { event, expectedRepositoryId, maintainerLogins, botLogins = new Set(), lifecycle } = input;
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new Error('Issue event must be an object.');

  const repositoryId = String(event.repositoryId ?? '');
  if (repositoryId !== expectedRepositoryId)
    return { disposition: 'ignored', reason: 'repository-mismatch' };
  if (event.pullRequest === true || event.isBot === true)
    return { disposition: 'ignored', reason: event.isBot ? 'bot-echo' : 'pull-request' };

  const actor = typeof event.actor === 'string' ? event.actor.toLowerCase() : '';
  const bots = new Set([...botLogins].map((login) => login.toLowerCase()));
  if (!actor || bots.has(actor)) return { disposition: 'ignored', reason: 'bot-echo' };
  const maintainers = new Set([...maintainerLogins].map((login) => login.toLowerCase()));
  if (!maintainers.has(actor)) return { disposition: 'ignored', reason: 'actor-not-maintainer' };

  const taskId = event.taskId;
  if (typeof taskId !== 'string' || !taskIdPattern.test(taskId))
    return { disposition: 'rejected', reason: 'invalid-task-id' };
  if (
    typeof event.issueNumber !== 'number' ||
    !Number.isSafeInteger(event.issueNumber) ||
    event.issueNumber < 1
  )
    return { disposition: 'rejected', reason: 'invalid-issue-number' };
  const deliveryId = event.deliveryId;
  if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(deliveryId))
    return { disposition: 'rejected', reason: 'invalid-delivery-id' };

  const action = event.action;
  if (typeof action !== 'string' || !allowedActions.has(action))
    return { disposition: 'rejected', reason: 'unsupported-action' };
  if (action === 'status') {
    if (typeof event.status !== 'string' || !allowedStatuses.has(event.status))
      return { disposition: 'rejected', reason: 'unsupported-status' };
    return {
      disposition: 'proposal',
      proposal: {
        kind: 'roadmap-status',
        deliveryId,
        taskId,
        issueNumber: event.issueNumber,
        actor,
        requestedStatus: event.status,
        rationale: boundedText(event.rationale, 'rationale'),
        instruction:
          'Maintainer must edit ROADMAP.md and evidence on dev; no status is accepted automatically.',
      },
    };
  }

  if (action === 'scope') {
    return {
      disposition: 'proposal',
      proposal: {
        kind: 'roadmap-scope',
        deliveryId,
        taskId,
        issueNumber: event.issueNumber,
        actor,
        rationale: boundedText(event.rationale, 'rationale'),
        requestedChange: boundedText(event.proposal, 'proposal'),
        instruction: 'Review as source diff on dev; issue content is never executed or fetched.',
      },
    };
  }

  const shouldBeClosed = action === 'close';
  if (!shouldBeClosed && action !== 'reopen')
    return { disposition: 'rejected', reason: 'unsupported-action' };
  if (
    shouldBeClosed &&
    lifecycle?.acceptanceVerified === true &&
    typeof lifecycle.sourceSha === 'string' &&
    /^[0-9a-f]{40}$/iu.test(lifecycle.sourceSha)
  )
    return {
      disposition: 'proposal',
      proposal: {
        kind: 'issue-close-review',
        deliveryId,
        taskId,
        issueNumber: event.issueNumber,
        actor,
        sourceSha: lifecycle.sourceSha,
        instruction:
          'Close only after the trusted lifecycle reconciler confirms all required delivery gates.',
      },
    };
  return {
    disposition: 'proposal',
    proposal: {
      kind: 'issue-triage',
      deliveryId,
      taskId,
      issueNumber: event.issueNumber,
      actor,
      requestedAction: shouldBeClosed ? 'close' : 'reopen',
      rationale: boundedText(event.rationale, 'rationale'),
      instruction:
        'Manual issue state is intent only; reconcile source evidence without an automatic close/reopen loop.',
    },
  };
}
