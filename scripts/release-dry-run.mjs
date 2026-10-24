import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseWorkflow = path.join(repositoryRoot, '.github/workflows/release.yml');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--date' || argument === '--channel') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      options.set(argument, value);
      index += 1;
    } else if (argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--output requires a file path.');
      options.set(argument, value);
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function plannedAssets(version, sourceSha, repository) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const imageRepository = `ghcr.io/${repository.toLowerCase()}`;
  return [
    { name: `${imageRepository}:${tag}`, kind: 'api-image', immutable: true },
    {
      name: `${imageRepository}-board:${tag}`,
      kind: 'board-image',
      immutable: true,
    },
    { name: 'GitHub Release notes', kind: 'release-notes', immutable: true },
    {
      name: 'release-artifacts.sha256',
      kind: 'transport-checksum',
      location: 'workflow-artifact',
      immutable: true,
    },
    {
      name: `release-images-${sourceSha}`,
      kind: 'verified-image-transport',
      immutable: true,
    },
    {
      name: 'release-api.spdx.json',
      kind: 'api-sbom',
      location: 'github-release-asset',
      required: true,
      implementationStatus: 'hosted-acceptance-pending',
    },
    {
      name: 'release-board.spdx.json',
      kind: 'board-sbom',
      location: 'github-release-asset',
      required: true,
      implementationStatus: 'hosted-acceptance-pending',
    },
    {
      name: 'release-assets.sha256',
      kind: 'release-asset-checksum',
      location: 'github-release-asset',
      required: true,
      implementationStatus: 'hosted-acceptance-pending',
    },
    {
      name: 'GitHub artifact provenance attestation',
      kind: 'artifact-provenance',
      required: true,
      implementationStatus: 'hosted-acceptance-pending',
    },
    {
      name: 'API and Board image provenance attestations',
      kind: 'image-provenance',
      required: true,
      implementationStatus: 'hosted-acceptance-pending',
    },
    {
      name: 'API and Board image SPDX attestations',
      kind: 'image-sbom-attestations',
      required: true,
      implementationStatus: 'hosted-acceptance-pending',
    },
  ];
}

export function requiredGates(sourceSha, version) {
  return [
    { id: 'source-main-ancestry', phase: 'verify', status: 'not-run', sourceSha },
    { id: 'exact-main-ci-gate', phase: 'verify', status: 'not-run', sourceSha },
    {
      id: 'workspace-release-version',
      phase: 'verify',
      status: 'not-run',
      command: `pnpm release:check v${version}`,
    },
    { id: 'lint', phase: 'verify', status: 'not-run', command: 'pnpm lint' },
    { id: 'format', phase: 'verify', status: 'not-run', command: 'pnpm format:check' },
    { id: 'typecheck', phase: 'verify', status: 'not-run', command: 'pnpm typecheck' },
    { id: 'generated-docs', phase: 'verify', status: 'not-run', command: 'pnpm docs:check' },
    {
      id: 'board-lint',
      phase: 'verify',
      status: 'not-run',
      command: 'pnpm --filter @moonwitness/board lint',
    },
    { id: 'unit', phase: 'verify', status: 'not-run', command: 'pnpm test:unit' },
    {
      id: 'postgres-integration',
      phase: 'verify',
      status: 'not-run',
      command: 'pnpm test:integration',
    },
    { id: 'api-board-image-build', phase: 'verify', status: 'not-run', command: 'docker build' },
    {
      id: 'container-smoke',
      phase: 'verify',
      status: 'not-run',
      command: 'bash scripts/smoke-containers.sh',
    },
    {
      id: 'critical-container-vulnerabilities',
      phase: 'verify',
      status: 'not-run',
      scanner: 'Trivy CRITICAL',
    },
    {
      id: 'production-compose-config',
      phase: 'verify',
      status: 'not-run',
      command: 'docker compose -f docker-compose.production.yml config --quiet',
    },
    { id: 'api-board-spdx-sbom', phase: 'verify', status: 'not-run' },
    { id: 'artifact-transport-checksum', phase: 'publish', status: 'not-run' },
    { id: 'github-artifact-provenance', phase: 'publish', status: 'not-run' },
    { id: 'remote-tag-source-sha', phase: 'publish', status: 'not-run', sourceSha },
    { id: 'ghcr-image-reconciliation', phase: 'publish', status: 'not-run' },
    { id: 'api-board-image-provenance', phase: 'publish', status: 'not-run' },
    { id: 'api-board-image-sbom-attestations', phase: 'publish', status: 'not-run' },
    { id: 'release-asset-reconciliation', phase: 'publish', status: 'not-run' },
    { id: 'release-asset-attestations', phase: 'publish', status: 'not-run' },
    { id: 'github-release-reconciliation', phase: 'publish', status: 'not-run' },
    { id: 'stable-latest-digest-policy', phase: 'publish', status: 'not-run' },
  ];
}

