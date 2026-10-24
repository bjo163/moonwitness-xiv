# Local AI knowledge rebuild (K0–K9)

**Status:** approved planning track under [ADR 0004](../decisions/0004-knowledge-rebuild-centralization.md). Task execution remains gated by dependencies, rights/privacy approvals, and the existing delivery contract. This track does not authorize application deployment or create GitHub issues by itself.

The source planning bundle is `MOONWITNESS_XI_LOCAL_AI_REBUILD_PLAN_2026-10-15/`. Its machine-readable task DAG is projected into `docs/roadmap/tasks.json`; `ROADMAP.md` owns the checkbox status. Review the source bundle before changing acceptance or scope. Do not import private archives or corpus bytes from the plan alone.

## Execution boundary

- Work on the existing `dev` branch. Preserve the `main` and `dev` two-branch contract; promote only through the protected `dev` → `main` PR.
- One stable K task per reviewable batch. Dependencies require accepted evidence, not task status claims.
- GitHub Issues are a bounded projection. This index does not create issues, and the initial K0 pilot must not create all 65 issues at once.
- Private data, source rights, schema changes, external inference, and deployment keep their separately documented review gates.
- Mark a task complete only after its acceptance and actual verification are recorded. Keep M-series task definitions/statuses intact.

## K0–K9 task cards

## K0-001 — Centralization ADR and deployment boundary

- Priority: P0; risk: approval-required.
- Depends on: none.
- File scope: `docs/decisions/`, `docs/architecture/`.
- Deliverable: Accepted ADR centralizing XIV knowledge ownership and recording the existing deployment boundary and acceptance responsibilities. Any deployment change requires a separate reviewed amendment to ADR 0001.
- Acceptance: Reviewed/accepted ADR explicitly separates canonical knowledge from runtime and does not bypass existing branch rules.
- Verification target: `pnpm docs:check:built and pnpm test:roadmap where affected`. This is a target, not evidence that the command exists or has passed.

## K0-002 — Exact-SHA XIV baseline and local capability survey

- Priority: P0; risk: normal.
- Depends on: none.
- File scope: `docs/knowledge/`, `docs/roadmap/evidence/`.
- Deliverable: Read-only baseline of build/test state, branches, Postgres, RAM/CPU/GPU/storage/network, and known failures.
- Acceptance: All observations cite actual commands/SHA; skipped integrations are labeled and no user data touched.
- Verification target: `git status; git rev-parse HEAD; node --version; pnpm --version; selective baseline commands`. This is a target, not evidence that the command exists or has passed.

## K0-003 — Canonical boundaries and domain ownership matrix

- Priority: P0; risk: normal.
- Depends on: `K0-001`.
- File scope: `docs/architecture/`, `docs/knowledge/`.
- Deliverable: One owner per domain and module-to-storage dataflow diagram.
- Acceptance: Every data class maps to exactly one canonical owner; caches/UI are derived; contradictions recorded.
- Verification target: `doc links and architecture checks`. This is a target, not evidence that the command exists or has passed.

## K0-004 — Legal rights and source ingestion policy

- Priority: P0; risk: approval-required.
- Depends on: `K0-001`.
- File scope: `docs/knowledge/`, `corpus/manifests/`.
- Deliverable: Source-rights policy and metadata-only fallback.
- Acceptance: Unknown/restricted license blocks public-byte bundling and includes takedown/attribution paths.
- Verification target: `schema and synthetic negative rights tests`. This is a target, not evidence that the command exists or has passed.

## K0-005 — Witness privacy consent and minor-safety policy

- Priority: P0; risk: approval-required.
- Depends on: `K0-001`.
- File scope: `docs/governance/`, `docs/knowledge/`.
- Deliverable: Classification, consent, minimization, deletion/redaction and child-protection policy.
- Acceptance: No private account archive/child report imported until approved; PUBLIC projection deny by default.
- Verification target: `policy decision fixtures; negative scenario review`. This is a target, not evidence that the command exists or has passed.

## K0-006 — Legacy knowledge inventory and migration ledger

- Priority: P0; risk: normal.
- Depends on: `K0-003`, `K0-004`.
- File scope: `docs/knowledge/`, `ontology/mappings/`.
- Deliverable: Per-source repo/file/hash/license/old-id/target-decision inventory.
- Acceptance: Historical metrics not marked confirmed; no runtime remote repository dependencies; alias conflicts and missing historical ID mappings remain explicitly unresolved. The owner-approved no-legacy-import disposition may close the migration ledger without copying legacy records or reconciling IDs.
- Verification target: `inventory schema validation and link review`. This is a target, not evidence that the command exists or has passed.

## K0-007 — Task lifecycle and local-agent trust contract

