import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const COMPATIBILITY_REVIEW_GATES = [
  'pnpm lint',
  'pnpm format:check',
  'pnpm typecheck',
  'pnpm test:unit:built',
  'pnpm test:integration:built',
  'pnpm test:e2e:built',
  'pnpm test:ui-catalog',
  'pnpm test:ui-budget',
  'pnpm test:architecture',
  'pnpm architecture:check:built',
  'pnpm docs:check:built',
  'pnpm test:docs-portal',
];

/** Candidate batches stay small so one update never mixes majors or unrelated lanes. */
export const DEFAULT_BATCH_LIMIT = 3;

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const GATE_BY_WORKSPACE = [
  { prefix: 'apps/api', gates: ['pnpm test:integration:built', 'pnpm test:e2e:built'] },
  { prefix: 'apps/board', gates: ['pnpm test:e2e:built'] },
  { prefix: 'apps/docs', gates: ['pnpm docs:check:built', 'pnpm test:docs-portal'] },
  { prefix: 'apps/ui-catalog', gates: ['pnpm test:ui-catalog'] },
  { prefix: 'packages/ui', gates: ['pnpm test:ui-catalog', 'pnpm test:ui-budget'] },
  { prefix: 'packages/assets', gates: ['pnpm test:assets'] },
  {
    prefix: '.github',
    gates: [
      'pnpm test:action-pins',
      'pnpm test:workflow-trust',
      'pnpm test:ci-gate',
      'pnpm automation:check:action-tags',
    ],
  },
];

const FALLBACK_GATES = ['pnpm typecheck', 'pnpm test:unit:built'];

const GATE_ORDER = [
  ...COMPATIBILITY_REVIEW_GATES,
  'pnpm test:assets',
  'pnpm test:action-pins',
  'pnpm test:workflow-trust',
  'pnpm test:ci-gate',
  'pnpm automation:check:action-tags',
];

function toRepoPath(location) {
  if (typeof location !== 'string' || location.length === 0) return null;
  const inside = relative(repoRoot, location);
  if (inside === '') return '.';
  if (inside.startsWith('..')) return null;
  return inside.split(sep).join('/');
}

function workspacePaths(dependentPackages) {
  const paths = new Set();
  for (const dependent of dependentPackages ?? []) {
    const path = toRepoPath(dependent?.location);
    // Root-located dependents (.github workflow files, the workspace root
    // package) have no directory of their own, so their name is the label.
    if (path === '.') paths.add(String(dependent?.name ?? '.'));
    else if (path) paths.add(path);
  }
  return [...paths].sort();
}

function gatesForWorkspaces(paths) {
  const gates = new Set(FALLBACK_GATES);
  for (const path of paths) {
    const entry = GATE_BY_WORKSPACE.find((candidate) => path.startsWith(candidate.prefix));
    for (const gate of entry ? entry.gates : FALLBACK_GATES) gates.add(gate);
  }
  return GATE_ORDER.filter((gate) => gates.has(gate));
}

let virtualStoreEntries;
function installedManifest(name) {
  // pnpm's outdated JSON carries no registry metadata, so the only upstream
  // pointer available offline is the manifest already resolved in this store.
  if (virtualStoreEntries === undefined) {
    try {
      virtualStoreEntries = readdirSync(resolve(repoRoot, 'node_modules/.pnpm'));
    } catch {
      virtualStoreEntries = null;
    }
  }
  if (!virtualStoreEntries) return null;
  const directoryPrefix = `${name.replace('/', '+')}@`;
  for (const entry of virtualStoreEntries) {
    if (!entry.startsWith(directoryPrefix)) continue;
    try {
      return JSON.parse(
        readFileSync(
          resolve(repoRoot, 'node_modules/.pnpm', entry, 'node_modules', name, 'package.json'),
          'utf8'
        )
      );
    } catch {
      // Peer-suffixed directories can shadow the plain one; keep scanning.
    }
  }
  return null;
}

function actionRepositoryUrl(name) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/.+)?$/.exec(name ?? '');
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

