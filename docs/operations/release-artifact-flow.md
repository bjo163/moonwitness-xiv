# Release artifact flow

The release workflow has a verify phase and a separately dispatched publish phase. A version tag is eligible only when it points to a commit reachable from `main` and the exact SHA has a successful `ci-gate` from a `main` push. The release verify job then runs the release checks, full quality/integration suite, Board/API container smoke checks, and a blocking CRITICAL vulnerability scan.

For tag runs, the verify job builds the API and Board images once. It labels each image with the source SHA and release version, smoke-tests those local images, and stores their image IDs in a manifest beside the archive. It exports the uploaded artifact ID and SHA-256 digest as job outputs. Both the attestation and publish jobs use one shared validator to fetch metadata by ID and fail closed unless ID, name, run ID, source SHA, unexpired state, and REST digest match the verify job outputs; they then download by that same artifact ID. The validator keeps numeric IDs as strings to avoid precision loss. The downloaded archive's member checksums are verified too. The publish job also checks source/version, image IDs and image labels, then pushes the loaded images. It must not rebuild either image.

The verify job also generates SPDX JSON SBOMs for the exact API and Board images and checksums for the bundle and public SBOM assets. A separate job attests the transport archive, manifest, SBOMs, and asset checksum file. During publication, image build provenance and SBOM attestations are bound to the pushed GHCR digests. GitHub Release assets are reconciled by name, SHA-256 digest, and size: matching assets are reused; conflicts fail closed; an ambiguous upload is re-read before retry. The release stays draft until both SBOM assets and their checksum file are present and verified.

Prerelease tags such as `v1.2.0-rc.1` publish versioned images but do not move the `latest` image tags. For stable versions, the publish job compares the candidate against all published stable GitHub Release tags and advances `latest` only when the candidate is strictly newer. Replaying an equal or older version leaves `latest` unchanged. Release publication creates container images and a GitHub Release; it does not deploy the API or Board application.

Publishing a versioned image first checks the existing GHCR tag. A retry reuses it only when the image ID, source SHA, version label, and OCI digest match; a conflicting tag fails without overwriting it. The publisher treats only a registry `manifest unknown` response as a missing tag; auth/network failures stop before writes. It also confirms the remote Git tag still points to the SHA whose artifacts passed verification.

The image artifact is retained for 30 days and belongs to the workflow run that verified its source. If it expires before a publish dispatch, rerun verification for the same trusted tag. Do not substitute an artifact from another workflow run or SHA.

## Orchestrated release lifecycle

`.github/workflows/release-orchestrate.yml` is the only automation allowed to create a version tag. It runs after a completed same-repository `push` CI workflow on `main`, or from a manual dispatch whose ref must be `refs/heads/main`. The decide job resolves an immutable commit SHA, requires it to equal the current `main` head, checks out that exact SHA, and requires the newest successful exact-SHA `ci-gate` from the main push run before evaluating release state. It reads remote tags and all GitHub Releases and delegates the decision to `scripts/release-orchestrator.mjs`.

The planner requires the baseline tag to have a published GitHub Release. A baseline tag without a release, or a newer tag without a release, blocks the run with an explicit anomaly. Automation advancing from a completed main CI run only handles release candidates: a root version with an `-rc.N` suffix can prepare or publish the next candidate, while a stable root version stops and records that stable or hotfix publication needs an explicit dispatch. This avoids silently preparing a patch or stable release after a stable release.

