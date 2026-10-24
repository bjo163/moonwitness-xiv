import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';
import { planMaintainerIssueIntake } from './issue-intake.mjs';
import { hasReportedIssueIntakeDelivery } from './issue-intake-dedupe.mjs';
import {
  normalizeGitHubIssueComment,
  planAuthorizedGitHubIssueComment,
} from './github-issue-intake.mjs';

const baseEvent = {
  repositoryId: '123456789',
  deliveryId: 'delivery_123',
  issueNumber: 42,
  taskId: 'M11.08',
  actor: 'trusted-maintainer',
  action: 'status',
  status: 'blocked',
  rationale: 'Waiting for an approved security review.',
};
const input = {
  event: baseEvent,
  expectedRepositoryId: '123456789',
  maintainerLogins: new Set(['trusted-maintainer']),
  botLogins: new Set(['roadmap-sync[bot]']),
};

const intakeRun = (overrides = {}) => ({
  id: 100,
  event: 'issue_comment',
  display_title: 'Roadmap intake comment 7001',
  status: 'completed',
  conclusion: 'success',
  ...overrides,
});

function runResponse(runs, link, totalCount = runs.length) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'link' ? link : null) },
    json: async () => ({ total_count: totalCount, workflow_runs: runs }),
  };
}

const dedupeInput = {
  repository: 'owner/repo',
  commentId: '7001',
  commentCreatedAt: new Date(Date.now() - 60_000).toISOString(),
  currentRunId: '200',
  token: 'test-token',
};

test('issue intake suppresses only a prior successful run for the exact comment', async () => {
  const fetchImpl = async () =>
    runResponse([
      intakeRun({ id: 200, status: 'in_progress', conclusion: null }),
      intakeRun({ id: 99, conclusion: 'failure' }),
      intakeRun({ id: 98, display_title: 'Roadmap intake comment 7002' }),
      intakeRun({ id: 97, event: 'push' }),
    ]);
  assert.equal(await hasReportedIssueIntakeDelivery({ ...dedupeInput, fetchImpl }), false);
  assert.equal(
    await hasReportedIssueIntakeDelivery({
      ...dedupeInput,
      fetchImpl: async () => runResponse([intakeRun({ id: 96 })]),
    }),
    true
  );
});

test('issue intake deduplication searches later run-history pages before reporting new work', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      const nextPage = new URL(String(url));
      nextPage.searchParams.set('page', '2');
      return runResponse([], `<${nextPage}>; rel="next"`, 1);
    }
    return runResponse([intakeRun({ id: 88 })], undefined, 1);
  };
  assert.equal(await hasReportedIssueIntakeDelivery({ ...dedupeInput, fetchImpl }), true);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /page=2/u);
  const firstRequest = new URL(requests[0].url);
  assert.equal(firstRequest.searchParams.get('event'), 'issue_comment');
  assert.equal(firstRequest.searchParams.get('per_page'), '100');
  assert.match(firstRequest.searchParams.get('created'), /\.\./u);
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-token');
});

