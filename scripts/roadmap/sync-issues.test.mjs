import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL, URLSearchParams } from 'node:url';
import {
  applyIssuePlan,
  createGitHubIssuesClient,
  planIssueSync,
  renderIssuePlanSummary,
  renderTaskCardDetails,
  selectTasksForSync,
} from './sync-issues.mjs';

const task = {
  id: 'M11.03',
  title: 'Build planner',
  milestone: 'M11',
  dependsOn: ['M11.02'],
  detailFile: 'docs/roadmap/11-issues-delivery.md',
  output: 'Planner and tests',
};
const sourceSha = 'a'.repeat(40);
const repositoryId = '123456789';

function plan(issues = [], tasks = [task]) {
  return planIssueSync({ tasks, issues, repositoryId, sourceSha });
}

test('plan defaults to create and repeated identical remote state becomes no-op', () => {
  const first = plan();
  assert.equal(first.operations[0].operation, 'create');
  const issue = {
    number: 17,
    title: first.operations[0].title,
    body: first.operations[0].body,
    state: 'open',
    labels: first.operations[0].labels.map((name) => ({ name })),
    milestone: { number: 11, title: 'M11' },
  };
  assert.equal(plan([issue]).operations[0].operation, 'noop');
});

test('projects K-series IDs into the same issue marker and idempotent planner contract', () => {
  const kTask = {
    ...task,
    id: 'K0-001',
    title: 'K foundation',
    milestone: 'K0',
    dependsOn: [],
    detailFile: 'docs/roadmap/12-local-ai-rebuild.md',
  };
  const first = plan([], [kTask]);
  assert.match(first.operations[0].body, /moonwitness-task: 123456789:K0-001/u);
  const issue = {
    number: 51,
    title: first.operations[0].title,
    body: first.operations[0].body,
    state: 'open',
    labels: first.operations[0].labels.map((name) => ({ name })),
    milestone: { number: 100, title: 'K0' },
  };
  assert.equal(plan([issue], [kTask]).operations[0].operation, 'noop');
});

test('task selection requires exact unique IDs and limits explicit writes to five tasks', () => {
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    ...task,
    id: `M11.0${index + 1}`,
  }));
  assert.equal(selectTasksForSync(tasks, undefined).length, 6);
  assert.deepEqual(
    selectTasksForSync(tasks, 'M11.04,M11.02', true).map(({ id }) => id),
    ['M11.02', 'M11.04']
  );
  assert.throws(() => selectTasksForSync(tasks, undefined, true), /explicit --task-ids/u);
  assert.throws(() => selectTasksForSync(tasks, 'M11.01,M11.01'), /duplicates/u);
  assert.throws(() => selectTasksForSync(tasks, 'M11.01,', true), /comma-separated/u);
  assert.throws(() => selectTasksForSync(tasks, 'M11.99'), /Unknown roadmap task/u);
  assert.throws(
    () => selectTasksForSync(tasks, 'M11.01,M11.02,M11.03,M11.04,M11.05,M11.06', true),
    /limited to 5 tasks/u
  );
});

test('selects a K-series task by its exact stable ID', () => {
  const kTask = { ...task, id: 'K0-001', milestone: 'K0' };
  assert.deepEqual(
    selectTasksForSync([kTask], 'K0-001', true).map(({ id }) => id),
    ['K0-001']
  );
});

test('issue plan summary is useful for operators without rendering issue bodies', () => {
  const desired = plan();
  const summary = renderIssuePlanSummary(desired);
  assert.match(summary, new RegExp(`source SHA: ${sourceSha}`, 'u'));
  assert.match(summary, /create: M11\.03/u);
  assert.doesNotMatch(summary, /BEGIN MOONWITNESS MANAGED/u);
  assert.doesNotMatch(summary, /Build planner/u);
});

