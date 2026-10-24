import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest, ModelAccess } from '@moonwitness/orm-base';
import {
  activateResearchGraphRelease,
  canonicalResearchJson,
  createResearchGraphRelease,
  manifest,
  MAX_RESEARCH_RELEASE_CANONICAL_BYTES,
  MAX_RESEARCH_RELEASE_RECORDS,
  readActiveResearchGraphRelease,
  readResearchGraphRelease,
} from '../src/index.js';

let db: Knex;

beforeEach(async () => {
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(
        connection: { pragma(sql: string): unknown },
        done: (error: Error | null, connection: unknown) => void
      ) {
        connection.pragma('foreign_keys = ON');
        done(null, connection);
      },
    },
  });
  await installAddons(db, [baseManifest, manifest]);
});

afterEach(async () => db.destroy());

const scopeId = 'mw:concept:synthetic-research-scope';
const assertionId = 'mw:assertion:synthetic-1';

function assertionContent(revision: number, claim: string) {
  return {
    id: assertionId,
    kind: 'Assertion',
    schema_version: 1,
    lifecycle: 'candidate',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    origin_ref: 'fixture://research/release-test',
    visibility: 'PUBLIC_APPROVED',
    content_revision: revision,
    claim,
    polarity: 'positive',
    scope: { kind: 'research_context', reference_id: scopeId },
    context: { mode: 'analysis', reference_id: scopeId },
    epistemic_status: 'hypothesized',
    review_status: 'pending',
  };
}

const releaseInput = {
  corpusKey: 'synthetic-research',
  schemaVersion: 'research-graph/v1',
  records: [
    {
      key: scopeId,
      kind: 'node' as const,
      visibility: 'INTERNAL' as const,
      content: {
        id: scopeId,
        kind: 'Concept',
        identity_class: 'ConceptIdentity',
        visibility: 'INTERNAL',
      },
    },
    {
      key: assertionId,
      kind: 'assertion' as const,
      visibility: 'PUBLIC' as const,
      content: assertionContent(1, 'Synthetic graph assertion.'),
    },
  ],
};

