# Knowledge privacy, consent, and safeguarding policy

- Status: accepted policy; import and publication workflows remain gated
- Data/privacy steward and safeguarding owner: `bjo163` (designated by the repository maintainer)
- Accepted: 2026-10-15, maintainer approval recorded in the execution task
- Related task: K0-005
- Related decision: [ADR 0004](../decisions/0004-knowledge-rebuild-centralization.md)
- Scope: witness, account-export, case, and child-sensitive knowledge records

This proposal sets fail-closed product and data-handling boundaries. It does
not establish legal compliance, authorize a private-data import, or assign a
retention period. Do not create or use real witness, account-export, or child
records in implementation fixtures.

## Classification and default access

Use the following classifications, compatible with ADR 0004:

| Classification    | Default access and handling                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_APPROVED` | Only a specific reviewed publication projection; never an automatic property of an imported source.                                                       |
| `INTERNAL`        | Authenticated, role- and tenant-bounded XIV users with a work need.                                                                                       |
| `CONFIDENTIAL`    | Explicitly granted, least-privilege access; no public search or previews.                                                                                 |
| `RESTRICTED`      | Named authorized handlers/stewards only; private by default, with access recorded.                                                                        |
| `CHILD_SENSITIVE` | Deny public access and general-purpose search, AI, notifications, and analytics. Synthetic fixtures only until an authorized safeguarding process exists. |

Missing classification, missing consent, unresolved identity, or an absent
access decision fails closed. Source, attachment, relation, and derived record
classification must propagate without downgrade; a public projection needs an
explicit reviewer decision and a reviewed, minimized copy. A public record
cannot be made from private data merely by removing a name.

Use existing XIV authentication and tenant boundaries. Do not introduce a
parallel identity/role system in this policy. Never trust `created_by`, tenant,
or reviewer identity from an untrusted request body.

## Consent, minimization, and correction

Before any private witness or personal archive import, obtain a recorded,
scoped authorization from the data subject or an authorized data owner. It
must identify the specific input, data categories, purposes, permitted
reviewers, intended derived uses/publication scope, consent date, and the
available withdrawal/correction path. Authorization for private analysis does
not imply permission to publish, share with a model, or retain indefinitely.

Collect only fields needed for the approved task. Keep original testimony and
corrections distinguishable; never silently rewrite a historical claim. A
withdrawal, correction, or deletion request requires a documented review of
the original, attachments, replicas, indexes, exports, and publication
projections, subject to qualified privacy/legal review of any retention duty.
This policy sets no fixed retention duration; a named data owner must approve
one before an import workflow is activated.

Unprovided ChatGPT/account exports and private user archives are `MISSING` and
must not be searched, reconstructed, or imported. The plan package alone is
not consent evidence.

## Prohibited exposure paths

Without an independently approved, minimized publication projection, private
or child-sensitive content must not appear in:

- public APIs, pages, guessed-ID routes, search, autocomplete, previews, or
  exports;
- embeddings, vector stores, general analytics, support bundles, CI artifacts,
  application logs, traces, or notifications;
- prompts, retrieved context, model training, or any hosted inference service.

Optional local AI remains disabled by default. A future local provider may see
only the approved input scope and must return candidate output to human review;
it cannot authorize publication or change canonical records directly.

## Child-safety boundary

Do not collect identifiable child testimony, allegations, contact details,
location, or media through a general public form. Use synthetic child fixtures
only. A future authorized child-protection workflow needs a named safeguarding
owner, restricted access and storage, a response/escalation procedure,
minimization and retention decisions, and specialist review before collection
or publication. The safeguarding owner is assigned, but no such workflow has
been authorized or implemented.

## Revocation and incident response

The data/privacy owner must define how revocation removes eligible content
from operational views, search/embedding indexes, caches, previews, exports,
and public releases; each derived artifact needs a reproducible invalidation
or rebuild path. Preserve only the minimum sanitized audit event required by
the approved retention policy; do not preserve withdrawn content in a log as a
workaround.

For suspected exposure, use the private
[security incident response runbook](../operations/security-incident-response.md).
Keep sensitive evidence private, record hashes and sanitized identifiers, and
assign a privacy/legal contact when user data or regulated obligations may be
involved. The repository runbook does not claim a private reporting channel or
production deployment is configured.

## Local lifecycle controls (K5-002 in progress)

The local research package now contains deny-by-default policy primitives in
`packages/research/src/privacy-lifecycle.ts`. They require authenticated
server-derived context, exact tenant scope for non-public records, granted
consent, an approved purpose, and an explicit authorization for restricted
records. Child-sensitive records are denied for search, export, publication,
analytics, and model input. A public projection requires a minimized,
revision-bound approval from a reviewer other than the requester.

Retention is denied unless an owner-approved absolute expiry and decision
reference are supplied; an expired policy denies use. Revocation plans contain
hashed subject/decision/artifact references and instructions to block access
and invalidate or rebuild derivatives. `excludeRevokedDerivedRecords` removes
withdrawn subjects from a derived record list. A package-local persistence
slice now records hash-only revocations in an append-only table and clears one
synthetic, tenant-scoped search projection in the same transaction. It
requires an active superadmin with company membership and the explicit
`knowledge_privacy_steward` group; generic model access remains denied. The
authenticated API exposes only this local revocation operation and active
synthetic projections, with event time generated by the server; it does not
cover other derivative stores or prove
that every cache, index, export, replica, or public release has been cleared.
The K5-002 task remains open until all applicable derivative adapters pass
negative API/search tests with no plaintext leakage.

## Synthetic negative cases and approval gates

Synthetic tests cover absent/withdrawn consent,
inherited `RESTRICTED` or `CHILD_SENSITIVE` classification, cross-tenant reads,
public projection self-approval, missing/expired retention, and revocation from
a derived record list. SQLite and isolated PostgreSQL tests also cover the
persisted synthetic projection slice, exact replay, idempotency conflict,
tenant/steward denial, append-only behavior, digest validation, and atomic
rollback. Guessable attachment IDs and end-to-end
public/search/preview/log/prompt leak checks remain required. A passing
synthetic test does not authorize real-data use.

Before a private import or public projection, the assigned owners must approve
the specific workflow and obtain any additional required review from:

- a data/privacy steward responsible for classification, consent, minimization,
  retention, revocation, and access reviews;
- a safeguarding owner before any child-sensitive collection or case workflow;
- a publication reviewer for each proposed public projection; and
- qualified privacy/legal counsel when a real sensitive case or jurisdictional
  obligation requires interpretation.

The data/privacy steward and safeguarding owner are assigned to `bjo163` for
policy ownership. A publication reviewer must still be identified for each
proposed public projection. This policy makes no claim of GDPR,
child-protection, or other legal compliance and authorizes no real private or
child-sensitive data import.