test('issue sync workflow bounds changed-task and backlog writes to an exact dev source', async () => {
  // The job slices below anchor on LF; a Windows checkout carries CRLF.
  const workflow = (
    await readFile(
      new URL('../../.github/workflows/roadmap-issue-plan.yml', import.meta.url),
      'utf8'
    )
  ).replaceAll('\r\n', '\n');
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const applyBoundary = jobs.indexOf('\n  apply:\n');
  const planJob = jobs.slice(0, applyBoundary);
  const applyJob = jobs.slice(applyBoundary);
  assert.match(workflow, /branches: \[dev\]/u);
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /default: false/u);
  assert.match(workflow, /cron: '13 9 \* \* \*'/u);
  assert.match(workflow, /backfill_next_batch:/u);
  assert.match(workflow, /github\.event_name == 'schedule' && 'dev'/u);
  assert.match(workflow, /changed-task-ids\.mjs --base/u);
  assert.match(workflow, /select-issue-sync-batch\.mjs/u);
  assert.match(workflow, /TASK_IDS_AUTO/u);
  assert.match(workflow, /Changed roadmap tasks selected for bounded automatic sync/u);
  assert.match(workflow, /--apply --task-ids "\$TASK_IDS" --lifecycle-snapshot/u);
  assert.match(planJob, /issues: read/u);
  assert.match(planJob, /checks: read/u);
  assert.doesNotMatch(planJob, /issues: write/u);
  assert.match(planJob, /fetch-depth: 0/u);
  assert.doesNotMatch(planJob, /collect-lifecycle-snapshot-cli\.mjs/u);
  assert.doesNotMatch(planJob, /--lifecycle-snapshot/u);
  assert.match(planJob, /trap 'rm -f/u);
  assert.match(
    applyJob,
    /event_name == 'push' && github\.ref == 'refs\/heads\/dev' && needs\.plan\.outputs\.changed_task_ids != ''/u
  );
  assert.match(
    applyJob,
    /event_name == 'workflow_dispatch' && inputs\.apply && github\.ref == 'refs\/heads\/dev'/u
  );
  assert.match(
    applyJob,
    /event_name == 'schedule' && github\.ref == 'refs\/heads\/main' && needs\.plan\.outputs\.backfill_task_ids/u
  );
  assert.match(applyJob, /"\$\(git rev-parse refs\/remotes\/origin\/dev\)" != "\$SOURCE_SHA"/u);
  // The five-task bound is enforced by the tested selector, and the workflow may only apply its batch.
  assert.match(applyJob, /node scripts\/roadmap\/issue-sync-continuation\.mjs prepare/u);
  assert.match(applyJob, /TASK_IDS="\$\(jq -r '\.applyTaskIds/u);
  assert.doesNotMatch(applyJob, /--apply --task-ids "\$SELECTION_TASK_IDS"/u);
  assert.match(applyJob, /node scripts\/roadmap\/issue-sync-continuation\.mjs dispatch/u);
  assert.match(
    applyJob,
    /BATCH_CONTINUATION_COUNT: \$\{\{ inputs\.batch_continuation_count \|\| 0 \}\}/u
  );
  assert.match(applyJob, /issues: write/u);
  assert.match(applyJob, /checks: read/u);
  assert.match(applyJob, /group: roadmap-issue-sync/u);
  assert.match(applyJob, /needs: \[plan\]/u);
  assert.match(applyJob, /persist-credentials: false/u);
  assert.match(applyJob, /fetch-depth: 0/u);
  assert.match(applyJob, /refs\/remotes\/origin\/dev/u);
  assert.match(applyJob, /collect-lifecycle-snapshot-cli\.mjs/u);
  assert.match(applyJob, /if \[\[ ! -s "\$snapshot_file" \]\]/u);
  assert.equal(
    (applyJob.match(/resume-stale-issue-sync\.mjs/gu) ?? []).length,
    3,
    'each stale guard resumes the selected task batch on current dev'
  );
  assert.match(applyJob, /git fetch origin dev --no-recurse-submodules/u);
  assert.match(applyJob, /--lifecycle-snapshot/u);
});

test('managed issue update preserves maintainer notes outside the generated block', () => {
  const existing = plan().operations[0];
  const issue = {
    number: 8,
    title: '[M11.03] old title',
    body: `${existing.body}\n\n## Catatan maintainer\nKeep this note.`,
    state: 'open',
  };
  const changedTask = { ...task, title: 'Build robust planner' };
  const operation = plan([issue], [changedTask]).operations[0];
  assert.equal(operation.operation, 'update');
  assert.match(operation.body, /Keep this note\./u);
  assert.match(operation.title, /Build robust planner/u);
});

test('managed block replacement preserves every byte outside its markers', () => {
  const changedTask = { ...task, title: 'Build exact-preservation planner' };
  const expectedBlock = plan([], [changedTask]).operations[0].body;
  const prefix = ' \n\nHuman heading\n\n';
  const suffix = '\n\nMaintainer note\nKeep trailing spaces too. \n\n';
  const previousBlock = plan().operations[0].body;
  const existingBody = `${prefix}${previousBlock}${suffix}`;
  const issue = { number: 81, title: '[M11.03] old title', body: existingBody, state: 'open' };
  const operation = plan([issue], [changedTask]).operations[0];

  assert.equal(operation.operation, 'update');
  assert.equal(operation.body, `${prefix}${expectedBlock}${suffix}`);

  const legacyIssue = {
    ...issue,
    number: 82,
    body: `<!-- moonwitness-task: ${repositoryId}:${task.id} -->\n${prefix}Legacy discussion \n\n`,
  };
  const legacyOperation = plan([legacyIssue], [changedTask]).operations[0];
  assert.equal(legacyOperation.operation, 'update');
  const managedBlock = expectedBlock.slice(expectedBlock.indexOf('\n') + 1);
  assert.equal(legacyOperation.body, `${managedBlock.trimEnd()}\n\n${legacyIssue.body}`);
});

test('unchanged managed content is a no-op even when maintainer notes are present', () => {
  const generated = plan().operations[0];
  const originalBody = `${generated.body}\n\n## Maintainer notes\nKeep this exact text.\n`;
  const issue = {
    number: 23,
    title: generated.title,
    body: originalBody,
    state: 'open',
    labels: [...generated.labels.filter((name) => name !== 'roadmap'), 'Roadmap', 'support'].map(
      (name) => ({ name })
    ),
    milestone: { number: 11, title: 'M11' },
  };

  const operation = plan([issue]).operations[0];
  assert.equal(operation.operation, 'noop');
  assert.equal(operation.body, originalBody);
  assert.deepEqual(operation.labels, ['Roadmap', 'milestone:m11', 'support']);
});

test('closed issues are discovered, pull requests ignored and duplicate identity conflicts', () => {
  const base = plan().operations[0];
  const issue = {
    number: 9,
    title: base.title,
    body: base.body,
    state: 'closed',
    labels: base.labels.map((name) => ({ name })),
    milestone: { number: 11, title: 'M11' },
  };
  assert.equal(plan([issue]).operations[0].operation, 'noop');
  assert.equal(
    plan([{ ...issue, pull_request: { url: 'https://example.invalid' } }]).operations[0].operation,
    'create'
  );
  assert.equal(plan([issue, { ...issue, number: 10 }]).operations[0].operation, 'conflict');
});

test('repository identity is scoped and malformed generated boundaries conflict', () => {
  const base = plan().operations[0];
  const otherRepoBody = base.body.replace(repositoryId, '987654321');
  assert.equal(
    plan([{ number: 1, title: base.title, body: otherRepoBody, state: 'open' }]).operations[0]
      .operation,
    'create'
  );
  const malformed = {
    number: 2,
    title: base.title,
    body: `${base.body}\n${base.body}`,
    state: 'open',
  };
  assert.equal(plan([malformed]).operations[0].operation, 'conflict');
  const duplicateEnd = {
    number: 3,
    title: base.title,
    body: `${base.body}\n${'<!-- END MOONWITNESS MANAGED -->'}`,
    state: 'open',
  };
  assert.equal(plan([duplicateEnd]).operations[0].operation, 'conflict');
});

test('apply refreshes a stale remote plan once when the new issue snapshot is stable', async () => {
  const stalePlan = plan();
  const desired = stalePlan.operations[0];
  const concurrentlyCreated = {
    number: 4,
    title: desired.title,
    body: desired.body,
    state: 'open',
    labels: desired.labels.map((name) => ({ name })),
    milestone: { number: 11, title: 'M11' },
  };
  let reads = 0;
  let writes = 0;
  const client = {
    listAll: async () => {
      reads += 1;
      return [concurrentlyCreated];
    },
    assertWritable: () => {
      writes += 1;
    },
    ensureMetadata: async () => {
      writes += 1;
      return new Map();
    },
    create: async () => {
      writes += 1;
      assert.fail('stable refreshed plan must not create a duplicate issue');
    },
    update: async () => {
      writes += 1;
      assert.fail('stable refreshed plan is already current');
    },
  };

  const result = await applyIssuePlan({
    plan: stalePlan,
    client,
    tasks: [task],
    repositoryId,
    sourceSha,
  });

  assert.deepEqual(result, []);
  assert.equal(reads, 2);
  assert.equal(writes, 0);
});

test('apply refuses remote inventory that keeps changing during its bounded refresh', async () => {
  const stalePlan = plan();
  let reads = 0;
  let writes = 0;
  const client = {
    listAll: async () => {
      reads += 1;
      return [{ number: reads, title: 'unrelated', body: 'human', state: 'open' }];
    },
    assertWritable: () => {
      writes += 1;
    },
    create: async () => {
      writes += 1;
    },
    update: async () => {
      writes += 1;
    },
  };

  await assert.rejects(
    applyIssuePlan({ plan: stalePlan, client, tasks: [task], repositoryId, sourceSha }),
    /kept changing during one bounded refresh/u
  );
  assert.equal(reads, 2);
  assert.equal(writes, 0);
});

test('apply rechecks dev immediately before an issue write after metadata preparation', async () => {
  let devHead = sourceSha;
  let sourceChecks = 0;
  let issueWrites = 0;
  const client = {
    listAll: async () => [],
    assertWritable: () => {},
    ensureMetadata: async () => {
      devHead = 'f'.repeat(40);
      return new Map();
    },
    create: async () => {
      issueWrites += 1;
    },
    update: async () => {
      issueWrites += 1;
    },
  };

  await assert.rejects(
    applyIssuePlan({
      plan: plan(),
      client,
      tasks: [task],
      repositoryId,
      sourceSha,
      assertSourceCurrent: async () => {
        sourceChecks += 1;
        if (devHead !== sourceSha) throw new Error('dev advanced; refusing stale issue writes');
      },
    }),
    /refusing stale issue writes/u
  );
  assert.equal(sourceChecks, 2);
  assert.equal(issueWrites, 0);
});

test('apply stops before metadata or issue writes when permission is revoked after planning', async () => {
  const generated = plan().operations[0];
  const currentIssue = {
    number: 41,
    title: generated.title,
    body: generated.body,
    state: 'open',
    labels: generated.labels.map((name) => ({ name })),
    milestone: { number: 11, title: 'M11' },
  };
  const changedTask = { ...task, title: 'Build safer planner' };
  const changedPlan = planIssueSync({
    tasks: [changedTask],
    issues: [currentIssue],
    repositoryId,
    sourceSha,
  });
  let writes = 0;
  const client = {
    listAll: async () => [currentIssue],
    assertWritable: () => {
      throw new Error('Resource not accessible by integration');
    },
    ensureMetadata: async () => {
      writes += 1;
      return new Map();
    },
    update: async () => {
      writes += 1;
    },
  };
  await assert.rejects(
    applyIssuePlan({
      plan: changedPlan,
      client,
      tasks: [changedTask],
      repositoryId,
      sourceSha,
    }),
    /Resource not accessible/u
  );
  assert.equal(writes, 0);
});

test('apply no-op succeeds without write permission or metadata mutations', async () => {
  const generated = plan().operations[0];
  const remoteIssue = {
    number: 47,
    title: generated.title,
    body: generated.body,
    state: 'open',
    labels: generated.labels.map((name) => ({ name })),
    milestone: { number: 11, title: 'M11' },
  };
  let writes = 0;
  const client = {
    listAll: async () => [remoteIssue],
    assertWritable: () => assert.fail('no-op apply must not require write permission'),
    ensureMetadata: async () => {
      writes += 1;
      return new Map();
    },
    update: async () => {
      writes += 1;
    },
    create: async () => {
      writes += 1;
    },
  };
  const result = await applyIssuePlan({
    plan: plan([remoteIssue]),
    client,
    tasks: [task],
    repositoryId,
    sourceSha,
  });
  assert.deepEqual(result, []);
  assert.equal(writes, 0);
});

test('replanning a freshly applied create produces a second apply with no writes', async () => {
  const remoteIssues = [];
  let createCalls = 0;
  const client = {
    listAll: async () => remoteIssues,
    assertWritable: () => {},
    ensureMetadata: async () => new Map([['M11', 11]]),
    create: async (operation) => {
      createCalls += 1;
      const issue = {
        number: 71,
        title: operation.title,
        body: operation.body,
        state: 'open',
        labels: operation.labels.map((name) => ({ name })),
        milestone: { number: 11, title: 'M11' },
      };
      remoteIssues.push(issue);
      return issue;
    },
    update: async () => assert.fail('freshly synchronized issue must not be updated'),
  };

  const firstResult = await applyIssuePlan({
    plan: plan(),
    client,
    tasks: [task],
    repositoryId,
    sourceSha,
  });
  assert.equal(firstResult.length, 1);
  assert.equal(firstResult[0].taskId, 'M11.03');
  assert.equal(firstResult[0].issue.number, 71);

  const repeatedPlan = plan(remoteIssues);
  assert.equal(repeatedPlan.operations[0].operation, 'noop');
  const secondResult = await applyIssuePlan({
    plan: repeatedPlan,
    client,
    tasks: [task],
    repositoryId,
    sourceSha,
  });

  assert.deepEqual(secondResult, []);
  assert.equal(createCalls, 1);
  assert.equal(remoteIssues.length, 1);
});

test('apply validates conflicts before requiring write permission', async () => {
  const generated = plan().operations[0];
  const conflict = {
    number: 48,
    title: generated.title,
    body: `${generated.body}\n${generated.body}`,
    state: 'open',
  };
  const client = {
    listAll: async () => [conflict],
    assertWritable: () => assert.fail('conflict must be reported before write permission'),
  };
  await assert.rejects(
    applyIssuePlan({ plan: plan([conflict]), client, tasks: [task], repositoryId, sourceSha }),
    /Duplicate managed identity/u
  );
});

test('apply rejects any duplicate conflict before the first remote mutation', async () => {
  const createTask = { ...task, id: 'M11.04', title: 'Create task' };
  const duplicateBody = plan().operations[0].body;
  const duplicateIssues = [
    { number: 7, title: '[M11.03] one', body: duplicateBody, state: 'open' },
    { number: 8, title: '[M11.03] two', body: duplicateBody, state: 'closed' },
  ];
  const conflictPlan = plan(duplicateIssues, [createTask, task]);
  const calls = [];
  const client = {
    listAll: async () => duplicateIssues,
    create: async () => calls.push('create'),
    update: async () => calls.push('update'),
  };
  await assert.rejects(
    applyIssuePlan({
      plan: conflictPlan,
      client,
      tasks: [createTask, task],
      repositoryId,
      sourceSha,
    }),
    /Duplicate managed identity/u
  );
  assert.deepEqual(calls, []);
});

test('update re-reads the issue and preserves concurrent maintainer notes and metadata', async () => {
  const generated = plan().operations[0];
  const original = {
    number: 31,
    title: '[M11.03] old title',
    body: `${generated.body}\n\nMaintainer note: original`,
    state: 'open',
    labels: [{ name: 'roadmap' }, { name: 'removed-by-maintainer' }],
    assignees: [{ login: 'planner' }, { login: 'removed-reviewer' }],
    milestone: { number: 11, title: 'M11' },
  };
  const latest = {
    ...original,
    body: `${original.body}\n\nConcurrent note: preserve me`,
    labels: [{ name: 'roadmap' }, { name: 'maintainer-label' }],
    assignees: [{ login: 'planner' }, { login: 'reviewer' }],
  };
  let patched;
  const client = {
    listAll: async () => [original],
    getIssue: async () => latest,
    update: async (operation) => {
      patched = operation;
      return { number: operation.issueNumber };
    },
  };
  const changedTask = { ...task, title: 'Build safer planner' };
  const changedPlan = planIssueSync({
    tasks: [changedTask],
    issues: [original],
    repositoryId,
    sourceSha,
  });
  await applyIssuePlan({
    plan: changedPlan,
    client,
    tasks: [changedTask],
    repositoryId,
    sourceSha,
  });
  assert.match(patched.body, /Concurrent note: preserve me/u);
  assert.deepEqual(patched.labels, ['maintainer-label', 'milestone:m11', 'roadmap']);
  assert.deepEqual(patched.assignees, ['planner', 'reviewer']);
});

test('update refuses concurrent edits to managed content without patching', async () => {
  const generated = plan().operations[0];
  const original = {
    number: 32,
    title: '[M11.03] old title',
    body: generated.body,
    state: 'open',
    milestone: { number: 11, title: 'M11' },
  };
  const changedTask = { ...task, title: 'Build safer planner' };
  const changedPlan = planIssueSync({
    tasks: [changedTask],
    issues: [original],
    repositoryId,
    sourceSha,
  });
  let patched = false;
  const client = {
    listAll: async () => [original],
    getIssue: async () => ({
      ...original,
      body: original.body.replace('Build planner', 'Changed manually'),
    }),
    update: async () => {
      patched = true;
    },
  };
  await assert.rejects(
    applyIssuePlan({
      plan: changedPlan,
      client,
      tasks: [changedTask],
      repositoryId,
      sourceSha,
    }),
    /changed in a managed field/u
  );
  assert.equal(patched, false);
});

test('update is skipped when the remote issue already reached the desired state', async () => {
  const generated = plan().operations[0];
  const original = {
    number: 33,
    title: generated.title,
    body: generated.body,
    state: 'open',
    labels: [{ name: 'roadmap' }, { name: 'milestone:m11' }],
    assignees: [],
    milestone: { number: 11, title: 'M11' },
  };
  const changedTask = { ...task, title: 'Build safer planner' };
  const changedPlan = planIssueSync({
    tasks: [changedTask],
    issues: [original],
    repositoryId,
    sourceSha,
  });
  const desired = planIssueSync({
    tasks: [changedTask],
    issues: [],
    repositoryId,
    sourceSha,
  }).operations[0];
  let patched = false;
  const client = {
    listAll: async () => [original],
    getIssue: async () => ({
      ...original,
      title: desired.title,
      body: desired.body,
      labels: desired.labels.map((name) => ({ name })),
    }),
    update: async () => {
      patched = true;
    },
  };
  const result = await applyIssuePlan({
    plan: changedPlan,
    client,
    tasks: [changedTask],
    repositoryId,
    sourceSha,
  });
  assert.deepEqual(result, [{ taskId: task.id, issueNumber: 33, unchanged: true }]);
  assert.equal(patched, false);
});

test('ambiguous create failure re-reads marker and recovers without creating a duplicate', async () => {
  const expected = plan().operations[0];
  let calls = 0;
  const client = {
    listAll: async () => {
      calls += 1;
      return calls === 1
        ? []
        : [{ number: 44, title: expected.title, body: expected.body, state: 'open' }];
    },
    create: async () => {
      throw new Error('response timed out after server accepted create');
    },
    update: async () => assert.fail('no generated content change expected'),
  };
  const result = await applyIssuePlan({
    plan: plan(),
    client,
    tasks: [task],
    repositoryId,
    sourceSha,
  });
  assert.deepEqual(result, [{ taskId: 'M11.03', issueNumber: 44, recovered: true }]);
});

test('ambiguous create failure refuses recovery when re-read finds duplicate managed markers', async () => {
  const expected = plan().operations[0];
  const committed = [
    { number: 45, title: expected.title, body: expected.body, state: 'open' },
    { number: 46, title: expected.title, body: expected.body, state: 'closed' },
  ];
  let reads = 0;
  let creates = 0;
  let updates = 0;
  const client = {
    listAll: async () => {
      reads += 1;
      return reads === 1 ? [] : committed;
    },
    create: async () => {
      creates += 1;
      throw new Error('response timed out after server accepted create');
    },
    update: async () => {
      updates += 1;
    },
  };

  await assert.rejects(
    applyIssuePlan({ plan: plan(), client, tasks: [task], repositoryId, sourceSha }),
    /response timed out after server accepted create/u
  );
  assert.equal(reads, 2);
  assert.equal(creates, 1);
  assert.equal(updates, 0);
});

test('transient create failure without a committed marker fails without a blind retry', async () => {
  const calls = [];
  const client = {
    listAll: async () => {
      calls.push('read');
      return [];
    },
    create: async () => {
      calls.push('create');
      throw new Error('API 503: temporary outage');
    },
    update: async () => assert.fail('create recovery must not become an update'),
  };
  await assert.rejects(
    applyIssuePlan({ plan: plan(), client, tasks: [task], repositoryId, sourceSha }),
    /API 503: temporary outage/u
  );
  assert.deepEqual(calls, ['read', 'create', 'read']);
});

test('GitHub issue adapter exhausts multi-page open and closed inventories before writes', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'POST' || init.method === 'PATCH')
      return { ok: true, status: 200, json: async () => ({ number: 1 }) };
    const urlText = String(url);
    const query = urlText.split('?')[1] ?? '';
    const params = new URLSearchParams(query);
    const state = params.get('state');
    const page = Number(params.get('page'));
    const firstNumber = state === 'open' ? 1 : 1001;
    const count = state === 'open' ? (page < 3 ? 100 : 5) : page === 1 ? 100 : 1;
    const offset = page === 1 ? 0 : page === 2 ? 100 : 200;
    return {
      ok: true,
      status: 200,
      json: async () =>
        Array.from({ length: count }, (_, index) => ({ number: firstNumber + offset + index })),
    };
  };
  const client = createGitHubIssuesClient({
    token: 'test-token',
    owner: 'owner',
    repo: 'repo',
    fetchImpl,
  });
  const issues = await client.listAll();
  assert.equal(issues.length, 306);
  assert.equal(new Set(issues.map(({ number }) => number)).size, 306);
  assert.deepEqual(
    calls.map(({ url }) => {
      const params = new URLSearchParams(url.split('?')[1]);
      return [params.get('state'), params.get('page')];
    }),
    [
      ['open', '1'],
      ['open', '2'],
      ['open', '3'],
      ['closed', '1'],
      ['closed', '2'],
    ]
  );
  await client.create({ title: 'test', body: 'body' });
  assert.equal(calls[5].init.method, 'POST');
  assert.equal(calls[5].init.body.includes('test-token'), false);
  await client.getIssue(42);
  assert.equal(calls[6].url.endsWith('/issues/42'), true);
});

