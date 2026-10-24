# Feature-to-test matrix

The current feature matrix lives in the [feature coverage report](feature-coverage.md). That report is the single source for feature IDs, role/company scope, positive and negative assertions, test evidence with source SHA, owners, and remaining gaps.

This page remains as the stable M0.02 deliverable and documentation entry point. The former initial table was removed because its evidence and gaps had become stale and duplicated the maintained report. No feature, task, acceptance criterion, or test requirement was removed.

## Maintenance contract

- Update the feature coverage report when behavior, access boundaries, or test evidence changes.
- Bind each test result to the SHA and run that actually executed it; a test filename alone is not proof.
- Keep skipped, unverified, external, and promotion-blocked cases explicit as gaps.
- Split a feature row when roles, company scope, or persistence behavior have different acceptance paths.
- Keep task completion and delivery state in [ROADMAP.md](../../ROADMAP.md) and the roadmap task index; this report does not claim that implementation evidence means the task is released.
