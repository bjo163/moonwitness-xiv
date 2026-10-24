# K4-003 Asma candidate reproducibility report

## Source-derived golden over the pinned Q7:46 line — base `dev` `8bd9e6c` — 2026-10-23

This report covers the mechanical half of the K4-003 verification target: golden example, false-positive negative, reproducibility. It ran on the MoonWitness local development workstation with Node.js v24.22.1 and pnpm 11.17.0. The only source text touched is the already-reviewed Tanzil Q7:46 artifact at `corpus/reference/sha256/6f/6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760`, read transiently inside a test and verified against its own SHA-256 and against `corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json`. Nothing was written to a database, published, or sent to any model or network endpoint, and no rights manifest or corpus byte was modified. The rights decision for this single line is recorded in [K2-005 evidence](../../docs/roadmap/evidence/K2-005.md#source-specific-rights-decision); it does not extend to any other verse or to derived persisted records.

The profile's own `method_policy` requires "a named, versioned analysis method and exact source passage, edition, hash, evidence, and term offsets". Before this change the projection accepted any two non-blank strings as a method, so the policy was unenforced, and the candidate identity omitted fields the record persists — two candidates that differ only in `context_mode` or annotation identity shared one `mw:asma-candidate:` digest. `packages/research/src/asma.ts` now requires `mw:asma-method:<slug>` plus a `major.minor.patch` version, mirroring the existing convention for alignment methods, and hashes every persisted field that can vary independently.

Checks run:

- `pnpm --filter @moonwitness/research test` — 15 files, 100 passed (`tsc -p tsconfig.test.json` first, so the test sources are type-checked).
- `pnpm --filter @moonwitness/research exec vitest run tests/asma.test.ts` — 10 passed, up from 7 before this change.
- `pnpm --filter @moonwitness/research build`, `pnpm --filter @moonwitness/api build`, `pnpm --filter @moonwitness/orm-knowledge build` — all pass; neither dependent references an Asma symbol.

Golden example and its anchor: `projectAsmaAttributeCandidate` (the production entry point, previously covered only by a rejection test) now projects the verified Q7:46 bytes into a `candidate` whose `source` block equals the profile's authorized passage exactly, including `content_sha256 6ff83b0…7760` and the rights reference. The term is the third whitespace-delimited token of the line, selected by position rather than by reading: which token in Q7:46 is a divine attribute is a human scholarly judgment and the profile keeps `lexical_inventory: "none"`. Re-projecting the same inputs returns the identical record. The digest `mw:asma-candidate:520cc83e540d4325b46e884db03fdb70d6fcf5dddf524f08ab94386b2a4e5acd` is asserted in the test as a reproducibility anchor, so a future change to the identity inputs is reported instead of silently re-labelling stored candidates.

Non-vacuity mutations, each reverted afterwards:

- Collapsing the identity hash back to its previous seven inputs fails only `binds the candidate identity to every field the record persists`, confirming the collision was real.
- Restoring the trim-only method check fails only `refuses a method that is not a named, versioned identity`, which covers eight shapes: a blank id, an unnamespaced `synthetic:` id, a bare label, an empty slug, an uppercase-and-space slug, and versions `1`, `v1.0` and blank.

False-positive negatives: the existing quotation, negation, ambiguity, unreviewed and counterevidence gates still reject on the synthetic witness, and the production Quran-primary profile still refuses the Genesis witness with `profile_source`. These are single-token Arabic-source negatives over the real line, not a measured false-positive rate.

Coverage, precision, recall, term-discovery quality, any historical count of the names, and behaviour over a real model are **not measured**. No score is claimed, and no claim is made that the projected token is a divine attribute. To finish K4-003 a human must name the analysis method that actually selects an attribute term in Qur'anic Arabic and decide the review rule for persisting the resulting candidates.

This report is a local reproducibility record for one pinned source line. It does not certify extraction quality, theological correctness, or release readiness.
