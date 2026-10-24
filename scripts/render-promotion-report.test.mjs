import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import {
  loadPromotionSourceMetadata,
  renderPromotionReport,
  replacePromotionReport,
} from './render-promotion-report.mjs';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const repository = 'owner/repo';

function input(overrides = {}) {
  return {
    repository,
    baseSha,
    headSha,
    commits: ['fix(roadmap): harden sync (M11.03)'],
    changedFiles: ['scripts/roadmap/sync-issues.mjs'],
    tasks: [
      {
        id: 'M11.03',
        title: 'Build issue | sync\nrenderer',
        detailFile: 'docs/roadmap/11-issues-delivery.md',
        status: 'open',
      },
    ],
    risk: { requiresApproval: true, reasons: ['sensitive-path:scripts/example.mjs'] },
    checks: [
      {
        name: 'ci-gate',
        status: 'completed',
        conclusion: 'success',
        detailsUrl: 'https://github.com/owner/repo/actions/runs/123',
      },
      {
        name: '<img src=x>|CodeQL',
        status: 'in_progress',
        conclusion: null,
        detailsUrl: 'https://evil.example/forged',
      },
    ],
    releasePlan: {
      status: 'planned',
      currentVersion: 'v1.0.0',
      nextVersion: 'v1.0.1-rc.1',
      changeKind: 'patch',
    },
    ...overrides,
  };
}

test('promotion report binds tasks, checks, version and risk to exact source SHA', () => {
  const report = renderPromotionReport(input());
  assert.match(report, new RegExp(`Source: \`${headSha.slice(0, 12)}\``));
  assert.match(
    report,
    /\[M11\.03\]\(https:\/\/github\.com\/owner\/repo\/blob\/[a-f0-9]{40}\/docs\/roadmap\/11-issues-delivery\.md\)/u
  );
  assert.match(report, /Build issue \\?\| sync renderer/u);
  assert.match(report, /ci-gate \| completed \/ success/u);
  assert.match(report, /CodeQL \| in_progress \/ pending/u);
  assert.match(report, /&lt;img src=x&gt;\\\|CodeQL/u);
  assert.doesNotMatch(report, /evil\.example|<img/u);
  assert.match(report, /v1\.0\.1-rc\.1/u);
  assert.match(report, /Approval required/u);
});

test('promotion report extracts and links K-series task IDs', () => {
  const report = renderPromotionReport(
    input({
      commits: ['docs(roadmap): register K0-001 and K0-003'],
      changedFiles: [],
      tasks: [
        {
          id: 'K0-001',
          title: 'Centralization ADR',
          detailFile: 'docs/roadmap/12-local-ai-rebuild.md',
          status: 'open',
        },
        {
          id: 'K0-003',
          title: 'Domain ownership',
          detailFile: 'docs/roadmap/12-local-ai-rebuild.md',
          status: 'open',
        },
      ],
    })
  );
  assert.match(report, /Affected task IDs \(2\)/u);
  assert.match(report, /\[K0-001\]/u);
  assert.match(report, /\[K0-003\]/u);
});

