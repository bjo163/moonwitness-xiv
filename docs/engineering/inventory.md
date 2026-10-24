# Inventory MoonWitness

Source audit refreshed on `dev` at `4f1d29eb4866c1c780aeeafa4897aa871b59c601` (2026-10-23). This is a source inventory, not proof that every route/role/data combination behaves correctly. The generated package/model references are maintained by `pnpm docs:generate` and checked in CI.

## Workspace and public package surfaces

The pnpm workspace has 4 applications and 21 packages (25 workspace children; 26 projects including the root, counted from `pnpm install` scope and `pnpm-workspace.yaml` globs at this SHA). `pnpm audit:workspace` counted 700 TypeScript/JavaScript source files, no runtime import cycles, and no workspace dependency cycles. It reports four file-level local import cycles — `packages/local-ai/src/index.ts` → `suggestion-generation.ts`, `packages/orm-knowledge/src/research-release-validation.ts` → `research-release.ts`, and two ORM `base.model.ts` edges into `environment.ts` and `model-definition.ts` — and because the runtime-cycle list is empty, all four are type-only edges; inspect them in [the refactor map](refactor-map.md).

| Workspace                       | Kind    | Public surface / purpose                                                                                                                           |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@moonwitness/api`              | App     | Fastify API and job/password/session maintenance CLIs; not a library export.                                                                       |
| `@moonwitness/board`            | App     | Next.js signed-in application: auth, dashboard, generic model, profile, settings, knowledge explorer and story workbench.                          |
| `@moonwitness/docs`             | App     | Searchable docs portal and version-aware Pages build.                                                                                              |
| `@moonwitness/ui-catalog`       | App     | Interactive design-system and asset catalog.                                                                                                       |
| `@moonwitness/assets`           | Package | Framework-independent static brand, icon and illustration files plus manifest/license metadata; explicit wildcard exports.                         |
| `@moonwitness/ui`               | Package | Typed React controls/charts, icons, explicit component subpaths and package-owned CSS/tokens.                                                      |
| `@moonwitness/types`            | Package | Shared DTO, API route, domain, JSON-RPC and configuration types.                                                                                   |
| `@moonwitness/client`           | Package | Typed HTTP client and query/domain support.                                                                                                        |
| `@moonwitness/corpus`           | Package | Deterministic offline corpus ingestion.                                                                                                            |
| `@moonwitness/knowledge`        | Package | Offline typed core knowledge record contracts and validation.                                                                                      |
| `@moonwitness/local-ai`         | Package | Opt-in loopback-only local AI runtime contract.                                                                                                    |
| `@moonwitness/orm`              | Package | ORM, model/addon contracts, programmatic schema/seed, registry and query support.                                                                  |
| `@moonwitness/orm-base`         | Package | Base identity/contact/localization/company/access models and stable example seeds.                                                                 |
| `@moonwitness/orm-organization` | Package | Organization/company-scoped addon models and seeds.                                                                                                |
| `@moonwitness/orm-integration`  | Package | Integration/configuration addon models and seeds.                                                                                                  |
| `@moonwitness/orm-knowledge`    | Package | Knowledge rebuild addon: canonical graph, review events, privacy projections, witness, story and candidate version stores with append-only guards. |
| `@moonwitness/orm-notification` | Package | Notification preferences/inbox addon models and seeds.                                                                                             |
| `@moonwitness/orm-request`      | Package | Request management addon models and seeds.                                                                                                         |
| `@moonwitness/orm-storage`      | Package | Storage metadata addon models and seeds.                                                                                                           |
| `@moonwitness/orm-workflow`     | Package | Workflow addon models and seeds.                                                                                                                   |
| `@moonwitness/research`         | Package | Typed, scoped assertions and research validation.                                                                                                  |
| `@moonwitness/auth`             | Package | Authentication/session services and addon contract.                                                                                                |
| `@moonwitness/jobs`             | Package | Durable jobs, scheduler, outbox runtime and worker contracts.                                                                                      |
| `@moonwitness/logger`           | Package | Structured logging and secret/error redaction.                                                                                                     |
| `@moonwitness/eslint-config`    | Package | Shared repository lint rules.                                                                                                                      |

Library packages expose their root `.` entry unless noted. UI and assets have explicit stable subpath exports to support tree-shaking and prevent consumer deep imports. Exact export maps and package versions are source-derived in [generated platform reference](../guide/reference/generated-platform.md); the model and relation inventory is in [generated models](../guide/reference/generated-models.md).

## Domain models, menus, access and example data

`packages/orm-base/src/manifest.ts` declares the 22 base models: `base.country`, `base.country_state`, `base.currency`, `base.language`, `base.company`, `base.bank`, `base.partner`, `base.partner_bank`, `base.partner_category`, `base.partner_category_link`, `base.partner_address`, `base.user`, `base.tag`, `base.tag_link`, `base.attachment`, `base.activity`, `base.sequence`, `base.access_group`, `base.group_membership`, `base.model_access`, `base.company_membership`, and `base.audit_log`. Other addon manifests extend this to 41 core addon models and 66 model relations in the checked architecture graph. Generated reference derives each model's fields/relations from source; do not maintain a second handwritten field catalog.

Menus are manifest metadata. Normal Workspace/Organization entries expose primary partner, company, user, activity, attachment and tag flows; technical, localization, finance and relation-support models are grouped under development/technical sections. Visibility in a menu is not an authorization rule: server-side model access, record rules and company scoping remain authoritative.

Seeds provide examples for countries (249), a country-state subset, currencies/languages, a default company, system/superadmin users and partner profiles, banks/bank accounts, partner categories/addresses, access groups/memberships/model access, tags, attachment/activity metadata and sequences. Seed identities are stable and conformance tests install the runtime addon set repeatedly to detect duplicate or overwritten records. `base.audit_log` deliberately has no fake seed. Seeded attachment/activity examples and any real uploaded bytes require a publication/privacy review; seed presence is not production user data.

## API surface by route family

API route sources are under `apps/api/src/routes/`; generic model operations are dynamically dispatched, so route family count does not equal endpoint/model count.

| Family                      | Source                   | Main behavior                                                                                         |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Health/root/metrics         | `health.routes.ts`       | Liveness/readiness, health, metrics and root metadata.                                                |
| Authentication/account      | `auth.routes.ts`         | Registration, login, refresh/logout, current account, own password/preferences/profile.               |
| Generic model/JSON-RPC      | `generic.routes.ts`      | Model metadata, views, search/count/read, create/update/delete/archive, actions and relation loading. |
| Jobs administration         | `jobs.routes.ts`         | Job/outbox health, list/runs/retry/cancel and cron administration/trigger.                            |
| Notifications               | `notification.routes.ts` | Inbox and account notification preferences.                                                           |
| Workflow/request operations | `workflow.routes.ts`     | Workflow/request actions and approval transitions.                                                    |

Startup (`apps/api/src/server.ts`) imports configuration and application modules inside its guarded bootstrap, verifies registered required models, seeded default base accounts and PostgreSQL connectivity before listening. Route registration is centralized in `apps/api/src/app.ts`; runtime route logging can enumerate method/path from the built Fastify app. Authorization must be assessed across user role, active company, model and action; merely seeing a route or a positive test does not prove its negative cases.

## Board user flows and reusable visual system

Board pages are auth, dashboard, generic model, profile and settings. The shell/navigation is in `apps/board/src/components/layout/app-shell.tsx` and `apps/board/src/lib/navigation.ts`; development mode gates technical model menus. Profile/preferences and password updates use the account API. Generic views include list, form/fields, one-to-many, query builder, import/export, tags, chatter/activities and attachment metadata/content. Shared primitives and charts are in `packages/ui`; brand/vector/social assets are in `packages/assets` and exposed through the UI catalog.

Browser specs under `apps/board/e2e/` cover authentication/session, account settings, protected navigation, data list, record editing, workflow/request, notifications, resilience, extended generic model behavior, and responsive/accessibility/visual audits. The PostgreSQL-backed integration specs require a dedicated `POSTGRES_TEST_URL`; browser suites using SQLite audit fixtures cover selected visual states, not PostgreSQL semantics. Check M3/M10 evidence for exact engine, viewport, screenshot and hosted-database coverage.

CSV import reports per-row failures. CSV export applies to selected rows on the currently loaded result page and neutralizes spreadsheet formula prefixes; cross-page selection/export is outside this flow. Chatter attachment content is served by the authenticated local-filesystem provider with server-only storage keys and parent-record authorization; shared-volume/distributed-storage, object-store and orphan-reconciliation limits are documented in [attachments](attachments.md). These are explicit operational boundaries, not invisible capabilities.

## Background work and persistence

Three API commands start independent processes: `jobs-worker`, `jobs-scheduler`, and `outbox-worker` (`apps/api/src/commands/`). Durable job leases/retries, schedule claiming, outbox delivery and graceful shutdown are in `packages/jobs/src/`; these use PostgreSQL and require dedicated runtime health checks. They are not in-process request timers. API startup and deployment must run the scheduler/worker roles intentionally; running multiple worker replicas relies on database claiming/locking semantics.

ORM addon installation uses programmatic model metadata and database operations; schema changes are not shipped as hand-maintained traditional SQL migration files. Addons own manifests, model declarations, access/menu metadata and stable seed identities. Addon conformance verifies manifests, dependencies, public models, views/menus, seed identity, repeated install and no accidental seed overwrite.

## Verification and automation inventory

- `pnpm verify` runs root lint, format, workspace build/typecheck, configured unit suites, addon conformance, UI/assets/charts and accessibility contracts, Board route-aware bundle budgets, release-policy tests, architecture verification and docs/Pages production build. It does not itself run live PostgreSQL integration, PostgreSQL-backed Board E2E, remote release/promotion, or Linux container runtime smoke.
- `.github/workflows/ci.yml` defines parallel quality/integration/Board/UI/automation/container lanes and an aggregate gate. The current `.github/workflows` directory contains 23 workflow files, including visual/browser matrix, docs links and Pages, security scans, dependency candidates, promotion, release planning/preparation/publication, main-to-dev sync, platform audit, roadmap issue planning/apply, and read-only maintainer issue intake. The intake workflow is source-configured on `dev` and still requires GitHub App repository variables/secrets plus default-branch promotion before hosted activation.
- PR/promotion checks must be read against the exact current SHA. Previous green CI is not inherited by a changed head. Fresh CODEOWNER approval, GitHub settings, default-branch workflow discovery, token permissions and hosted workflows are external state; local source cannot prove activation.
- Latest full local verification recorded in [M10.03 evidence](../roadmap/evidence/M10.03.md) passed on `9df3205b3350e8fb906674c943a00d7743ae246c`; it is historical relative to this source audit. Measured from audit base `4f1d29e` in a clean detached worktree with its own install, and passing on the resulting documentation commits: `pnpm audit:workspace` (25 workspace children, 700 source files, no runtime import cycles, no workspace dependency cycles, four type-only file-level cycles), `pnpm architecture:generate` (14 artifacts from 25 packages, 56 core addon models, 89 model relations; the committed `core-model-relations.json` source fingerprint was stale and is regenerated by this audit), `pnpm docs:generate` with `generate-reference --check` and `update-readme --check`, `pnpm docs:links`, the 13 docs script tests and the ORM example typecheck/test, and `pnpm board:budget` against a real Next.js production build (homepage 36 354 raw / 11 851 gzip, board 235 355 / 78 018, login 198 620 / 64 828, model 221 949 / 73 022, one 96 211 / 18 281 stylesheet shared by the four routes, 27 012-byte interface audio loaded on demand — all within budget). The per-addon conformance and API startup test evidence is recorded in their own current task evidence; GitHub CI, PostgreSQL/browser/container runtime and promotion are separate exact-SHA checks.

## Remaining source questions and acceptance boundaries

- Audit all model × role × company/action combinations using the feature matrix and negative-access cases; a source inventory alone cannot prove authorization.
- Review demo seed records and attachment examples for privacy before public documentation captures or reusable fixtures.
- Latest read-only GitHub audit (2026-10-11) confirms exactly `main`/`dev`, active branch/tag rulesets, repository-level auto-merge and Pages capability, and the main-required `ci-gate`; classic branch-protection endpoints return 403 to the connected integration. See [GitHub capability baseline](github-capabilities.md). Default-branch activation and sensitive promotion remain separate hosted gates.
- Capture repeatable coverage and performance baselines without replacing the route-aware Board bundle budgets with a single total-bundle number.
- Run PostgreSQL integration/browser and container runtime lanes on the supported hosted runner; local `pnpm verify` intentionally does not claim them.
