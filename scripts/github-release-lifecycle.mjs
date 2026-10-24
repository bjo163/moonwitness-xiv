import { reconcileReleaseAssets, validateReleaseAssets } from './reconcile-release-assets.mjs';

const TAG_PATTERN =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function validateRelease(release, { tag, prerelease }) {
  if (
    !release ||
    release.tagName !== tag ||
    !Number.isSafeInteger(release.id) ||
    typeof release.isDraft !== 'boolean' ||
    typeof release.isPrerelease !== 'boolean' ||
    release.isPrerelease !== prerelease
  ) {
    throw new Error(`GitHub release state does not match expected tag ${tag}`);
  }
  return release;
}

/** Reuse an existing tag release or recover a draft whose create response was lost. */
export async function ensureGitHubDraftRelease({ tag, prerelease, adapter }) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag) || typeof prerelease !== 'boolean')
    throw new Error('Invalid GitHub release identity');
  if (!adapter || typeof adapter.getReleaseByTag !== 'function')
    throw new Error('GitHub release adapter is incomplete');

  const existing = await adapter.getReleaseByTag(tag);
  if (existing) return validateRelease(existing, { tag, prerelease });
  if (typeof adapter.createDraft !== 'function')
    throw new Error('GitHub release adapter cannot create a draft');

  let creationError;
  try {
    await adapter.createDraft(tag, prerelease);
  } catch (error) {
    creationError = error;
  }

  let recovered;
  try {
    recovered = await adapter.getReleaseByTag(tag);
  } catch {
    throw new Error(`Unable to verify draft release creation for ${tag}`, {
      cause: creationError,
    });
  }
  if (!recovered) {
    if (creationError) throw creationError;
    throw new Error(`GitHub did not create draft release ${tag}`);
  }
  return validateRelease(recovered, { tag, prerelease });
}

/** Reconcile, verify and publish a release as one retryable identity-bound operation. */
export async function completeGitHubRelease({ tag, prerelease, updateLatest, files, adapter }) {
  if (typeof updateLatest !== 'boolean')
    throw new Error('Invalid GitHub release publication policy');
  if (typeof adapter?.verifyAsset !== 'function' || typeof adapter?.publishRelease !== 'function') {
    throw new Error('GitHub release adapter cannot verify and publish assets');
  }
  validateReleaseAssets({ tag, releaseId: 1, isDraft: true, files, adapter });

  const release = await ensureGitHubDraftRelease({ tag, prerelease, adapter });
  const assets = await reconcileReleaseAssets({
    tag,
    releaseId: release.id,
    isDraft: release.isDraft,
    files,
    adapter,
  });

  for (const file of files) await adapter.verifyAsset(tag, file.path);

  let publishError;
  if (release.isDraft) {
    try {
      await adapter.publishRelease(tag, { prerelease, updateLatest });
    } catch (error) {
      publishError = error;
    }
  }

  let finalRelease;
  try {
    finalRelease = await adapter.getReleaseByTag(tag);
  } catch {
    throw new Error(`Unable to verify published release ${tag}`, { cause: publishError });
  }
  finalRelease = validateRelease(finalRelease, { tag, prerelease });
  if (finalRelease.id !== release.id)
    throw new Error(`GitHub release identity changed while completing ${tag}`);
  if (finalRelease.isDraft) {
    if (publishError) throw publishError;
    throw new Error(`GitHub release ${tag} remains a draft after publication`);
  }

  return {
    tag,
    releaseId: release.id,
    releaseAction: release.isDraft ? 'published' : 'reused',
    recoveredPublish: Boolean(publishError),
    assets,
  };
}