function resolveUpstream(name, group, entry) {
  const fromRegistry = repositoryUrl(entry.latestManifest);
  if (fromRegistry) return { url: fromRegistry, source: 'registry-manifest' };
  if (group === 'actions') {
    const fromAction = actionRepositoryUrl(name);
    return fromAction ? { url: fromAction, source: 'action-reference' } : { source: 'unavailable' };
  }
  const fromStore = repositoryUrl(installedManifest(name));
  return fromStore ? { url: fromStore, source: 'installed-manifest' } : { source: 'unavailable' };
}

function compatibilityProbe(name, group) {
  if (group === 'actions')
    return { kind: 'not-applicable', reason: 'Actions are pinned refs, not imports.' };
  let output;
  try {
    output = execFileSync(
      'git',
      ['grep', '-n', '-E', `['\`]${name}(/[^'\`]*)?['\`]`, '--', 'apps', 'packages', 'scripts'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
  } catch (error) {
    if (error.status !== 1 || typeof error.stdout !== 'string') {
      return { kind: 'unavailable', reason: 'The local import scan could not run.' };
    }
    output = error.stdout;
  }
  const specifiers = new Set();
  const files = new Set();
  for (const line of output.split('\n')) {
    const located = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!located) continue;
    const specifier = /['`]([^'`\\]+)['`]/.exec(located[3]);
    if (!specifier) continue;
    specifiers.add(specifier[1]);
    files.add(located[1]);
  }
  return {
    kind: 'local-import-scan',
    referencingFiles: files.size,
    specifiers: [...specifiers].sort(),
  };
}

function majorImpactReport({
  name,
  group,
  current,
  latest,
  dependents,
  releaseNotes,
  upstreamSource,
  paths,
  compatibility,
}) {
  return {
    status: 'manual-review-required',
    current,
    target: latest,
    releaseNotes,
    releaseNotesSource: upstreamSource,
    workspaceDependents: dependents,
    impactedWorkspaces: paths,
    testImpacts: gatesForWorkspaces(paths),
    localUsage:
      compatibility.kind === 'local-import-scan'
        ? `${compatibility.referencingFiles} tracked source file(s) reference "${name}" through ${compatibility.specifiers.length} specifier(s): ${compatibility.specifiers.join(', ') || 'the bare package export'}`
        : compatibility.reason,
    requiredTasks: [
      'Review every upstream migration guide and breaking change between current and target versions.',
      'Search the repository for imported APIs, package configuration, and runtime behavior affected by the major update.',
      'Map each breaking change to workspace dependents and record the required source/data/API migration.',
      'Document rollback constraints and assign an owner before applying the candidate.',
      'Do not select the major candidate for automatic application; submit a manual, reviewed compatibility plan.',
    ],
    requiredGates: [...COMPATIBILITY_REVIEW_GATES],
    securityScans: [
      'Workspace dependencies: block CRITICAL findings.',
      'Candidate API and Board images: block CRITICAL findings.',
    ],
    package: name,
    group,
  };
}

function parseVersion(version) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version ?? ''
  );
  return match ? match.slice(1, 4).map(Number) : null;
}

export function classifyCompatibility(current, latest) {
  const from = parseVersion(current);
  const to = parseVersion(latest);
  if (!from || !to) return 'unknown';
  if (to[0] !== from[0]) return 'major';
  if (to[1] !== from[1]) return 'minor';
  if (to[2] !== from[2]) return 'patch';
  return 'same';
}

function isNewerVersion(current, target) {
  const from = parseVersion(current);
  const to = parseVersion(target);
  if (!from || !to) return false;
  for (let index = 0; index < from.length; index += 1) {
    if (to[index] !== from[index]) return to[index] > from[index];
  }
  return false;
}

function groupFor(dependencyType) {
  if (dependencyType === 'githubAction') return 'actions';
  if (dependencyType === 'dependencies' || dependencyType === 'optionalDependencies') {
    return 'runtime';
  }
  if (dependencyType === 'devDependencies') return 'development';
  return null;
}