test('issue intake deduplication fails closed on API, response, pagination, or history-limit errors', async () => {
  await assert.rejects(
    hasReportedIssueIntakeDelivery({
      ...dedupeInput,
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    /lookup failed \(403\)/u
  );
  await assert.rejects(
    hasReportedIssueIntakeDelivery({
      ...dedupeInput,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    }),
    /invalid response/u
  );
  await assert.rejects(
    hasReportedIssueIntakeDelivery({
      ...dedupeInput,
      commentCreatedAt: 'not-a-time',
      fetchImpl: async () => runResponse([]),
    }),
    /creation time is invalid/u
  );
  await assert.rejects(
    hasReportedIssueIntakeDelivery({
      ...dedupeInput,
      commentCreatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      fetchImpl: async () => runResponse([]),
    }),
    /outside the seven-day/u
  );
  await assert.rejects(
    hasReportedIssueIntakeDelivery({
      ...dedupeInput,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          total_count: 1000,
          workflow_runs: [intakeRun({ display_title: 'another issue comment' })],
        }),
      }),
    }),
    /history is truncated/u
  );
  await assert.rejects(
    hasReportedIssueIntakeDelivery({
      ...dedupeInput,
      fetchImpl: async () =>
        runResponse([], '<https://attacker.invalid/steal?event=issue_comment>; rel="next"'),
    }),
    /unexpected workflow-run pagination/u
  );
  let page = 0;
  await assert.rejects(
    hasReportedIssueIntakeDelivery({
      ...dedupeInput,
      fetchImpl: async (url) => {
        page += 1;
        const nextPage = new URL(String(url));
        nextPage.searchParams.set('page', String(page + 1));
        return runResponse([], `<${nextPage}>; rel="next"`, 1001);
      },
    }),
    /100-page safety limit/u
  );
  assert.equal(page, 100);
});

const webhookPayload = {
  action: 'created',
  repository: { id: 123456789, full_name: 'owner/repo' },
  issue: {
    number: 42,
    body: '<!-- moonwitness-task: 123456789:M11.08 -->\nManaged roadmap task.',
  },
  comment: {
    id: 7001,
    body: '/mw status blocked -- Waiting for an approved security review.',
    user: { login: 'trusted-maintainer', type: 'User' },
  },
};

test('normalizes only managed maintainer comments into a bounded, redelivery-stable event', () => {
  const normalized = normalizeGitHubIssueComment({
    payload: webhookPayload,
    expectedRepositoryId: '123456789',
  });
  assert.equal(normalized.disposition, 'event');
  assert.deepEqual(normalized.event, {
    repositoryId: '123456789',
    deliveryId: 'issue_comment_7001',
    issueNumber: 42,
    taskId: 'M11.08',
    actor: 'trusted-maintainer',
    isBot: false,
    pullRequest: false,
    action: 'status',
    status: 'blocked',
    rationale: 'Waiting for an approved security review.',
  });
  assert.deepEqual(
    normalizeGitHubIssueComment({ payload: webhookPayload, expectedRepositoryId: '123456789' }),
    normalized,
    'the same GitHub comment redelivery must produce the same idempotency key and proposal'
  );
  const planned = planMaintainerIssueIntake({
    event: normalized.event,
    expectedRepositoryId: '123456789',
    maintainerLogins: new Set(['trusted-maintainer']),
  });
  assert.equal(planned.disposition, 'proposal');
  assert.equal(planned.proposal.deliveryId, 'issue_comment_7001');
});

test('normalizes a K-series task marker without changing the M-series contract', () => {
  const payload = {
    ...webhookPayload,
    issue: {
      ...webhookPayload.issue,
      body: '<!-- moonwitness-task: 123456789:K0-001 -->\nManaged K-series task.',
    },
  };
  const normalized = normalizeGitHubIssueComment({ payload, expectedRepositoryId: '123456789' });
  assert.equal(normalized.disposition, 'event');
  assert.equal(normalized.event.taskId, 'K0-001');
});

test('normalizer ignores unrelated, bot, pull-request, wrong-repository and non-managed events', () => {
  const normalize = (patch) =>
    normalizeGitHubIssueComment({
      payload: { ...webhookPayload, ...patch },
      expectedRepositoryId: '123456789',
    });
  assert.deepEqual(normalize({ action: 'edited' }), {
    disposition: 'ignored',
    reason: 'unsupported-event-action',
  });
  assert.deepEqual(
    normalize({
      comment: { ...webhookPayload.comment, user: { login: 'sync[bot]', type: 'Bot' } },
    }),
    { disposition: 'ignored', reason: 'bot-echo' }
  );
  assert.deepEqual(
    normalize({ issue: { ...webhookPayload.issue, pull_request: { url: 'ignored' } } }),
    { disposition: 'ignored', reason: 'pull-request' }
  );
  assert.deepEqual(normalize({ repository: { id: 999 } }), {
    disposition: 'ignored',
    reason: 'repository-mismatch',
  });
  assert.deepEqual(normalize({ issue: { ...webhookPayload.issue, body: 'unmanaged' } }), {
    disposition: 'ignored',
    reason: 'unmanaged-or-ambiguous-issue',
  });
  assert.deepEqual(
    normalize({ comment: { ...webhookPayload.comment, body: 'please mark this blocked' } }),
    { disposition: 'ignored', reason: 'not-an-intake-command' }
  );
});