test('public read-only planning needs no token and writes fail closed without one', async () => {
  const calls = [];
  const client = createGitHubIssuesClient({
    owner: 'owner',
    repo: 'repo',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => [] };
    },
  });

  assert.deepEqual(await client.listAll(), []);
  assert.equal(
    calls.every(({ init }) => !init.headers?.Authorization),
    true
  );
  assert.throws(
    () => client.assertWritable(),
    /GITHUB_TOKEN is required for GitHub issue mutations/u
  );
  await assert.rejects(
    applyIssuePlan({ plan: plan(), client, tasks: [task], repositoryId, sourceSha }),
    /GITHUB_TOKEN is required/u
  );
  await assert.rejects(client.create({ title: 'test', body: 'body' }), /GITHUB_TOKEN is required/u);
  await assert.rejects(
    client.update({ issueNumber: 1, title: 'test', body: 'body' }),
    /GITHUB_TOKEN is required/u
  );
  await assert.rejects(client.ensureMetadata([task]), /GITHUB_TOKEN is required/u);
  assert.equal(calls.length, 4);
});

test('GitHub adapter revalidates the source before every mutating API request', async () => {
  let current = true;
  const calls = [];
  const client = createGitHubIssuesClient({
    token: 'test-token',
    owner: 'owner',
    repo: 'repo',
    assertSourceCurrent: async () => {
      if (!current) throw new Error('dev advanced; refusing stale issue writes');
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET' });
      return { ok: true, status: 200, json: async () => ({ number: 1 }) };
    },
  });

  await client.create({ title: 'fresh', body: 'first write' });
  current = false;
  await assert.rejects(
    client.update({ issueNumber: 1, title: 'stale', body: 'second write' }),
    /refusing stale issue writes/u
  );
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['POST']
  );
});

