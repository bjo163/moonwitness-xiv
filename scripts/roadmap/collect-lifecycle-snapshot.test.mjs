import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectLifecycleSnapshot,
  completedExactDevPullRequestTechnicalGate,
  exactDevPullRequestTechnicalGate,
  flattenGitHubPages,
  isExactDevMainPullRequest,
  parseEvidenceSourceSha,
  parseRoadmapTaskStates,
  selectExactDevPullRequestCiRun,
} from './collect-lifecycle-snapshot.mjs';
import { projectLifecycleSnapshot } from './lifecycle-snapshot.mjs';
import {
  readCurrentDevPullRequestTechnicalGate,
  withGitHubReadRetry,
  writeSnapshotIfDevHeadIsCurrent,
} from './collect-lifecycle-snapshot-cli.mjs';

const sourceSha = 'a'.repeat(40);
const planSha = 'b'.repeat(40);
const devSha = 'c'.repeat(40);
const mainSha = 'd'.repeat(40);
const releaseSha = 'e'.repeat(40);
const task = { id: 'M1.01', dependsOn: [], status: 'complete', evidence: 'evidence.md' };
const indexTasks = [task, { id: 'M1.02', dependsOn: [], evidence: 'partial.md' }];
const roadmap = '- [x] M1.01 Finished with evidence.\n- [ ] M1.02 In progress.\n';

test('retries bounded transient GitHub API read failures and preserves permission errors', async () => {
  const delays = [];
  let attempts = 0;
  const value = await withGitHubReadRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('Command failed: gh api');
        error.stderr = "gh: We couldn't respond to your request in time. (HTTP 504)";
        throw error;
      }
      return { ok: true };
    },
    { sleep: async (milliseconds) => delays.push(milliseconds) }
  );
  assert.deepEqual(value, { ok: true });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);

  let permissionAttempts = 0;
  await assert.rejects(
    withGitHubReadRetry(async () => {
      permissionAttempts += 1;
      const error = new Error('HTTP 403: Resource not accessible by integration');
      error.stderr = error.message;
      throw error;
    }),
    /HTTP 403/u
  );
  assert.equal(permissionAttempts, 1);
});

test('flattens every GitHub CLI pagination page and rejects malformed page shapes', () => {
  const checkPages = [
    { check_runs: [{ id: 1, name: 'ci-technical-gate' }] },
    { check_runs: [{ id: 2, name: 'ci-technical-gate' }] },
  ];
  const releasePages = [[{ tag_name: 'v1.0.0' }], [{ tag_name: 'v1.1.0' }]];
  assert.deepEqual(flattenGitHubPages(checkPages, 'check_runs'), [
    { id: 1, name: 'ci-technical-gate' },
    { id: 2, name: 'ci-technical-gate' },
  ]);
  assert.deepEqual(flattenGitHubPages(releasePages, undefined), [
    { tag_name: 'v1.0.0' },
    { tag_name: 'v1.1.0' },
  ]);
  assert.throws(() => flattenGitHubPages({}, 'check_runs'), /pagination returned/u);
  assert.throws(() => flattenGitHubPages([{ check_runs: null }], 'check_runs'), /page has/u);
});