export function assertCleanSource(statusOutput) {
  if (statusOutput.trim())
    throw new Error(
      'Release dry-run requires a clean checkout so its report matches the source SHA.'
    );
}

export function resolveRepositorySlug(remote) {
  const ssh = /^(?:ssh:\/\/)?git@[^/:]+:(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote);
  if (ssh?.groups?.slug) return ssh.groups.slug;
  let parsed;
  try {
    parsed = new globalThis.URL(remote);
  } catch {
    throw new Error('origin must be a GitHub HTTPS or SSH repository URL.');
  }
  const slug = parsed.pathname.replace(/^\//u, '').replace(/\.git$/u, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug))
    throw new Error('origin must identify a GitHub owner/repository.');
  return slug;
}

export function buildReleaseDryRunReport(
  preparation,
  currentFiles,
  repository = 'owner/repository',
  gates = preparation.status === 'no-release'
    ? []
    : requiredGates(preparation.source.headSha, preparation.version)
) {
  const versionDiff = [];
  const fileChanges = [];
  let changelogSection = null;

  for (const file of preparation.files ?? []) {
    const before = currentFiles.get(file.path) ?? '';
    fileChanges.push({
      path: file.path,
      beforeSha256: sha256(before),
      afterSha256: sha256(file.contents),
    });
    if (file.path.endsWith('package.json')) {
      const previous = JSON.parse(before);
      const next = JSON.parse(file.contents);
      if (previous.version !== next.version)
        versionDiff.push({ path: file.path, from: previous.version, to: next.version });
    }
    if (file.path === 'CHANGELOG.md') {
      const header = `## [${preparation.version}] - `;
      const start = file.contents.indexOf(header);
      if (start >= 0) {
        const nextHeader = file.contents.indexOf('\n## [', start + header.length);
        changelogSection = file.contents.slice(start, nextHeader < 0 ? undefined : nextHeader);
      }
    }
  }

  return {
    schemaVersion: 1,
    kind: 'moonwitness-release-dry-run',
    generatedAt: new Date().toISOString(),
    source: preparation.source,
    status: preparation.status,
    version: preparation.version ?? null,
    releaseInputSha: preparation.releaseInputSha ?? null,
    versionDiff,
    changelogDiff: changelogSection,
    files: fileChanges,
    assets: preparation.version
      ? plannedAssets(preparation.version, preparation.source.headSha, repository)
      : [],
    readinessFindings: preparation.version
      ? plannedAssets(preparation.version, preparation.source.headSha, repository)
          .filter((asset) => asset.required && asset.implementationStatus !== 'hosted-verified')
          .map((asset) => `${asset.kind} requires hosted release acceptance`)
      : [],
    gates,
    writesPerformed: false,
    registryWritesPerformed: false,
    githubReleaseCreated: false,
    pagesPublished: false,
    deploymentPerformed: false,
  };
}

async function run(options) {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assertCleanSource(status);
  const date = options.get('--date') ?? new Date().toISOString().slice(0, 10);
  const channel = options.get('--channel') ?? 'rc';
  if (!['rc', 'stable', 'hotfix'].includes(channel))
    throw new Error(`Unsupported release channel: ${channel}`);
  const preparationOutput = execFileSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts/prepare-release.mjs'),
      '--include-content',
      '--date',
      date,
      '--channel',
      channel,
    ],
    { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const preparation = JSON.parse(preparationOutput);
  const repository = resolveRepositorySlug(
    execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim()
  );
  const currentFiles = new Map(
    await Promise.all(
      (preparation.files ?? []).map(async (file) => [
        file.path,
        await readFile(path.join(repositoryRoot, file.path), 'utf8'),
      ])
    )
  );
  const workflow = await readFile(releaseWorkflow, 'utf8');
  const report = buildReleaseDryRunReport(preparation, currentFiles, repository);
  report.channel = channel;
  report.releaseWorkflowSha256 = sha256(workflow);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = options.get('--output');
  if (outputPath) await writeFile(path.resolve(outputPath), output, { flag: 'wx' });
  else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