- Priority: P0; risk: normal.
- Depends on: `K0-001`, `K0-002`.
- File scope: `docs/agents/`, `docs/roadmap/`.
- Deliverable: Agent protocol, evidence file template, K task index integration.
- Acceptance: No direct main/force push, secrets, data exfiltration, bypass, premature complete; roadmap M tasks preserved.
- Verification target: `pnpm test:roadmap; existing issue-plan dry-run`. This is a target, not evidence that the command exists or has passed.

## K1-001 — Knowledge record types and JSON schemas

- Priority: P0; risk: normal.
- Depends on: `K0-001`, `K0-003`.
- File scope: `packages/knowledge/`, `ontology/core/`.
- Deliverable: Typed core record contracts and JSON Schema 2020-12.
- Acceptance: Positive and malformed records handled with path-specific validation diagnostics.
- Verification target: `package typecheck/unit validation`. This is a target, not evidence that the command exists or has passed.

## K1-002 — Canonical ID/alias grammar and resolver

- Priority: P0; risk: normal.
- Depends on: `K1-001`.
- File scope: `packages/knowledge/`, `ontology/core/`.
- Deliverable: Stable `mw:*` ID grammar, alias registry, conflict state.
- Acceptance: No silent same-as by title, deterministic ID validation and ID collision tests.
- Verification target: `canonical IDs positive/negative fixtures`. This is a target, not evidence that the command exists or has passed.

## K1-003 — Source artifact and rights schemas

- Priority: P0; risk: normal.
- Depends on: `K1-001`, `K0-004`.
- File scope: `packages/knowledge/`, `corpus/manifests/`.
- Deliverable: Artifact, edition, rights/attribution/locale/ref manifest type.
- Acceptance: Missing rights/checksum disallows publish; source bytes preserved unmodified.
- Verification target: `schema fixtures including unknown license`. This is a target, not evidence that the command exists or has passed.

## K1-004 — PROV-based activity and evidence contracts

- Priority: P0; risk: normal.
- Depends on: `K1-001`.
- File scope: `packages/knowledge/`, `ontology/core/`.
- Deliverable: Actor/source/activity/time/derivation provenance envelope.
- Acceptance: Every derived record carries input IDs, method and version; provenance references resolve.
- Verification target: `unit negative dangling-reference tests`. This is a target, not evidence that the command exists or has passed.

## K1-005 — Standalone offline knowledge validator CLI

- Priority: P0; risk: normal.
- Depends on: `K1-001`, `K1-002`, `K1-003`, `K1-004`.
- File scope: `scripts/knowledge/`, `packages/knowledge/`.
- Deliverable: CLI for local source records, IDs, rights, referential integrity.
- Acceptance: Exit nonzero on invalid/missing refs; no API/model/network requirement.
- Verification target: `fresh filesystem fixture + network-denied CLI run`. This is a target, not evidence that the command exists or has passed.

## K1-006 — Deterministic canonical JSON and snapshot hashing

- Priority: P0; risk: normal.
- Depends on: `K1-005`.
- File scope: `packages/knowledge/`, `scripts/knowledge/`.
- Deliverable: JCS-compatible hashing and stable manifest order; dataset digest.
- Acceptance: Same input gives same hash across runs/order; changes produce different hash.
- Verification target: `RFC 8785 vectors; repeated snapshot fixture`. This is a target, not evidence that the command exists or has passed.

## K1-007 — Independent ontology/corpus schema versioning

- Priority: P0; risk: normal.
- Depends on: `K1-005`, `K0-006` for historical-record acceptance.
- File scope: `ontology/versions/`, `docs/knowledge/`.
- Deliverable: Version contract, semantic diff and compatibility matrix.
- Acceptance: Each historical record admitted into this rebuild validates under its declared immutable schema or has an explicit migration; incompatible changes are blocked. If the owner-approved K0-006 disposition excludes legacy records, synthetic fixtures prove the compatibility gate, evidence records that no historical-record compatibility is claimed, and future imports reopen this task before acceptance.
- Verification target: `version upgrade/downgrade negative tests`. This is a target, not evidence that the command exists or has passed.

## K2-001 — Deterministic offline ingestion adapter

- Priority: P0; risk: normal.
- Depends on: `K1-005`, `K1-006`.
- File scope: `packages/corpus/`, `scripts/knowledge/`.
- Deliverable: Pin/parse/import recipe engine with dry-run and import report.
- Acceptance: No hidden downloads or nondeterminism; parser failure leaves prior snapshot intact.
- Verification target: `clean/repeat/invalid/partial import tests`. This is a target, not evidence that the command exists or has passed.

## K2-002 — Content-addressed raw artifact store

- Priority: P0; risk: normal.
- Depends on: `K2-001`.
- File scope: `packages/corpus/`, `corpus/manifests/`.
- Deliverable: Raw-byte immutable blob storage contract and SHA integrity.
- Acceptance: Checksum collision/mismatch rejects, no overwrites, no path traversal.
- Verification target: `binary corruption and unsafe path cases`. This is a target, not evidence that the command exists or has passed.