| Decision         | Write action                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prepare`        | Dispatch `release-prepare.yml` on `dev` with the exact expected dev SHA and the selected `rc`, `stable`, or `hotfix` channel.                                                                                                                                                                                                  |
| RC `release`     | Create the annotated tag at the revalidated main SHA with `scripts/create-release-tag.mjs`, then explicitly dispatch `release.yml` for that tag with `publish=true`. The tag push uses `GITHUB_TOKEN` and therefore cannot trigger the release workflow implicitly.                                                            |
| Stable `release` | Requires an explicit dispatch with `channel=stable` and `confirm_version=<tag>`. The job runs in the `release` environment, rechecks the confirmation and current main SHA, creates the tag, and dispatches `release.yml` with `confirm_stable=<tag>`. `release.yml` repeats the confirmation check before any registry write. |
| `no-release`     | No write.                                                                                                                                                                                                                                                                                                                      |
| `blocked`        | The run fails with the reason (unpublished baseline, tag/release conflict, version mismatch, invalid plan). No tag or release is created.                                                                                                                                                                                      |

A release candidate cycle is:

1. Dispatch **Orchestrate release** on `main` with `channel=rc` (or wait for the next main CI completion after an RC version is already on `main`). A `prepare` decision dispatches release preparation on `dev`.
2. The preparation workflow pushes the version/changelog commit through its expected-ref guard and explicitly dispatches full CI and promotion, because a `GITHUB_TOKEN` push does not start them. Merge the promotion PR only through the normal protected review and CI path.
3. When CI completes on the resulting `main` SHA, the orchestrator sees the prepared RC version, creates the immutable tag at that SHA, and dispatches the verified publication workflow. Prerelease publication never moves `latest`.

A stable cycle starts only after the final release candidate is published:

1. Dispatch **Orchestrate release** on `main` with `channel=stable` and `confirm_version=vX.Y.Z`. The planner finalizes the version from the published RC baseline; the exact confirmation authorizes preparation.
2. Merge the promotion PR through the protected path.
3. Dispatch **Orchestrate release** again with `channel=stable` and the same `confirm_version=vX.Y.Z`. The job runs in the `release` environment; configure required reviewers there before the first stable publication. The tag and the publication dispatch carry the same confirmation.

A hotfix uses `channel=hotfix`, accepts only patch-level changes, and always requires the explicit stable confirmation before preparation and publication. Local decision previews can be reproduced without writes:

```sh
node scripts/release-orchestrator.mjs \
  --head <main-sha> --channel rc \
  --remote-tags-file remote-tags.txt --releases-file releases.json \
  --output decision.json
```

`remote-tags.txt` is the output of `git ls-remote --tags origin`; `releases.json` is `gh api --paginate --slurp repos/<owner>/<repo>/releases?per_page=100`. Add `--confirm-version vX.Y.Z` to preview a stable publication.

The repository currently has the `v1.0.0-rc.1` tag without a published GitHub Release, and its commit has no successful main-push `ci-gate`, so the trusted release workflow cannot publish it as-is. Orchestration fails closed with `baseline-unpublished`; a maintainer must decide and document an explicit baseline/bootstrap policy before release automation can proceed. Do not delete, move, or retag the tag to bypass the check.

## Consumer verification

Download the release asset `release-images.tar`, `release-image-manifest.json`, `release-api.spdx.json`, `release-board.spdx.json`, `release-artifacts.sha256`, and `release-assets.sha256` from the exact tag workflow artifact (for the full transport bundle) or download the SBOM assets from the GitHub Release. Verify transport checksums and all signer identities with:

```sh
pnpm release:verify-attestations -- bjo163/moonwitness-xiv bjo163/moonwitness-xiv/.github/workflows/release.yml v1.2.3 ./release-images
```

The verifier rejects checksum, source SHA, version, repository, or signer workflow mismatches, then calls `gh attestation verify` for each file and both OCI images. Release assets can also be checked directly with `gh release verify-asset <tag> <file>`.

## Current release automation limits

The image tag retry path now reconciles matching images without writing and refuses conflicting content. The workflow and local contract tests now cover SBOM generation, digest-bound attestations, draft release asset reconciliation, and consumer identity verification. A hosted full release cycle has not been verified; permissions, actual GHCR attestations, uploaded asset digests, and end-to-end retry behavior remain acceptance work. Do not treat local workflow tests as proof of a published release.
