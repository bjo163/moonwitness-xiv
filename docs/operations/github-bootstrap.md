# GitHub automation bootstrap

This repository currently uses the workflow-scoped `GITHUB_TOKEN`. It does not require a personal access token or a GitHub App private key. The permissions below describe the current workflows and the optional App design for a future installation when repository-scoped `GITHUB_TOKEN` permissions are insufficient.

For the observed account capabilities and the date of the last read-only settings audit, see [the GitHub capability baseline](../engineering/github-capabilities.md). For the detailed effective per-job grants and CI evidence, see [the workflow permission evidence](../roadmap/evidence/M8.01.md). Those records are authoritative for the current repository state; this runbook is the setup procedure and must be rechecked after workflow or repository-policy changes.

## Current workflow permissions

Workflow permissions are declared at the top level or on individual jobs. Keep top-level grants read-only wherever possible, and add write access only to the job that performs that operation.

| Workflow/job           | Required permission                                        | Purpose                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI plan and test jobs  | `contents: read`, `pull-requests: read` only where needed  | Checkout source and inspect the promotion PR.                                                                                                         |
| CodeQL analysis        | `contents: read`, `security-events: write`                 | Upload CodeQL SARIF; the write grant belongs only to analysis.                                                                                        |
| CI containers          | `contents: read`, `security-events: write`                 | Upload Trivy SARIF from the image and lockfile scans.                                                                                                 |
| Promote PR job         | `contents: write`, `issues: write`, `pull-requests: write` | Create/update the single `dev` → `main` PR, labels, and merge queue request. Risk policy may disable auto-merge and require fresh CODEOWNER approval. |
| Release verify         | `contents: read`                                           | Build and test a candidate without publishing.                                                                                                        |
| Release publish        | `contents: write`, `packages: write`                       | Publish versioned GHCR images and GitHub Release after explicit dispatch and successful verification.                                                 |
| Pages publication job  | `pages: write`, `id-token: write` only for the publish job | Publish documentation only; build/verification jobs stay read-only.                                                                                   |
| Pages failure reporter | `issues: write`, `actions: read`                           | Deduplicate/update a Pages failure issue using workflow run metadata.                                                                                 |
| Roadmap issue-plan job | `contents: read`, `issues: read`                           | Produce a read-only roadmap reconciliation plan; apply remains opt-in, scoped to `dev`, explicit Task IDs, and a maximum batch size.                  |

The source workflow is authoritative. Recheck this table after changing a workflow permission or operation. Never put a token or private key in a repository file, artifact, workflow output, or log.

## Optional GitHub App for branch writes

Use an App only if workflow `GITHUB_TOKEN` cannot perform a documented operation. Prefer a repository-only installation and a short-lived installation token minted for one job. Do not create a personal access token as a workaround.

For a dedicated promotion App, grant only the permissions needed by the exact API calls it performs:

- **Contents: read and write** to read refs and update the single promotion branch only if the current merge strategy requires an App-authored branch write. The current workflow uses GitHub's PR merge API instead.
- **Pull requests: read and write** to find and update the existing `dev` → `main` PR and request/enable merge.
- **Issues: read and write** only if it creates or updates PR labels/comments through the Issues API.
- **Metadata: read** is implicit and required by GitHub.

Do not grant Actions, Administration, Secrets, Checks, or Packages permissions to a promotion-only App. Publishing workflows should use a separate identity only if `GITHUB_TOKEN` is insufficient; grant `Packages: write` and the minimum release permission, and keep that credential out of promotion jobs.

Suggested repository Actions variables/secrets when an App is approved:

| Name                            | Type             | Value                                                                                 |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `PROMOTION_APP_ID`              | Actions variable | Numeric App ID.                                                                       |
| `PROMOTION_APP_PRIVATE_KEY`     | Actions secret   | PEM private key, rotated when an owner/operator leaves or a key is suspected exposed. |
| `PROMOTION_APP_INSTALLATION_ID` | Actions variable | Installation ID for this repository.                                                  |

These names are documentation only; the current workflows do not read them. Never commit real values. Do not add secrets until a workflow actually uses the App and its permissions have been verified. Keep the App ID and installation ID as Actions variables, and the private key as an Actions secret; never use a personal token or reusable private key as a workflow input. Reassess whether the App is needed before provisioning it.

## Create and validate an App

1. Create a GitHub App owned by the organization/user that owns the repository. Disable user-to-server permissions and webhook subscriptions unless a separately reviewed feature requires them.
2. Set repository permissions to the narrow list above, install it only on `bjo163/moonwitness-xiv`, and record its owner, purpose, permission review date, and rotation owner in an access-controlled operations record.
3. Generate a private key once and add it directly as an Actions secret. Never paste it into chat, issue comments, command-line arguments, workflow summaries, or local repository files.
4. Before enabling writes, use a temporary validation workflow/job with `contents: read` and GitHub's implicit `metadata: read` to request repository metadata. Print only the HTTP success/failure and repository name; do not print token, headers, private key, or full response headers. Delete the temporary validation job after a successful check.
5. Add only the write scopes required for the production operation, then run the workflow on a controlled manual dispatch. Confirm the installation token expires, cannot access a second repository, and cannot perform an unrelated write.
6. Rotate by creating a replacement key, updating the Actions secret, validating the new key, and revoking the old key. If compromise is suspected, revoke first, disable affected automation, review audit logs, and issue corrected releases through new version tags rather than moving an existing tag.

## Operational checks

- Review repository Actions permissions and each workflow's effective permissions at least quarterly and after workflow edits.
- Keep branch protection/rulesets as the enforcement layer; workflow code and labels are not authorization boundaries.
- `dev` is the only integration branch. Do not configure an App or updater to create another long-lived branch.
- A bot must not mark roadmap work complete without linked evidence and successful checks on the exact source SHA.
- Record any unavailable GitHub account capability as a limitation; do not claim that a setting is enabled based on documentation alone.

## Documentation publication incident lifecycle

The Pages workflow manages only open issues with the exact `docs-publication` label. Failures update one issue body with the newest run and up to ten distinct run links; the reporter does not create per-run comments. The body uses a managed block, so maintainer notes and labels outside that block remain intact. Duplicate matching issues or malformed markers stop the reporter before it writes. A successful trusted Pages deploy resolves that docs-only incident. The reporter never searches or mutates security-report issues, and its job receives only `issues: write`.