test('large promotion ranges keep every task ID while bounding linked detail', () => {
  const tasks = Array.from({ length: 148 }, (_, index) => {
    const id = `M${Math.floor(index / 99)}.${String((index % 99) + 1).padStart(2, '0')}`;
    return {
      id,
      title: `${id} ${'A detailed roadmap task title '.repeat(12)}`,
      detailFile: `docs/roadmap/${id.toLowerCase()}.md`,
      status: 'open',
    };
  });
  const report = renderPromotionReport(
    input({
      commits: tasks.map((task) => `feat: complete ${task.id}`),
      changedFiles: [],
      tasks,
    })
  );

  assert.ok(report.length < 20_000, `expected compact report, got ${report.length} characters`);
  assert.match(report, /Affected task IDs \(148\)/u);
  assert.match(report, /M0\.01/u);
  assert.match(report, /M1\.49/u);
  assert.equal((report.match(/\]\(https:\/\/github\.com\/owner\/repo\/blob\//gu) ?? []).length, 32);
  assert.match(report, /118 more task details omitted/u);
  assert.match(
    report,
    new RegExp(
      `Full task list at this SHA\\]\\(https://github\\.com/owner/repo/blob/${headSha}/ROADMAP\\.md\\)`,
      'u'
    )
  );
});

test('report marks unavailable release baseline and missing check runs without inventing success', () => {
  const report = renderPromotionReport(input({ checks: [], releasePlan: undefined }));
  assert.match(report, /no stable release baseline is configured/u);
  assert.match(report, /No checks reported \| pending \/ pending/u);
  assert.doesNotMatch(report, /passed|success/u);
});

test('managed report replacement preserves manual notes and is idempotent', () => {
  const report = renderPromotionReport(input());
  const original = 'Maintainer notes\n\nKeep this section.';
  const first = replacePromotionReport(original, report);
  const second = replacePromotionReport(first, report);
  assert.equal(second, first);
  assert.ok(second.endsWith(original));
  assert.equal(second.split('Automated promotion report').length - 1, 1);
});

test('managed report refuses malformed markers instead of overwriting PR content', () => {
  const report = renderPromotionReport(input());
  assert.throws(
    () => replacePromotionReport('Human text\n<!-- BEGIN MOONWITNESS PROMOTION REPORT -->', report),
    /malformed or duplicate report markers/u
  );
  assert.throws(
    () =>
      replacePromotionReport(
        '<!-- END MOONWITNESS PROMOTION REPORT -->\n<!-- BEGIN MOONWITNESS PROMOTION REPORT -->',
        report
      ),
    /reversed report markers/u
  );
});

test('promotion source metadata is loaded from the exact reported commit', () => {
  const requestedFiles = [];
  const metadata = loadPromotionSourceMetadata(headSha, (file) => {
    requestedFiles.push(file);
    if (file === 'ROADMAP.md') return '- [x] M11.10 generated source status';
    return JSON.stringify({ tasks: [{ id: 'M11.10', title: 'Exact source task' }] });
  });

  assert.deepEqual(requestedFiles, ['ROADMAP.md', 'docs/roadmap/tasks.json']);
  assert.match(metadata.roadmap, /\[x\] M11\.10/u);
  assert.equal(metadata.tasksIndex.tasks[0]?.title, 'Exact source task');
  assert.throws(() => loadPromotionSourceMetadata('dev', () => '{}'), /full lowercase commit SHA/u);
  assert.throws(
    () => loadPromotionSourceMetadata(headSha, () => '{"tasks":{}}'),
    /task index is invalid/u
  );
});

test('promotion workflow refreshes one managed report from event SHA and preserves PR write boundaries', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/promote.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /checks: read/u);
  assert.match(workflow, /commits\/\$EXPECTED_SHA\/check-runs/u);
  assert.match(workflow, /node scripts\/render-promotion-report\.mjs/u);
  assert.match(
    workflow,
    /gh pr edit "\$PR_NUMBER" --repo "\$GH_REPO" --body-file "\$report_file"/u
  );
  assert.match(workflow, /git tag --list 'v\[0-9\]\*'/u);
  assert.match(
    workflow,
    /gh pr edit "\$PR_NUMBER" --repo "\$GH_REPO" --add-label approval-required/u
  );
});

test('completed verification refreshes report without running source-branch code or merging', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/refresh-promotion-report.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /workflow_run:/u);
  assert.match(workflow, /EXPECTED_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /checks: read/u);
  assert.match(workflow, /pull-requests: write/u);
  assert.match(
    workflow,
    /gh pr edit "\$PR_NUMBER" --repo "\$GH_REPO" --body-file "\$report_file"/u
  );
  assert.doesNotMatch(workflow, /gh pr merge/u);
});