test('GitHub adapter closes an issue only when a lifecycle operation explicitly requests it', async () => {
  const writes = [];
  const client = createGitHubIssuesClient({
    token: 'test-token',
    owner: 'owner',
    repo: 'repo',
    fetchImpl: async (_url, init = {}) => {
      writes.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ number: 1 }) };
    },
  });
  await client.update({ issueNumber: 1, title: 'candidate', body: 'evidence', closeIssue: true });
  await client.update({ issueNumber: 2, title: 'still open', body: 'evidence' });
  assert.deepEqual(writes, [
    { title: 'candidate', body: 'evidence', state: 'closed' },
    { title: 'still open', body: 'evidence' },
  ]);
});

test('GitHub adapter honors bounded rate-limit delays on reads', async () => {
  const delays = [];
  let calls = 0;
  const client = createGitHubIssuesClient({
    token: 'test-token',
    owner: 'owner',
    repo: 'repo',
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1)
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => (name === 'retry-after' ? '2' : null) },
          text: async () => 'API rate limit exceeded',
        };
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  assert.deepEqual(await client.listAll(), []);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000]);
});

test('GitHub adapter distinguishes permission failures and never retries writes blindly', async () => {
  let calls = 0;
  const client = createGitHubIssuesClient({
    token: 'test-token',
    owner: 'owner',
    repo: 'repo',
    sleepImpl: async () => assert.fail('permission failures must not be retried'),
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: calls === 1 ? 403 : 503,
        headers: { get: () => null },
        text: async () => (calls === 1 ? 'Resource not accessible by integration' : 'unavailable'),
      };
    },
  });
  await assert.rejects(client.listAll(), /API 403: Resource not accessible/u);
  assert.equal(calls, 1);
  await assert.rejects(client.create({ title: 'test', body: 'body' }), /API 503/u);
  assert.equal(calls, 2);
});