test('selects exact same-repository dev-to-main PR gate and ignores duplicate push checks', () => {
  const run = selectExactDevPullRequestCiRun(
    [
      {
        workflow_runs: [
          {
            id: 9,
            event: 'pull_request',
            head_branch: 'dev',
            head_sha: devSha,
            status: 'completed',
            pull_requests: [
              {
                number: 24,
                head: { ref: 'dev', sha: devSha, repo: { full_name: 'bjo163/moonwitness-xiv' } },
                base: { ref: 'main', repo: { full_name: 'bjo163/moonwitness-xiv' } },
              },
            ],
          },
          {
            id: 11,
            event: 'pull_request',
            head_branch: 'dev',
            head_sha: devSha,
            status: 'in_progress',
            pull_requests: [
              {
                number: 24,
                head: { ref: 'dev', sha: devSha, repo: { full_name: 'bjo163/moonwitness-xiv' } },
                base: { ref: 'main', repo: { full_name: 'bjo163/moonwitness-xiv' } },
              },
            ],
          },
          {
            id: 8,
            event: 'workflow_dispatch',
            head_branch: 'dev',
            head_sha: devSha,
            status: 'completed',
          },
          {
            id: 7,
            event: 'pull_request',
            head_branch: 'dev',
            head_sha: devSha,
            status: 'completed',
            pull_requests: [
              {
                number: 7,
                head: { ref: 'feature', sha: devSha, repo: { full_name: 'fork/moonwitness-xiv' } },
                base: { ref: 'main', repo: { full_name: 'bjo163/moonwitness-xiv' } },
              },
            ],
          },
          {
            id: 6,
            event: 'pull_request',
            head_branch: 'dev',
            head_sha: sourceSha,
            status: 'completed',
            pull_requests: [],
          },
        ],
      },
    ],
    devSha
  );
  assert.equal(run.id, 11);
  assert.equal(run.pull_request_number, 24);
  assert.equal(
    isExactDevMainPullRequest(
      {
        number: 24,
        head: {
          ref: 'dev',
          sha: devSha,
          repo: { full_name: 'bjo163/moonwitness-xiv' },
        },
        base: { ref: 'main', repo: { full_name: 'bjo163/moonwitness-xiv' } },
      },
      devSha,
      'bjo163/moonwitness-xiv',
      24
    ),
    true
  );
  assert.equal(
    isExactDevMainPullRequest(
      {
        number: 24,
        head: { ref: 'dev', sha: devSha, repo: { full_name: 'fork/moonwitness-xiv' } },
        base: { ref: 'main', repo: { full_name: 'bjo163/moonwitness-xiv' } },
      },
      devSha,
      'bjo163/moonwitness-xiv',
      24
    ),
    false
  );
  assert.equal(
    isExactDevMainPullRequest(
      {
        number: 25,
        head: { ref: 'dev', sha: devSha, repo: { full_name: 'bjo163/moonwitness-xiv' } },
        base: { ref: 'main', repo: { full_name: 'bjo163/moonwitness-xiv' } },
      },
      devSha,
      'bjo163/moonwitness-xiv',
      24
    ),
    false
  );
  assert.deepEqual(
    exactDevPullRequestTechnicalGate(run, [
      {
        jobs: [
          { id: 20, name: 'quality', status: 'completed', conclusion: 'success' },
          { id: 24, name: 'ci-gate', status: 'completed', conclusion: 'failure' },
          { id: 22, name: 'ci-technical-gate', status: 'completed', conclusion: 'success' },
          { id: 21, name: 'ci-technical-gate', status: 'completed', conclusion: 'failure' },
        ],
      },
    ]),
    {
      id: 22,
      name: 'ci-technical-gate',
      head_sha: devSha,
      status: 'completed',
      conclusion: 'success',
    }
  );
  assert.equal(exactDevPullRequestTechnicalGate(run, [{ jobs: [] }]), undefined);
  assert.equal(selectExactDevPullRequestCiRun([{ workflow_runs: [] }], devSha), undefined);
});

test('fails immediately when a completed PR CI run omits its technical gate', () => {
  const run = { id: 42, head_sha: devSha, status: 'completed' };
  assert.throws(
    () => completedExactDevPullRequestTechnicalGate(run, [{ jobs: [] }]),
    /did not report a completed ci-technical-gate/u
  );
  assert.throws(
    () =>
      completedExactDevPullRequestTechnicalGate(run, [
        { jobs: [{ id: 4, name: 'ci-technical-gate', status: 'in_progress' }] },
      ]),
    /did not report a completed ci-technical-gate/u
  );
});

test('returns an unverified snapshot immediately when no exact-source PR run exists', async () => {
  let workflowReads = 0;
  const result = await readCurrentDevPullRequestTechnicalGate({
    repository: 'bjo163/moonwitness-xiv',
    sourceSha: devSha,
    readDevHead: async () => devSha,
    readWorkflowRuns: async () => {
      workflowReads += 1;
      return [{ workflow_runs: [] }];
    },
    readPullRequest: async () => assert.fail('no exact-source run should be selected'),
    readJobs: async () => assert.fail('no exact-source run should be selected'),
  });

  assert.deepEqual(result, { status: 'ready', checkRuns: [] });
  assert.equal(workflowReads, 1);
});