function safeTarget(current, wanted, latest) {
  const wantedCompatibility = classifyCompatibility(current, wanted);
  if (
    typeof wanted === 'string' &&
    !wanted.includes('-') &&
    isNewerVersion(current, wanted) &&
    ['patch', 'minor'].includes(wantedCompatibility)
  ) {
    return { version: wanted, compatibility: wantedCompatibility, source: 'wanted' };
  }

  const latestCompatibility = classifyCompatibility(current, latest);
  if (
    wantedCompatibility === 'same' &&
    typeof latest === 'string' &&
    !latest.includes('-') &&
    isNewerVersion(current, latest) &&
    ['patch', 'minor'].includes(latestCompatibility)
  ) {
    return { version: latest, compatibility: latestCompatibility, source: 'latest' };
  }
  return null;
}

function repositoryUrl(manifest) {
  const repository = manifest?.repository;
  const candidate =
    (typeof repository === 'string' ? repository : repository?.url) ?? manifest?.homepage;
  if (typeof candidate !== 'string') return null;
  const normalized = candidate
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const shorthand = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(normalized);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/tree\/[A-Za-z0-9_.\-/]+)?$/.test(
    normalized
  )
    ? normalized
    : null;
}

export function buildDependencyPlan(outdated, sourceSha, generatedAt, options = {}) {
  const batchLimit = normalizeBatchLimit(options.batchLimit);
  const groups = { runtime: [], development: [], actions: [] };
  for (const [name, entry] of Object.entries(outdated)) {
    const group = groupFor(entry.dependencyType);
    if (!group) continue;
    const current = entry.current ?? '';
    const latest = entry.latest ?? '';
    const upstream = resolveUpstream(name, group, entry);
    const impactedWorkspaces = workspacePaths(entry.dependentPackages);
    const candidate = {
      name,
      group,
      current,
      wanted: entry.wanted ?? null,
      latest,
      compatibility: classifyCompatibility(current, latest),
      wantedCompatibility: classifyCompatibility(current, entry.wanted ?? latest),
      safeTarget: safeTarget(current, entry.wanted, latest),
      deprecated: entry.isDeprecated === true,
      dependents: Array.isArray(entry.dependentPackages)
        ? entry.dependentPackages
            .map((dependent) => dependent.name)
            .filter(Boolean)
            .sort()
        : [],
      impactedWorkspaces,
      releaseNotes: upstream.url ?? null,
      releaseNotesSource: upstream.source,
      localUsage: compatibilityProbe(name, group),
    };
    if (candidate.compatibility === 'major' || candidate.wantedCompatibility === 'major') {
      candidate.majorImpact = majorImpactReport({
        name,
        group,
        current,
        latest,
        dependents: candidate.dependents,
        releaseNotes: candidate.releaseNotes,
        upstreamSource: candidate.releaseNotesSource,
        paths: impactedWorkspaces,
        compatibility: candidate.localUsage,
      });
    }
    groups[group].push(candidate);
  }
  for (const candidates of Object.values(groups)) {
    candidates.sort((left, right) => left.name.localeCompare(right.name));
  }
  return {
    sourceSha,
    generatedAt,
    mode: 'read-only-plan',
    batchLimit,
    batch: selectBatch(groups, batchLimit),
    groups,
  };
}

function normalizeBatchLimit(value) {
  if (value === undefined) return DEFAULT_BATCH_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('--batch-limit must be an integer between 1 and 20.');
  }
  return limit;
}

export function selectBatch(groups, batchLimit) {
  const batch = { limit: batchLimit, selected: [], deferred: [] };
  for (const [group, candidates] of Object.entries(groups)) {
    const applicable = candidates.filter((candidate) => candidate.safeTarget);
    for (const candidate of applicable.slice(0, batchLimit)) {
      candidate.batchSelected = true;
      batch.selected.push({
        group,
        name: candidate.name,
        current: candidate.current,
        target: candidate.safeTarget.version,
        compatibility: candidate.safeTarget.compatibility,
      });
    }
    for (const candidate of applicable.slice(batchLimit)) {
      candidate.batchSelected = false;
      batch.deferred.push(`${group}:${candidate.name}`);
    }
    for (const candidate of candidates) {
      if (!candidate.safeTarget) candidate.batchSelected = null;
    }
  }
  return batch;
}

