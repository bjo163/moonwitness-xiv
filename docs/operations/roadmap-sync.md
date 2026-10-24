# Roadmap issue sync audit and recovery

This runbook covers the read-only roadmap issue audit and bounded manual recovery. The Git source on `dev` remains authoritative for Task ID, scope, dependencies, acceptance, and evidence. A GitHub issue is a projection plus maintainer-owned discussion. The audit never deletes issues, closes/reopens them, or rewrites maintainer notes.

## Run a read-only audit

The `Roadmap issue sync` workflow defines push, daily schedule, and manual plan triggers and runs `scripts/roadmap/audit-issues.mjs` before lifecycle collection and the issue plan. Push-triggered hosted runs have been observed. The workflow is also present on the default branch (`roadmap-issue-plan.yml`, blob `687d4707e6ef9d3f46dead451cf809fcd1eb3e39` on `main`) with `schedule: - cron: '13 9 * * *'`, so scheduled runs are eligible from `main`; the `main` copy trails `dev` until the promotion PR merges. Run conclusions and per-step conclusions for this workflow are readable without authentication, so a scheduled or push outcome can be classified from the public Actions API; only log bodies and uploaded artifacts need `actions: read`. The plan job has `issues: read`; it removes the temporary report when it exits. The summary reports counts for missing, duplicate, orphan, stale-source, stale-milestone, broken generated-link, malformed-block, metadata drift, and lifecycle state drift. The report deliberately excludes issue bodies, comments, assignees, and human notes.

For a local run, use a read-only token for private repositories. Public repositories can use anonymous reads. Pass the script flags directly; with pnpm a `--` separator is forwarded as a literal argument and the audit rejects it as an unknown option:

```powershell
$env:GITHUB_REPOSITORY = 'owner/repository'
$env:GITHUB_REPOSITORY_ID = '123456789'
pnpm roadmap:issues:audit --quiet
```

For a private repository, provide `GITHUB_TOKEN` through the caller's existing secure shell/workflow credential setup with read-only Issues access; this example does not overwrite or clear existing credentials. The full JSON report can be written inside the checkout with `--output .roadmap-issue-audit.json`; that path is ignored by Git. Keep the file private if issue IDs or internal repository metadata are sensitive. The command reads all open and closed issues, milestones, and labels with bounded GET retries. It never calls an issue write endpoint. A permission, response-shape, or rate-limit error is a failed audit, not a clean report.

## Interpret drift

| Finding                | Meaning                                                                                                                                                                                                                 | Recovery                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Task ID        | No issue has the repository-ID/Task-ID marker.                                                                                                                                                                          | Review the plan, then dispatch a small explicit Task ID batch if issue bootstrap is authorized.                                                                                                                                                                                                                                                                                          |
| Duplicate Task ID      | More than one issue has the same stable marker.                                                                                                                                                                         | Stop apply; maintainer chooses the surviving record. Preserve and link all discussions; never delete automatically.                                                                                                                                                                                                                                                                      |
| Orphan Task ID         | A managed issue refers to a task removed from the current index.                                                                                                                                                        | Keep the issue and discussion. Add `needs-triage` plus a short reason and expiry/review date after maintainer review; propose source change on `dev` if the task should return.                                                                                                                                                                                                          |
| Stale source           | Managed block source SHA differs from this audit's exact source SHA.                                                                                                                                                    | Regenerate from current `dev` using a dry-run and inspect human notes before any bounded apply.                                                                                                                                                                                                                                                                                          |
| Stale milestone/label  | The issue metadata no longer matches the current task index, or a managed namespace item is unused.                                                                                                                     | Review the expected metadata. Do not remove labels or milestones automatically; distinguish human labels from the bot namespace.                                                                                                                                                                                                                                                         |
| Broken generated link  | The managed Card/Evidence target is malformed, points outside this repository, or does not match an indexed path.                                                                                                       | Validate the task card/evidence in Git and rerun the plan. Do not fetch arbitrary URLs from issue content.                                                                                                                                                                                                                                                                               |
| Malformed/conflict     | Duplicate/malformed identity or managed-block boundaries are present.                                                                                                                                                   | Do not apply that record. Repair boundaries manually while preserving all text outside the managed block, then rerun the audit.                                                                                                                                                                                                                                                          |
| Lifecycle state drift  | The live issue state contradicts what the source status and the managed block's own projection agree on: open while the task is complete, delivered, and blocker-free, or closed while the source task is not complete. | Never close or reopen from this row alone. The first shape closes itself on the next bounded apply while the projection stays true, so a persistent occurrence means the projection has not run at this source. The second is maintainer triage: reopen the issue or move the task to complete. A stale managed block cannot produce either claim because the source status is required. |
| Batch larger than five | A push changed more than five issue-owned tasks, so apply takes the first five and dispatches a bounded continuation against `dev`.                                                                                     | Nothing to do for up to twenty selected tasks; each continuation applies at most five and carries the remainder. Past that the prepare step fails closed before any write, so split the source change across pushes or dispatch explicit batches of at most five.                                                                                                                        |

Orphan triage is an explicit recommendation; the auditor does not add a label or comment. Any triage override must identify the maintainer, reason, UTC expiry/review date, and source issue. Expired overrides return to the next audit; they do not hide a conflict permanently.

## Rebuild a plan and resume a bounded apply

First validate the source index and inspect a read-only plan at the exact checkout SHA:

```powershell
pnpm automation:check:roadmap
pnpm roadmap:issues:plan --quiet --task-ids M11.01,M11.02
```

Use the Actions workflow for writes so the token remains scoped to `issues: write`. Apply is available only on `dev`, requires `apply=true` and explicit Task IDs, and is limited to five tasks per run:

```powershell
gh workflow run roadmap-issue-plan.yml --ref dev -f apply=true -f task_ids=M11.01,M11.02
gh run list --workflow roadmap-issue-plan.yml --branch dev --limit 5
gh run watch <run-id> --exit-status
```

Review the plan job and apply job separately. The plan job must succeed for the exact event SHA before apply begins. If a run stops partway through, rerun the audit and plan; already-created identities should become no-ops, and the same bounded Task IDs can be retried. Never reuse a stale plan fingerprint after source or remote state changes. Rate limits and permissions fail closed; wait for reset or correct permissions, then recompute rather than replaying a cached write plan.

Do not use `Closes`/`Fixes` for broad promotion batches. Issue lifecycle closure is not enabled by this runbook. Manual close/reopen is treated as maintainer intent and must be reconciled with acceptance evidence; the bot does not automatically reopen or oscillate state.

## Recovery boundaries

- Branches remain `dev` and `main`. Source edits and audit-rule changes go through normal `dev` CI; `main` changes only through the protected promotion PR and required review.
- Generated reports contain source SHA and generation time. Do not commit ephemeral raw audit JSON unless the review explicitly needs a redacted, body-free fixture.
- If workflow logs or GitHub API access are unavailable, record the run ID, exact source SHA, failed job/step, and what could not be observed. Step names and conclusions are public for this workflow, so classify the failure from them before claiming it is unobservable. Do not infer success from a queued run or a skipped apply job.
- Never put credentials, issue bodies, private discussion, or arbitrary issue-provided URLs into logs, artifacts, commits, or this report.
- Monthly platform incident reconciliation is handled by `platform-audit`; roadmap issue audit remains a read-only step in the weekly/push/manual `Roadmap issue sync` plan. A recurrence is not proof of successful recovery until a hosted run completes.
