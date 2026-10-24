# `@moonwitness/corpus`

Deterministic, offline ingestion for pinned local JSON record sources. The first
adapter supports only `json-record-array/v1`; it does not fetch URLs, execute
code, infer identity, or decide source rights.

An ingestion recipe pins the exact source bytes:

```json
{
  "format": "moonwitness-ingestion-recipe/v1",
  "recipeId": "example-v1",
  "source": {
    "path": "corpus/input/records.json",
    "sha256": "<64-character-lowercase-sha256>"
  },
  "parser": "json-record-array/v1"
}
```

Validate the recipe shape against `schemas/ingestion-recipe.schema.json`. Then
build the workspace and run a dry-run or immutable import:

```sh
pnpm --filter @moonwitness/knowledge build
pnpm --filter @moonwitness/corpus build
node scripts/knowledge/ingest.mjs recipe.json --output corpus/releases/example --dry-run
node scripts/knowledge/ingest.mjs recipe.json --output corpus/releases/example
```

The adapter verifies the pinned source digest, parses duplicate-key-safe JSON,
validates every record against the knowledge contract, rejects duplicate IDs,
and computes an RFC 8785 snapshot digest. It validates the complete input before
writing. Output is staged beside its destination and published by rename; an
existing release path is immutable and cannot be overwritten. A failed parse,
checksum, or record validation leaves the prior release untouched. Tests use
synthetic fixtures; separately licensed excerpts under `corpus/reference/`
have pinned manifests and source-specific scope.

## Content-addressed raw artifacts

`putRawArtifact` stores exact bytes under `sha256/<first-two-hex>/<sha256>` in an
existing store directory. The supplied digest must match the bytes. Repeating
the same write is idempotent; a corrupt existing object is reported and never
replaced. `readRawArtifact` verifies the digest again before returning bytes.
The store rejects malformed digests, symbolic links, and non-directory path
segments. It stores bytes only; rights and publication decisions remain separate.

## Pinned Qur’an passage slice

`corpus/manifests/quran-passage-index.json` maps an exact edition and verse
locator to a source-artifact manifest and one content-addressed source line.
`readQuranPassage` loads only those local files, requires a structurally valid
source-bytes manifest with permitted rights for the requested use, verifies the
SHA-256 and byte length, and checks that the source line's locator matches the
index. It returns the exact source bytes and the unmodified verse text. Unknown
editions or locators, missing artifacts, checksum mismatches, and denied rights
fail closed. The function does not make network requests.

`importQuranPassage` stores the verified exact bytes in a local raw-artifact
store. Reimporting the same bytes is idempotent; it never overwrites a corrupt
blob. Rights clearance and attribution are recorded in the source manifest and
notice file, and are not inferred from artifact availability.

## Second textual witness sample

`corpus/manifests/textual-witness-index.json` maps the one-verse WEBP sample to
its explicit `mw:expression:webp-protestant` and
`mw:edition:webp-protestant-2020-stable` identities. The identity fixture links
that edition only to the WEBP expression; it asserts no identity or witness
relationship with Quran, Taurat, Zabur, Injil, or any other revelation. The
source manifest records the public-domain source, excerpt operation, rights
scope, and checksum. The returned citation also records that “World English
Bible” is an eBible.org trademark, the unchanged excerpt does not imply
endorsement, and changed translation wording must not be labeled World English
Bible. If a future source is restricted, a metadata-only manifest remains valid
and no text bytes need to be checked in.

## Private archive intake manifest

`createPrivateArchiveImportManifest` records a user-supplied local archive's
kind, export time, byte length, SHA-256, and source-scoped consent fields. It
hashes the selected file locally and writes only the metadata manifest.
`importPrivateArchive` additionally copies a consent-bound local file to a
separate private intake directory. It uses exclusive creation, restrictive file
permissions, stages complete files beside their destinations before atomic
no-overwrite publication, verifies the copied digest, and removes only the
published file identity it created if verification or manifest creation fails.
On POSIX, intake directories must be owner-private and have no unsafe shared
writable ancestors. Windows mode bits do not prove ACL isolation, so callers
must supply directories protected to the current user. Both functions reject denied or
withdrawn consent, source mismatch, unsafe paths, symbolic links, intake roots
inside the workspace, and overwrites. The caller supplies the repository
`workspaceRoot` and external local source/destination roots. These functions do
not parse, upload, or publish archive contents; tests use synthetic bytes only.
Never commit real account, witness, or consent data. Validation checks declared
structure and source binding; it does not prove consent is authentic or legally
sufficient. Retention, revocation, and any real-data workflow remain gated by
K5-002 and the accepted privacy policy.

## Dataset release pointers

`createDatasetRelease` stores an immutable, content-addressed release manifest
that binds a snapshot digest to independent ontology/corpus versions and the
previously active release. Ingestion also pins the recipe path and digest that
produced the snapshot; the recipe in turn pins its local source path and digest.
`activateDatasetRelease` verifies the manifest and snapshot before atomically
replacing the active pointer; activating an older release performs rollback
without deleting either manifest. `replayDatasetRelease` rebuilds a missing
snapshot from its pinned local recipe, verifies the reconstructed digest, and
only then activates it. A corrupt existing snapshot is never overwritten, and
missing or changed source inputs fail closed while leaving the current pointer
unchanged. The pipeline performs no network fetches. Source files must remain
available in the repository or in an operator-managed local workspace; recipe
pinning is an integrity check, not rights clearance or automatic source-byte
retention.