export function selectUpdateCandidate(plan, packageName) {
  if (
    !plan ||
    plan.mode !== 'read-only-plan' ||
    !Array.isArray(plan.groups?.runtime) ||
    !Array.isArray(plan.groups?.development) ||
    !Array.isArray(plan.groups?.actions)
  ) {
    throw new Error('Invalid dependency candidate plan.');
  }
  const candidates = [...plan.groups.runtime, ...plan.groups.development];
  const matches = candidates.filter((candidate) => candidate.name === packageName);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one package candidate named ${packageName}; found ${matches.length}.`
    );
  }
  const [candidate] = matches;
  if (!candidate.safeTarget) {
    if (typeof candidate.wanted === 'string' && candidate.wanted.includes('-')) {
      throw new Error(`Candidate ${packageName} is a prerelease and cannot be auto-applied.`);
    }
    if (candidate.compatibility === 'major' || candidate.wantedCompatibility === 'major') {
      throw new Error(`Major candidate ${packageName} is report-only and cannot be auto-applied.`);
    }
    throw new Error(`Candidate ${packageName} has no safe patch/minor target.`);
  }
  return {
    packageName: candidate.name,
    version: candidate.safeTarget.version,
    sourceSha: plan.sourceSha,
    compatibility: candidate.safeTarget.compatibility,
    targetSource: candidate.safeTarget.source,
  };
}

export function renderSummary(plan) {
  const lines = [
    '## Dependency update candidates (read-only)',
    '',
    `- Source SHA: \`${plan.sourceSha}\``,
    `- Generated: ${plan.generatedAt}`,
    `- Batch limit per group: ${plan.batch.limit}`,
    '',
    `### Selected batch (${plan.batch.selected.length} of the safe patch/minor candidates)`,
    '',
  ];
  if (plan.batch.selected.length === 0) {
    lines.push('No safe patch/minor candidate was available to batch.', '');
  } else {
    lines.push(
      '| Group | Package/action | Current | Target | Class |',
      '| --- | --- | --- | --- | --- |'
    );
    for (const item of plan.batch.selected) {
      lines.push(
        `| ${item.group} | ${item.name} | ${item.current} | ${item.target} | ${item.compatibility} |`
      );
    }
    lines.push(
      '',
      `${plan.batch.deferred.length} safe candidate(s) stayed outside this batch: ${plan.batch.deferred.join(', ') || 'none'}.`,
      ''
    );
  }
  for (const [group, candidates] of Object.entries(plan.groups)) {
    lines.push(`### ${group} (${candidates.length})`, '');
    if (candidates.length === 0) {
      lines.push('No updates reported.', '');
      continue;
    }
    lines.push(
      '| Package/action | Current | Wanted | Wanted class | Safe target | Latest | Latest class | Dependents | Batch | Release notes |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    );
    for (const item of candidates) {
      const cells = [
        item.name,
        item.current,
        item.wanted ?? '—',
        item.wantedCompatibility,
        item.safeTarget ? `${item.safeTarget.version} (${item.safeTarget.source})` : '—',
        item.latest,
        item.compatibility,
        item.dependents.join(', ') || '—',
        item.batchSelected === true ? 'selected' : item.batchSelected === false ? 'deferred' : '—',
        item.releaseNotes
          ? `${item.releaseNotes}/releases (${item.releaseNotesSource})`
          : `not resolvable locally (${item.releaseNotesSource})`,
      ].map((value) => String(value).replace(/[|\r\n]/g, ' '));
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
    for (const item of candidates) {
      if (!item.majorImpact) continue;
      lines.push(
        `#### Major compatibility review: ${item.name}`,
        '',
        `- Current: \`${item.majorImpact.current}\`; target: \`${item.majorImpact.target}\`.`,
        `- Direct workspace dependents: ${item.majorImpact.workspaceDependents.join(', ') || 'not reported; inventory them before planning'}.`,
        `- Impacted workspaces: ${item.majorImpact.impactedWorkspaces.join(', ') || 'not resolved to a repository path'}.`,
        `- Local usage: ${item.majorImpact.localUsage}.`,
        `- Upstream release notes: ${item.majorImpact.releaseNotes ? `${item.majorImpact.releaseNotes}/releases (source: ${item.majorImpact.releaseNotesSource})` : `not resolvable locally (source: ${item.majorImpact.releaseNotesSource}); locate and record authoritative notes before planning`}.`,
        '- Status: manual review required; the candidate executor refuses major updates.',
        '- Required migration and verification tasks:'
      );
      for (const task of item.majorImpact.requiredTasks) lines.push(`  - ${task}`);
      lines.push('- Test impacts derived from the impacted workspaces:');
      for (const gate of item.majorImpact.testImpacts) lines.push(`  - \`${gate}\``);
      lines.push('- Required full candidate gates:');
      for (const gate of item.majorImpact.requiredGates) lines.push(`  - \`${gate}\``);
      for (const scan of item.majorImpact.securityScans) lines.push(`  - ${scan}`);
      lines.push('');
    }
  }
  lines.push(
    'Plan generation did not update manifests, lockfiles, branches, issues, or pull requests. Major and prerelease candidates are report-only.',
    ''
  );
  return lines.join('\n');
}

function loadOutdatedJson() {
  let stdout;
  try {
    stdout = execSync('pnpm outdated --recursive --format json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    if (error.status !== 1 || typeof error.stdout !== 'string') {
      throw new Error(`pnpm outdated failed (exit ${String(error.status)}).`, { cause: error });
    }
    stdout = error.stdout;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected an object keyed by package or action name.');
    }
    return parsed;
  } catch (error) {
    throw new Error('pnpm outdated did not return valid JSON.', { cause: error });
  }
}

function gitSourceSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function resolvePlanOutputPath(args) {
  const outputIndex = args.indexOf('--output');
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && (!outputPath || outputPath.startsWith('--'))) {
    throw new Error('--output requires a path.');
  }
  return outputPath;
}

function main(args) {
  const outputPath = resolvePlanOutputPath(args);
  const sourceIndex = args.indexOf('--source-sha');
  const sourceSha = sourceIndex >= 0 ? args[sourceIndex + 1] : gitSourceSha();
  if (!sourceSha || sourceSha.startsWith('--')) throw new Error('--source-sha requires a value.');

  const limitIndex = args.indexOf('--batch-limit');
  const batchLimit = limitIndex >= 0 ? args[limitIndex + 1] : undefined;
  if (limitIndex >= 0 && (!batchLimit || batchLimit.startsWith('--'))) {
    throw new Error('--batch-limit requires a value.');
  }
  const planOptions = { batchLimit };

  const selectedIndex = args.indexOf('--select');
  if (selectedIndex >= 0) {
    const packageName = args[selectedIndex + 1];
    if (!packageName || packageName.startsWith('--'))
      throw new Error('--select requires a package name.');
    const plan = buildDependencyPlan(
      loadOutdatedJson(),
      sourceSha,
      new Date().toISOString(),
      planOptions
    );
    process.stdout.write(`${JSON.stringify(selectUpdateCandidate(plan, packageName))}\n`);
    return;
  }

  const plan = buildDependencyPlan(
    loadOutdatedJson(),
    sourceSha,
    new Date().toISOString(),
    planOptions
  );
  if (outputPath) {
    const serialized = `${JSON.stringify(plan, null, 2)}\n`;
    writeFileSync(resolve(outputPath), serialized, { encoding: 'utf8', flag: 'wx' });
  }
  process.stdout.write(renderSummary(plan));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) writeFileSync(summaryPath, renderSummary(plan), { encoding: 'utf8', flag: 'a' });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
