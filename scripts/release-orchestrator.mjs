import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  formatVersion,
  listReleaseTags,
  parseVersion,
  resolveReleasePlan,
} from './release-plan.mjs';
import { resolveCommit } from './git-range.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[a-f0-9]{40}$/u;
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/u;

function parseArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      options.set(argument, true);
    } else if (
      [
        '--head',
        '--channel',
        '--confirm-version',
        '--remote-tags-file',
        '--releases-file',
        '--output',
      ].includes(argument)
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      options.set(argument, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  for (const required of ['--head', '--remote-tags-file', '--releases-file']) {
    if (!options.has(required)) throw new Error(`${required} is required.`);
  }
  return options;
}

export function normalizeVersion(value) {
  const match = versionPattern.exec(value ?? '');
  if (!match) throw new Error(`Unsupported release version: ${value}`);
  const version = parseVersion(match[0]);
  return formatVersion(version);
}

export function parseRemoteTags(source) {
  if (typeof source !== 'string') throw new Error('Remote tag listing must be text.');
  const tags = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const [sha, reference] = line.trim().split(/\s+/u);
    if (!shaPattern.test(sha ?? '')) throw new Error('Remote tag listing contains an invalid SHA.');
    const match = /^refs\/tags\/(?<tag>.+?)(?<peeled>\^\{\})?$/u.exec(reference ?? '');
    if (!match?.groups) continue;
    const tag = match.groups.tag;
    if (match.groups.peeled || !tags.has(tag)) tags.set(tag, sha);
  }
  return tags;
}

function flattenPages(value) {
  if (!Array.isArray(value)) throw new Error('GitHub release listing must be an array.');
  return value.every((item) => Array.isArray(item)) ? value.flat() : value;
}

export function parseReleases(source) {
  let value;
  try {
    value = typeof source === 'string' ? JSON.parse(source) : source;
  } catch {
    throw new Error('GitHub release listing must be valid JSON.');
  }
  const releases = [];
  for (const release of flattenPages(value)) {
    if (
      !release ||
      typeof release.tag_name !== 'string' ||
      typeof release.draft !== 'boolean' ||
      typeof release.prerelease !== 'boolean'
    ) {
      throw new Error('GitHub release listing contains an invalid release.');
    }
    if (!versionPattern.test(release.tag_name)) continue;
    releases.push({
      tag: normalizeVersion(release.tag_name),
      draft: release.draft,
      prerelease: release.prerelease,
    });
  }
  return releases;
}

export function publishedTagsFromReleases(releases) {
  return releases.filter((release) => !release.draft).map((release) => release.tag);
}

