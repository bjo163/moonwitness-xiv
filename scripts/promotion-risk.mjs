import { classifyCommits } from './release-classification.mjs';
import { isDocumentationContent } from './docs-change-policy.mjs';

// Ordered from the widest blast radius down. A tier only counts when the diff can
// change behaviour that reaches main, which is why test-only scripts and
// documentation content are absent from the path tiers.
const riskTiers = [
  {
    tier: 'release-surface',
    rank: 0,
    patterns: [
      /^\.github\/(?:workflows|actions)\//,
      /^\.github\/(?:dependabot\.yml|codeowners|actionlint\.yaml)$/,
    ],
  },
  {
    tier: 'runtime-data',
    rank: 1,
    patterns: [
      /^apps\/api\/src\//,
      /^packages\/(?:auth|orm|orm-base|jobs)\//,
      /^packages\/[^/]+\/(?:.*\/)?(?:models|addons|manifest)(?:\/|\.|$)/,
      /^apps\/[^/]+\/package\.json$/,
      /^packages\/[^/]+\/package\.json$/,
      /^(?:Dockerfile|docker-compose\.production\.yml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
    ],
  },
  {
    tier: 'automation-logic',
    rank: 2,
    patterns: [/^scripts\//, /^\.githooks\//],
  },
];

// Commit- and deletion-driven risk carries no path evidence, so it labels the
// diff `commit-signal`, the weakest tier: a workflow change still outranks it.
const nonShippingScript = /(?:^|\/)(?:tests?\/|[^/]+\.test\.mjs$)/;

function normalizedPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function pathRiskTier(value) {
  const filePath = normalizedPath(value ?? '').toLowerCase();
  if (!filePath || isDocumentationContent(filePath)) return undefined;
  return riskTiers.find(({ patterns }) =>
    patterns.some((pattern) => {
      if (!pattern.test(filePath)) return false;
      return !(filePath.startsWith('scripts/') && nonShippingScript.test(filePath));
    })
  )?.tier;
}

function changeRiskTier(change) {
  return pathRiskTier(change.path) ?? pathRiskTier(change.previousPath);
}

function tierRank(tier) {
  return riskTiers.find((entry) => entry.tier === tier)?.rank ?? riskTiers.length;
}

export function classifyPromotionRisk({ commits, changes }) {
  const release = classifyCommits(commits);
  const reasons = new Set();
  let riskTier;

  const elevate = (tier) => {
    if (riskTier === undefined || tierRank(tier) < tierRank(riskTier)) riskTier = tier;
  };

  if (release.changeKind === 'invalid') reasons.add('invalid-commit-message');
  if (release.changeKind === 'major') reasons.add('breaking-change');
  if (release.changeKind === 'invalid' || release.changeKind === 'major') elevate('commit-signal');

  for (const commit of release.commits) {
    const scope = commit.scope?.toLowerCase() ?? '';
    if (
      commit.type === 'security' ||
      /(^|[-/])(auth|access|permission|policy|security|schema|database|orm)([-/]|$)/.test(scope)
    ) {
      reasons.add(`sensitive-commit:${commit.sha}`);
      elevate('commit-signal');
    }
  }

  for (const change of changes) {
    if (change.status === 'D' && !isDocumentationContent(normalizedPath(change.path))) {
      reasons.add(`file-deletion:${normalizedPath(change.path)}`);
      elevate('commit-signal');
    }
    const tier = changeRiskTier(change);
    if (tier !== undefined) {
      reasons.add(`sensitive-path:${normalizedPath(change.path)}`);
      elevate(tier);
    }
  }

  if (reasons.size > 0 && riskTier !== undefined) reasons.add(`risk-tier:${riskTier}`);

  return {
    changeKind: release.changeKind,
    requiresApproval: reasons.size > 0,
    riskTier,
    reasons: [...reasons].sort(),
    invalidCommits: release.invalidCommits,
    sourceCommitCount: release.commits.length,
    skippedMergeCount: release.skippedMergeCommits.length,
  };
}
