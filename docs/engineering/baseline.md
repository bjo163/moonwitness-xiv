# Baseline kualitas MoonWitness

Baseline awal direkam pada 2026-10-04 dari Windows developer workspace. Nilainya di bawah dipertahankan sebagai snapshot historis, bukan kondisi terkini atau release threshold. Snapshot hosted terbaru yang bisa diverifikasi tercatat di bagian akhir untuk source `2d872862510096732f52f7ec3cd4779ec0044539` pada branch `dev`.

| Check                                           | Command                                    | Result                                                                                                       |
| ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Root ESLint                                     | pnpm lint                                  | Pass, exit 0                                                                                                 |
| Formatting, after formatting new inventory docs | pnpm format:check                          | Pass, exit 0; run again before commit                                                                        |
| Monorepo production build                       | pnpm build                                 | Pass, exit 0; Board built with Vite 8.3.2                                                                    |
| Root workspace tests                            | pnpm test                                  | Pass, 123 passed, 3 skipped; 19 test files pass, 1 PostgreSQL integration file skipped                       |
| API tests                                       | via pnpm test                              | 69 passed, 3 skipped across 10 pass and 1 skipped files                                                      |
| Base addon                                      | pnpm --filter @moonwitness/orm-base test   | 18 passed across 3 files, including TypeScript check                                                         |
| Board typecheck                                 | pnpm --filter @moonwitness/board typecheck | Pass, tsc -b                                                                                                 |
| Board lint                                      | pnpm --filter @moonwitness/board lint      | Exit 0 with 15 existing warnings; see table below                                                            |
| PostgreSQL integration                          | root test in local Windows env             | Skipped because POSTGRES_TEST_URL was not configured in this shell; not counted as passed                    |
| Board production bundle                         | pnpm build                                 | main JS 434.89 kB / 134.12 kB gzip; model page chunk 143.68 kB / 29.29 kB gzip; CSS 64.47 kB / 11.80 kB gzip |
| Docker/container smoke                          | not run locally during baseline            | Must run in GitHub Linux CI                                                                                  |
| Browser E2E                                     | no Board browser specs found               | Missing; M3                                                                                                  |

## Board lint warnings

Board oxlint exits zero but reports 15 warnings:

| Count | File                                          | Rule/issue                                   |
| ----- | --------------------------------------------- | -------------------------------------------- |
| 1     | src/components/ui/button.tsx                  | react(only-export-components)                |
| 1     | src/hooks/use-auth.tsx                        | react(only-export-components)                |
| 1     | src/components/layout/activity-bell.tsx       | impure Date during render                    |
| 3     | src/components/views/query-builder-dialog.tsx | set-state-in-effect twice; hook dependencies |
| 2     | src/components/views/form-view.tsx            | set-state-in-effect; hook dependencies       |
| 2     | src/components/views/fields.tsx               | react(only-export-components) twice          |
| 2     | src/components/views/chatter.tsx              | impure Date.now during render twice          |
| 2     | src/components/views/import-wizard-dialog.tsx | useMemo dependencies                         |
| 1     | src/components/views/list-view.tsx            | react(preserve-manual-memoization)           |

Treat these as baseline debt, then address in focused changes with behavior tests. Do not suppress warning rules wholesale.

## Current hosted snapshot — 2026-10-16 — `2d87286`

Exact-source CI run [38822624487](https://github.com/bjo163/moonwitness-xiv/actions/runs/38822624487) used Ubuntu 24.04, Node 22, pnpm 11.17.0, and frozen workspace install. Source SHA: `2d872862510096732f52f7ec3cd4779ec0044539`. This commit changes roadmap evidence only; CI ran against that exact tree.

| Check                                                   | Exact-source result | Scope and caveat                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint`, `pnpm format:check`, `pnpm typecheck`      | Pass                | Quality job; Board lint separately passed with 0 warnings and 0 errors across 55 files.                                                                                                                            |
| Board bundle budget + architecture + docs/assets checks | Pass                | Route-aware bundle budgets, architecture tests/check, docs export check, and full docs build passed.                                                                                                               |
| Unit tests                                              | Pass                | `pnpm test:unit:ci`; sanitized JUnit and coverage/performance reports were uploaded. Aggregate test/skip counts and coverage percentage are not stated here because the available job summary did not expose them. |
| PostgreSQL integration + application restore drill      | Pass                | Dedicated PostgreSQL 16 service; `REQUIRE_POSTGRES_TESTS=true`; JUnit report scan and upload passed.                                                                                                               |
| Board and docs portal browser                           | Pass                | Chromium Board suite and portal navigation/responsive suite passed; sanitized browser reports uploaded.                                                                                                            |
| Container smoke/security                                | Pass                | Exact CI container job passed.                                                                                                                                                                                     |
| CodeQL / Gitleaks                                       | Pass                | CodeQL run [38822624376](https://github.com/bjo163/moonwitness-xiv/actions/runs/38822624376); Gitleaks run [38822624204](https://github.com/bjo163/moonwitness-xiv/actions/runs/38822624204).                      |
| `ci-technical-gate`                                     | Pass                | All required technical lanes passed.                                                                                                                                                                               |
| Final `ci-gate`                                         | Blocked             | Failed only because no fresh CODEOWNER approval existed for this exact SHA; this is an external promotion gate, not a technical test failure.                                                                      |

The hosted Board production build reported CSS 64.39 kB (12.28 kB gzip), the entry JavaScript chunk 247.82 kB (79.43 kB gzip), and the lazy model-page chunk 108.04 kB (26.33 kB gzip). These are one CI build's compressed-size observations, not the total JS downloaded by every route and not a newly adopted threshold. The previous single-main-chunk measurement is historical and should not be compared directly because the current output is split across chunks.

The root pipeline now has dedicated unit/integration, browser, UI, container, docs, and automation lanes. A successful technical run may still fail final promotion for CODEOWNER approval. Test reports are retained as workflow artifacts; this text deliberately does not infer exact test totals, skip counts, coverage, or duration from job success alone.

## Performance measurement plan

One local Vite bundle measurement is only an initial reference. It is not a stable budget. M0.06/M4.15 should add repeatable runner measurement and compare before setting threshold. Include route-specific compressed chunks; avoid declaring all JS shipped on initial route when lazy-loaded.
