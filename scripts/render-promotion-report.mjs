import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { parseTaskId, taskIdSource } from './roadmap/task-ids.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const beginMarker = '<!-- BEGIN MOONWITNESS PROMOTION REPORT -->';
const endMarker = '<!-- END MOONWITNESS PROMOTION REPORT -->';
const taskPattern = new RegExp(`\\b${taskIdSource}\\b`, 'gu');
const maximumTaskDetailRows = 30;

function escapeTableCell(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

function safeCheckLink(value, repository) {
  if (typeof value !== 'string') return '—';
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      (parsed.pathname.startsWith(`/${repository}/actions/runs/`) ||
        parsed.pathname.startsWith(`/${repository}/commit/`))
    )
      return `[run](${parsed.href})`;
  } catch {
    // Invalid or untrusted check URLs are shown as absent, never rendered as links.
  }
  return '—';
}

function shortSha(value) {
  return value.slice(0, 12);
}

function truncate(value, maximumLength) {
  const characters = [...String(value)];
  return characters.length <= maximumLength
    ? String(value)
    : `${characters.slice(0, maximumLength - 1).join('')}…`;
}

function extractTaskIds(text) {
  return [...new Set(text.match(taskPattern) ?? [])].sort((left, right) => {
    const leftParts = parseTaskId(left);
    const rightParts = parseTaskId(right);
    const series = (id) => (id.startsWith('M') ? 0 : 1);
    return (
      series(left) - series(right) ||
      (leftParts?.milestone ?? '').localeCompare(rightParts?.milestone ?? '', undefined, {
        numeric: true,
      }) ||
      (leftParts?.ordinal ?? 0) - (rightParts?.ordinal ?? 0)
    );
  });
}

export function replacePromotionReport(existingBody, report) {
  const body = existingBody.trimEnd();
  const beginCount = body.split(beginMarker).length - 1;
  const endCount = body.split(endMarker).length - 1;
  if (beginCount !== endCount || beginCount > 1)
    throw new Error('Promotion PR body has malformed or duplicate report markers.');
  if (beginCount === 1) {
    const start = body.indexOf(beginMarker);
    const end = body.indexOf(endMarker);
    if (end < start) throw new Error('Promotion PR body has reversed report markers.');
    const endExclusive = end + endMarker.length;
    return `${body.slice(0, start)}${report}${body.slice(endExclusive)}`.trim();
  }
  return [report, body].filter(Boolean).join('\n\n');
}

export function renderPromotionReport({
  repository,
  baseSha,
  headSha,
  commits,
  changedFiles,
  tasks,
  risk,
  checks,
  releasePlan,
}) {
  if (!/^[a-f0-9]{40}$/u.test(baseSha) || !/^[a-f0-9]{40}$/u.test(headSha))
    throw new Error('Promotion report requires full lowercase base and head commit SHAs.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error('Promotion report repository identity is invalid.');
  if (!Array.isArray(commits) || !Array.isArray(changedFiles) || !Array.isArray(tasks))
    throw new Error('Promotion report commits, changedFiles, and tasks must be arrays.');
  if (!risk || typeof risk.requiresApproval !== 'boolean' || !Array.isArray(risk.reasons))
    throw new Error('Promotion risk report is missing or malformed.');
  if (!Array.isArray(checks)) throw new Error('Promotion check results must be an array.');

  const taskIds = extractTaskIds(
    [...commits, ...changedFiles].join('\n') +
      '\n' +
      tasks.map((task) => `${task.id} ${task.title}`).join('\n')
  );
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const relevantTasks = taskIds.filter((id) => tasksById.has(id));
  const orderedChecks = [...checks]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 20);
  const checkRows = orderedChecks.length
    ? orderedChecks.map(
        (check) =>
          `| ${escapeTableCell(check.name)} | ${escapeTableCell(check.status)} / ${escapeTableCell(check.conclusion ?? 'pending')} | ${safeCheckLink(check.detailsUrl, repository)} |`
      )
    : ['| No checks reported | pending / pending | Check status for this exact SHA |'];
  const taskIdSummary = relevantTasks.length
    ? `Affected task IDs (${relevantTasks.length}): ${relevantTasks.map((id) => `\`${id}\``).join(', ')}`
    : 'No roadmap Task IDs detected in commit subjects or changed paths.';
  const taskRows = relevantTasks.length
    ? relevantTasks.slice(0, maximumTaskDetailRows).map((id) => {
        const task = tasksById.get(id);
        const card = `https://github.com/${repository}/blob/${headSha}/${task.detailFile}`;
        return `| [${id}](${card}) | ${escapeTableCell(truncate(task.title, 90))} | ${escapeTableCell(task.status ?? 'source status unavailable')} |`;
      })
    : ['| No roadmap Task IDs detected in commit subjects or changed paths | — | — |'];
  if (relevantTasks.length > maximumTaskDetailRows)
    taskRows.push(
      `| ${relevantTasks.length - maximumTaskDetailRows} more task details omitted | [Full task list at this SHA](https://github.com/${repository}/blob/${headSha}/ROADMAP.md) | See source roadmap |`
    );
  const commitRows = commits.length
    ? commits
        .slice(0, 20)
        .map((commit) => `- ${escapeTableCell(commit)}`)
        .join('\n')
    : '- No commits found in this promotion range.';
  const changedPathRows = changedFiles.length
    ? changedFiles
        .slice(0, 30)
        .map((file) => `- \`${escapeTableCell(file).replaceAll('`', '\\`')}\``)
        .join('\n')
    : '- No changed paths found.';
  const riskText = risk.requiresApproval
    ? `**Approval required** — ${risk.reasons.map(escapeTableCell).join('; ') || 'risk classifier requires review'}`
    : `**Low risk** — ${risk.reasons.map(escapeTableCell).join('; ') || 'no elevated risk detected'}`;
  const versionText = releasePlan
    ? releasePlan.status === 'no-release'
      ? `No application release planned (${escapeTableCell(releasePlan.changeKind)} changes only).`
      : `Candidate: **${escapeTableCell(releasePlan.nextVersion ?? 'not determined')}** from ${escapeTableCell(releasePlan.currentVersion ?? 'unknown baseline')} (${escapeTableCell(releasePlan.changeKind ?? 'unknown change')}).`
    : 'Unavailable: no stable release baseline is configured or planner output was not supplied.';

  return [
    beginMarker,
    '## Automated promotion report',
    '',
    `Source: \`${shortSha(headSha)}\` → \`main\` (base \`${shortSha(baseSha)}\`). This report is bound to the exact ` +
      `[source commit](https://github.com/${repository}/commit/${headSha}) and [full roadmap](https://github.com/${repository}/blob/${headSha}/ROADMAP.md).`,
    '',
    '### Roadmap tasks',
    '',
    taskIdSummary,
    '',
    '| Task | Scope | Source status |',
    '| --- | --- | --- |',
    ...taskRows,
    '',
    '### Verification for this source SHA',
    '',
    '| Check | Status / result | Details |',
    '| --- | --- | --- |',
    ...checkRows,
    '',
    '### Release plan',
    '',
    versionText,
    '',
    'Application deployment is not part of this workflow.',
    '',
    '### Promotion risk',
    '',
    riskText,
    '',
    '### Commits',
    '',
    commitRows,
    '',
    '### Changed paths',
    '',
    changedPathRows,
    '',
    endMarker,
  ].join('\n');
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

