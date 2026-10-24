import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { classifyCommits } from './release-classification.mjs';
import { readCommitRange, resolveCommit } from './git-range.mjs';

const semverPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
const releaseChannels = new Set(['rc', 'stable', 'hotfix']);

export function parseVersion(value) {
  const match = semverPattern.exec(value ?? '');
  if (!match) throw new Error(`Invalid supported release version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : Number(match[4]),
  };
}

export function formatVersion(version) {
  const suffix = version.prerelease === null ? '' : `-rc.${version.prerelease}`;
  return `v${version.major}.${version.minor}.${version.patch}${suffix}`;
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease - right.prerelease;
}

export function listReleaseTags() {
  const output = execFileSync('git', ['tag', '--list', 'v[0-9]*'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output
    .split(/\r?\n/)
    .filter((tag) => semverPattern.test(tag))
    .map((tag) => ({ tag, version: parseVersion(tag) }))
    .sort((left, right) => compareVersions(right.version, left.version));
}

export function parsePublishedTags(value) {
  if (!Array.isArray(value)) throw new Error('Published release tags must be an array.');
  const tags = [];
  const seen = new Set();
  for (const tag of value) {
    if (typeof tag !== 'string' || !semverPattern.test(tag))
      throw new Error(`Published release tag is not a supported semantic version: ${tag}`);
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function planSkeleton({ headSha, baselineTag, channel, classification }) {
  return {
    schemaVersion: 1,
    source: { baselineTag, baselineSha: null, headSha },
    status: classification.changeKind === 'invalid' ? 'invalid' : 'planned',
    changeKind: classification.changeKind,
    channel,
    currentVersion: null,
    nextVersion: null,
    bump: 'none',
    baselineKind: null,
    baselinePublished: null,
    publishedBaselineVerified: false,
    requiresApproval: false,
    approvalGate: null,
    publishPolicy: null,
    anomalies: [],
    invalidReason: null,
    commits: classification.commits.map(
      ({ sha, subject, type, scope, description, isBreaking, changeKind }) => ({
        sha,
        subject,
        type,
        scope,
        description,
        isBreaking,
        changeKind,
      })
    ),
    releasableCommitShas: classification.commits
      .filter((commit) => commit.changeKind !== 'none')
      .map((commit) => commit.sha),
    ignoredCommitShas: classification.commits
      .filter((commit) => commit.changeKind === 'none')
      .map((commit) => commit.sha),
    skippedMergeShas: classification.skippedMergeCommits,
    invalidCommits: classification.invalidCommits,
    writesPerformed: false,
  };
}

function selectBaseline(tags, channel, baselineTag) {
  const sorted = tags
    .map((tag) => ({ tag: tag.tag, version: parseVersion(tag.tag) }))
    .sort((left, right) => compareVersions(right.version, left.version));
  if (baselineTag) {
    const selected = sorted.find((tag) => tag.tag === baselineTag);
    if (!selected) throw new Error(`Baseline tag is not a valid local release tag: ${baselineTag}`);
    return selected;
  }
  if (channel === 'hotfix') return sorted.find((tag) => tag.version.prerelease === null) ?? null;
  return sorted[0] ?? null;
}

export function createReleasePlan({
  tags,
  headSha,
  commits,
  channel = 'rc',
  baselineTag,
  publishedTags = null,
  requirePublishedBaseline = false,
}) {
  if (!releaseChannels.has(channel)) throw new Error(`Unsupported release channel: ${channel}`);
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error('No valid release tag exists; establish the first-stable baseline explicitly.');
  }
  if (requirePublishedBaseline && publishedTags === null) {
    throw new Error('Published baseline verification requires the published release tags.');
  }
  const published = publishedTags === null ? null : parsePublishedTags(publishedTags);
  const classification = classifyCommits(commits);
  const baseline = selectBaseline(tags, channel, baselineTag);

  if (!baseline) {
    const plan = planSkeleton({ headSha, baselineTag: null, channel, classification });
    plan.status = 'invalid';
    plan.invalidReason = 'A hotfix requires an existing stable release tag as its baseline.';
    return plan;
  }

  const allVersions = tags
    .map((tag) => ({ tag: tag.tag, version: parseVersion(tag.tag) }))
    .sort((left, right) => compareVersions(right.version, left.version));
  const plan = planSkeleton({ headSha, baselineTag: baseline.tag, channel, classification });
  plan.currentVersion = formatVersion(baseline.version);
  plan.baselineKind = baseline.version.prerelease === null ? 'stable' : 'prerelease';
  plan.publishedBaselineVerified = published !== null;
  const publishedSet = published === null ? null : new Set(published);
  if (publishedSet) plan.baselinePublished = publishedSet.has(baseline.tag);

  if (requirePublishedBaseline) {
    if (!publishedSet.has(baseline.tag)) {
      plan.anomalies.push({
        code: 'baseline-unpublished',
        tag: baseline.tag,
        message: `Baseline tag ${baseline.tag} has no published GitHub Release.`,
      });
    } else {
      const newerUnpublished = allVersions.filter(
        (tag) => compareVersions(tag.version, baseline.version) > 0 && !publishedSet.has(tag.tag)
      );
      if (newerUnpublished.length > 0) {
        plan.anomalies.push({
          code: 'newer-tag-unpublished',
          tags: newerUnpublished.map((tag) => tag.tag),
          message: `Release tags newer than ${baseline.tag} have no published GitHub Release: ${newerUnpublished
            .map((tag) => tag.tag)
            .join(', ')}.`,
        });
      }
    }
  }

  if (classification.changeKind === 'invalid') return plan;
  if (plan.anomalies.length > 0) {
    plan.status = 'invalid';
    plan.invalidReason = plan.anomalies[0].message;
    return plan;
  }

  const publishedStable = publishedSet
    ? [...publishedSet].filter((tag) => parseVersion(tag).prerelease === null)
    : allVersions.filter((tag) => tag.version.prerelease === null).map((tag) => tag.tag);

  let next = null;
  let bump = 'none';
  let invalidReason = null;

  if (channel === 'rc') {
    if (!['major', 'minor', 'patch'].includes(classification.changeKind)) {
      plan.status = 'no-release';
      plan.requiresApproval = false;
      return plan;
    }
    const base = baseline.version;
    if (base.prerelease === null) {
      next = { ...base, prerelease: 1 };
      if (classification.changeKind === 'major') {
        next.major += 1;
        next.minor = 0;
        next.patch = 0;
      } else if (classification.changeKind === 'minor') {
        next.minor += 1;
        next.patch = 0;
      } else {
        next.patch += 1;
      }
      bump = classification.changeKind;
    } else if (classification.changeKind === 'major') {
      next = { major: base.major + 1, minor: 0, patch: 0, prerelease: 1 };
      bump = 'major';
    } else if (classification.changeKind === 'minor') {
      next = {
        major: base.major,
        minor: base.minor + 1,
        patch: 0,
        prerelease: 1,
      };
      bump = 'minor';
    } else {
      next = { ...base, prerelease: base.prerelease + 1 };
      bump = 'prerelease';
    }
  } else if (channel === 'stable') {
    const base = baseline.version;
    if (base.prerelease !== null) {
      if (classification.changeKind === 'major' || classification.changeKind === 'minor') {
        invalidReason =
          'A stable release from a release candidate requires patch-only changes; cut a new release candidate for a minor or major change.';
      } else {
        next = { ...base, prerelease: null };
        bump = classification.changeKind === 'patch' ? 'patch' : 'stabilize';
      }
    } else if (classification.changeKind === 'none') {
      plan.status = 'no-release';
      return plan;
    } else if (classification.changeKind === 'patch') {
      next = { ...base, patch: base.patch + 1 };
      bump = 'patch';
    } else {
      invalidReason =
        'Minor and major versions must pass through a published release candidate before a stable release.';
    }
  } else if (classification.changeKind === 'none') {
    invalidReason = 'A hotfix requires at least one patch-level change.';
  } else if (classification.changeKind !== 'patch') {
    invalidReason = 'A hotfix may contain only patch-level changes.';
  } else {
    const base = baseline.version;
    next = { ...base, patch: base.patch + 1 };
    bump = 'patch';
  }

  if (invalidReason) {
    plan.status = 'invalid';
    plan.invalidReason = invalidReason;
    return plan;
  }

  plan.nextVersion = formatVersion(next);
  plan.bump = bump;
  plan.requiresApproval = next.prerelease === null && publishedStable.length === 0;
  plan.approvalGate = plan.requiresApproval ? 'first-stable' : null;
  plan.publishPolicy = next.prerelease === null ? 'confirm-stable' : 'automatic';
  return plan;
}

export function resolveReleasePlan({
  head = 'HEAD',
  baselineTag,
  baselineSha,
  channel = 'rc',
  publishedTags = null,
  requirePublishedBaseline = false,
  tags = listReleaseTags(),
} = {}) {
  if (baselineTag && baselineSha) throw new Error('Choose either a baseline tag or a baseline SHA');
  if (!releaseChannels.has(channel)) throw new Error(`Unsupported release channel: ${channel}`);

  let selectedTag = baselineTag;
  let selectedSha;
  if (selectedTag) {
    if (!tags.some((tag) => tag.tag === selectedTag))
      throw new Error(`Baseline tag is not a valid local release tag: ${selectedTag}`);
    selectedSha = resolveCommit(selectedTag);
  } else if (baselineSha) {
    selectedSha = resolveCommit(baselineSha);
    selectedTag = tags.find((tag) => resolveCommit(tag.tag) === selectedSha)?.tag ?? null;
    if (!selectedTag) throw new Error('Baseline SHA must resolve to an existing release tag.');
  } else {
    const selected = selectBaseline(tags, channel, undefined);
    if (!selected) {
      throw new Error('No stable release tag exists; a hotfix needs an explicit stable baseline.');
    }
    selectedTag = selected.tag;
    selectedSha = resolveCommit(selected.tag);
  }

  const headSha = resolveCommit(head);
  const commits = readCommitRange(selectedSha, headSha);
  const plan = createReleasePlan({
    tags,
    headSha,
    commits,
    channel,
    baselineTag: selectedTag,
    publishedTags,
    requirePublishedBaseline,
  });
  plan.source.baselineSha = selectedSha;
  return plan;
}

function parseArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json' || argument === '--require-published-baseline') {
      options.set(argument, true);
    } else if (
      ['--head', '--baseline-tag', '--baseline-sha', '--channel', '--published-tags-file'].includes(
        argument
      )
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options.set(argument, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.has('--baseline-tag') && options.has('--baseline-sha')) {
    throw new Error('Choose either --baseline-tag or --baseline-sha');
  }
  return options;
}

async function readPublishedTagsFile(path) {
  const source = await readFile(path, 'utf8');
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    value = source.split(/\r?\n/).filter(Boolean);
  }
  return parsePublishedTags(value);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const publishedTags = options.has('--published-tags-file')
    ? await readPublishedTagsFile(options.get('--published-tags-file'))
    : null;
  const plan = resolveReleasePlan({
    head: options.get('--head') ?? 'HEAD',
    baselineTag: options.get('--baseline-tag'),
    baselineSha: options.get('--baseline-sha'),
    channel: options.get('--channel') ?? 'rc',
    publishedTags,
    requirePublishedBaseline: options.has('--require-published-baseline'),
  });
  process.stdout.write(`${JSON.stringify(plan, null, options.has('--json') ? 0 : 2)}\n`);
  if (plan.status === 'invalid') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(
      'Usage: pnpm release:plan [--head <ref>] [--channel rc|stable|hotfix] [--baseline-tag <tag> | --baseline-sha <sha>] [--published-tags-file <json>] [--require-published-baseline] [--json]\n'
    );
    process.exitCode = 2;
  });
}
