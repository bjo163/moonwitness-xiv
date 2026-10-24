# K3 storage compatibility pilot — synthetic release and review-event binding

## Status

- Status: pilot evidence only. On 2026-10-16 the owner selected PostgreSQL for canonical research graph releases and operational review events. Local and hosted PostgreSQL integration and the K3-seeded isolated backup/restore drill passed on exact `dev` SHA `678d094d8871efda23e7daf061cb051f1aa382c1` ([run 38952266037](https://github.com/bjo163/moonwitness-xi/actions/runs/38952266037)); the exact-SHA technical gate, including browser, passed. Fresh CODEOWNER approval and operational recovery requirements remain open. This note does not mark the storage path production-ready.
- Date: 2026-10-16 (Asia/Jakarta).
- Scope: an original test-only compatibility exercise joining filesystem corpus snapshots to ORM workflow events, followed by a typed PostgreSQL addon pilot for immutable research graph releases.
- Data: synthetic entities and graph records at content revisions 1 and 2. No external repository, network source, licensed corpus text, or private data was used.

## Pilot

`packages/orm-workflow/tests/storage-compatibility-pilot.mjs` exercises both current adapters with one synthetic record identity. It is intentionally run with Node's built-in test runner so it remains outside the package's Vitest suite:

1. The corpus path ingests canonical JSON to immutable snapshots, creates two content-addressed dataset releases, checks their snapshot digests differ when the record revision changes, verifies the second release points to the first, deletes the first snapshot, and replays it from its pinned local recipe/source. Replay restores the first digest and active pointer while leaving the original release manifest bytes unchanged.
2. The existing workflow addon stores the selected release ID, snapshot digest, record ID, and record revision in a transition event payload. A forced event-insert failure proves the workflow state update and event insert roll back together. Retrying succeeds once; an exact retry returns the committed revision; changed payload under the same idempotency key fails; a stale expected revision fails; raw ORM update/delete of the committed event fails.
3. The only database used is an in-memory SQLite test database with existing synthetic addon seed records. The test is isolated and does not change package runtime dependencies or production code.

## Results

| Check                                                                                            | Result    |
| ------------------------------------------------------------------------------------------------ | --------- |
| `pnpm --filter @moonwitness/corpus build`                                                        | Pass      |
| `pnpm --filter @moonwitness/orm-workflow build`                                                  | Pass      |
| `pnpm --filter @moonwitness/orm-workflow exec node --test tests/storage-compatibility-pilot.mjs` | Pass; 1/1 |

Existing focused suites add broader evidence for immutable release manifests, exact release replay, rollback and failed activation pointer preservation (`packages/corpus/tests/dataset-release.test.ts`), plus workflow revision checks, payload equality on replay, transactional rollback, and ORM/SQL append-only protections (`packages/orm-workflow/tests/runtime.test.ts`).

## Compatibility assessment and recommendation

The pilot shows the two existing mechanisms can be joined by stable release and content digests: the file-backed release path can reproduce an immutable graph snapshot, while the workflow event path can atomically retain a decision payload referencing that exact snapshot. They are complementary boundaries rather than interchangeable stores: the corpus release path supplies canonical snapshot retrieval/rebuild/rollback; workflow tables supply operational state transitions and append-only review-event history. A workflow JSON payload alone does not validate or resolve a canonical research record.

The original file-snapshot recommendation below is superseded by the owner's explicit choice to keep canonical graph releases and review workflow/events in PostgreSQL. Derived indexes remain rebuildable outputs. The previous filesystem exercise remains historical evidence only.

## PostgreSQL selection follow-up

The owner selected "all in PostgreSQL" on 2026-10-16. The first typed storage pilot is implemented in `@moonwitness/orm-knowledge` through the normal addon install path:

- `knowledge_research_graph_releases` stores immutable manifest bytes and their SHA-256 identity.
- `knowledge_research_graph_records` stores each immutable canonical JSON record and content digest.
- `knowledge_research_active_releases` selects one active immutable release per corpus. Activation checks the expected current digest and can restore a prior intact release.
- A `research-graph/v1` release must pass the ontology assertion/relation/evidence and graph checks before activation; active reads verify corpus identity and fail closed on invalid graph snapshots.
- Release bytes are canonicalized deterministically, and reads verify member hashes, manifest membership, and release digest before returning records.
- Test data is synthetic. It includes no new licensed text, witness data, or relationship between the approved Quran and Genesis examples.

The local SQLite compatibility tests pass for deterministic serialization, exact replay, immutable rows, expected-head activation/rollback, and caller-transaction rollback. All 3 isolated-schema PostgreSQL tests, including the combined review adapter, passed as part of the 28-test package suite against a newly created PostgreSQL 16 disposable Docker container. The container was removed afterward; the application database on port 5432 was not used. Hosted run [38952266037](https://github.com/bjo163/moonwitness-xi/actions/runs/38952266037) on exact `dev` SHA `678d094d8871efda23e7daf061cb051f1aa382c1` also passed the PostgreSQL integration and isolated application backup/restore drill, including the K3 fixture described below. The technical gate passed; fresh CODEOWNER approval is still required.

The transaction-aware K3 review adapter is implemented in `@moonwitness/orm-knowledge`: it validates the active PostgreSQL graph release, subject/evidence bindings, authenticated reviewer context, and explicit actor identity mappings inside the locked workflow transaction, then persists the decision with the workflow event. It has focused SQLite behavioral tests. The isolated-schema PostgreSQL integration suite also exercises the combined adapter's commit/replay, rollback after an injected persistence failure, and append-only protections; hosted PostgreSQL integration and the K3-seeded isolated backup/restore drill passed on the SHA above. The authenticated K3 API routes and their remaining gates are recorded in [K3-005](K3-005.md), [K3-006](K3-006.md), and [K3-007](K3-007.md); they are not approved for production exposure. Approved Tanzil/Q7:46 source bytes remain pinned local repository assets resolved offline; PostgreSQL stores canonical structured research snapshots and operational review/workflow data, not corpus bytes. The addon remains a typed pilot, not evidence for deployment.

## Limitations and gates

- SQLite tests validate subject/evidence binding and authorization; the disposable local PostgreSQL run additionally validates the combined workflow/review commit, exact replay, rollback after an injected insert failure, and append-only guards. An earlier hosted candidate failed its unit step on a stale test payload expectation before reaching PostgreSQL. On exact SHA `678d094d8871efda23e7daf061cb051f1aa382c1`, hosted PostgreSQL integration, browser, and isolated backup/restore checks passed; fresh CODEOWNER approval and K3 privacy/review and route-specific acceptance gates remain open.
- The original compatibility exercise used SQLite and filesystem releases, not PostgreSQL. The current canonical structured research release, active pointer, workflow state, and review history are selected for PostgreSQL. Corpus source bytes remain pinned local repository assets resolved offline; they are not copied into the database backup.
- The restore-drill fixture installs the actual `orm-knowledge` manifest, then exercises active research releases, graph records, actor mappings, review events, and linked workflow history with synthetic rows in the ORM-created tables. Direct seed/verify against a disposable local PostgreSQL 16 instance passed. The full isolated hosted `pg_dump`/restore drill passed in run `38952266037` on the exact candidate SHA above, verifying those K3 tables after restore. The Windows host lacks native PostgreSQL client utilities; a Docker-backed local operational `pg_dump`/restore rehearsal now passes on the uncommitted runner change recorded in [K3-007](K3-007.md). Operational backup cadence, off-host retention, and measured recovery objectives remain unestablished. The historical file-backed release pilot is not the canonical storage design. Application deployment remains out of scope under ADR 0001/0004.
- Existing Q7:46 Tanzil and WEBP Genesis 1:1 approvals remain exact-source/sample scope only. The review fixture resolves only Q7:46 locally and asserts no relationship between it and Genesis. Rights/privacy policy ownership does not authorize other imports or private-data projection.
- Before production acceptance: pass the hosted PostgreSQL integration test; bind the release lookup and validated review payload to the same locked workflow transaction; define and rehearse restore of releases, active pointers, and workflow history from one consistent database backup; and approve the authenticated K3 adapter contract and visibility rules.
