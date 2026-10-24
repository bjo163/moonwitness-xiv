import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  computeReleaseInputSha,
  releaseNotesBegin,
  releaseNotesEnd,
  renderChangelogSection,
} from './render-changelog.mjs';
import { readCommitRange, resolveCommit } from './git-range.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = 'CHANGELOG.md';

function parseArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--include-content') options.set(argument, true);
    else if (['--expected-head', '--date', '--channel'].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      options.set(argument, value);
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function asVersion(value) {
  if (
    typeof value !== 'string' ||
    !/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/u.test(value)
  )
    throw new Error(`Unsupported release version: ${value}`);
  return value.replace(/^v/u, '');
}

function replaceSection(source, generatedSection, version, inputSha) {
  const lines = source.split('\n');
  const headerPrefix = `## [${version}] - `;
  const isReleaseHeader = (line) => /^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/u.test(line);
  const sectionStarts = lines.flatMap((line, index) =>
    isReleaseHeader(line) ? [index] : line.startsWith('## [') ? [index] : []
  );
  const matching = sectionStarts.filter((index) => lines[index].startsWith(headerPrefix));
  if (matching.length > 1)
    throw new Error(`CHANGELOG.md contains duplicate sections for ${version}.`);

  if (matching.length === 1) {
    const startLine = matching[0];
    const endLine = sectionStarts.find((index) => index > startLine) ?? lines.length;
    const startOffset = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
    const endOffset =
      endLine === lines.length ? source.length : lines.slice(0, endLine).join('\n').length + 1;
    const existing = source.slice(startOffset, endOffset);
    const markerLines = existing
      .split('\n')
      .filter((line) => line.startsWith('<!-- release-source-sha:'));
    if (markerLines.length !== 1 || !markerLines[0].includes(`input: ${inputSha} -->`)) {
      const begin = existing.indexOf(releaseNotesBegin);
      const end = existing.indexOf(releaseNotesEnd);
      if (
        begin < 0 ||
        end <= begin ||
        existing.indexOf(releaseNotesBegin, begin + 1) >= 0 ||
        existing.indexOf(releaseNotesEnd, end + 1) >= 0
      )
        throw new Error(
          `Existing ${version} changelog notes are not safely managed; refusing to overwrite them.`
        );
      const managedEnd = end + releaseNotesEnd.length;
      const updated = `${existing.slice(0, begin)}${generatedSection.slice(generatedSection.indexOf(releaseNotesBegin), generatedSection.indexOf(releaseNotesEnd) + releaseNotesEnd.length)}${existing.slice(managedEnd)}`;
      return `${source.slice(0, startOffset)}${updated}${source.slice(endOffset)}`;
    }
    return source;
  }

  const insertAtLine = sectionStarts[0] ?? lines.length;
  const insertOffset =
    insertAtLine === lines.length
      ? source.length
      : lines.slice(0, insertAtLine).join('\n').length + 1;
  const before = source.slice(0, insertOffset).replace(/\s*$/u, '');
  const after = source.slice(insertOffset).replace(/^\s*/u, '');
  return `${before}\n\n${generatedSection.trimEnd()}${after ? `\n\n${after}` : '\n'}`;
}

export function prepareReleaseFiles({ plan, manifests, changelog, changelogSection }) {
  if (plan?.status !== 'planned' || !plan.nextVersion)
    throw new Error('Only a planned release with a next version can be prepared.');
  if (
    !/^[a-f0-9]{40}$/u.test(plan.source?.headSha ?? '') ||
    !/^[a-f0-9]{40}$/u.test(plan.source?.baselineSha ?? '')
  )
    throw new Error('Release preparation requires full source and baseline commit SHAs.');

  const version = asVersion(plan.nextVersion);
  const files = [];
  let updatedWorkspaces = 0;
  for (const { path: manifestPath, source } of manifests) {
    const manifest = JSON.parse(source);
    const shouldUpdate =
      manifestPath === 'package.json' || manifest.name?.startsWith('@moonwitness/');
    if (!shouldUpdate) continue;
    if (manifest.version !== version) {
      manifest.version = version;
      updatedWorkspaces += manifestPath === 'package.json' ? 0 : 1;
    }
    const contents = `${JSON.stringify(manifest, null, 2)}\n`;
    if (contents !== source) files.push({ path: manifestPath, contents });
  }
  if (!manifests.some(({ path: manifestPath }) => manifestPath === 'package.json'))
    throw new Error('Root package.json is missing from release preparation inputs.');

  const nextChangelog = replaceSection(
    changelog,
    changelogSection,
    version,
    computeReleaseInputSha(plan)
  );
  if (nextChangelog !== changelog) files.push({ path: changelogPath, contents: nextChangelog });
  return {
    source: plan.source,
    version,
    status: files.length ? 'prepared' : 'already-prepared',
    files,
    updatedWorkspaces,
    releaseInputSha: computeReleaseInputSha(plan),
    writesPerformed: false,
  };
}

async function readWorkspaceManifests() {
  const directories = [];
  for (const group of ['apps', 'packages']) {
    const entries = await readdir(path.join(repositoryRoot, group), { withFileTypes: true });
    directories.push(
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => `${group}/${entry.name}`)
    );
  }
  const paths = ['package.json', ...directories.map((directory) => `${directory}/package.json`)];
  const pathResults = await Promise.all(
    paths.map(async (manifestPath) => {
      try {
        await readFile(path.join(repositoryRoot, manifestPath), 'utf8');
        return manifestPath;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    })
  );
  return Promise.all(
    pathResults
      .filter((manifestPath) => manifestPath !== null)
      .map(async (manifestPath) => ({
        path: manifestPath,
        source: await readFile(path.join(repositoryRoot, manifestPath), 'utf8'),
      }))
  );
}

function repositoryUrl() {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  const ssh =
    /^git@github\.com:(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
      remote
    );
  if (ssh?.groups) return `https://github.com/${ssh.groups.owner}/${ssh.groups.repo}`;
  return remote.replace(/\.git$/u, '');
}

function assertExpectedDevHead(expectedHead) {
  if (!/^[a-f0-9]{40}$/u.test(expectedHead))
    throw new Error('--expected-head must be a full lowercase commit SHA.');
  if (resolveCommit('HEAD') !== expectedHead)
    throw new Error('Checkout changed after release planning; recompute from the new dev head.');
  if (process.env.GITHUB_REF && process.env.GITHUB_REF !== 'refs/heads/dev')
    throw new Error('Release preparation may only write from the dev branch.');
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  if (branch && branch !== 'dev')
    throw new Error(`Release preparation requires dev, received ${branch}.`);
  if (
    execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  )
    throw new Error('Release preparation requires a clean disposable checkout.');
  const remote = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/dev'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/u)[0];
  if (remote !== expectedHead)
    throw new Error('origin/dev advanced; recompute release preparation from its new SHA.');
}

async function main(args) {
  const options = parseArguments(args);
  const apply = options.has('--apply');
  const includeContent = options.has('--include-content');
  const headSha = resolveCommit('HEAD');
  const expectedHead = options.get('--expected-head');
  if (apply) {
    if (process.env.GITHUB_ACTIONS !== 'true')
      throw new Error(
        '--apply is restricted to the disposable hosted release-preparation checkout.'
      );
    if (!expectedHead) throw new Error('--apply requires --expected-head.');
    assertExpectedDevHead(expectedHead);
  }
  const date = options.get('--date') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))
    throw new Error('--date must be a valid UTC date in YYYY-MM-DD format.');
  const channel = options.get('--channel') ?? 'rc';
  if (!['rc', 'stable', 'hotfix'].includes(channel))
    throw new Error(`Unsupported release channel: ${channel}`);
  const planOutput = execFileSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts/release-plan.mjs'),
      '--head',
      headSha,
      '--channel',
      channel,
      '--json',
    ],
    { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const plan = JSON.parse(planOutput);
  if (plan.status === 'no-release') {
    process.stdout.write(
      `${JSON.stringify({ source: plan.source, status: 'no-release', writesPerformed: false }, null, 2)}\n`
    );
    return;
  }
  if (plan.status !== 'planned')
    throw new Error('Release plan is invalid; fix commit classification before preparation.');
  const commits = readCommitRange(plan.source.baselineSha, plan.source.headSha);
  const changelogSection = renderChangelogSection({
    plan,
    commits,
    repositoryUrl: repositoryUrl(),
    date,
  });
  const changelog = await readFile(path.join(repositoryRoot, changelogPath), 'utf8');
  const preparation = prepareReleaseFiles({
    plan,
    manifests: await readWorkspaceManifests(),
    changelog,
    changelogSection,
  });
  preparation.channel = channel;
  if (!apply) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...preparation,
          files: includeContent
            ? preparation.files
            : preparation.files.map(({ path: filePath }) => filePath),
        },
        null,
        2
      )}\n`
    );
    return;
  }
  if (apply && preparation.files.length) {
    for (const file of preparation.files)
      await writeFile(path.join(repositoryRoot, file.path), file.contents, 'utf8');
    execFileSync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
    execFileSync('pnpm', ['docs:generate'], { cwd: repositoryRoot, stdio: 'inherit' });
    execFileSync('pnpm', ['release:check', `v${preparation.version}`], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
    execFileSync('pnpm', ['docs:check'], { cwd: repositoryRoot, stdio: 'inherit' });
    execFileSync(
      'pnpm',
      [
        'exec',
        'prettier',
        '--write',
        'package.json',
        'apps/*/package.json',
        'packages/*/package.json',
        'CHANGELOG.md',
        'docs',
      ],
      { cwd: repositoryRoot, stdio: 'inherit' }
    );
    execFileSync('pnpm', ['release:check', `v${preparation.version}`], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
    execFileSync('pnpm', ['docs:check'], { cwd: repositoryRoot, stdio: 'inherit' });
    execFileSync('pnpm', ['format:check'], { cwd: repositoryRoot, stdio: 'inherit' });
    preparation.writesPerformed = true;
    preparation.generatedDocs = true;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ...preparation,
        files: includeContent
          ? preparation.files
          : preparation.files.map(({ path: filePath }) => filePath),
      },
      null,
      2
    )}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