## K2-003 — Dataset release manifest and rollback pointers

- Priority: P0; risk: normal.
- Depends on: `K2-001`, `K1-007`.
- File scope: `packages/corpus/`, `corpus/manifests/`.
- Deliverable: Versioned dataset source snapshot and active projection switch.
- Acceptance: Rebuild deterministic; can select known-good version; no data loss on interrupted import.
- Verification target: `snapshot replay/rollback tests`. This is a target, not evidence that the command exists or has passed. Manifest/pointer metadata alone does not complete dataset rebuild/replay acceptance.

## K2-004 — Revelation identity versus canon/edition ontology

- Priority: P0; risk: normal.
- Depends on: `K1-002`, `K1-003`.
- File scope: `ontology/domains/`, `corpus/reference/`.
- Deliverable: Explicit identity/relation classes for Qur’an/Taurat/Zabur/Injil and available textual witnesses.
- Acceptance: Distinct identities do not collapse; no assumption that modern canon is automatically identical to named revelation.
- Verification target: `ontology/relation contradiction fixtures`. This is a target, not evidence that the command exists or has passed.

## K2-005 — First rights-cleared Qur’an passage slice

- Priority: P0; risk: normal.
- Depends on: `K2-002`, `K2-003`, `K2-004`.
- File scope: `corpus/reference/`, `corpus/manifests/`, `packages/corpus/`.
- Deliverable: Pinned, lawful, integrity-checked passage sample including Q7:46.
- Acceptance: Exact original retrievable by edition/passage; missing text/rights flagged; reimport idempotent.
- Verification target: `G1 retrieval+checksum+negative edition/passage tests`. This is a target, not evidence that the command exists or has passed.

## K2-006 — Second-source textual witness sample with edition guard

- Priority: P0; risk: normal.
- Depends on: `K2-005`, `K0-004`.
- File scope: `corpus/reference/`, `corpus/manifests/`.
- Deliverable: Licensed metadata/full-text small source outside Quran, separately identified by expression.
- Acceptance: No identity conflation; metadata-only fallback for rights restriction.
- Verification target: `cross-edition compare, copyright negative test`. This is a target, not evidence that the command exists or has passed.

## K2-007 — Source/citation lookup API and SDK

- Priority: P0; risk: normal.
- Depends on: `K2-005`, `K1-002`.
- File scope: `apps/api/`, `packages/client/`, `packages/corpus/`, `Dockerfile`, container smoke and generated API reference.
- Deliverable: Authenticated exact source/passage routes and typed SDK methods for the pinned Tanzil and WEBP samples, with checksum/rights verification and production image corpus data.
- Acceptance: Unknown ID 404; privacy and rights enforced; API documented and typed.
- Verification: [K2-007 evidence](evidence/K2-007.md): API auth/corpus integration, SDK typecheck/tests, corpus integrity, generated API docs, image packaging policy, and authenticated container smoke coverage.

## K2-008 — Corpus offline rebuild and snapshot certification

- Priority: P0; risk: normal.
- Depends on: `K2-003`, `K2-005`, `K2-007`.
- File scope: `scripts/knowledge/`, `docs/roadmap/evidence/`.
- Deliverable: Offline CLI proof and source-reconstruction report.
- Acceptance: Network disabled; bit-identical manifests; import errors measured, not suppressed.
- Verification: [K2-008 evidence](evidence/K2-008.md): empty-output rebuild, network-denied fixture, byte-identical indexes/manifests/artifacts, and visible source-corruption retry report.

## K3-001 — Assertion with scope, polarity and epistemic status

- Priority: P0; risk: normal.
- Depends on: `K1-004`, `K2-007`.
- File scope: `packages/research/`, `ontology/core/`.
- Deliverable: Typed assertion records with explicit review/uncertainty.
- Acceptance: Quoted claim/negation/context cannot become global fact; missing != false.
- Verification: [K3-001 evidence](evidence/K3-001.md): positive/negative assertions, required quoted-speaker context, forbidden global scope, review/epistemic states, and explicit missing lookup result.

## K3-002 — Evidence links and exact source selectors

- Priority: P0; risk: normal.
- Depends on: `K3-001`.
- File scope: `packages/research/`, `apps/api/`.
- Deliverable: Evidence references to canonical passage/range/content hash.
- Acceptance: No invented citations; dangling selector rejected; counterevidence supported.
- Verification: [K3-002 evidence](evidence/K3-002.md): exact local source/edition/locator/hash checks, quote/range validation, counterevidence direction, and authenticated API contract.

## K3-003 — Alias/identity reconciliation with human decision

