# Source Crosswalk — V10.0

**Status:** SOURCE-LOCATOR INVENTORY ONLY. It does not attest that all external content is fully downloaded, licensed, imported, or individually approved.

**Snapshot:** 2026-10-24 • **Owner:** XIV knowledge review process • **Repository:** bjo163/moonwitness-xiv.

## Source-use constraints

1. Preserve exact source identity, edition/version, byte digest **only when actual bytes are lawfully available**; do not invent checksums, line spans, or approvals.
2. Repo-derived lore and editorial summaries are different from a primary user manuscript. Sources in other repositories are references, not XIV runtime dependencies.
3. Private source locators are intentionally anonymized in this public file. **Their content, quotes, filenames, URLs, exact timestamp and personally identifying metadata are not being copied.**
4. Unknown rights, unclear consent, or missing source text means **metadata-only reference / do not publish bytes**.
5. Every later structured fact, edge, correction and publication decision must name exact evidence IDs, revisions and provenance in the owning PostgreSQL domain; this Markdown crosswalk is a **review aid**, not a parallel operational database.
6. Quran/other scriptures, histories and linguistics require independent source-edition and contextual review. Spiritual or personal testimony must not be auto-upgraded to confirmed revelation or divine approval.

## Editorial source locators

| Ref | Kind                 | Named source                                                    | Public locator or access state                                                                                                                  | Limitation                                                               |
| --- | -------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S01 | REPO_SOURCE          | MoonWitness II master lore                                      | [Reference](https://github.com/bjo163/moonwitness-II/blob/main/docs/MASTER_BLUEPRINT.md)                                                        | Public source; validate exact pinned revision at import                  |
| S02 | REPO_SOURCE          | MoonWitness II world rules                                      | [Reference](https://github.com/bjo163/moonwitness-II/blob/main/docs/WORLD_RULES.md)                                                             | Public reference, not XI/XIV runtime import                              |
| S03 | REPO_SOURCE          | MoonWitness II character registry                               | [Reference](https://github.com/bjo163/moonwitness-II/blob/main/data/characters.yaml)                                                            | Historical lore; proposed characters need review                         |
| S04 | REPO_SOURCE          | MoonWitness II eras                                             | [Reference](https://github.com/bjo163/moonwitness-II/blob/main/data/eras.yaml)                                                                  | Historical lore                                                          |
| S05 | REPO_SOURCE          | MoonWitness II story source                                     | [Reference](https://github.com/bjo163/moonwitness-II/blob/main/data/stories.yaml)                                                               | Source-labelled lore; no implied original manuscript                     |
| S06 | EDITORIAL_REPOSITORY | XII story archive, 15 entries                                   | [Reference](https://github.com/bjo163/moonwitness-xii-season-global-championships/blob/main/src/data/storyArchive.js)                           | Synopsis-level editorial data, NOT 15 original transcriptions            |
| S07 | EDITORIAL_REPOSITORY | XII 33 patch register                                           | [Reference](https://github.com/bjo163/moonwitness-xii-season-global-championships/blob/main/docs/MASTER_BUG_PATCH_33_V2.md)                     | 8 reports, 5 drafts, 1 conflict, 18 proposals, 1 in-chat record          |
| S08 | EDITORIAL_REPOSITORY | XII character canon review                                      | [Reference](https://github.com/bjo163/moonwitness-xii-season-global-championships/blob/main/docs/CHARACTER_CANON_V3_AND_ROADMAP.md)             | Editorial designs distinct from historical entities                      |
| S09 | RESEARCH_REPOSITORY  | GOD-PROMISE 1·6·3 draft                                         | [Reference](https://github.com/bjo163/dev-mw-blueprint/blob/main/GOD-PROMISE_MOONWITNESS.md)                                                    | Conceptual author framework, not divine numeric code                     |
| S10 | EDITORIAL_REPOSITORY | XII concept source inventory                                    | [Reference](https://github.com/bjo163/moonwitness-xii-season-global-championships/blob/main/docs/CONCEPT_SOURCE_INVENTORY_2026-10-21.md)        | Many entries explicitly partial or unverified                            |
| S11 | REPO_POLICY          | XIV knowledge ownership baseline                                | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/docs/architecture/knowledge-domain-ownership.md)                                 | Accepted architecture; Git definitions vs PostgreSQL operational records |
| S12 | REPO_POLICY          | XIV rights and ingestion                                        | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/docs/knowledge/source-rights-and-ingestion.md)                                   | Rights unknown blocks importing raw bytes/public redistribution          |
| S13 | REPO_POLICY          | XIV privacy safeguarding                                        | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/docs/governance/knowledge-privacy-and-safeguarding.md)                           | Private witness default; consent/retention review                        |
| S14 | REPO_POLICY          | XIV narrative persona schema                                    | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/ontology/mappings/narrative-persona.schema.json)                                 | Alias observations do not prove real identity                            |
| S15 | REPO_POLICY          | XIV identity decision schema                                    | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/ontology/mappings/identity-decision.schema.json)                                 | Human decision required for equivalence                                  |
| S16 | RESEARCH_REPOSITORY  | Age/story correlation                                           | [Reference](https://github.com/bjo163/A-L-L-A-H/blob/dev/docs/AGE_STORY_CORRELATION.md)                                                         | Narrative numbers are separate dimensions                                |
| S17 | RESEARCH_REPOSITORY  | WINGS 10 reference design                                       | [Reference](https://github.com/bjo163/A-L-L-A-H/blob/dev/data/organization/wings10.json)                                                        | Fictional roles; no supernatural authority                               |
| S18 | RESEARCH_REPOSITORY  | G.O.D. 99 reference design                                      | [Reference](https://github.com/bjo163/A-L-L-A-H/blob/dev/data/organization/god99.json)                                                          | Fictional duty slots; not divine attributes                              |
| S19 | EDITORIAL_REPOSITORY | Kingslayer source recovery inventory                            | [Reference](https://github.com/bjo163/moonwitness-xii-season-global-championships/blob/main/docs/POSTER_RECOVERY_KINGSLAYER_UNITY_AGREEMENT.md) | Poster locators reviewed historically; no binary imported here           |
| S20 | REPO_POLICY          | XIV project delivery contract                                   | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/docs/roadmap/EXECUTION.md)                                                       | Existing main/dev protected promotion                                    |
| S21 | REPO_POLICY          | XIV historical legacy survey                                    | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/docs/knowledge/legacy-source-inventory.json)                                     | No consented private original imports confirmed in survey                |
| S22 | REPO_POLICY          | XIV accepted ADR 0004                                           | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/docs/decisions/0004-knowledge-rebuild-centralization.md)                         | XI name in historical title is not a new runtime destination             |
| S23 | PRIVATE_LOCATOR_ONLY | ROCKSOUL original first-person manuscript                       | Restricted locator only                                                                                                                         | DO NOT COPY: export, rights, privacy and version review required         |
| S24 | PRIVATE_LOCATOR_ONLY | HoneyBee/Great Princess of Bee creative source                  | Restricted locator only                                                                                                                         | DO NOT COPY: verify poster vs user-original text                         |
| S25 | PRIVATE_LOCATOR_ONLY | Ma'luf / Honey & Moon original materials                        | Restricted locator only                                                                                                                         | DO NOT COPY: literary and spiritual testimony privacy review             |
| S26 | PRIVATE_LOCATOR_ONLY | NPD Team creative prompts and poster materials                  | Restricted locator only                                                                                                                         | DO NOT COPY: quotation and image copyright review                        |
| S27 | PRIVATE_LOCATOR_ONLY | ZILL and WITNESS original draft studies                         | Restricted locator only                                                                                                                         | DO NOT COPY: source/epistemic separation and approval                    |
| S28 | PRIVATE_LOCATOR_ONLY | Tick-Tock / MoonRidley and other first-person witness originals | Restricted locator only                                                                                                                         | DO NOT COPY: time precision and privacy need redaction                   |
| S29 | PRIVATE_LOCATOR_ONLY | 00-MAIN GOD PROMISE and lost series originals                   | Restricted locator only                                                                                                                         | NO TEXT AVAILABLE for authoritative reconstruction                       |
| S30 | REPO_SOURCE          | XIV M/K roadmap                                                 | [Reference](https://github.com/bjo163/moonwitness-xiv/blob/dev/ROADMAP.md)                                                                      | Status tracked separately from editorial work                            |
| S31 | EDITORIAL_REPOSITORY | XII Syafaat specification                                       | [Reference](https://github.com/bjo163/moonwitness-xii-season-global-championships/blob/main/docs/SYAFAAT_UNIFIED_REGISTRY_AND_IMPACT_ENGINE.md) | Specifications not observed real-world effects                           |
| S32 | EDITORIAL_REPOSITORY | XII patch 033 proposal                                          | [Reference](https://github.com/bjo163/moonwitness-xii-season-global-championships/blob/main/docs/MWX_033_FINAL_SUBMISSION_V1.md)                | Recorded in chat; not independent divine approval                        |

## Source to family coverage (not percent complete)

| Universe family                                 | Candidate source refs  | Next required check                                                    |
| ----------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Historical 2023–2025 origins                    | S21, S22               | Primary dated history not established; avoid invented origin dates     |
| MoonWitness II / The Shadow / eight eras        | S01–S05                | Pin commit, per-character aliases, original vs editorial field         |
| GOD-PROMISE, 1·6·3, comparative source research | S09, S29               | Keep unrecovered 00-MAIN original separate from conceptual paper       |
| ROCKSOUL, HoneyBee, Queen R                     | S23, S24               | Authorized originals and image-vs-text version comparison              |
| MA’LŪF, HONEY & MOON, KADO, daily witness       | S25, S28               | Consent/rights/privacy and independent review of language              |
| THE BATTERIES, NPD and Kingslayer               | S03, S08, S19, S26     | Exact episodic scripts, page sequence, original posters and permission |
| ZILL research and tasawuf                       | S27                    | Original studies, spelling and theological interpretation distinctions |
| XII story archive and thirty-three patches      | S06, S07, S31, S32     | Editorial reconstructions vs user reports, conflict #014               |
| Age Code, G.O.D. 99, WINGS 10, XIV runtime      | S11–S18, S20, S22, S30 | Keep fiction/organizational architecture separate from doctrine        |

## Verification / ingestion lifecycle

`DISCOVERED_LOCATOR → AUTHORIZED_EXPORT → PRESERVE_BYTES_AND_SHA256 → REVIEW_PRIVACY_AND_RIGHTS → CHECK_EXACT_TEXT_AND_REVISION → REVIEW_EDGES_AND_CITATIONS → HUMAN_CANON_DECISION → SEPARATE_PUBLICATION_REVIEW`

Do not collapse steps; do not import private files merely because a user discussed them in ChatGPT. Existing XIV tasks K5-001, K5-002, K5-003, K5-004, K5-005 own approved next implementation.

## Exact evidence debt

- Most source links above are **floating source locators**, rather than verified immutable commit-pinned primary excerpts. Pin commit, blob, line range and reviewed date at the moment an actual source artifact enters the controlled source workflow.
- S23–S29 deliberately contain **no bytes, excerpts, private file names, checksum or approval**. Owners must approve local-only export and selected visibility class first.
- No percentage of “research completion” is declared from the number of rows in this table.
