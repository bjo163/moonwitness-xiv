# Source rights and ingestion policy

- Status: accepted policy; source-specific clearance remains required
- Rights steward and maintainer: `bjo163` (designated by the repository maintainer)
- Accepted: 2026-10-15, maintainer approval recorded in the execution task
- Related task: K0-004
- Related decision: [ADR 0004](../decisions/0004-knowledge-rebuild-centralization.md)
- Scope: provenance and redistribution gates for corpus/source artifacts

This is an operational proposal, not legal advice and not a determination that
any particular text, translation, dataset, or source is free to use. No source
license or redistribution right is established by this document. A source may
be referenced for research while byte ingestion or publication remains denied.

## Default decision

- Rights state defaults to `unknown`; missing, ambiguous, disputed, expired, or
  unreviewed terms are not permission.
- `unknown`, `review_pending`, `restricted`, `disputed`, and `withdrawn` block
  copying source bytes into an XIV release and block public byte publication.
- Metadata-only reference is the fallback when source bytes are not authorized.
  It may contain a stable source identity, edition/locator, retrieval metadata,
  a digest where the bytes were lawfully obtained for hashing, and a reference
  to rights evidence. Do not copy passage text, OCR, translation, or excerpts
  into a metadata-only record. Review metadata itself for rights and privacy.
- A public release requires a source-specific recorded review decision that
  explicitly covers the edition, exact content/version, intended use,
  redistribution scope, and any expiry or territory limitation. A hash proves
  byte identity, not permission.
- No automated scraper, model, AI output, or availability of a public URL may
  decide or upgrade a rights state. Legacy repository contents receive the
  same source-by-source review.

## Source and release record

Before a candidate enters an ingestion review, record the fields available and
mark missing evidence explicitly:

- stable source and edition identifiers; publisher/rightsholder as stated by
  the source; exact title, language, script, edition/version, and format;
- source URI or archive locator, access/retrieval method and date, and the
  applicable source terms or grant reference;
- SHA-256 of the exact artifact when it was obtained lawfully; byte length and
  integrity method; do not rewrite the original artifact to normalize it;
- rights state, review decision and scope, reviewer identity/role, decision
  date, supporting evidence reference, known attribution wording, and
  documented restrictions/expiry;
- parser/transform recipe and version, output digest, and the XIV release(s)
  that contain or reference the source.

The rights decision must distinguish permission to read or analyze from
permission to store, transform, publish excerpts, redistribute the full bytes,
or use a source for model training. Do not infer one permission from another.
If the governing terms do not clearly address an intended use, keep that use
blocked and refer the question to the designated rights steward and qualified
counsel as appropriate.

## Fail-closed publication gate

An ingestion/release candidate must be rejected or kept metadata-only when any
of these are missing or unresolved:

1. source identity, exact edition/version, or byte-integrity evidence;
2. source-specific rights evidence and an authorized review decision for the
   requested storage and distribution scope;
3. required attribution text and its intended display locations;
4. documented transformation and output-to-source provenance;
5. an assigned owner and process for receiving rights complaints and takedown
   requests.

Synthetic fixtures should cover unknown/restricted rights, missing evidence,
missing attribution, metadata-only output with no source bytes, and blocked
publication. Do not use real restricted corpora as test fixtures.

## Complaint and takedown handling

Use the private reporting route described by the
[security incident runbook](../operations/security-incident-response.md) for a
rights complaint that could expose restricted material. The repository owner
acts as incident commander unless another person is assigned. The named rights
steward and, where needed, qualified counsel must be assigned before a public
corpus release is enabled.

On receiving a credible request or directive, preserve the report privately,
identify affected source IDs, editions, digests, releases, and derived
projections, then suspend affected publication while the authorized reviewer
assesses it. Remove or quarantine affected bytes and rebuild/retract public
search, previews, and indexes when the decision requires it. Keep only
sanitized decision evidence and operational audit needed for accountability;
do not copy complainant data or source text into public issues, logs, or CI.
Republish only after a recorded decision resolves the request and all required
gates pass.

## Approval gates and current gaps

- **Named rights steward:** `bjo163` is assigned for policy ownership and
  source-rights review. A source-specific decision is still required before
  any source bytes are ingested or published.
- **Qualified legal review:** required when source terms, jurisdiction, or
  redistribution permission are uncertain. No legal interpretation is made
  here.
- **Source-specific clearance:** still required for every edition and release;
  acceptance of this general policy would not clear a source.
- **Implementation:** K1-003 supplies a structural artifact manifest schema.
  Importer, storage, takedown automation and publication remain separately
  scoped downstream work; policy acceptance does not activate them.

Approval of this policy establishes the repository's general decision rules;
it is not a legal opinion, source-specific license clearance, or authorization
to ingest, redistribute, or train on any particular source.