- Priority: P0; risk: normal.
- Depends on: `K3-001`, `K1-002`.
- File scope: `packages/research/`, `ontology/mappings/`.
- Deliverable: Match candidates, explicit accepted/rejected identity decisions.
- Acceptance: Similarity never produces auto-sameAs; conflict is not overwritten.
- Verification: [K3-003 evidence](evidence/K3-003.md): unresolved candidates, homonym/multilingual aliases, explicit reviewed decisions, retained contradictions, and rejected cross-candidate summaries.

## K3-004 — Typed reviewed relation graph projection

- Priority: P0; risk: normal.
- Depends on: `K3-002`, `K3-003`.
- File scope: `packages/research/`, `apps/api/`.
- Deliverable: Allowed relation vocabulary and adjacency queries.
- Acceptance: Relation type/version/scope/support visible; safe graph traversal; no cycles induced in invalid ways.
- Verification target: `adjacency, privacy leakage, relation guard tests`. This is a target, not evidence that the command exists or has passed.

## K3-005 — Research review and immutable decision event flow

- Priority: P0; risk: normal.
- Depends on: `K3-001`, `K3-004`.
- File scope: `packages/research/`, `packages/orm-workflow/`, `apps/api/`.
- Deliverable: Human review workflow tied to source revision and event history.
- Acceptance: Reviewer cannot self-certify prohibited transitions; stale revision rejected; decisions historically recorded.
- Verification target: `workflow revision/auth/idempotency tests`. This is a target, not evidence that the command exists or has passed.

## K3-006 — Cross-domain explanation and alternative hypothesis API

- Priority: P0; risk: normal.
- Depends on: `K3-002`, `K3-004`.
- File scope: `packages/research/`, `apps/api/`.
- Deliverable: Explain edges, supporting/opposing refs, alternatives/uncertainty.
- Acceptance: Every explanation provenance-linked; no causation inference by timestamp alone.
- Verification target: `golden graph test on Q7:46 and contested case`. This is a target, not evidence that the command exists or has passed.

## K3-007 — Evidence-aware duplicate scoring candidates

- Priority: P0; risk: normal.
- Depends on: `K3-003`, `K3-006`.
- File scope: `packages/research/`, `apps/api/`.
- Deliverable: Non-destructive duplicate suggestions with rationale and review state.
- Acceptance: No automatic merge; true duplicate/overlap/different cases tested; private records not exposed.
- Verification target: `G3 overlap 009/012/013 and authorization tests`. This is a target, not evidence that the command exists or has passed.

## K4-001 — Text segmentation and lexical metadata with offsets

- Priority: P0; risk: normal.
- Depends on: `K2-005`, `K3-002`.
- File scope: `packages/research/`, `ontology/domains/`.
- Deliverable: Language/script-aware tokens, original byte/text offset mapping.
- Acceptance: Original source text preserved, offsets accurate, normalization confined to derivative.
- Verification target: `Arabic token/Unicode roundtrip tests`. This is a target, not evidence that the command exists or has passed.

## K4-002 — Polarity/speaker/quotation semantic annotation

- Priority: P0; risk: normal.
- Depends on: `K4-001`, `K3-001`.
- File scope: `packages/research/`, `ontology/domains/`.
- Deliverable: Structured direction, negation, quoted speaker/context schema.
- Acceptance: Negated claims and quotations do not become positive asserted fact.
- Verification target: `golden polarity fixtures`. This is a target, not evidence that the command exists or has passed.

## K4-003 — Pure Asma source-derived proof of concept

- Priority: P0; risk: normal.
- Depends on: `K4-002`, `K3-002`.
- File scope: `packages/research/`, `research/profiles/`.
- Deliverable: Explicit Quran-primary profile, candidate divine-attribute relation extraction.
- Acceptance: No hardcoded list-of-99 as engine truth; every result tied to source and method; historical metrics marked unverified.
- Verification target: `golden examples, false-positive negatives, reproducibility`. This is a target, not evidence that the command exists or has passed.
- Evidence: [K4-003](evidence/K4-003.md). The projection enforces the profile's own `method_policy` — a `mw:asma-method:<slug>` identity plus a `major.minor.patch` version — and the candidate id now hashes every persisted, independently variable field, closing an identity collision; the first golden over the reviewed Q7:46 bytes runs through the production entry point at a pinned reproducibility digest, and the projection now rejects any evidence reference the corpus resolver did not mint. A human-authored Arabic term-discovery method, the K3-005 review rule for persisting a candidate, and any real extraction result remain open and no record is written.

## K4-004 — Semantic RUH/HIZAB concept scope and mappings

- Priority: P0; risk: normal.
- Depends on: `K4-002`, `K2-004`.
- File scope: `ontology/domains/`, `research/profiles/`.
- Deliverable: Typed theology/semantic concept profiles with uncertainty and scope.
- Acceptance: Semantic model is interpretation, not revelation; divergent theological contexts retained.
- Verification target: `cross-scope ontology tests`. This is a target, not evidence that the command exists or has passed.

