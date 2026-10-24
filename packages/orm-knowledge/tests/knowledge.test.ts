import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest, ModelAccess, User } from '@moonwitness/orm-base';
import {
  isNextCorrectionSequence,
  isValidCorrectionProvenance,
  appendOwnedSyntheticWitnessCorrection,
  manifest,
  WitnessCorrection,
  WitnessInterpretation,
  WitnessTestimony,
  type WitnessCorrectionSourceResolver,
} from '../src/index.js';

const digest = 'c'.repeat(64);

const resolveSource: WitnessCorrectionSourceResolver = async (reference) => ({
  ...reference,
  bytes_verified: true,
  rights_state: 'permitted',
  allowed_uses: ['read_analyze', 'quote_excerpt'],
});

describe('knowledge witness records addon', () => {
  let db: Knex;

  beforeEach(() => {
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
  });

  afterEach(async () => db.destroy());

  it('installs synthetic examples with restricted visibility by default', async () => {
    await installAddons(db, [manifest, baseManifest]);
    const testimony = await WitnessTestimony.query().findOne({
      external_key: 'synthetic-witness-001',
    });
    expect(testimony).toMatchObject({
      visibility: 'RESTRICTED',
      synthetic: true,
      received_time_text: 'spring',
    });
    const scopedWitness = await WitnessTestimony.query().findOne({
      external_key: 'synthetic-witness-scoped-001',
    });
    expect(scopedWitness).toMatchObject({ synthetic: true, visibility: 'RESTRICTED' });
    expect(Number(scopedWitness?.company_id)).toBeGreaterThan(0);
    expect(await WitnessCorrection.query().where('testimony_id', testimony?.id)).toHaveLength(1);
    const interpretation = await WitnessInterpretation.query().findOne({
      assertion_ref: 'assertion://synthetic/meeting-after-noon',
    });
    expect(interpretation).toMatchObject({
      visibility: 'RESTRICTED',
      epistemic_status: 'hypothesis',
      evidence_ref: 'evidence://synthetic/witness-001/correction-001',
    });
    expect(manifest.data?.length).toBeGreaterThan(0);
    expect(manifest.menus?.every((menu) => menu.developmentOnly)).toBe(true);
    for (const model of [WitnessTestimony, WitnessCorrection, WitnessInterpretation]) {
      await expect(
        ModelAccess.query().findOne({ model_name: model.modelName, read: false })
      ).resolves.toBeDefined();
    }
  });

  it('upgrades populated 1.3 witness tables without classifying legacy rows as synthetic', async () => {
    await installAddons(db, [baseManifest]);
    const system = await User.query().findOne({ login: 'system' });
    await db.schema.createTable('knowledge_witness_testimonies', (table) => {
      table.increments('id').primary();
      table.boolean('active').notNullable().defaultTo(true);
      table.timestamp('create_date');
      table.timestamp('write_date');
      table.integer('create_uid');
      table.integer('write_uid');
      table.string('external_key').notNullable();
      table.text('original_text').notNullable();
      table.string('source_label').notNullable();
      table.string('source_locator').notNullable();
      table.string('source_digest').notNullable();
      table.string('received_time_text').notNullable();
      table.string('received_time_precision').notNullable();
      table.text('uncertainty_note');
      table.string('visibility').notNullable();
      table.integer('created_by_id').notNullable();
    });
    await db('knowledge_witness_testimonies').insert({
      external_key: 'legacy-unclassified-witness',
      original_text: 'Legacy record must remain unclassified.',
      source_label: 'Legacy fixture',
      source_locator: 'fixture://legacy-unclassified',
      source_digest: digest,
      received_time_text: 'unknown',
      received_time_precision: 'unknown',
      visibility: 'RESTRICTED',
      created_by_id: Number(system?.id),
    });
    await db('_orm_addons').insert({ name: 'knowledge', version: '1.3.0' });

    await installAddons(db, [baseManifest, manifest]);

    const legacy = await WitnessTestimony.query().findOne({
      external_key: 'legacy-unclassified-witness',
    });
    expect(legacy).toMatchObject({ synthetic: false, company_id: null });
    expect(
      await WitnessTestimony.query().where({
        external_key: 'legacy-unclassified-witness',
        synthetic: true,
      })
    ).toHaveLength(0);
  });

  it('rejects ordinary model updates and deletes to source and correction records', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const testimony = await WitnessTestimony.query().findOne({
      external_key: 'synthetic-witness-001',
    });
    const correction = await WitnessCorrection.query().findOne({ sequence: 1 });
    await expect(WitnessTestimony.query().patch({ original_text: 'replacement' })).rejects.toThrow(
      'cannot be updated or deleted'
    );
    await expect(WitnessTestimony.query().deleteById(testimony?.id)).rejects.toThrow(
      'cannot be updated or deleted'
    );
    await expect(
      WitnessCorrection.query().patch({ correction_text: 'replacement' })
    ).rejects.toThrow('cannot be updated or deleted');
    await expect(WitnessCorrection.query().deleteById(correction?.id)).rejects.toThrow(
      'cannot be updated or deleted'
    );
    const interpretation = await WitnessInterpretation.query().first();
    await expect(
      WitnessInterpretation.query().patch({ interpretation_text: 'replacement' })
    ).rejects.toThrow('cannot be updated or deleted');
    await expect(WitnessInterpretation.query().deleteById(interpretation?.id)).rejects.toThrow(
      'cannot be updated or deleted'
    );
    expect(await WitnessTestimony.query().findById(testimony?.id)).toMatchObject({
      original_text: 'Synthetic example: the meeting began sometime in spring.',
    });
  });

  it('rejects raw SQL updates and deletes for every witness record type', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const testimony = await WitnessTestimony.query().findOne({
      external_key: 'synthetic-witness-001',
    });
    const correction = await WitnessCorrection.query().findOne({ sequence: 1 });
    const interpretation = await WitnessInterpretation.query().first();
    const rows = [
      { table: 'knowledge_witness_testimonies', id: testimony?.id, column: 'original_text' },
      { table: 'knowledge_witness_corrections', id: correction?.id, column: 'correction_text' },
      {
        table: 'knowledge_witness_interpretations',
        id: interpretation?.id,
        column: 'interpretation_text',
      },
    ] as const;

    for (const row of rows) {
      await expect(
        db(row.table)
          .where({ id: row.id })
          .update({ [row.column]: 'raw SQL replacement' })
      ).rejects.toThrow('Knowledge witness records are append-only');
      await expect(db(row.table).where({ id: row.id }).delete()).rejects.toThrow(
        'Knowledge witness records are append-only'
      );
    }

    expect(await WitnessTestimony.query().findById(testimony?.id)).toMatchObject({
      original_text: 'Synthetic example: the meeting began sometime in spring.',
    });
    expect(await WitnessCorrection.query().findById(correction?.id)).toMatchObject({
      correction_text: 'Synthetic correction: the meeting began after noon.',
    });
    expect(await WitnessInterpretation.query().findById(interpretation?.id)).toMatchObject({
      interpretation_text: 'Synthetic hypothesis: the meeting likely began after noon.',
    });
  });

  it('validates correction chain sequence and complete source provenance', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const testimony = await WitnessTestimony.query().findOne({
      external_key: 'synthetic-witness-001',
    });
    const system = await User.query().findOne({ login: 'system' });
    expect(await isNextCorrectionSequence(testimony?.id ?? 0, 2)).toBe(true);
    expect(await isNextCorrectionSequence(testimony?.id ?? 0, 3)).toBe(false);
    expect(
      isValidCorrectionProvenance({
        sequence: 2,
        source_label: 'Archive source',
        source_locator: 'archive://collection/item',
        source_digest: digest,
        asserted_time_text: 'circa 1940',
        asserted_time_precision: 'unknown',
        recorded_by_id: system?.id ?? 0,
      })
    ).toBe(true);
    expect(
      isValidCorrectionProvenance({
        sequence: 2,
        source_label: ' ',
        source_locator: 'archive://collection/item',
        source_digest: 'bad',
        asserted_time_text: 'circa 1940',
        asserted_time_precision: 'unknown',
        recorded_by_id: system?.id ?? 0,
      })
    ).toBe(false);

    await db('knowledge_witness_corrections').insert({
      testimony_id: testimony?.id,
      sequence: 3,
      correction_text: 'Synthetic correction inserted after an intentional sequence gap.',
      reason: 'Synthetic gap detection fixture.',
      source_label: 'Synthetic test source',
      source_locator: 'fixture://correction-gap',
      source_digest: digest,
      asserted_time_text: 'unknown',
      asserted_time_precision: 'unknown',
      recorded_by_id: system?.id,
      synthetic: true,
    });
    expect(await isNextCorrectionSequence(testimony?.id ?? 0, 4)).toBe(false);
    expect(await isNextCorrectionSequence(testimony?.id ?? 0, 2)).toBe(false);
  });

  it('serializes concurrent correction inserts with the database unique constraint', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const original = await WitnessCorrection.query().findOne({ sequence: 1 });
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        db('knowledge_witness_corrections').insert({
          testimony_id: original?.testimony_id,
          sequence: 2,
          correction_text: 'Concurrent synthetic correction.',
          reason: 'Synthetic concurrent sequence test.',
          source_label: 'Synthetic test',
          source_locator: 'fixture://concurrent-correction',
          source_digest: digest,
          asserted_time_text: 'unknown',
          recorded_by_id: original?.recorded_by_id,
        })
      )
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(
      await WitnessCorrection.query().where({ testimony_id: original?.testimony_id, sequence: 2 })
    ).toHaveLength(1);
  });

  it('atomically appends only the next owner-scoped synthetic restricted correction and supports exact retries', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const testimony = await WitnessTestimony.query().findOne({
      external_key: 'synthetic-witness-scoped-001',
    });
    const actor = {
      userId: Number(testimony?.created_by_id),
      companyId: Number(testimony?.company_id),
      role: 'superadmin',
    } as const;
    const input = {
      sequence: 2,
      correctionText: 'Synthetic correction: the lamp was near the north doorway.',
      reason: 'Synthetic owner correction fixture.',
      sourceLabel: 'Synthetic correction fixture',
      sourceLocator: 'fixture://witness/scoped/001/correction/002',
      sourceDigest: digest,
      assertedTimeText: '2026',
      assertedTimePrecision: 'year' as const,
      resolveSource,
    };
    const first = await appendOwnedSyntheticWitnessCorrection(
      db,
      actor,
      Number(testimony?.id),
      input
    );
    const retry = await appendOwnedSyntheticWitnessCorrection(
      db,
      actor,
      Number(testimony?.id),
      input
    );
    expect(first).toMatchObject({ sequence: 2, idempotent: false });
    expect(retry).toMatchObject({ sequence: 2, idempotent: true });
    expect(
      await WitnessCorrection.query().where({ testimony_id: testimony?.id, sequence: 2 })
    ).toHaveLength(1);
    await expect(
      appendOwnedSyntheticWitnessCorrection(db, actor, Number(testimony?.id), {
        ...input,
        correctionText: 'Conflicting retry payload.',
      })
    ).rejects.toThrow('different payload');
    await expect(
      appendOwnedSyntheticWitnessCorrection(db, actor, Number(testimony?.id), {
        ...input,
        sequence: 4,
      })
    ).rejects.toThrow('next contiguous');
    await expect(
      appendOwnedSyntheticWitnessCorrection(db, actor, Number(testimony?.id), {
        ...input,
        sequence: 3,
        uncertaintyNote: 42 as never,
      })
    ).rejects.toThrow('Invalid synthetic witness correction');
    await expect(
      appendOwnedSyntheticWitnessCorrection(
        db,
        { ...actor, companyId: 999 },
        Number(testimony?.id),
        input
      )
    ).rejects.toThrow();
  });

  it('fails closed unless a resolver verifies the correction source bytes and citation rights', async () => {
    await installAddons(db, [baseManifest, manifest]);
    const testimony = await WitnessTestimony.query().findOne({
      external_key: 'synthetic-witness-scoped-001',
    });
    const actor = {
      userId: Number(testimony?.created_by_id),
      companyId: Number(testimony?.company_id),
      role: 'superadmin',
    } as const;
    const input = {
      sequence: 2,
      correctionText: 'Synthetic correction: the lamp was near the north doorway.',
      reason: 'Synthetic owner correction fixture.',
      sourceLabel: 'Synthetic correction fixture',
      sourceLocator: 'fixture://witness/scoped/001/correction/002',
      sourceDigest: digest,
      assertedTimeText: '2026',
      assertedTimePrecision: 'year' as const,
    };
    const unverified: WitnessCorrectionSourceResolver[] = [
      async () => null,
      async (reference) => ({
        ...reference,
        bytes_verified: true,
        rights_state: 'blocked' as never,
        allowed_uses: ['quote_excerpt'],
      }),
      async (reference) => ({
        ...reference,
        bytes_verified: true,
        rights_state: 'permitted',
        allowed_uses: ['read_analyze'],
      }),
      async (reference) => ({
        ...reference,
        source_digest: 'a'.repeat(64),
        bytes_verified: true,
        rights_state: 'permitted',
        allowed_uses: ['quote_excerpt'],
      }),
    ];
    for (const resolve of [undefined, ...unverified]) {
      await expect(
        appendOwnedSyntheticWitnessCorrection(db, actor, Number(testimony?.id), {
          ...input,
          resolveSource: resolve,
        })
      ).rejects.toThrow('verified local bytes');
    }
    expect(
      await WitnessCorrection.query().where({ testimony_id: testimony?.id, sequence: 2 })
    ).toHaveLength(0);

    await expect(
      appendOwnedSyntheticWitnessCorrection(db, actor, Number(testimony?.id), {
        ...input,
        resolveSource,
      })
    ).resolves.toMatchObject({ sequence: 2, idempotent: false });
    await expect(
      appendOwnedSyntheticWitnessCorrection(db, actor, Number(testimony?.id), {
        ...input,
        resolveSource: async () => null,
      })
    ).rejects.toThrow('verified local bytes');
  });
});
