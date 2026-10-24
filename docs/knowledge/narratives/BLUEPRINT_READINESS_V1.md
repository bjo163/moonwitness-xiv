# V10 → Canon → Master Blueprint: Readiness and Non-Duplication Gate

**Status:** PLANNING HANDOFF. This is **not** a completed runtime feature, canon approval, change to ADR, or authorization to release.

## Repository decision

- Single integration repo: [bjo163/moonwitness-xiv](https://github.com/bjo163/moonwitness-xiv/tree/dev), branch `dev`.
- Protected `main` receives only approved `dev → main` promotion. Do not create new remote branches, bypass checks, force push or deploy applications without an accepted scope change.
- Retain historical `XI`-named folders and pinned commit URLs for traceability; repo rename is **not** authority to bulk rewrite historical evidence.
- Technology/ownership remains Fastify, Objection/Knex, PostgreSQL, React/Vite Board and programmatic addons under [ADR 0004](../../decisions/0004-knowledge-rebuild-centralization.md).
- Existing source-rights and privacy/retention policy remain binding; local AI may produce review candidates only.

## Sequential evidence gates

| Gate             | Deliverable                                                             | Pass condition                                                                           | Current V10 assessment                                                  |
| ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| G0 — Baseline    | Exact current dev SHA, current CI/roadmap/issue-sync evidence           | Security and CI gate disposition recorded; no inaccurate release claim                   | **UNVERIFIED / separate existing CI failures**                          |
| G1 — Archive     | V10 public-safe summary and private originals                           | Immutable versions, source identity, consent, and visibility decisions                   | **PARTIAL:** public editorial index only; no private originals imported |
| G2 — Provenance  | Source crosswalk, exact original-vs-reconstruction and correction links | Source review/rights/temporal evidence; unresolved marked accurately                     | **PARTIAL:** locators and gaps only                                     |
| G3 — Correlation | Typed candidate edge review                                             | Source refs plus conflicts; negative `sameAs` cases; human reviewer                      | **PARTIAL:** Markdown analytic candidates only                          |
| G4 — Canon       | Human reviewed narrative personas, stories, selected relationships      | K5-003/004/005 approvals, immutable versioning, separate publication review              | **BLOCKED:** depends on upstream sources/review                         |
| G5 — Blueprint   | Universe Experience + Technical Architecture and capability reuse map   | No duplicate domain owners, models, API, graph DB or feature issues; acceptance/evidence | **NOT STARTED:** gate G4 is incomplete                                  |
| G6 — Delivery    | Existing task IDs and staged work                                       | Source SHA, scoped tests, CODEOWNER, CI/rights/release gates                             | **NOT AUTHORIZED BY THIS EDITORIAL BATCH**                              |

An incomplete source does **not** prevent drafting conceptual candidates, but it **does** prevent claims of final canon, imported private content or published artwork.

## Capability ownership matrix

| Area                       | Existing owner/boundary                      | New V10 work allowed                                     | Do not introduce                                            |
| -------------------------- | -------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| Text/artifact governance   | `docs/knowledge/`; K5-001/002/003            | Editorial digests, source locators, provenance questions | Public raw private archive or second ingestion system       |
| Ontology and aliases       | `ontology/mappings/`; K5-005                 | Human review candidate matrix                            | Implicit equivalence, unversioned competing schema          |
| Story/page manifests       | K5-004; `packages/orm-knowledge/`            | Future contracts behind owning task                      | Unreviewed media import, auto-publish                       |
| Canonical graph and review | PostgreSQL via programmatic addons, ADR 0004 | Candidate records with provenance after approval         | New parallel graph database or editable Markdown authority  |
| UI                         | `apps/board/`; K8-001/K8-002                 | Later reviewed workspace/reader projections              | Second permissions service or unfenced public private views |
| External projects          | Their own source owners                      | Reference-only, reviewed migration candidates            | Automatic mirroring or runtime dependency                   |
| Blueprint                  | Architecture owner and M/K roadmap           | New scoped architecture text after gates                 | Feature claims based only on a fictional poster             |

## Release blockers and next work

1. **Privacy/rights:** determine which exact V10 portions (if any) the maintainer approves for public verbatim publication. This public index does not copy originals.
2. **Source priority:** acquire **authorized private** source exports for 00-MAIN GOD PROMISE, ROCKSOUL, NPD, ZILL, KADO and witness arcs; compute hashes only after bytes actually obtained.
3. **Upstream workflow:** K5-003 (#83) must satisfy its own provenance acceptance; K5-004 (#88) and K5-005 (#90) remain separate downstream tasks.
4. **Security CI:** validate current required run results on the exact candidate SHA; a docs-only commit cannot be called release-ready while security or docs checks fail.
5. **Blueprint planning:** compare XIV's actual implementation against each approved narrative capability and produce **two documents only after adequate review**: (i) Universe Experience Blueprint and (ii) Technical/Ownership Blueprint. Reuse the existing M/K task IDs, record any genuine gap with source/evidence before creating new work.

## Done means

This documentation batch is complete when links and Markdown shape are validated, chapter count is exactly 99, each candidate edge has a source locator, no restricted source bytes are included, and the commit is present on the authorized `dev` branch. **It does not mean canonical review, import, CI, publication, or blueprint have been completed.**