test('GitHub adapter stops when a rate-limit reset exceeds its retry window', async () => {
  let calls = 0;
  const client = createGitHubIssuesClient({
    token: 'test-token',
    owner: 'owner',
    repo: 'repo',
    now: () => 1_000_000,
    maxRetryDelayMs: 5000,
    sleepImpl: async () => assert.fail('over-bound retries must stop without sleeping'),
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 403,
        headers: {
          get: (name) =>
            name === 'x-ratelimit-remaining' ? '0' : name === 'x-ratelimit-reset' ? '1060' : null,
        },
        text: async () => 'API rate limit exceeded',
      };
    },
  });
  await assert.rejects(client.listAll(), /exceeds the configured 5000ms bound/u);
  assert.equal(calls, 1);
});

test('task renderer extracts implementation and acceptance sections from its exact card', () => {
  const card = [
    '## M11.03 — Issue sync',
    '',
    '### Langkah pelaksanaan',
    '1. Read all issues.',
    '2. Preserve maintainer notes.',
    '',
    '### Verifikasi dan syarat selesai',
    'Repeated apply creates no duplicates.',
    '',
    '## M11.04 — Next card',
    '### Langkah pelaksanaan',
    'This content belongs to another task.',
  ].join('\n');

  assert.deepEqual(renderTaskCardDetails(card, 'M11.03'), {
    steps: '1. Read all issues.\n2. Preserve maintainer notes.',
    acceptance: 'Repeated apply creates no duplicates.',
  });
  assert.throws(() => renderTaskCardDetails(card, 'M11.99'), /missing the M11\.99 section/u);
});