## K4-005 — Four-tradition cross-reference alignment candidates

- Priority: P0; risk: normal.
- Depends on: `K4-002`, `K3-004`, `K2-006`.
- File scope: `packages/research/`, `research/profiles/`.
- Deliverable: Reviewed textual parallel candidates across available witnesses.
- Acceptance: Reference text/edition provenance complete; parity/similarity never implies identity or fulfilment.
- Verification target: `cross-edition quote/alignment tests`. This is a target, not evidence that the command exists or has passed.

## K4-006 — Semantics benchmark and drift ledger

- Priority: P0; risk: normal.
- Depends on: `K4-003`, `K4-004`, `K4-005`.
- File scope: `research/evaluations/`, `docs/knowledge/`.
- Deliverable: Precision/error reports, historical count reconciliation record.
- Acceptance: Measured data/fixtures versioned; empty/unsupported/unknown distinct; no invented benchmark pass.
- Verification target: `deterministic golden-suite report`. This is a target, not evidence that the command exists or has passed.

## K5-001 — Local-only memory/archive ingestion manifest

- Priority: P0; risk: privacy-sensitive.
- Depends on: `K1-004`, `K0-005`.
- File scope: `packages/corpus/`, `corpus/manifests/`, `scripts/knowledge/`.
- Deliverable: Opt-in import from user-supplied exports with source kind/time/consent and checksum.
- Acceptance: Import without network/cloud, no hidden account scraping; no raw private input committed.
- Verification target: `synthetic export fixture + denial/overwrite tests`. This is a target, not evidence that the command exists or has passed.

## K5-002 — Privacy redaction, revocation and retention controls

- Priority: P0; risk: privacy-sensitive.
- Depends on: `K5-001`.
- File scope: `packages/research/`, `packages/orm-knowledge/`, `apps/api/`, `docs/governance/`.
- Deliverable: Sensitive record access and delete/redact policy, audit semantics.
- Current evidence: policy primitives, authenticated hash-only API, one synthetic-only persisted search-projection invalidation slice, and route-level cross-tenant denial; other derivative stores and exposure-path tests remain open. See [K5-002 evidence](evidence/K5-002.md).
- Acceptance: Revoked content removed from derived index/public projection; restricted tests leak zero plaintext.
- Verification target: `negative cross-tenant/public/search tests`. This is a target, not evidence that the command exists or has passed.

## K5-003 — Witness original/correction/provenance domain

- Status: in progress; synthetic ORM addon and ontology contract are implemented. Generic REST/RPC access is denied to every role by the central API policy, and PostgreSQL/SQLite triggers prevent ordinary SQL `UPDATE`/`DELETE`. A read-only owner/company-scoped endpoint now exposes only explicitly synthetic, restricted records to an active superadmin witness steward with company membership. No list or write endpoint exists; legacy unclassified rows remain hidden. The internal correction append takes a source only through a caller-supplied resolver that verifies its bytes and citation rights, and fails closed without one. Real-data privacy approval remains open, and database owners can still alter or remove triggers, so this is not tamper-proof storage.
- Priority: P0; risk: privacy-sensitive.
- Depends on: `K5-001`, `K3-001`.
- File scope: `packages/orm-knowledge/`, `ontology/domains/`, workspace quality and architecture registries.
- Deliverable: First-person testimony plus correction chain, separate interpretation and evidence links.
- Acceptance: Original witness immutable in ordinary workflow; uncertainty/time precision kept; privacy default private.
- Verification: [K5-003 evidence](evidence/K5-003.md): synthetic SQLite/PostgreSQL addon tests cover seed visibility, source/correction/interpretation ORM and ordinary SQL mutation denial, correction ordering, and the fail-closed source resolver check for byte, rights and citation use, plus addon conformance. API tests verify owner/company isolation, guessed and non-synthetic ID concealment, no list/write surface, and generic REST/RPC denial for all roles. Keep real testimony disabled until workflow-specific privacy/safeguarding approval and any required legal review are recorded.

## K5-004 — Story, episode, page/media manifest contracts

- Priority: P0; risk: normal.
- Depends on: `K5-003`, `K2-003`.
- File scope: `packages/orm-knowledge*/`, `ontology/domains/`.
- Deliverable: Versioned content story/page and 1 image/file per page optional render.
- Acceptance: Page order stable, original story text preserved, no fake media asset or auto-publish.
- Verification target: `G2 two-page media/versioning test`. This is a target, not evidence that the command exists or has passed.

## K5-005 — Character canon and personal terminology reconciliation

- Priority: P0; risk: normal.
- Depends on: `K5-003`, `K3-003`.
- File scope: `corpus/reference/`, `ontology/mappings/`.
- Deliverable: Typed persona aliases and source-backed narrative roles.
- Acceptance: No equation of narrative persona with historical/theological person without review; source attribution.
- Verification target: `persona vs person conflation negative case`. This is a target, not evidence that the command exists or has passed.