test('captures a pending exact-source gate without waiting or treating it as verified', async () => {
  const run = {
    id: 42,
    event: 'pull_request',
    head_branch: 'dev',
    head_sha: devSha,
    status: 'in_progress',
    pull_requests: [
      {
        number: 24,
        head: { ref: 'dev', sha: devSha, repo: { full_name: 'bjo163/moonwitness-xiv' } },
        base: { ref: 'main', sha: mainSha, repo: { full_name: 'bjo163/moonwitness-xiv' } },
      },
    ],
  };
  const result = await readCurrentDevPullRequestTechnicalGate({
    repository: 'bjo163/moonwitness-xiv',
    sourceSha: devSha,
    readDevHead: async () => devSha,
    readWorkflowRuns: async () => [{ workflow_runs: [run] }],
    readPullRequest: async () => ({
      number: 24,
      head: { ref: 'dev', sha: devSha, repo: { full_name: 'bjo163/moonwitness-xiv' } },
      base: { ref: 'main', sha: mainSha, repo: { full_name: 'bjo163/moonwitness-xiv' } },
    }),
    readJobs: async () => [
      { jobs: [{ id: 25, name: 'ci-technical-gate', status: 'in_progress', conclusion: null }] },
    ],
  });

  assert.deepEqual(result, {
    status: 'ready',
    checkRuns: [
      {
        id: 25,
        name: 'ci-technical-gate',
        head_sha: devSha,
        status: 'in_progress',
        conclusion: null,
      },
    ],
  });
});

test('does not write a collected snapshot if dev advances after collection', async () => {
  let writes = 0;
  const written = await writeSnapshotIfDevHeadIsCurrent({
    sourceSha: devSha,
    readDevHead: async () => 'f'.repeat(40),
    writeSnapshot: async () => {
      writes += 1;
    },
  });

  assert.equal(written, false);
  assert.equal(writes, 0);
});

test('treats a PR head change during exact-run validation as a stale no-op', async () => {
  let headReads = 0;
  const run = {
    id: 9,
    event: 'pull_request',
    head_branch: 'dev',
    head_sha: devSha,
    status: 'in_progress',
    pull_requests: [
      {
        number: 24,
        head: { ref: 'dev', sha: devSha, repo: { full_name: 'bjo163/moonwitness-xiv' } },
        base: { ref: 'main', repo: { full_name: 'bjo163/moonwitness-xiv' } },
      },
    ],
  };
  const result = await readCurrentDevPullRequestTechnicalGate({
    repository: 'bjo163/moonwitness-xiv',
    sourceSha: devSha,
    readDevHead: async () => (++headReads === 1 ? devSha : 'f'.repeat(40)),
    readWorkflowRuns: async () => [{ workflow_runs: [run] }],
    readPullRequest: async () => ({
      number: 24,
      head: {
        ref: 'dev',
        sha: 'f'.repeat(40),
        repo: { full_name: 'bjo163/moonwitness-xiv' },
      },
      base: { ref: 'main', repo: { full_name: 'bjo163/moonwitness-xiv' } },
    }),
    readJobs: async () => assert.fail('stale run must not read gate jobs'),
  });

  assert.deepEqual(result, { status: 'stale' });
  assert.equal(headReads, 2);
});