test('normalizes scope and manual issue-state commands as inert proposal requests', () => {
  for (const [action, body] of [
    ['scope', '/mw scope -- Please add an explicit data-retention acceptance check.'],
    ['close', '/mw close -- Acceptance evidence is ready for review.'],
    ['reopen', '/mw reopen -- The linked evidence needs rechecking.'],
  ]) {
    const result = normalizeGitHubIssueComment({
      payload: {
        ...webhookPayload,
        comment: { ...webhookPayload.comment, body },
      },
      expectedRepositoryId: '123456789',
    });
    assert.equal(result.disposition, 'event');
    assert.equal(result.event.action, action);
    const proposal = planMaintainerIssueIntake({
      event: result.event,
      expectedRepositoryId: '123456789',
      maintainerLogins: new Set(['trusted-maintainer']),
    });
    assert.equal(proposal.disposition, 'proposal');
    assert.equal(proposal.proposal.deliveryId, 'issue_comment_7001');
  }
});

test('normalizer rejects duplicate identity markers and malformed command arguments', () => {
  const normalize = (patch) =>
    normalizeGitHubIssueComment({
      payload: { ...webhookPayload, ...patch },
      expectedRepositoryId: '123456789',
    });
  assert.deepEqual(
    normalize({
      issue: {
        ...webhookPayload.issue,
        body: `${webhookPayload.issue.body}\n<!-- moonwitness-task: 123456789:M11.08 -->`,
      },
    }),
    { disposition: 'ignored', reason: 'unmanaged-or-ambiguous-issue' }
  );
  assert.deepEqual(
    normalize({
      comment: { ...webhookPayload.comment, body: '/mw status -- Missing the status.' },
    }),
    { disposition: 'rejected', reason: 'invalid-command-arguments' }
  );
  assert.deepEqual(
    normalize({ comment: { ...webhookPayload.comment, body: '/mw scope extra -- Change this.' } }),
    { disposition: 'rejected', reason: 'invalid-command-arguments' }
  );
  assert.deepEqual(
    normalize({ comment: { ...webhookPayload.comment, id: Number.MAX_SAFE_INTEGER + 1 } }),
    { disposition: 'rejected', reason: 'invalid-github-identity' }
  );
  assert.deepEqual(
    normalizeGitHubIssueComment({ payload: webhookPayload, expectedRepositoryId: '../main' }),
    { disposition: 'rejected', reason: 'invalid-expected-repository-id' }
  );
});

