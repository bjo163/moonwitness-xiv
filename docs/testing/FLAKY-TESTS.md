# Flaky test policy

CI retries a browser test at most once. The Playwright retry diagnostics report keeps the first attempt's status and concise error alongside the retry result, even if the retry passes. CI scans that JSON with the other reports before uploading it.

Tests are never quarantined by default. A quarantine entry is currently tracking metadata only: it does not skip or remove a test from CI, so every test remains blocking. To track a reproducibly flaky non-critical test, add one entry to [`flaky-tests.json`](flaky-tests.json) with its stable ID, test identifier, responsible GitHub username, tracking issue URL, reason, and `expiresOn` date. The automation check fails if any required field is absent, an expiry date has passed, IDs repeat, or a protected authentication/authorization/security test is listed. Remove the entry as soon as the issue is fixed; an expiry is a deadline, not an automatic extension.

Do not add a quarantine based only on one failed run. Compare the first attempt, retry diagnostics, and more than one CI run to identify the cause. Do not increase retries to turn a failure green; a persistent second failure stays red and blocks the gate.

## Choose the smallest useful local check

Run tests by changed behavior and dependency boundary. A local focused pass is evidence for that behavior; it does not replace exact-SHA hosted checks or a full gate when the roadmap, release workflow, or CI requires one.

- For a single unit or policy change, run its test file and the validator for the changed contract. Do not rerun unrelated package suites.
- For PostgreSQL behavior, run the named integration test against an isolated database whose name includes `test` or `e2e`. Run the full integration suite only when shared setup, schema behavior, or multiple integration contracts changed.
- Board E2E defaults to one worker because its specs share a seeded PostgreSQL database. Use a higher `--workers` value only with per-worker database isolation; otherwise API requests can time out under fixture contention.
- For a Board flow, the canonical `pnpm test:e2e <spec-or-grep>` command runs policy/build/password-reset preflights before Playwright. If those preflights already passed on the same source tree and the change is isolated to the selected browser behavior, invoke Playwright directly to avoid rebuilding and resetting the test account again:

  ```sh
  pnpm exec playwright test --config apps/board/playwright.config.ts <spec-file> --grep='<case>' --retries=0
  ```

  Set `POSTGRES_TEST_URL` to an isolated test database first. Direct Playwright is a local iteration shortcut; never use it to skip required CI preflights, typecheck, lint, security checks, or hosted gates. If source in a dependency used by the Board changed since the last build, run the canonical preflights before relying on the browser result.

  To run one filtered test through the wrapper, use the package-manager delimiter explicitly, for example `pnpm test:e2e:built -- --grep=login`. The wrapper removes that delimiter before invoking Playwright so the filter is not mistaken for a positional test path.

- For a visual-only change, run the affected visual spec at the target viewport. Run the full three-browser matrix when cross-browser behavior changed or when a scheduled/release gate requires it; a backend-only change does not need a local visual matrix.
- Run formatting and lint on changed files while iterating. Run repository-wide checks once for the completed batch or when the change affects shared configuration, generated output, or repository-wide policy.

Run package-manager commands sequentially in one checkout. `pnpm` may perform a workspace install-status check before a command; parallel invocations can contend on its lockfile. Independent agents should use isolated worktrees, and hosted CI can validate a pushed batch while local work proceeds on an independent batch.