test('accepts the completed exact PR technical gate for lifecycle evidence', () => {
  const run = { id: 42, head_sha: devSha, status: 'completed' };
  assert.deepEqual(
    completedExactDevPullRequestTechnicalGate(run, [
      {
        jobs: [
          {
            id: 4,
            name: 'ci-technical-gate',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
    ]),
    [
      {
        id: 4,
        name: 'ci-technical-gate',
        head_sha: devSha,
        status: 'completed',
        conclusion: 'success',
      },
    ]
  );
});

test('parses the explicit source commit marker and derives canonical roadmap task states', () => {
  assert.equal(parseEvidenceSourceSha(`# Evidence\n- Source SHA: \`${sourceSha}\`\n`), sourceSha);
  assert.equal(
    parseEvidenceSourceSha('# Evidence\n- Audit only, no source commit recorded.\n'),
    undefined
  );
  const states = parseRoadmapTaskStates(roadmap, indexTasks);
  assert.deepEqual(states.get('M1.01'), { status: 'complete', acceptanceVerified: true });
  assert.deepEqual(states.get('M1.02'), { status: 'todo', acceptanceVerified: false });
  assert.throws(
    () => parseRoadmapTaskStates(`${roadmap}- [ ] M1.01 Duplicate.\n`, indexTasks),
    /exactly one/u
  );
  assert.throws(
    () => parseRoadmapTaskStates(`${roadmap}- [x] M1.99 Unknown.\n`, indexTasks),
    /unindexed task/u
  );
});

test('parses K-series checkboxes through the shared lifecycle snapshot path', () => {
  const tasks = [{ id: 'K0-001', dependsOn: [], status: 'complete', evidence: 'k-evidence.md' }];
  const states = parseRoadmapTaskStates('- [x] K0-001 Approved ADR.\n', tasks);
  assert.deepEqual(states.get('K0-001'), { status: 'complete', acceptanceVerified: true });
});

test('collects current checks and ancestry without confusing evidence SHA with implementation SHA', async () => {
  const partialSourceSha = 'f'.repeat(40);
  const snapshot = await collectLifecycleSnapshot({
    tasks: indexTasks,
    roadmap,
    readEvidence: async (file) =>
      file === 'evidence.md'
        ? `# Evidence\n- Source SHA: \`${sourceSha}\`\n`
        : `# In progress\n- Source SHA: \`${partialSourceSha}\`\n`,
    repositoryId: '12345',
    sourceSha: planSha,
    branchHeads: { dev: devSha, main: mainSha },
    checkRuns: [
      {
        id: 2,
        name: 'ci-technical-gate',
        head_sha: devSha,
        status: 'completed',
        conclusion: 'success',
      },
      {
        id: 1,
        name: 'ci-technical-gate',
        head_sha: devSha,
        status: 'completed',
        conclusion: 'failure',
      },
      {
        id: 3,
        name: 'ci-technical-gate',
        head_sha: sourceSha,
        status: 'completed',
        conclusion: 'success',
      },
      { id: 4, name: 'CodeQL', head_sha: devSha, status: 'completed', conclusion: 'success' },
    ],
    releases: [],
    resolveReleaseCommit: () => undefined,
    commitExists: (sha) => sha === sourceSha || sha === partialSourceSha,
    isAncestor: (source, branch) =>
      [sourceSha, partialSourceSha].includes(source) && branch === devSha,
    generatedAt: '2026-10-07T10:00:00.000Z',
  });
  const row = snapshot.tasks.find(({ taskId }) => taskId === 'M1.01');
  assert.equal(row.evidenceSha, planSha);
  assert.equal(row.sourceSha, sourceSha);
  assert.equal(row.sourceInDev, true);
  assert.equal(row.sourceInMain, false);
  assert.deepEqual(row.requiredChecks, [
    { name: 'ci-technical-gate', headSha: devSha, status: 'completed', conclusion: 'success' },
  ]);
  const partialRow = snapshot.tasks.find(({ taskId }) => taskId === 'M1.02');
  assert.equal(partialRow.acceptanceVerified, false);
  assert.equal(partialRow.sourceInDev, true);
  assert.deepEqual(partialRow.requiredChecks, [
    { name: 'ci-technical-gate', headSha: devSha, status: 'completed', conclusion: 'success' },
  ]);
  const projected = projectLifecycleSnapshot({
    snapshot,
    tasks: indexTasks,
    issues: [],
    repositoryId: '12345',
    sourceSha: planSha,
    now: Date.parse('2026-10-07T10:00:00.000Z'),
  });
  assert.equal(projected.get('M1.01').deliveryStage, 'verified-dev');
});

test('adds release delivery only when the source is proven on main and in the release ancestry', async () => {
  const snapshot = await collectLifecycleSnapshot({
    tasks: [task],
    roadmap: '- [x] M1.01 Done.\n',
    readEvidence: async () => `- Source SHA: ${sourceSha}`,
    repositoryId: '12345',
    sourceSha: planSha,
    branchHeads: { dev: devSha, main: mainSha },
    checkRuns: [],
    releases: [
      {
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        published_at: '2026-10-01T00:00:00.000Z',
      },
    ],
    resolveReleaseCommit: () => releaseSha,
    commitExists: () => true,
    isAncestor: (source, branch) =>
      source === planSha && branch === mainSha
        ? false
        : source === 'a'.repeat(40) && [mainSha, releaseSha].includes(branch),
    generatedAt: '2026-10-07T10:00:00.000Z',
  });
  const row = snapshot.tasks[0];
  assert.equal(row.sourceInMain, true);
  assert.deepEqual(row.releaseManifest, { version: 'v1.2.3', sourceSha, releaseSha });
  assert.equal(row.releaseContainsSource, true);
  const projected = projectLifecycleSnapshot({
    snapshot,
    tasks: [task],
    issues: [],
    repositoryId: '12345',
    sourceSha: planSha,
    now: Date.parse('2026-10-07T10:00:00.000Z'),
  });
  assert.equal(projected.get('M1.01').deliveryStage, 'released');
});

test('keeps prerelease status bound to its semver tag and rejects invalid release targets', async () => {
  const validReleaseSha = '9'.repeat(40);
  const missingReleaseSha = '8'.repeat(40);
  const tags = new Map([
    ['v1.4.0-rc.2', validReleaseSha],
    ['v1.4.0', missingReleaseSha],
    ['v1.4.1', '7'.repeat(39)],
    ['v1.5.0', '6'.repeat(40)],
    ['v1.5.1', '5'.repeat(40)],
  ]);
  const snapshot = await collectLifecycleSnapshot({
    tasks: [task],
    roadmap: '- [x] M1.01 Done.\n',
    readEvidence: async () => `- Source SHA: \`${sourceSha}\``,
    repositoryId: '12345',
    sourceSha: planSha,
    branchHeads: { dev: devSha, main: mainSha },
    checkRuns: [],
    releases: [
      {
        tag_name: 'v1.5.1',
        draft: false,
        prerelease: false,
        published_at: '2026-10-06T00:00:00.000Z',
      },
      {
        tag_name: 'v1.5.0',
        draft: false,
        prerelease: true,
        published_at: '2026-10-05T00:00:00.000Z',
      },
      {
        tag_name: 'v1.4.1',
        draft: false,
        prerelease: false,
        published_at: '2026-10-04T00:00:00.000Z',
      },
      {
        tag_name: 'v1.4.0',
        draft: false,
        prerelease: false,
        published_at: '2026-10-03T00:00:00.000Z',
      },
      {
        tag_name: 'v1.4.0-rc.2',
        draft: false,
        prerelease: true,
        published_at: '2026-10-02T00:00:00.000Z',
      },
      {
        tag_name: 'v1.6.0',
        draft: true,
        prerelease: false,
        published_at: '2026-10-06T00:00:00.000Z',
      },
    ],
    resolveReleaseCommit: (tag) => tags.get(tag),
    commitExists: (sha) => sha !== missingReleaseSha && sha !== '6'.repeat(40),
    isAncestor: (candidate, branch) =>
      candidate === sourceSha && [mainSha, devSha, validReleaseSha].includes(branch),
    generatedAt: '2026-10-07T10:00:00.000Z',
  });

  const row = snapshot.tasks[0];
  assert.deepEqual(row.releaseManifest, {
    version: 'v1.4.0-rc.2',
    sourceSha,
    releaseSha: validReleaseSha,
  });
  assert.equal(row.releaseContainsSource, true);
  const projected = projectLifecycleSnapshot({
    snapshot,
    tasks: [task],
    issues: [],
    repositoryId: '12345',
    sourceSha: planSha,
    now: Date.parse('2026-10-07T10:00:00.000Z'),
  });
  assert.equal(projected.get('M1.01').deliveryStage, 'released');
  assert.equal(projected.get('M1.01').releaseVersion, 'v1.4.0-rc.2');
});
