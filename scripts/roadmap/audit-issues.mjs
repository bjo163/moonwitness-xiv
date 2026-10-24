import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { createGitHubIssuesClient } from './sync-issues.mjs';
import { parseRoadmapTaskStates } from './collect-lifecycle-snapshot.mjs';
import { taskIdCaptureSource } from './task-ids.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const markerPattern = new RegExp(
  `^<!-- moonwitness-task: ([1-9][0-9]*):${taskIdCaptureSource} -->$`,
  'gmu'
);
const managedStart = '<!-- BEGIN MOONWITNESS MANAGED -->';
const managedEnd = '<!-- END MOONWITNESS MANAGED -->';
const fullShaPattern = /^[a-f0-9]{40}$/u;
// Mirrors the delivery stages that make a projection closeable in lifecycle.mjs.
const deliveredStages = new Set(['verified-dev', 'in-main', 'released']);

function collectManagedIssues(issues, repositoryId) {
  const matches = new Map();
  const malformed = [];
  for (const issue of issues) {
    if (issue.pull_request || !['open', 'closed'].includes(issue.state)) continue;
    const body = typeof issue.body === 'string' ? issue.body : '';
    const taskMarkers = [...body.matchAll(markerPattern)].filter(
      ([, repo]) => repo === repositoryId
    );
    if (taskMarkers.length === 0) continue;
    if (taskMarkers.length !== 1) {
      malformed.push({ issueNumber: issue.number, reason: 'multiple-managed-task-markers' });
      continue;
    }
    const [, , taskId] = taskMarkers[0];
    const matched = matches.get(taskId) ?? [];
    matched.push(issue);
    matches.set(taskId, matched);
    const starts = body.split(managedStart).length - 1;
    const ends = body.split(managedEnd).length - 1;
    if (starts !== 1 || ends !== 1 || body.indexOf(managedEnd) < body.indexOf(managedStart))
      malformed.push({ issueNumber: issue.number, taskId, reason: 'malformed-managed-block' });
  }
  return { matches, malformed };
}

function issueGeneratedBlock(issue) {
  const body = typeof issue.body === 'string' ? issue.body : '';
  const start = body.indexOf(managedStart);
  const end = body.indexOf(managedEnd);
  if (start < 0 || end < start) return '';
  return body.slice(start, end + managedEnd.length);
}

function expectedManagedLabels(task) {
  return new Set(
    [
      'roadmap',
      `milestone:${task.milestone.toLowerCase()}`,
      ...(task.priority ? [`priority:${task.priority}`] : []),
      ...(task.labels ?? []),
    ].map((label) => label.toLowerCase())
  );
}

function generatedLinkProblems(issue, task, repositoryUrl) {
  const block = issueGeneratedBlock(issue);
  const problems = [];
  const checkLine = (name, expectedPath) => {
    if (!expectedPath) return;
    const line = new RegExp(`^${name}:\\s+\\[[^\\]]+\\]\\(([^)]+)\\)\\s*$`, 'mu').exec(block)?.[1];
    if (!line) {
      problems.push(`${name.toLowerCase()}-link-missing`);
      return;
    }
    let actual;
    try {
      actual = new URL(line);
    } catch {
      problems.push(`${name.toLowerCase()}-link-invalid`);
      return;
    }
    const base = new URL(repositoryUrl);
    const segments = actual.pathname.split('/').filter(Boolean);
    if (
      actual.origin !== base.origin ||
      segments[0] !== base.pathname.split('/').filter(Boolean)[0] ||
      segments[1] !== base.pathname.split('/').filter(Boolean)[1] ||
      segments[2] !== 'blob' ||
      !fullShaPattern.test(segments[3] ?? '') ||
      segments.slice(4).join('/') !== expectedPath
    )
      problems.push(`${name.toLowerCase()}-link-dead-or-untrusted`);
  };
  checkLine('Card', task.detailFile);
  checkLine('Evidence', task.evidence);
  return problems;
}

/**
 * Compare the projection the sync wrote into the managed block against the live
 * issue state and the source status of the task. Delivery evidence only exists
 * inside that block, so a stale block can never invent a closure claim here.
 */
