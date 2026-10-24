import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { argv, cwd, env, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const requiredProjects = ['quality', 'integration', 'browser', 'containers', 'automation', 'ui'];
const automationSuites = ['workflow', 'release', 'roadmap', 'platform'];
const fullScopeFiles = new Set([
  '.github',
  'scripts',
  'ROADMAP.md',
  '.dockerignore',
  '.env.example',
  '.env.production.example',
  '.gitleaks.toml',
  'package.json',
  '.gitignore',
  '.gitattributes',
  '.githooks',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  '.prettierignore',
  '.prettierrc',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.development.yml',
  'docker-compose.smoke.yml',
  'docker-compose.production.yml',
  'deploy',
]);

export { fullScopeFiles };

export function hasFullScopeChange(changedFiles) {
  return changedFiles.some((path) =>
    [...fullScopeFiles].some((root) => path === root || path.startsWith(`${root}/`))
  );
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    stderr.write(
      `git ${args[0]} could not compare the requested revisions; selecting full scope.\n`
    );
    if (result.stderr) stderr.write(result.stderr);
    return null;
  }
  return result.stdout;
}

export function expandWorkspaceDependencies(changedNames, projects) {
  const affected = new Set(changedNames);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (affected.has(project.name)) continue;
      if (project.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(project.name);
        changed = true;
      }
    }
  }
  return affected;
}

export function ciProjectsForAffectedPackages(affectedPackages, changedFiles = []) {
  const affected = new Set(affectedPackages);
  const projects = new Set();
  const uiPackages = new Set(['@moonwitness/assets', '@moonwitness/ui', '@moonwitness/ui-catalog']);
  const specializedPackages = new Set([...uiPackages, '@moonwitness/api', '@moonwitness/board']);
  if (affected.has('@moonwitness/board')) {
    projects.add('quality');
    projects.add('browser');
    projects.add('containers');
  }
  if (affected.has('@moonwitness/api')) {
    projects.add('integration');
    projects.add('containers');
  }
  if ([...affected].some((name) => uiPackages.has(name))) {
    projects.add('quality');
    projects.add('ui');
  }
  if ([...affected].some((name) => !specializedPackages.has(name))) {
    for (const project of ['quality', 'integration', 'browser', 'containers']) {
      projects.add(project);
    }
  }
  if (changedFiles.some((path) => path.startsWith('docs/roadmap/'))) {
    projects.add('automation');
  }
  return [...projects];
}

export function requiresQualityLane(changedFiles, unclassifiedChanges = false) {
  return (
    unclassifiedChanges ||
    changedFiles.some(
      (path) =>
        (path.startsWith('docs/') || path === 'README.md') && !path.startsWith('docs/roadmap/')
    )
  );
}

export function automationSuitesForPlan(projects, mode) {
  if (!projects.includes('automation')) return [];
  return mode === 'full' ? automationSuites : ['roadmap'];
}

async function writePlan(result, jsonOutput) {
  const projects = result.projects;
  const selectedAutomationSuites = automationSuitesForPlan(projects, result.mode);
  result.automationSuites = selectedAutomationSuites;
  if (env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      env.GITHUB_OUTPUT,
      `projects=${JSON.stringify(projects)}\nautomation-suites=${JSON.stringify(selectedAutomationSuites)}\nplan=${JSON.stringify(result)}\n`
    );
  }
  stdout.write(jsonOutput ? JSON.stringify(result) : projects.join('\n'));
}

export async function readWorkspaceProjects(root = cwd()) {
  const workspaceYaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [];
  let readingPackages = false;
  for (const line of workspaceYaml.split(/\r?\n/u)) {
    if (/^packages:\s*$/u.test(line)) {
      readingPackages = true;
      continue;
    }
    if (readingPackages && /^\S/u.test(line)) break;
    if (!readingPackages) continue;
    const pattern = /^\s+-\s+['"]?([^'"#]+)['"]?\s*$/u.exec(line)?.[1]?.trim();
    if (pattern) patterns.push(pattern);
  }
  if (patterns.length === 0) throw new Error('pnpm workspace packages are missing');

  const projects = [];
  const names = new Set();
  for (const pattern of patterns) {
    const match = /^([^*]+)\/\*$/u.exec(pattern);
    if (!match) throw new Error(`Unsupported pnpm workspace package pattern: ${pattern}`);
    const packageDirectory = join(root, match[1]);
    const entries = await readdir(packageDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packagePath = join(packageDirectory, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error(
            `Workspace directory without a package.json: ${relative(root, packagePath).replaceAll('\\', '/')}`,
            { cause: error }
          );
        }
        throw error;
      }
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`Workspace package name is missing: ${packagePath}`);
      }
      if (names.has(manifest.name)) {
        throw new Error(`Duplicate workspace package name: ${manifest.name}`);
      }
      names.add(manifest.name);
      const dependencies = Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })
        .filter(([name, version]) => name.startsWith('@moonwitness/') && version === 'workspace:*')
        .map(([name]) => name)
        .sort();
      projects.push({
        name: manifest.name,
        path: relative(root, packagePath).replaceAll('\\', '/'),
        dependencies,
      });
    }
  }
  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

async function main() {
  const base = argv[2] ?? env.AFFECTED_BASE_SHA;
  const head = argv[3] ?? env.GITHUB_SHA ?? 'HEAD';
  const jsonOutput = argv.includes('--json');
  let workspaceProjects;
  try {
    workspaceProjects = await readWorkspaceProjects();
  } catch {
    stderr.write('Invalid pnpm workspace graph; using full CI scope.\n');
    await writePlan(
      { mode: 'full', reason: 'invalid-workspace-graph', projects: requiredProjects },
      jsonOutput
    );
    return;
  }

  const changedPaths = base ? git(['diff', '--name-only', base, head]) : null;
  if (changedPaths === null) {
    const reason = base ? 'base-sha-unavailable' : 'base-sha-missing';
    await writePlan({ mode: 'full', reason, projects: requiredProjects }, jsonOutput);
    return;
  }

  const changedFiles = changedPaths.split(/\r?\n/u).filter(Boolean);
  if (hasFullScopeChange(changedFiles)) {
    await writePlan(
      { mode: 'full', reason: 'shared-configuration', projects: requiredProjects },
      jsonOutput
    );
    return;
  }

  const changedNames = workspaceProjects
    .filter((project) => {
      return changedFiles.some((path) => path.startsWith(`${project.path}/`));
    })
    .map((project) => project.name);
  const affected = expandWorkspaceDependencies(changedNames, workspaceProjects);

  const ciProjects = ciProjectsForAffectedPackages(affected, changedFiles);
  const unclassifiedChanges = changedFiles.some(
    (path) =>
      !workspaceProjects.some((project) => path.startsWith(`${project.path}/`)) &&
      !path.startsWith('docs/') &&
      path !== 'README.md'
  );
  if (requiresQualityLane(changedFiles, unclassifiedChanges)) {
    if (!ciProjects.includes('quality')) ciProjects.push('quality');
  }

  const result = {
    mode: 'affected',
    reason: 'workspace-dependency-closure',
    changed: changedNames.sort(),
    affected: [...affected].sort(),
    projects: ciProjects,
  };
  await writePlan(result, jsonOutput);
}

const isDirectExecution =
  argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(argv[1]);
if (isDirectExecution) await main();