describe('canonical PostgreSQL-compatible research release pilot', () => {
  it('canonicalizes JSON deterministically and rejects non-JSON values', () => {
    expect(canonicalResearchJson({ z: 2, a: { y: true, x: 'v' } })).toBe(
      '{"a":{"x":"v","y":true},"z":2}'
    );
    expect(() => canonicalResearchJson({ missing: undefined })).toThrow('undefined');
    expect(() => canonicalResearchJson(Number.NaN)).toThrow('finite');
  });

  it('denies generic ordinary-user access to canonical release tables', async () => {
    for (const modelName of [
      'knowledge.research_graph_release',
      'knowledge.research_graph_record',
      'knowledge.research_active_release',
    ]) {
      await expect(
        ModelAccess.query().findOne({ model_name: modelName, read: false, write: false })
      ).resolves.toBeDefined();
    }
  });

  it('rejects oversized releases before persistence and fails closed on oversized stored manifests', async () => {
    await expect(
      db.transaction((trx) =>
        createResearchGraphRelease(trx, {
          ...releaseInput,
          records: Array.from({ length: MAX_RESEARCH_RELEASE_RECORDS + 1 }, (_, index) => ({
            key: `mw:concept:oversized-${index}`,
            kind: 'node' as const,
            visibility: 'INTERNAL' as const,
            content: {
              id: `mw:concept:oversized-${index}`,
              kind: 'Concept',
              visibility: 'INTERNAL',
            },
          })),
        })
      )
    ).rejects.toThrow('record limit');
    await expect(
      db.transaction((trx) =>
        createResearchGraphRelease(trx, {
          ...releaseInput,
          records: releaseInput.records.map((record) => ({
            ...record,
            content: {
              id: record.key,
              kind: 'Concept',
              visibility: 'INTERNAL',
              payload: 'x'.repeat(MAX_RESEARCH_RELEASE_CANONICAL_BYTES),
            },
          })),
        })
      )
    ).rejects.toThrow('content limit');
    const oversizedAggregate = 'x'.repeat(MAX_RESEARCH_RELEASE_CANONICAL_BYTES / 2 + 128);
    await expect(
      db.transaction((trx) =>
        createResearchGraphRelease(trx, {
          ...releaseInput,
          records: [0, 1].map((index) => ({
            key: `mw:concept:aggregate-${index}`,
            kind: 'node' as const,
            visibility: 'INTERNAL' as const,
            content: {
              id: `mw:concept:aggregate-${index}`,
              kind: 'Concept',
              visibility: 'INTERNAL',
              payload: oversizedAggregate,
            },
          })),
        })
      )
    ).rejects.toThrow('content limit');

    const valid = await db.transaction((trx) => createResearchGraphRelease(trx, releaseInput));
    const releaseRow = await db('knowledge_research_graph_releases')
      .where({ release_digest: valid.releaseDigest })
      .first();
    await db.raw('DROP TRIGGER knowledge_research_graph_releases_reject_update');
    await db('knowledge_research_graph_releases')
      .where({ id: releaseRow.id })
      .update({ manifest_json: ' '.repeat(MAX_RESEARCH_RELEASE_CANONICAL_BYTES + 1) });
    await expect(
      db.transaction((trx) => readResearchGraphRelease(trx, valid.releaseDigest))
    ).resolves.toBeNull();
  });

  it('stores content-addressed immutable releases and activates/rolls back by expected head', async () => {
    const first = await db.transaction((trx) => createResearchGraphRelease(trx, releaseInput));
    const replay = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        ...releaseInput,
        records: [...releaseInput.records].reverse(),
      })
    );
    expect(replay.releaseDigest).toBe(first.releaseDigest);
    expect(await db('knowledge_research_graph_releases')).toHaveLength(1);
    expect(await db('knowledge_research_graph_records')).toHaveLength(2);

    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: releaseInput.corpusKey,
        releaseDigest: first.releaseDigest,
        expectedCurrentReleaseDigest: null,
        activatedAt: '2026-10-16T00:00:00.000Z',
      })
    );
    await expect(
      db.transaction((trx) =>
        activateResearchGraphRelease(trx, {
          corpusKey: releaseInput.corpusKey,
          releaseDigest: first.releaseDigest,
          expectedCurrentReleaseDigest: null,
          activatedAt: '2026-10-16T00:01:00.000Z',
        })
      )
    ).rejects.toThrow('changed');
    expect(
      (await db.transaction((trx) => readActiveResearchGraphRelease(trx, releaseInput.corpusKey)))
        ?.releaseDigest
    ).toBe(first.releaseDigest);

    const second = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        ...releaseInput,
        previousReleaseDigest: first.releaseDigest,
        records: releaseInput.records.map((record) =>
          record.key === assertionId
            ? { ...record, content: assertionContent(2, 'Synthetic graph assertion, revised.') }
            : record
        ),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: releaseInput.corpusKey,
        releaseDigest: second.releaseDigest,
        expectedCurrentReleaseDigest: first.releaseDigest,
        activatedAt: '2026-10-16T00:02:00.000Z',
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: releaseInput.corpusKey,
        releaseDigest: first.releaseDigest,
        expectedCurrentReleaseDigest: second.releaseDigest,
        activatedAt: '2026-10-16T00:03:00.000Z',
      })
    );
    expect(
      (await db.transaction((trx) => readActiveResearchGraphRelease(trx, releaseInput.corpusKey)))
        ?.releaseDigest
    ).toBe(first.releaseDigest);
    const restored = await db.transaction((trx) =>
      readResearchGraphRelease(trx, second.releaseDigest)
    );
    expect(restored).toMatchObject({ previousReleaseDigest: first.releaseDigest });
    expect(restored?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: assertionId,
          content: assertionContent(2, 'Synthetic graph assertion, revised.'),
        }),
      ])
    );
  });

  it('rolls back partially written snapshots and pointer changes in the caller transaction', async () => {
    await expect(
      db.transaction(async (trx) => {
        const release = await createResearchGraphRelease(trx, releaseInput);
        await activateResearchGraphRelease(trx, {
          corpusKey: releaseInput.corpusKey,
          releaseDigest: release.releaseDigest,
          expectedCurrentReleaseDigest: null,
          activatedAt: '2026-10-16T00:00:00.000Z',
        });
        throw new Error('forced transaction failure');
      })
    ).rejects.toThrow('forced transaction failure');
    expect(await db('knowledge_research_graph_releases')).toHaveLength(0);
    expect(await db('knowledge_research_graph_records')).toHaveLength(0);
    expect(await db('knowledge_research_active_releases')).toHaveLength(0);
  });

  it('prevents cross-corpus activation and malformed or dangling release lineage', async () => {
    const release = await db.transaction((trx) => createResearchGraphRelease(trx, releaseInput));
    await expect(
      db.transaction((trx) =>
        activateResearchGraphRelease(trx, {
          corpusKey: 'another-corpus',
          releaseDigest: release.releaseDigest,
          expectedCurrentReleaseDigest: null,
          activatedAt: '2026-10-16T00:00:00.000Z',
        })
      )
    ).rejects.toThrow('different corpus');
    await expect(
      db.transaction((trx) =>
        createResearchGraphRelease(trx, {
          ...releaseInput,
          previousReleaseDigest: 'bad-digest',
        })
      )
    ).rejects.toThrow('SHA-256');
    await expect(
      db.transaction((trx) =>
        createResearchGraphRelease(trx, {
          ...releaseInput,
          previousReleaseDigest: 'd'.repeat(64),
        })
      )
    ).rejects.toThrow('does not exist');
    expect(await db('knowledge_research_active_releases')).toHaveLength(0);
  });

  it('rejects direct SQL mutation of immutable release and content rows', async () => {
    const release = await db.transaction((trx) => createResearchGraphRelease(trx, releaseInput));
    const releaseRow = await db('knowledge_research_graph_releases')
      .where({ release_digest: release.releaseDigest })
      .first();
    const recordRow = await db('knowledge_research_graph_records')
      .where({ release_id: releaseRow.id })
      .first();
    await expect(
      db('knowledge_research_graph_releases')
        .where({ id: releaseRow.id })
        .update({ record_count: 9 })
    ).rejects.toThrow('append-only');
    await expect(
      db('knowledge_research_graph_records').where({ id: recordRow.id }).delete()
    ).rejects.toThrow('append-only');
  });

  it('fails closed when restored release bytes do not match their stored digest', async () => {
    const release = await db.transaction((trx) => createResearchGraphRelease(trx, releaseInput));
    const releaseRow = await db('knowledge_research_graph_releases')
      .where({ release_digest: release.releaseDigest })
      .first();
    await db.raw('DROP TRIGGER knowledge_research_graph_records_reject_update');
    await db('knowledge_research_graph_records')
      .where({ release_id: releaseRow.id })
      .update({ content_json: '{"tampered":true}' });
    await expect(
      db.transaction((trx) => readResearchGraphRelease(trx, release.releaseDigest))
    ).resolves.toBeNull();
  });

  it('fails closed when a corrupted active pointer targets a valid release from another corpus', async () => {
    const requested = await db.transaction((trx) => createResearchGraphRelease(trx, releaseInput));
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: releaseInput.corpusKey,
        releaseDigest: requested.releaseDigest,
        expectedCurrentReleaseDigest: null,
        activatedAt: '2026-10-16T00:00:00.000Z',
      })
    );
    const other = await db.transaction((trx) =>
      createResearchGraphRelease(trx, { ...releaseInput, corpusKey: 'other-synthetic-research' })
    );
    const otherRow = await db('knowledge_research_graph_releases')
      .where({ release_digest: other.releaseDigest })
      .first('id');
    await db('knowledge_research_active_releases')
      .where({ corpus_key: releaseInput.corpusKey })
      .update({ release_id: otherRow.id });

    await expect(
      db.transaction((trx) => readActiveResearchGraphRelease(trx, releaseInput.corpusKey))
    ).resolves.toBeNull();
  });

  it('does not activate graph content that fails the ontology schemas', async () => {
    const release = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        ...releaseInput,
        records: releaseInput.records.map((record) =>
          record.key === assertionId
            ? {
                ...record,
                content: { id: assertionId, kind: 'Assertion', claim: 'Missing required fields.' },
              }
            : record
        ),
      })
    );
    await expect(
      db.transaction((trx) =>
        activateResearchGraphRelease(trx, {
          corpusKey: releaseInput.corpusKey,
          releaseDigest: release.releaseDigest,
          expectedCurrentReleaseDigest: null,
          activatedAt: '2026-10-16T00:00:00.000Z',
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    expect(await db('knowledge_research_active_releases')).toHaveLength(0);
  });
});