export function decideReleaseAction({
  plan,
  currentVersion,
  headSha,
  devSha,
  devContained,
  remoteTags,
  releases,
  confirmVersion = null,
  channel,
}) {
  if (!shaPattern.test(headSha) || !shaPattern.test(devSha))
    throw new Error('Release orchestration requires full source and dev commit SHAs.');
  if (!(remoteTags instanceof Map)) throw new Error('Remote tag state is required.');
  if (!Array.isArray(releases)) throw new Error('GitHub release state is required.');
  if (channel !== plan.channel) throw new Error('Release channel does not match the plan.');

  const current = normalizeVersion(currentVersion);
  const baseline = plan.currentVersion ? normalizeVersion(plan.currentVersion) : null;
  const next = plan.nextVersion ? normalizeVersion(plan.nextVersion) : null;
  const confirmation = confirmVersion ? normalizeVersion(confirmVersion) : null;
  const summary = {
    channel,
    source: { headSha, devSha },
    plan: {
      status: plan.status,
      changeKind: plan.changeKind,
      baselineTag: plan.source?.baselineTag ?? null,
      baselineSha: plan.source?.baselineSha ?? null,
      currentVersion: baseline,
      nextVersion: next,
      requiresApproval: Boolean(plan.requiresApproval),
      approvalGate: plan.approvalGate ?? null,
      publishPolicy: plan.publishPolicy ?? null,
      anomalies: plan.anomalies ?? [],
    },
  };

  if (plan.status === 'no-release') {
    return {
      status: 'no-release',
      reason: 'No release-worthy commit exists.',
      ...summary,
      action: null,
    };
  }
  if (plan.status === 'invalid') {
    return {
      status: 'blocked',
      reason: 'invalid-plan',
      detail: plan.invalidReason ?? 'The release plan is invalid.',
      ...summary,
      action: null,
    };
  }
  if (!baseline || !next) throw new Error('A planned release requires baseline and next versions.');

  const tagSha = remoteTags.get(next) ?? null;
  const release = releases.find((entry) => entry.tag === next) ?? null;
  const nextIsStable = parseVersion(next).prerelease === null;

  if (release && release.prerelease !== !nextIsStable) {
    return {
      status: 'blocked',
      reason: 'release-state-mismatch',
      detail: `GitHub Release ${next} has an unexpected prerelease state.`,
      ...summary,
      action: null,
    };
  }
  if (release && !release.draft) {
    if (tagSha !== headSha) {
      return {
        status: 'blocked',
        reason: 'tag-mismatch-for-published-release',
        detail: `Published release ${next} does not point at ${headSha}.`,
        ...summary,
        action: null,
      };
    }
    return {
      status: 'already-released',
      reason: `${next} is already published from ${headSha}.`,
      ...summary,
      action: null,
    };
  }
  if (release && tagSha !== headSha) {
    return {
      status: 'blocked',
      reason: 'tag-mismatch-for-draft-release',
      detail: `Draft release ${next} is not bound to ${headSha}.`,
      ...summary,
      action: null,
    };
  }
  if (nextIsStable && confirmation !== next) {
    return {
      status: 'approval-required',
      reason: 'first-stable-or-stable-release-confirmation',
      requiredConfirmation: next,
      ...summary,
      action: null,
    };
  }

  if (current === baseline) {
    if (!devContained) {
      return {
        status: 'waiting',
        reason: 'dev-not-contained-in-main',
        detail: 'dev contains commits that main has not validated yet.',
        ...summary,
        action: null,
      };
    }
    if (tagSha) {
      return {
        status: 'blocked',
        reason: 'tag-exists-before-preparation',
        detail: `Tag ${next} exists before its version was prepared.`,
        ...summary,
        action: null,
      };
    }
    if (release) {
      return {
        status: 'blocked',
        reason: 'release-exists-before-preparation',
        detail: `A GitHub Release for ${next} exists without a matching tag.`,
        ...summary,
        action: null,
      };
    }
    return {
      status: 'ready',
      reason: `Prepare ${next} from dev ${devSha}.`,
      ...summary,
      action: {
        type: 'prepare',
        expectedDevSha: devSha,
        channel,
        tag: next,
        createTag: false,
        confirmStable: null,
      },
    };
  }

  if (current === next) {
    if (tagSha && tagSha !== headSha) {
      return {
        status: 'blocked',
        reason: 'tag-conflict',
        detail: `Tag ${next} points at ${tagSha}, not ${headSha}.`,
        ...summary,
        action: null,
      };
    }
    return {
      status: 'ready',
      reason: `${next} is prepared on main; tag and publish from ${headSha}.`,
      ...summary,
      action: {
        type: 'release',
        expectedDevSha: null,
        tag: next,
        createTag: tagSha === null,
        confirmStable: nextIsStable ? next : null,
      },
    };
  }

  return {
    status: 'blocked',
    reason: 'version-mismatch',
    detail: `Workspace version ${current} is neither the ${channel} baseline ${baseline} nor the planned ${next}.`,
    ...summary,
    action: null,
  };
}

async function readManifestVersion() {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string') throw new Error('Root package version is missing.');
  return normalizeVersion(manifest.version);
}

function devContainedIn(headSha, devSha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', devSha, headSha], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

async function run(options) {
  const headSha = options.get('--head');
  if (!shaPattern.test(headSha)) throw new Error('--head must be a full lowercase commit SHA.');
  if (resolveCommit('HEAD') !== headSha)
    throw new Error('Checked-out HEAD does not match the requested release source.');

  const remoteTags = parseRemoteTags(await readFile(options.get('--remote-tags-file'), 'utf8'));
  const releases = parseReleases(await readFile(options.get('--releases-file'), 'utf8'));
  const publishedTags = publishedTagsFromReleases(releases);
  const devSha = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/dev'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/u)[0];
  if (!shaPattern.test(devSha ?? '')) throw new Error('Unable to resolve the current dev SHA.');

  for (const tag of listReleaseTags()) {
    if (!remoteTags.has(tag.tag))
      throw new Error(`Local release tag ${tag.tag} is missing from origin; refresh tags first.`);
  }

  const channel = options.get('--channel') ?? 'rc';
  const plan = resolveReleasePlan({
    head: headSha,
    channel,
    publishedTags,
    requirePublishedBaseline: true,
  });
  const decision = decideReleaseAction({
    plan,
    currentVersion: await readManifestVersion(),
    headSha,
    devSha,
    devContained: devContainedIn(headSha, devSha),
    remoteTags,
    releases,
    confirmVersion: options.get('--confirm-version') ?? null,
    channel,
  });
  const output = `${JSON.stringify(decision, null, 2)}\n`;
  const outputPath = options.get('--output');
  if (outputPath) await writeFile(path.resolve(outputPath), output);
  else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