## K5-006 — 33-BUG registry recovery and alias conflict review

- Priority: P0; risk: privacy-sensitive.
- Depends on: `K5-003`, `K3-007`.
- File scope: `packages/orm-knowledge*/`, `corpus/reference/`.
- Deliverable: 33 planned slots; reviewed partial title/code mapping; missing/conflicts shown.
- Acceptance: No fabricated submission/approval/fix; IDs separate between program/case/story.
- Verification target: `G3 overlap/alias/unknown slots tests`. This is a target, not evidence that the command exists or has passed.

## K6-001 — Mizan blueprint evaluation and policy boundary ADR

- Priority: P0; risk: approval-required.
- Depends on: `K3-005`, `K0-001`.
- File scope: `docs/decisions/`, `research/profiles/`.
- Deliverable: Proof/rejection of legacy TH/ARI factor semantics and legal/divine boundary.
- Acceptance: No human-worth/salvation/legal verdict from analytic score; unknown stays unknown.
- Verification target: `calibration fixtures + failure-mode review`. This is a target, not evidence that the command exists or has passed.

## K6-002 — Scoped analytic responsibility engine (optional)

- Priority: P0; risk: normal.
- Depends on: `K6-001`, `K3-002`.
- File scope: `packages/research/`, `ontology/domains/`.
- Deliverable: Deterministic policy-versioned nonnormative analytic factor calculation.
- Acceptance: All factors evidence-bound; reproducible; outputs carry scope and cannot certify divine/legal status.
- Verification target: `golden factor + missing data + override tests`. This is a target, not evidence that the command exists or has passed.

## K6-003 — BUG case workflow reuse and action/outcome models

- Priority: P0; risk: normal.
- Depends on: `K5-006`, `K3-005`.
- File scope: `packages/orm-knowledge*/`, `apps/api/`.
- Deliverable: Case intake, triage, plan, action, verification, reopen linked to events.
- Acceptance: Statuses separate approval/publish/resolved; no duplicate action/outbox side effect.
- Verification target: `G3 end-to-end state/replay tests`. This is a target, not evidence that the command exists or has passed.

## K6-004 — Child protection and publication risk gates

- Priority: P0; risk: privacy-sensitive.
- Depends on: `K6-003`, `K5-002`.
- File scope: `apps/api/`, `docs/governance/`.
- Deliverable: Sensitive-case disclosure protection and human-reviewed escalation procedure.
- Acceptance: No child identifiers in public/AI prompt/log; deny until authorized protection process approved.
- Verification target: `G3 synthetic child privacy and data minimization negative tests`. This is a target, not evidence that the command exists or has passed.

## K6-005 — Evidence-backed outcome verification

- Priority: P0; risk: normal.
- Depends on: `K6-003`, `K3-002`.
- File scope: `packages/orm-knowledge*/`, `apps/api/`.
- Deliverable: Verified fix outcome proof, independent reviewer, reopen behavior.
- Acceptance: Posting/submitting story cannot close BUG; evidence freshness and outcome test required.
- Verification target: `reopen/stale verification/unreviewed evidence tests`. This is a target, not evidence that the command exists or has passed.

## K7-001 — Local AI runtime adapter contract with disabled default

- Priority: P0; risk: normal.
- Depends on: `K1-001`, `K0-005`.
- File scope: `packages/local-ai/`, `packages/research/`, `packages/orm-knowledge/`, `apps/api/`.
- Deliverable: `@moonwitness/local-ai` typed `AI_MODE=disabled|local` runtime with explicit loopback allowlist, injected into API without requiring a model.
- Acceptance: API/worker startup and core workflow pass without model; no remote fallback.
- Verification target: `offline smoke disabled/unavailable tests`. This is a target, not evidence that the command exists or has passed.

## K7-002 — Hardware survey and model artifact registry

- Priority: P0; risk: normal.
- Depends on: `K7-001`.
- File scope: `docs/operations/`, `packages/local-ai/`.
- Deliverable: CPU/GPU/RAM/VRAM/disk and licensed model SHA/profile report.
- Acceptance: No single compulsory model; source/license and storage outside Git verified.
- Verification target: `hash, license, missing model tests`. This is a target, not evidence that the command exists or has passed.

## K7-003 — Permission-scoped local retrieval and chunks

- Priority: P0; risk: privacy-sensitive.
- Depends on: `K7-001`, `K3-002`.
- File scope: `packages/local-ai/`, `packages/research/`, `packages/orm-knowledge/`, `apps/api/`.
- Deliverable: Retriever with canonical source spans, citation identity and visibility constraints.
- Acceptance: No private/child snippets exposed; exact citation metadata returns.
- Verification target: `restricted retrieval and citation coverage tests`. This is a target, not evidence that the command exists or has passed.