export function loadPromotionSourceMetadata(
  headSha,
  readAtRevision = (file) => git(['show', `${headSha}:${file}`])
) {
  if (!/^[a-f0-9]{40}$/u.test(headSha))
    throw new Error('Promotion source metadata requires a full lowercase commit SHA.');
  const roadmap = readAtRevision('ROADMAP.md');
  const tasksIndex = JSON.parse(readAtRevision('docs/roadmap/tasks.json'));
  if (!Array.isArray(tasksIndex.tasks)) throw new Error('Promotion source task index is invalid.');
  return { roadmap, tasksIndex };
}

function parseChecks(value) {
  if (!Array.isArray(value.check_runs)) throw new Error('GitHub check-runs response is invalid.');
  return value.check_runs.map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    detailsUrl: check.html_url,
  }));
}

async function main() {
  const [
    baseSha,
    headSha,
    riskPath,
    checksPath,
    releasePlanPath,
    existingBodyPath,
    outputPath,
    repo = process.env.GITHUB_REPOSITORY,
  ] = process.argv.slice(2);
  if (
    !baseSha ||
    !headSha ||
    !riskPath ||
    !checksPath ||
    !releasePlanPath ||
    !existingBodyPath ||
    !outputPath ||
    !repo
  )
    throw new Error(
      'Usage: node scripts/render-promotion-report.mjs <base-sha> <head-sha> <risk-json> <checks-json> <release-json> <existing-body> <output> [owner/repo]'
    );
  const range = `${baseSha}..${headSha}`;
  const commits = git(['log', '--format=%s', range]).split(/\r?\n/u).filter(Boolean);
  const changedFiles = git(['diff', '--name-only', baseSha, headSha])
    .split(/\r?\n/u)
    .filter(Boolean);
  const { roadmap, tasksIndex } = loadPromotionSourceMetadata(headSha);
  const changedTaskIds = new Set(
    extractTaskIds(`${commits.join('\n')}\n${changedFiles.join('\n')}`).filter((id) =>
      tasksIndex.tasks.some((task) => task.id === id)
    )
  );
  for (const id of extractTaskIds(
    git(['diff', '--unified=0', baseSha, headSha, '--', 'ROADMAP.md'])
  ))
    if (tasksIndex.tasks.some((task) => task.id === id)) changedTaskIds.add(id);
  const tasks = [...changedTaskIds].map((id) => {
    const task = tasksIndex.tasks.find((candidate) => candidate.id === id);
    const line = roadmap
      .split(/\r?\n/u)
      .find((candidate) =>
        new RegExp(`^\\s*-\\s*\\[[ xX]\\]\\s+${id.replace('.', '\\.')}\\b`, 'u').test(candidate)
      );
    return {
      id,
      title: task.title,
      detailFile: task.detailFile,
      status: line ? (/^\s*-\s*\[x\]/iu.test(line) ? 'complete' : 'open') : 'missing',
    };
  });
  const risk = JSON.parse(await readFile(path.resolve(riskPath), 'utf8'));
  const checks = parseChecks(JSON.parse(await readFile(path.resolve(checksPath), 'utf8')));
  const releasePlan = JSON.parse(await readFile(path.resolve(releasePlanPath), 'utf8'));
  const existingBody = await readFile(path.resolve(existingBodyPath), 'utf8');
  const report = renderPromotionReport({
    repository: repo,
    baseSha,
    headSha,
    commits,
    changedFiles,
    tasks,
    risk,
    checks,
    releasePlan: releasePlan.status === 'unavailable' ? undefined : releasePlan,
  });
  await writeFile(
    path.resolve(outputPath),
    `${replacePromotionReport(existingBody, report)}\n`,
    'utf8'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