test('requested assignees are resolved as GitHub accounts and invalid names fail closed', async () => {
  const requests = [];
  const client = createGitHubIssuesClient({
    token: 'test-token',
    owner: 'owner',
    repo: 'repo',
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/users/maintainer'))
        return { ok: true, status: 200, json: async () => ({ login: 'maintainer' }) };
      return { ok: false, status: 404, text: async () => 'Not Found' };
    },
  });

  assert.deepEqual(await client.validateAssignees([{ ...task, assignee: 'maintainer' }]), [
    'maintainer',
  ]);
  await assert.rejects(
    client.validateAssignees([{ ...task, assignee: 'missing-user' }]),
    /GitHub Issues API 404/u
  );
  assert.deepEqual(requests, [
    'https://api.github.com/users/maintainer',
    'https://api.github.com/users/missing-user',
  ]);
});

test('all indexed tasks render implementation steps and acceptance from their roadmap cards', async () => {
  const indexUrl = new URL('../../docs/roadmap/tasks.json', import.meta.url);
  const index = JSON.parse(await readFile(indexUrl, 'utf8'));
  const cards = new Map();
  const cardDetailsByTask = new Map();
  for (const task of index.tasks) {
    let card = cards.get(task.detailFile);
    if (card === undefined) {
      card = await readFile(new URL(`../../${task.detailFile}`, import.meta.url), 'utf8');
      cards.set(task.detailFile, card);
    }
    const details = renderTaskCardDetails(card, task.id);
    assert.ok(details.steps, `${task.id} has implementation steps`);
    assert.ok(details.acceptance, `${task.id} has acceptance criteria`);
    cardDetailsByTask.set(task.id, details);
  }
  const generated = planIssueSync({
    tasks: index.tasks,
    issues: [],
    repositoryId,
    sourceSha,
    repositoryUrl: 'https://github.com/owner/repo',
    cardDetailsByTask,
  });
  assert.equal(generated.operations.length, index.tasks.length);
  assert.ok(generated.operations.every((operation) => operation.operation === 'create'));
  assert.ok(
    generated.operations.every(
      (operation) =>
        operation.body.includes('## Implementation steps') &&
        operation.body.includes('## Acceptance criteria') &&
        operation.body.includes('Source SHA:')
    )
  );
  for (const task of index.tasks) {
    const operation = generated.operations.find(({ taskId }) => taskId === task.id);
    assert.ok(operation, `${task.id} has a generated issue`);
    if (task.evidence) {
      assert.ok(
        operation.body.includes(`Evidence: [${task.evidence}](`),
        `${task.id} evidence link`
      );
    } else {
      assert.ok(
        operation.body.includes('Evidence: not recorded yet'),
        `${task.id} missing evidence`
      );
    }
  }
});