function lifecycleStateDrift(block, state, sourceStatus) {
  if (!sourceStatus) return null;
  const workStatus = /^Work status: (\S+)$/mu.exec(block)?.[1];
  const deliveryStage = /^Delivery stage: (\S+)$/mu.exec(block)?.[1] ?? null;
  const blockers = /^Lifecycle blockers: (.*)$/mu.exec(block)?.[1];
  if (state === 'closed' && sourceStatus !== 'complete')
    return { kind: 'closed-while-incomplete', sourceStatus, deliveryStage };
  if (
    state === 'open' &&
    sourceStatus === 'complete' &&
    workStatus === 'complete' &&
    deliveredStages.has(deliveryStage ?? '') &&
    blockers === undefined
  )
    return { kind: 'open-while-deliverable', sourceStatus, deliveryStage };
  return null;
}

/**
 * Read-only source-to-issue drift audit. It never performs network or filesystem
 * writes. Lifecycle state drift is judged only when `taskStates` carries the
 * source status parsed from the master roadmap; without it no claim is made.
 */
export function auditRoadmapIssues({
  tasks,
  taskStates,
  issues,
  milestones,
  labels,
  repositoryId,
  repositoryUrl,
  sourceSha,
  generatedAt,
}) {
  if (!/^[1-9][0-9]*$/u.test(repositoryId)) throw new Error('Repository ID must be numeric.');
  if (!fullShaPattern.test(sourceSha)) throw new Error('Audit source SHA must be a full Git SHA.');
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const { matches, malformed } = collectManagedIssues(issues, repositoryId);
  const taskIds = new Set(tasksById.keys());
  const missing = [...tasksById.keys()].filter((taskId) => !matches.has(taskId)).sort();
  const duplicates = [...matches]
    .filter(([, rows]) => rows.length > 1)
    .map(([taskId, rows]) => ({
      taskId,
      issueNumbers: rows.map(({ number }) => number).sort((a, b) => a - b),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const orphans = [...matches]
    .filter(([taskId]) => !taskIds.has(taskId))
    .map(([taskId, rows]) => ({
      taskId,
      issueNumbers: rows.map(({ number }) => number).sort((a, b) => a - b),
      recommendedAction: 'needs-triage',
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const staleSource = [];
  const staleMilestoneIssues = [];
  const missingIssueLabels = [];
  const unexpectedManagedIssueLabels = [];
  const linkProblems = [];
  const stateDrift = [];
  for (const [taskId, rows] of matches) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    for (const issue of rows) {
      if (rows.length > 1) continue;
      const block = issueGeneratedBlock(issue);
      const source = /^Source SHA: ([a-f0-9]{40})$/mu.exec(block)?.[1];
      if (source !== sourceSha)
        staleSource.push({ taskId, issueNumber: issue.number, sourceSha: source ?? null });
      if (issue.milestone?.title !== task.milestone)
        staleMilestoneIssues.push({
          taskId,
          issueNumber: issue.number,
          actual: issue.milestone?.title ?? null,
          expected: task.milestone,
        });
      const expected = expectedManagedLabels(task);
      const current = new Set((issue.labels ?? []).map(({ name }) => name.toLowerCase()));
      const missingForIssue = [...expected].filter((label) => !current.has(label)).sort();
      if (missingForIssue.length)
        missingIssueLabels.push({ taskId, issueNumber: issue.number, labels: missingForIssue });
      const unexpected = [...current]
        .filter(
          (label) => /^(?:roadmap|milestone:|priority:|lane:)/u.test(label) && !expected.has(label)
        )
        .sort();
      if (unexpected.length)
        unexpectedManagedIssueLabels.push({
          taskId,
          issueNumber: issue.number,
          labels: unexpected,
        });
      const problems = generatedLinkProblems(issue, task, repositoryUrl);
      if (problems.length) linkProblems.push({ taskId, issueNumber: issue.number, problems });
      const stateFinding = lifecycleStateDrift(block, issue.state, taskStates?.get(taskId)?.status);
      if (stateFinding) stateDrift.push({ taskId, issueNumber: issue.number, ...stateFinding });
    }
  }
  const requiredMilestones = new Set(tasks.map(({ milestone }) => milestone));
  const missingMilestones = [...requiredMilestones]
    .filter((title) => !milestones.some((row) => row.title === title))
    .sort();
  const orphanMilestones = milestones
    .filter((row) => row.state === 'open' && !requiredMilestones.has(row.title))
    .map(({ title, number }) => ({ title, number }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const requiredLabels = new Set(tasks.flatMap((task) => [...expectedManagedLabels(task)]));
  const knownLabels = new Set(labels.map(({ name }) => name.toLowerCase()));
  const missingLabels = [...requiredLabels].filter((name) => !knownLabels.has(name)).sort();
  const orphanLabels = labels
    .filter(
      ({ name }) =>
        /^(?:roadmap|milestone:|priority:|lane:)/u.test(name.toLowerCase()) &&
        !requiredLabels.has(name.toLowerCase())
    )
    .map(({ name }) => name)
    .sort();
  return {
    schemaVersion: 1,
    repositoryId,
    sourceSha,
    generatedAt,
    summary: {
      taskCount: tasks.length,
      managedIssueCount: [...matches.values()].reduce((sum, rows) => sum + rows.length, 0),
      missingCount: missing.length,
      duplicateCount: duplicates.length,
      orphanIssueCount: orphans.length,
      staleSourceCount: staleSource.length,
      staleMilestoneIssueCount: staleMilestoneIssues.length,
      brokenGeneratedLinkCount: linkProblems.length,
      conflictCount: malformed.length,
      lifecycleStateDriftCount: stateDrift.length,
      metadataDriftCount:
        missingMilestones.length +
        orphanMilestones.length +
        missingLabels.length +
        orphanLabels.length +
        missingIssueLabels.length +
        unexpectedManagedIssueLabels.length,
    },
    missing,
    duplicates,
    orphans,
    malformed,
    staleSource,
    staleMilestoneIssues,
    linkProblems,
    stateDrift,
    metadata: {
      missingMilestones,
      orphanMilestones,
      missingLabels,
      orphanLabels,
      missingIssueLabels,
      unexpectedManagedIssueLabels,
    },
  };
}

export function renderIssueAuditSummary(report) {
  const { summary } = report;
  return [
    `Roadmap issue audit source SHA: ${report.sourceSha}`,
    `Tasks=${summary.taskCount}, managedIssues=${summary.managedIssueCount}, missing=${summary.missingCount}, duplicates=${summary.duplicateCount}, orphanIssues=${summary.orphanIssueCount}.`,
    `StaleSource=${summary.staleSourceCount}, staleMilestoneIssues=${summary.staleMilestoneIssueCount}, brokenGeneratedLinks=${summary.brokenGeneratedLinkCount}, conflicts=${summary.conflictCount}, metadataDrift=${summary.metadataDriftCount}, lifecycleStateDrift=${summary.lifecycleStateDriftCount}.`,
  ].join('\n');
}

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const quiet = args.includes('--quiet');
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/roadmap/audit-issues.mjs [--quiet] [--output <repository-relative-file>]\n'
    );
    return;
  }
  if (args.some((arg) => arg.startsWith('--') && !['--output', '--quiet'].includes(arg)))
    throw new Error('Unknown issue audit option.');
  if (outputIndex >= 0 && (!outputPath || outputPath.startsWith('--')))
    throw new Error('--output requires a repository-relative file.');
  const absoluteOutput = outputPath ? path.resolve(repositoryRoot, outputPath) : undefined;
  if (absoluteOutput && !absoluteOutput.startsWith(`${repositoryRoot}${path.sep}`))
    throw new Error('--output must stay inside the repository.');
  const repository = process.env.GITHUB_REPOSITORY;
  const repositoryId = process.env.GITHUB_REPOSITORY_ID;
  if (!repository || !repositoryId)
    throw new Error('Set GITHUB_REPOSITORY and GITHUB_REPOSITORY_ID.');
  execFileSync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts/roadmap/validate-roadmap.mjs')],
    { cwd: repositoryRoot, stdio: 'ignore' }
  );
  const index = JSON.parse(
    await readFile(path.join(repositoryRoot, 'docs/roadmap/tasks.json'), 'utf8')
  );
  const taskStates = parseRoadmapTaskStates(
    await readFile(path.join(repositoryRoot, 'ROADMAP.md'), 'utf8'),
    index.tasks
  );
  const repositoryParts = repository.split('/');
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !part))
    throw new Error('GITHUB_REPOSITORY must be owner/repository.');
  const [owner, repo] = repositoryParts;
  const client = createGitHubIssuesClient({ token: process.env.GITHUB_TOKEN, owner, repo });
  const [issues, metadata] = await Promise.all([client.listAll(), client.listMetadata()]);
  const report = auditRoadmapIssues({
    tasks: index.tasks,
    taskStates,
    issues,
    milestones: metadata.milestones,
    labels: metadata.labels,
    repositoryId,
    repositoryUrl: `https://github.com/${owner}/${repo}`,
    sourceSha: git(['rev-parse', 'HEAD']),
    generatedAt: new Date().toISOString(),
  });
  if (absoluteOutput)
    await writeFile(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${quiet ? renderIssueAuditSummary(report) : `${JSON.stringify(report, null, 2)}\n`}${absoluteOutput ? `\nWrote read-only audit report for ${report.sourceSha}.` : ''}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