## K7-004 — Staging-only structured suggestion workflow

- Priority: P0; risk: normal.
- Depends on: `K7-003`, `K3-005`.
- File scope: `packages/local-ai/`, `apps/api/`.
- Deliverable: Summaries/term/duplicate suggestions stored as unreviewed candidate.
- Acceptance: Invalid JSON/citations/unsupported claims rejected; model cannot write canonical.
- Verification target: `schema hallucinated citation/prompt injection tests`. This is a target, not evidence that the command exists or has passed.
- Evidence: [K7-004](evidence/K7-004.md).

## K7-005 — Prompt injection and high-risk action isolation

- Priority: P0; risk: security-critical.
- Depends on: `K7-004`.
- File scope: `packages/local-ai/`, `apps/api/`.
- Deliverable: Untrusted content handling and human-approved action boundary.
- Acceptance: Malicious retrieved text cannot alter system rules, run shell, publish, leak secret.
- Verification target: `OWASP-inspired adversarial fixtures`. This is a target, not evidence that the command exists or has passed.
- Evidence: [K7-005](evidence/K7-005.md); restricted local API pilot implemented, with a named `LMI-01`…`LMI-13` adapter corpus and a `SCH-01`…`SCH-07` scheduler/generic-write corpus now pinning the action boundary, and with a 97-cell `kind × ceiling × output-shape × tenant state` matrix in `packages/local-ai/tests/suggestion-matrix.test.ts` whose four mutation checks show which guards are load-bearing; model-specific evaluation and one recorded scheduler head-of-line repair decision still open.

## K7-006 — Local AI evaluation and model-outage certification

- Priority: P0; risk: normal.
- Depends on: `K7-002`, `K7-005`.
- File scope: `research/evaluations/`, `docs/operations/`.
- Deliverable: Measured latency/memory/source coverage; local model-off resilience report.
- Acceptance: Same-source comparison, named machine; no fictional score; non-AI flow passes offline.
- Verification target: `offline egress-denied and G1–G3 regression tests`. This is a target, not evidence that the command exists or has passed.
- Local baseline: AI-disabled runtime and API startup/authentication checks pass. Model identity/endpoint are not configured, so performance, memory, source coverage, same-source comparison, and OS-level egress denial remain unmeasured. The outage half is now certified at the API boundary: three tests drive the real loopback-only runtime through `disabled`, `timeout`, `provider_unreachable` and `invalid_response`, pinning the fixed 503 body, `private, no-store`, zero stored candidate rows, no provider detail in the response, a single loopback transport request per call with `redirect: 'error'` and an `AbortSignal`, refusal of a non-loopback endpoint before any transport exists, and a rate limit that stays armed while the model is down; four targeted route mutations show each of those assertions fails when the contract is broken. See [evaluation protocol](../../research/evaluations/K7-006-protocol.md), [operations report](../operations/local-ai-evaluation.md), and [K7-006 evidence](evidence/K7-006.md).

## K8-001 — Knowledge explorer in existing Board

- Priority: P0; risk: normal.
- Depends on: `K3-006`, `K2-007`.
- File scope: `apps/api/`, `packages/client/`, and the existing `apps/board/` explorer.
- Deliverable: Source/edition/assertion/evidence/graph navigation with roles.
- Acceptance: Reuse the authenticated Board shell; allow keyboard/mobile navigation; search the verified active PostgreSQL release by bounded query and return only `INTERNAL` assertions, evidence whose parent assertion is readable, and relations whose own visibility and both endpoint nodes are readable. Hidden records must not be distinguishable from missing search results. Evidence navigation preserves its exact approved source/edition/locator; relation results open the existing explanation view. Search never returns source passage text or adds write controls.
- Verification target: `Board Playwright role/access tests`. This is a target, not evidence that the command exists or has passed.

## K8-002 — Witness/editorial workbench and poster pages

- Priority: P0; risk: normal.
- Depends on: `K5-004`, `K8-001`.
- File scope: `apps/board/`, `packages/ui/`.
- Deliverable: Original vs derived story revision, page text and media management.
- Acceptance: No face requirement is editorial style not epistemic data; 1 page/asset serialization; no raw text loss.
- Verification target: `G2 Board E2E and revision tests`. This is a target, not evidence that the command exists or has passed.

## K8-003 — Approved publication read API

- Priority: P0; risk: security-critical.
- Depends on: `K6-004`, `K3-005`.
- File scope: `apps/api/`, `packages/client/`.
- Deliverable: Read-only published snapshot endpoints.
- Acceptance: No private/draft/child content even by guessed ID; rights/review verified.
- Verification target: `negative disclosure and snapshot consistency tests`. This is a target, not evidence that the command exists or has passed.

## K8-004 — Public website minimal knowledge shell