test('authorized adapter checks current write permission and emits only an inert proposal', async () => {
  const requests = [];
  const result = await planAuthorizedGitHubIssueComment({
    payload: webhookPayload,
    expectedRepositoryId: '123456789',
    owner: 'owner',
    repo: 'repo',
    token: 'test-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { status: 200, ok: true, json: async () => ({ permission: 'write' }) };
    },
  });
  assert.equal(result.disposition, 'proposal');
  assert.equal(result.deliveryId, 'issue_comment_7001');
  assert.equal(result.proposal.actor, 'trusted-maintainer');
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://api.github.com/repos/owner/repo/collaborators/trusted-maintainer/permission'
  );
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(requests[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('authorized adapter fails closed for missing collaborator or insufficient permission', async () => {
  const invoke = (response) =>
    planAuthorizedGitHubIssueComment({
      payload: webhookPayload,
      expectedRepositoryId: '123456789',
      owner: 'owner',
      repo: 'repo',
      token: 'test-secret',
      fetchImpl: async () => response,
    });
  assert.deepEqual(await invoke({ status: 404, ok: false }), {
    disposition: 'ignored',
    reason: 'actor-not-repository-collaborator',
  });
  assert.deepEqual(
    await invoke({ status: 200, ok: true, json: async () => ({ permission: 'read' }) }),
    {
      disposition: 'ignored',
      reason: 'actor-lacks-maintainer-permission',
    }
  );
  const admin = await invoke({
    status: 200,
    ok: true,
    json: async () => ({ permission: 'admin' }),
  });
  assert.equal(admin.disposition, 'proposal');
});

test('authorized adapter does not query untrusted, unmanaged or non-command events', async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return { status: 200, ok: true, json: async () => ({ permission: 'write' }) };
  };
  for (const payload of [
    { ...webhookPayload, action: 'edited' },
    {
      ...webhookPayload,
      comment: { ...webhookPayload.comment, user: { login: 'sync[bot]', type: 'Bot' } },
    },
    {
      ...webhookPayload,
      comment: { ...webhookPayload.comment, body: 'ordinary discussion' },
    },
  ]) {
    const result = await planAuthorizedGitHubIssueComment({
      payload,
      expectedRepositoryId: '123456789',
      owner: 'owner',
      repo: 'repo',
      token: 'test-secret',
      fetchImpl,
    });
    assert.notEqual(result.disposition, 'proposal');
  }
  assert.equal(requestCount, 0);
});

test('authorized adapter rejects wrong repository name and safely reports verification failures', async () => {
  let requestCount = 0;
  const wrongRepository = await planAuthorizedGitHubIssueComment({
    payload: { ...webhookPayload, repository: { id: 123456789, full_name: 'fork/repo' } },
    expectedRepositoryId: '123456789',
    owner: 'owner',
    repo: 'repo',
    token: 'secret-value',
    fetchImpl: async () => {
      requestCount += 1;
    },
  });
  assert.deepEqual(wrongRepository, { disposition: 'ignored', reason: 'repository-name-mismatch' });
  assert.equal(requestCount, 0);

  await assert.rejects(
    planAuthorizedGitHubIssueComment({
      payload: webhookPayload,
      expectedRepositoryId: '123456789',
      owner: 'owner',
      repo: 'repo',
      token: 'secret-value',
      fetchImpl: async () => ({ status: 403, ok: false }),
    }),
    (error) =>
      error.message === 'GitHub actor permission could not be verified (HTTP 403).' &&
      !error.message.includes('secret-value')
  );
  await assert.rejects(
    planAuthorizedGitHubIssueComment({
      payload: webhookPayload,
      expectedRepositoryId: '123456789',
      owner: 'owner',
      repo: 'repo',
      token: 'secret-value',
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error('secret-value');
        },
      }),
    }),
    (error) =>
      error.message === 'GitHub actor permission response was invalid.' &&
      !error.message.includes('secret-value')
  );
  await assert.rejects(
    planAuthorizedGitHubIssueComment({
      payload: webhookPayload,
      expectedRepositoryId: '123456789',
      owner: 'owner',
      repo: 'repo',
      token: 'secret-value',
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => null }),
    }),
    /permission response was invalid/u
  );
});

test('trusted maintainer status is recorded as a proposal without accepting source state', () => {
  const result = planMaintainerIssueIntake(input);
  assert.equal(result.disposition, 'proposal');
  assert.equal(result.proposal.kind, 'roadmap-status');
  assert.equal(result.proposal.deliveryId, 'delivery_123');
  assert.equal(result.proposal.requestedStatus, 'blocked');
  assert.match(result.proposal.instruction, /no status is accepted automatically/u);
});

