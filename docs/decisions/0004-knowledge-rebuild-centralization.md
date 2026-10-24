# ADR 0004: XI knowledge rebuild boundaries and deployment review

- Status: accepted
- Date: 2026-10-15 (storage selection recorded 2026-10-16)
- Decision owners: MoonWitness maintainers (maintainer approval recorded 2026-10-15)
- Related plan: `MOONWITNESS_XI_LOCAL_AI_REBUILD_PLAN_2026-10-15/MOONWITNESS_XI_MASTER_PLAN.md`
- Related task: K0-001
- Supersedes: none; ADR 0001 remains the accepted delivery contract

## Context

The local AI rebuild plan proposes centralizing knowledge-domain development in
this repository. It also describes a possible future application deployment
scope. The accepted [ADR 0001](0001-platform-contracts.md) currently excludes
deployment of the running application to staging or production. This proposal
does not amend that restriction by itself.

The proposal must fit the existing Fastify API, Objection/Knex ORM, PostgreSQL,
React/Vite Board, addon lifecycle, strict TypeScript policy, programmatic schema
installation, and guarded `dev` to `main` promotion. The proposal does not
authorize copying legacy repositories or private archives, distributing
unlicensed corpus bytes, changing live schemas, or publishing application data.

## Decision

1. Keep this repository as the sole code home for any future XI knowledge
   contracts, domain modules, adapters, and user experiences that maintainers
   accept. Legacy repositories remain research references or individually
   reviewed import candidates; they are not runtime dependencies.
2. Store canonical knowledge records, immutable graph releases, and
   operational workflow/review events in the local PostgreSQL database. The
   owner selected "all in PostgreSQL" on 2026-10-16 for the graph snapshot and
   review-storage choice after reviewing the typed K3 storage pilot. This
   selection does not copy approved corpus source bytes into PostgreSQL: those
   remain pinned local repository assets and are resolved offline with their
   rights metadata. Keep these responsibilities distinct through the
   addon/schema boundary; derived indexes remain reproducible outputs. Do not
   make Board state, AI memory, a vector index, or an external legacy service a
   second canonical source. Complete hosted PostgreSQL and recovery
   compatibility checks before exposing authenticated K3 adapters or treating
   the persistence path as production-ready.
3. Keep existing runtime and delivery contracts. Any new persistent schema
   must use the accepted programmatic addon/upgrade path and preserve existing
   user data. Any new package or adapter needs a bounded responsibility,
   consumer, and focused compatibility evidence.
4. Treat local AI as an optional development assistant. Any future runtime AI
   must be disabled by default, local-only, incapable of hidden remote fallback,
   and limited to staging candidate outputs for human review. Deterministic
   workflows must remain usable with AI unavailable.
5. Preserve provenance, source rights, uncertainty, privacy, classification,
   consent, and deletion/retraction obligations in any accepted design.
   Unknown rights block redistribution; private witness or account imports
   require a separately scoped consent and privacy decision. Synthetic test
   data must be labeled and must not be represented as real testimony.
6. Retain exactly the `dev` and `main` repository branches and guarded PR
   promotion from `dev` to `main`. No force push, direct routine `main` write,
   bypass of required checks/CODEOWNER, or release claim without evidence.
7. Keep staging/production application deployment out of scope. A future
   proposal to change this boundary requires a separate reviewed amendment to
   ADR 0001 and the roadmap, plus named operators, security/privacy ownership,
   rights clearance, backup/restore evidence, incident response, and the
   existing protected-main release gates. This ADR is not that amendment and
   grants no deployment permission.

## Consequences

- Implementation remains gated on maintainer review of this proposal and on
  the repository's existing task, security, rights, and release controls.
- K0 baseline observations must be recorded at the actual source SHA. Missing
  local Postgres, hardware, or network capability is reported as unavailable,
  not inferred from plan documents.
- Subsequent K0/K1 work should be split into reviewable task batches. Schema,
  corpus ingestion, private-data import, runtime AI, and deployment each retain
  their own acceptance and approval gates. The K3 PostgreSQL selection does
  not approve new source imports or private data, and does not close the hosted
  compatibility or restore evidence gates.
- This proposal does not close a roadmap item, create issues, change an
  accepted ADR, or certify a release.
