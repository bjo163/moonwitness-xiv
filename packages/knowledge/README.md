# @moonwitness/knowledge

Offline, typed structural contracts for the XIV core knowledge record envelope,
explicit canonical identity resolution, and PROV-inspired provenance graphs.

The JSON Schema at `schemas/knowledge-record.schema.json` is the canonical
Draft 2020-12 contract. `validateKnowledgeRecord` returns JSON Pointer
diagnostics, and `isKnowledgeRecord` provides a type guard after validation.
`validateCanonicalKnowledgeId` checks stable IDs in the `mw:<kind>:<token>`
namespace, and `resolveKnowledgeIdentity` accepts exact canonical IDs or an
explicit source namespace and alias value. Alias collisions are returned as
conflicts; titles and similarity are never used as implicit identity.

The optional `derivation` field records an activity ID, non-empty input IDs,
method ID, and method version on each derived record. `validateKnowledgeProvenanceGraph`
checks canonical IDs, actor/source/input/output/activity resolution, matching
generation and method metadata, ordered timestamps, and acyclic derivation
lineage. In this graph contract, activity `generated_ids` defines the derived
record set, and every listed output must carry matching derivation metadata.
The graph contains only an ID/kind index; validate each full record envelope
separately with `validateKnowledgeRecord`. Actors must resolve to `Agent`
records and `source_ids` must resolve to `Artifact` records. The exported
provenance schema is also available at
`@moonwitness/knowledge/provenance-schema`.

The activity mapping is PROV-inspired: activities correspond to `prov:Activity`,
actors to `prov:Agent` / `prov:wasAssociatedWith`, used inputs and sources to
`prov:used`, and generated records to `prov:wasGeneratedBy`. Method IDs and
versions are explicit XIV contract fields; this package does not claim to be an
RDF runtime or infer causation from timestamps. Rights clearance remains a
separate gate. Visibility values follow the accepted K0-005 vocabulary; records
must state a visibility explicitly. Fixtures and tests use synthetic data only.

The source artifact manifest schema at
`schemas/source-artifact-manifest.schema.json` records artifact identity, exact
edition, locale, rights decision, attribution, and intended publication
representation. Public source bytes require a permitted, scoped decision, an
exact SHA-256 and byte length, attribution, and a complaint-process owner.
Unknown or restricted rights remain metadata-only at most. Structural
validity does not establish legal permission or authorize a release;
source-specific evidence and review remain mandatory. `validateSourceArtifactManifest`
checks the schema and full date/URI formats without deciding whether the rights
claims are true.

## Standalone dataset validator

After building the package, validate a local directory without calling an API,
model, or network service:

```sh
pnpm --filter @moonwitness/knowledge build
node scripts/knowledge/validate.mjs path/to/dataset
```

The dataset layout is `records/**/*.json` (one knowledge record per file),
optional `aliases.json` (an array of `{ "namespace", "value", "targetId" }`),
optional `source-artifacts/**/*.json` (source artifact manifests), and optional
`provenance.json` (one PROV-inspired graph). Record and alias IDs are checked
against the canonical registry; manifest editions must resolve to `Edition`
records; provenance actors, sources, inputs, outputs, activities and derivation
links must resolve. Duplicate IDs, alias conflicts, dangling references,
malformed manifests and invalid record envelopes produce deterministic
diagnostics and a nonzero exit. Source URIs are format-checked only and never
fetched. Symbolic links below the dataset tree are rejected.

Use `--json` for machine-readable diagnostics. No approval, rights clearance,
private-data consent, or publication authorization is inferred from a passing
validation result. The validator fixture contains synthetic values only.

## Canonical dataset snapshots

After the package build, create a deterministic content digest for a validated
dataset:

```sh
node scripts/knowledge/snapshot.mjs path/to/dataset
```

The command prints a manifest containing SHA-256 digests for each record, alias,
source-artifact manifest, and provenance graph. Collection ordering, JSON object
key ordering, and filenames do not affect the digest; array ordering inside a
document remains meaningful. The command uses RFC 8785 canonical JSON, rejects
duplicate JSON object names and invalid I-JSON values, and returns no digest for
an invalid dataset. Snapshot hashes identify structural content; they do not
establish source rights or prove that external bytes match metadata.

`createKnowledgeSnapshot`, `canonicalizeJson`, `hashCanonicalJson`, and
`parseCanonicalJson` are exported from the package root. The independent ontology
and corpus version registry, compatibility contract, and migration gate are
documented in [schema versioning](../../docs/knowledge/schema-versioning.md).

```sh
pnpm --filter @moonwitness/knowledge build
pnpm --filter @moonwitness/knowledge typecheck
pnpm --filter @moonwitness/knowledge test
```