test('issue descriptions link dependencies to existing issues and create labels/milestones idempotently', async () => {
  const dependentTask = { ...task, id: 'M11.04', dependsOn: ['M11.03'] };
  const issue = {
    number: 31,
    title: '[M11.03] Existing planner',
    body: `<!-- moonwitness-task: ${repositoryId}:M11.03 -->`,
    state: 'open',
  };
  const details = new Map([
    ['M11.04', { steps: 'Render the task card.', acceptance: 'Dependencies are linked.' }],
  ]);
  const rendered = planIssueSync({
    tasks: [dependentTask],
    issues: [issue],
    repositoryId,
    sourceSha,
    repositoryUrl: 'https://github.com/owner/repo',
    cardDetailsByTask: details,
  }).operations[0];
  assert.match(rendered.body, /\[M11\.03\]\(https:\/\/github\.com\/owner\/repo\/issues\/31\)/u);
  assert.match(rendered.body, /## Implementation steps\nRender the task card\./u);
  assert.match(rendered.body, /## Acceptance criteria\nDependencies are linked\./u);
  assert.deepEqual(rendered.labels, ['milestone:m11', 'roadmap']);

  const calls = [];
  const remoteMilestones = [];
  const remoteLabels = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ target, init });
    if (target.endsWith('/milestones?state=all&per_page=100&page=1'))
      return { ok: true, status: 200, json: async () => remoteMilestones };
    if (target.endsWith('/labels?per_page=100&page=1'))
      return { ok: true, status: 200, json: async () => remoteLabels };
    if (init.method === 'POST' && target.endsWith('/milestones')) {
      const milestone = { ...JSON.parse(init.body), number: 11 };
      remoteMilestones.push(milestone);
      return { ok: true, status: 201, json: async () => milestone };
    }
    if (init.method === 'POST' && target.endsWith('/labels')) {
      const label = JSON.parse(init.body);
      remoteLabels.push(label);
      return { ok: true, status: 201, json: async () => label };
    }
    if (init.method === 'POST' && target.endsWith('/issues'))
      return { ok: true, status: 201, json: async () => ({ number: 32 }) };
    return { ok: false, status: 500, text: async () => 'unexpected request' };
  };
  const client = createGitHubIssuesClient({
    token: 'test-token',
    owner: 'owner',
    repo: 'repo',
    fetchImpl,
  });
  const milestoneNumbers = await client.ensureMetadata([dependentTask]);
  await client.ensureMetadata([dependentTask]);
  await client.create({ ...rendered, milestoneNumber: milestoneNumbers.get('M11') });
  assert.equal(
    calls.filter(({ target, init }) => target.endsWith('/milestones') && init.method === 'POST')
      .length,
    1
  );
  assert.equal(
    calls.filter(({ target, init }) => target.endsWith('/labels') && init.method === 'POST').length,
    2
  );
  const issueWrite = calls.find(
    ({ target }) => target.endsWith('/issues') && !target.includes('?')
  );
  assert.deepEqual(JSON.parse(issueWrite.init.body), {
    title: rendered.title,
    body: rendered.body,
    labels: ['milestone:m11', 'roadmap'],
    milestone: 11,
  });
});