- Priority: P0; risk: normal.
- Depends on: `K8-003`, `K0-001`.
- File scope: `apps/web/`, `packages/ui/`.
- Deliverable: Public sources, cases/stories and provenance previews.
- Acceptance: Reuses approved projection, is accessible/SEO testable; no deployment until ADR amendment.
- Verification target: `web route/screenshot/accessibility tests`. This is a target, not evidence that the command exists or has passed.

## K8-005 — Role-safe case/status and submission prototype

- Priority: P0; risk: privacy-sensitive.
- Depends on: `K6-005`, `K8-001`.
- File scope: `apps/board/`, `apps/web/`.
- Deliverable: Safe case progress UI and limited public proposal form, if policy permits.
- Acceptance: Minor-sensitive route disabled without authorized process; no fake verified statuses.
- Verification target: `G3 public/private and duplicate E2E tests`. This is a target, not evidence that the command exists or has passed.

## K8-006 — Editorial/publication revision and takedown support

- Priority: P0; risk: normal.
- Depends on: `K8-003`, `K8-004`.
- File scope: `apps/api/`, `apps/board/`, `apps/web/`.
- Deliverable: Publish/retract/supersede snapshots and auditable permissions.
- Acceptance: Withdrawn material removed from public search/cache; historical internal audit remains.
- Verification target: `publication revoke/snapshot cache E2E`. This is a target, not evidence that the command exists or has passed.

## K9-001 — Exact-SHA full knowledge and app CI gate

- Priority: P0; risk: release-critical.
- Depends on: `K8-006`, `K7-006`.
- File scope: `.github/workflows/`, `scripts/knowledge/`.
- Deliverable: Required deterministic/unit/PostgreSQL/browser/security/offline checks.
- Acceptance: Required test skip is fail; evidence points to same source SHA.
- Verification target: `full candidate CI report`. This is a target, not evidence that the command exists or has passed.

## K9-002 — Source license, PII, secrets and dependency scan

- Priority: P0; risk: security-critical.
- Depends on: `K9-001`.
- File scope: `scripts/knowledge/`, `docs/operations/`.
- Deliverable: Candidate scope audit of corpus artifacts, prompts and releases.
- Acceptance: No restricted source/public PII/secret or unknown legal rights in bundle.
- Verification target: `security scan + deliberate bad fixture`. This is a target, not evidence that the command exists or has passed.

## K9-003 — Migration, interrupted-write and backup/restore drill

- Priority: P0; risk: normal.
- Depends on: `K9-001`.
- File scope: `scripts/knowledge/`, `docs/operations/`.
- Deliverable: Validated upgrade, point-in-time restore practice and knowledge snapshot recovery.
- Acceptance: No data loss in disposables; canonical hashes/role policy preserved.
- Verification target: `restore with corrupt/incomplete artifact cases`. This is a target, not evidence that the command exists or has passed.

## K9-004 — Offline egress-denial certification

- Priority: P0; risk: normal.
- Depends on: `K9-001`, `K9-003`.
- File scope: `docs/operations/`, `scripts/knowledge/`.
- Deliverable: Actual no-network boot/reimport/search/API/Board/model-off evidence.
- Acceptance: Any unplanned socket DNS egress fails; no cloud model dependency.
- Verification target: `air-gapped acceptance report`. This is a target, not evidence that the command exists or has passed.

## K9-005 — Measured performance and capacity decision

- Priority: P0; risk: normal.
- Depends on: `K9-001`.
- File scope: `research/evaluations/`, `docs/operations/`.
- Deliverable: Same-machine corpus size/latency/memory/IO and index build metrics.
- Acceptance: Baseline, limits, dataset/model versions declared; unsupported hardware not hidden.
- Verification target: `repeatable bench results`. This is a target, not evidence that the command exists or has passed.

## K9-006 — Protected promotion and rollback-ready release

- Priority: P0; risk: approval-required.
- Depends on: `K9-002`, `K9-003`, `K9-004`, `K9-005`.
- File scope: `docs/roadmap/evidence/`, `docs/operations/`.
- Deliverable: Reviewed release report, manifest, SBOM/provenance where pipeline supports.
- Acceptance: Only dev-to-main via existing gates; release status equals observed artifact state.
- Verification target: `exact SHA CI, review, release/recover plan`. This is a target, not evidence that the command exists or has passed.

## K9-007 — Publication-production go/no-go assessment

- Priority: P0; risk: approval-required.
- Depends on: `K9-006`, `K0-005`.
- File scope: `docs/decisions/`, `docs/operations/`.
- Deliverable: Written decision on deployment authorization, privacy, rights, operations owner, incident policy.
- Acceptance: No public app deploy absent revised ADR, responsible operator, restore proof and consent/rights gates.
- Verification target: `human signoff with evidence`. This is a target, not evidence that the command exists or has passed.