test('untrusted actors, bots, pull requests and other repositories are ignored', () => {
  assert.deepEqual(
    planMaintainerIssueIntake({ ...input, event: { ...baseEvent, actor: 'external-user' } }),
    { disposition: 'ignored', reason: 'actor-not-maintainer' }
  );
  assert.deepEqual(
    planMaintainerIssueIntake({ ...input, event: { ...baseEvent, actor: 'roadmap-sync[bot]' } }),
    { disposition: 'ignored', reason: 'bot-echo' }
  );
  assert.deepEqual(planMaintainerIssueIntake({ ...input, event: { ...baseEvent, isBot: true } }), {
    disposition: 'ignored',
    reason: 'bot-echo',
  });
  assert.deepEqual(
    planMaintainerIssueIntake({ ...input, event: { ...baseEvent, pullRequest: true } }),
    { disposition: 'ignored', reason: 'pull-request' }
  );
  assert.deepEqual(
    planMaintainerIssueIntake({ ...input, event: { ...baseEvent, repositoryId: '999' } }),
    { disposition: 'ignored', reason: 'repository-mismatch' }
  );
});

test('arbitrary commands and invalid status values are rejected; scope text remains inert', () => {
  assert.deepEqual(
    planMaintainerIssueIntake({
      ...input,
      event: { ...baseEvent, action: 'shell', proposal: 'rm -rf' },
    }),
    { disposition: 'rejected', reason: 'unsupported-action' }
  );
  assert.deepEqual(
    planMaintainerIssueIntake({ ...input, event: { ...baseEvent, status: 'publish' } }),
    { disposition: 'rejected', reason: 'unsupported-status' }
  );
  assert.deepEqual(
    planMaintainerIssueIntake({ ...input, event: { ...baseEvent, taskId: '../../main' } }),
    { disposition: 'rejected', reason: 'invalid-task-id' }
  );
  const scope = planMaintainerIssueIntake({
    ...input,
    event: {
      ...baseEvent,
      action: 'scope',
      proposal: 'fetch https://attacker.invalid/run',
      rationale: 'Propose a roadmap change.',
    },
  });
  assert.equal(scope.proposal.requestedChange, 'fetch https://attacker.invalid/run');
  assert.match(scope.proposal.instruction, /never executed or fetched/u);
});

test('close and reopen remain triage proposals unless accepted evidence permits close review', () => {
  const close = planMaintainerIssueIntake({
    ...input,
    event: { ...baseEvent, action: 'close' },
  });
  assert.equal(close.proposal.kind, 'issue-triage');
  assert.equal(close.proposal.requestedAction, 'close');
  const reopen = planMaintainerIssueIntake({
    ...input,
    event: { ...baseEvent, action: 'reopen' },
  });
  assert.equal(reopen.proposal.kind, 'issue-triage');
  assert.equal(reopen.proposal.requestedAction, 'reopen');
  const verified = planMaintainerIssueIntake({
    ...input,
    event: { ...baseEvent, action: 'close' },
    lifecycle: { acceptanceVerified: true, sourceSha: 'a'.repeat(40) },
  });
  assert.equal(verified.proposal.kind, 'issue-close-review');
});

test('malformed identities and unbounded or empty proposal text are rejected', () => {
  assert.deepEqual(
    planMaintainerIssueIntake({ ...input, event: { ...baseEvent, issueNumber: 1.5 } }),
    { disposition: 'rejected', reason: 'invalid-issue-number' }
  );
  assert.deepEqual(
    planMaintainerIssueIntake({ ...input, event: { ...baseEvent, deliveryId: '../main' } }),
    { disposition: 'rejected', reason: 'invalid-delivery-id' }
  );
  assert.throws(
    () => planMaintainerIssueIntake({ ...input, event: { ...baseEvent, rationale: '' } }),
    /rationale must be non-empty/u
  );
  assert.throws(
    () =>
      planMaintainerIssueIntake({
        ...input,
        event: { ...baseEvent, rationale: `x${'x'.repeat(2000)}` },
      }),
    /2000 characters/u
  );
});