test('planner projects lifecycle evidence deterministically and flags manual close without closing it', () => {
  const lifecycle = {
    workStatus: 'complete',
    deliveryStage: 'verified-dev',
    blockers: [],
    verifiedOnDevSha: 'b'.repeat(40),
    needsTriage: false,
    shouldClose: true,
  };
  const input = {
    tasks: [task],
    issues: [],
    repositoryId,
    sourceSha,
    lifecycleByTask: new Map([[task.id, lifecycle]]),
  };
  const first = planIssueSync(input);
  assert.match(first.operations[0].body, /Work status: complete/u);
  assert.match(first.operations[0].body, /Delivery stage: verified-dev/u);
  assert.deepEqual(first.lifecycleSummary, {
    workStatuses: { complete: 1 },
    deliveryStages: { 'verified-dev': 1 },
    closeReadyTaskIds: ['M11.03'],
    needsTriageTaskIds: [],
  });
  assert.match(renderIssuePlanSummary(first), /Lifecycle delivery: verified-dev=1/u);
  assert.match(renderIssuePlanSummary(first), /Issue close candidates: M11\.03/u);
  assert.match(first.operations[0].body, new RegExp(`Verified dev SHA: ${'b'.repeat(40)}`, 'u'));
  assert.equal(planIssueSync(input).inputHash, first.inputHash);
  const changed = planIssueSync({
    ...input,
    lifecycleByTask: new Map([[task.id, { ...lifecycle, needsTriage: true }]]),
  });
  assert.notEqual(changed.inputHash, first.inputHash);
  assert.match(
    changed.operations[0].body,
    /Issue state: closed manually; maintainer triage required\./u
  );
  assert.equal(changed.operations[0].operation, 'create');
});

test('lifecycle apply closes only an existing issue with a verified close candidate', async () => {
  const initial = plan().operations[0];
  const remoteIssue = {
    number: 71,
    title: initial.title,
    body: initial.body,
    state: 'open',
    labels: initial.labels.map((name) => ({ name })),
    milestone: { number: 11, title: 'M11' },
  };
  const lifecycleByTask = new Map([
    [
      task.id,
      {
        workStatus: 'complete',
        deliveryStage: 'verified-dev',
        blockers: [],
        verifiedOnDevSha: 'b'.repeat(40),
        needsTriage: false,
        shouldClose: true,
      },
    ],
  ]);
  const desired = planIssueSync({
    tasks: [task],
    issues: [remoteIssue],
    repositoryId,
    sourceSha,
    lifecycleByTask,
    lifecycleSnapshotGeneratedAt: new Date().toISOString(),
  });
  assert.equal(desired.operations[0].operation, 'update');
  assert.equal(desired.operations[0].closeIssue, true);
  assert.equal(desired.operations[0].expectedIssueState, 'open');

  const writes = [];
  const client = {
    listAll: async () => [remoteIssue],
    getIssue: async () => remoteIssue,
    assertWritable() {},
    ensureMetadata: async () => new Map([['M11', 11]]),
    update: async (operation) => writes.push(operation),
  };
  const result = await applyIssuePlan({
    plan: desired,
    client,
    tasks: [task],
    repositoryId,
    sourceSha,
    lifecycleByTask,
  });
  assert.equal(result.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].closeIssue, true);
  assert.match(writes[0].body, /Work status: complete/u);
});

test('lifecycle apply aborts if an issue was manually closed after planning', async () => {
  const initial = plan().operations[0];
  const remoteIssue = {
    number: 72,
    title: initial.title,
    body: initial.body,
    state: 'open',
    labels: initial.labels.map((name) => ({ name })),
    milestone: { number: 11, title: 'M11' },
  };
  const lifecycleByTask = new Map([
    [
      task.id,
      {
        workStatus: 'complete',
        deliveryStage: 'verified-dev',
        blockers: [],
        verifiedOnDevSha: 'b'.repeat(40),
        needsTriage: false,
        shouldClose: true,
      },
    ],
  ]);
  const desired = planIssueSync({
    tasks: [task],
    issues: [remoteIssue],
    repositoryId,
    sourceSha,
    lifecycleByTask,
  });
  const client = {
    listAll: async () => [remoteIssue],
    getIssue: async () => ({ ...remoteIssue, state: 'closed' }),
    assertWritable() {},
    ensureMetadata: async () => new Map(),
    update: async () => assert.fail('manual close race must prevent the write'),
  };
  await assert.rejects(
    applyIssuePlan({
      plan: desired,
      client,
      tasks: [task],
      repositoryId,
      sourceSha,
      lifecycleByTask,
      lifecycleSnapshotGeneratedAt: new Date().toISOString(),
    }),
    /managed field after planning/u
  );
});

test('lifecycle apply rejects a snapshot that expires before issue writes', async () => {
  const issue = plan().operations[0];
  const lifecycleByTask = new Map([
    [
      task.id,
      {
        workStatus: 'complete',
        deliveryStage: 'verified-dev',
        blockers: [],
        verifiedOnDevSha: 'b'.repeat(40),
        needsTriage: false,
        shouldClose: true,
      },
    ],
  ]);
  const desired = planIssueSync({
    tasks: [task],
    issues: [{ number: 73, title: issue.title, body: issue.body, state: 'open' }],
    repositoryId,
    sourceSha,
    lifecycleByTask,
  });
  const writes = [];
  const client = {
    listAll: async () => [{ number: 73, title: issue.title, body: issue.body, state: 'open' }],
    getIssue: async () => assert.fail('stale snapshot must fail before issue reads'),
    assertWritable: () => assert.fail('stale snapshot must fail before enabling writes'),
    ensureMetadata: async () => new Map(),
    update: async (operation) => writes.push(operation),
  };
  await assert.rejects(
    applyIssuePlan({
      plan: desired,
      client,
      tasks: [task],
      repositoryId,
      sourceSha,
      lifecycleByTask,
      lifecycleSnapshotGeneratedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    }),
    /five minutes old/u
  );
  assert.equal(writes.length, 0);
});
