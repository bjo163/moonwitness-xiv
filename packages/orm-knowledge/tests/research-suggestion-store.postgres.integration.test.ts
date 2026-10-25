import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { manifest as knowledgeManifest } from '../src/manifest.js';
import {
  readResearchSuggestionVersion,
  recordResearchSuggestionReviewDecision,
  resolveResearchSuggestionReviewDecision,
  storeResearchSuggestions,
} from '../src/research-suggestion-store.js';

const connectionString = process.env.POSTGRES_TEST_URL;
const postgresDescribe = connectionString ? describe : describe.skip;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const sourceText = 'Synthetic PostgreSQL extractive passage.';
const envelopeFor = (text: string, locator: string) =>
  ({
    format: 'mw-local-ai-suggestion-envelope/v1',
    suggestions: [
      {
        id: 'mw:suggestion:postgres-integration',
        kind: 'summary',
        status: 'unreviewed',
        visibility: 'INTERNAL',
        text,
        citations: [
          {
            evidence_id: 'mw:evidence:postgres-synthetic',
            assertion_id: 'mw:assertion:postgres-synthetic',
            selector: {
              source_id: 'mw:source:synthetic-postgres',
              edition_id: 'mw:edition:synthetic-postgres-v1',
              locator,
              content_sha256: sha256(text),
              range: { unit: 'unicode_scalar', start: 0, end: Array.from(text).length },
              selected_span_sha256: sha256(text),
            },
          },
        ],
      },
    ],
  }) as const;

const envelope = envelopeFor(sourceText, 'fixture://postgres/suggestion/1');

const resolverForTransaction = (trx: Knex.Transaction) => ({
  async resolvePassage(
    selector: (typeof envelope.suggestions)[number]['citations'][number]['selector']
  ) {
    const row = await trx('test_research_passage_access')
      .where({
        source_id: selector.source_id,
        edition_id: selector.edition_id,
        locator: selector.locator,
      })
      .first('content_sha256', 'text', 'readable');
    return row
      ? {
          source_id: selector.source_id,
          edition_id: selector.edition_id,
          locator: selector.locator,
          content_sha256: String(row.content_sha256),
          text: String(row.text),
          readable: Boolean(row.readable),
        }
      : null;
  },
  async resolveAssertion(assertionId: string) {
    const row = await trx('test_research_assertion_access')
      .where({ assertion_id: assertionId })
      .first('active', 'readable');
    return row ? { active: Boolean(row.active), readable: Boolean(row.readable) } : null;
  },
  async resolveEvidence(evidenceId: string) {
    const row = await trx('test_research_evidence_access')
      .where({ evidence_id: evidenceId })
      .first('assertion_id', 'active', 'readable');
    return row
      ? {
          assertion_id: String(row.assertion_id),
          active: Boolean(row.active),
          readable: Boolean(row.readable),
        }
      : null;
  },
});

postgresDescribe('research suggestion PostgreSQL integration', () => {
  const schema = `mw_suggestion_${randomUUID().replaceAll('-', '')}`;
  let adminDb: Knex;
  let db: Knex;

  beforeAll(async () => {
    if (!connectionString) throw new Error('POSTGRES_TEST_URL is required');
    adminDb = knex({ client: 'pg', connection: connectionString, pool: { min: 0, max: 2 } });
    await adminDb.raw('select 1');
    await adminDb.raw('create schema ??', [schema]);
    db = knex({
      client: 'pg',
      connection: connectionString,
      searchPath: [schema],
      pool: { min: 0, max: 3 },
    });
    await installAddons(db, [baseManifest, knowledgeManifest]);
    await db.schema.createTable('test_research_passage_access', (table) => {
      table.string('source_id').notNullable();
      table.string('edition_id').notNullable();
      table.string('locator').notNullable();
      table.string('content_sha256').notNullable();
      table.text('text').notNullable();
      table.boolean('readable').notNullable();
      table.primary(['source_id', 'edition_id', 'locator']);
    });
    await db.schema.createTable('test_research_assertion_access', (table) => {
      table.string('assertion_id').primary();
      table.boolean('active').notNullable();
      table.boolean('readable').notNullable();
    });
    await db.schema.createTable('test_research_evidence_access', (table) => {
      table.string('evidence_id').primary();
      table.string('assertion_id').notNullable();
      table.boolean('active').notNullable();
      table.boolean('readable').notNullable();
    });
  }, 30000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (adminDb) {
      await adminDb.raw('drop schema if exists ?? cascade', [schema]);
      await adminDb.destroy();
    }
  });

  it('serializes concurrent tenant writes, verifies reads, and rejects SQL mutation', async () => {
    const userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    const companyId = Number((await db('companies').first('id'))?.id);
    if (!userId || !companyId) throw new Error('Synthetic PostgreSQL actor/company is unavailable');
    await db('test_research_passage_access').insert({
      source_id: 'mw:source:synthetic-postgres',
      edition_id: 'mw:edition:synthetic-postgres-v1',
      locator: 'fixture://postgres/suggestion/1',
      content_sha256: sha256(sourceText),
      text: sourceText,
      readable: true,
    });
    await db('test_research_passage_access').insert([
      {
        source_id: 'mw:source:synthetic-postgres',
        edition_id: 'mw:edition:synthetic-postgres-v1',
        locator: 'fixture://postgres/suggestion/changed-a',
        content_sha256: sha256('Synthetic PostgreSQL changed version A.'),
        text: 'Synthetic PostgreSQL changed version A.',
        readable: true,
      },
      {
        source_id: 'mw:source:synthetic-postgres',
        edition_id: 'mw:edition:synthetic-postgres-v1',
        locator: 'fixture://postgres/suggestion/changed-b',
        content_sha256: sha256('Synthetic PostgreSQL changed version B.'),
        text: 'Synthetic PostgreSQL changed version B.',
        readable: true,
      },
    ]);
    await db('test_research_assertion_access').insert({
      assertion_id: 'mw:assertion:postgres-synthetic',
      active: true,
      readable: true,
    });
    await db('test_research_evidence_access').insert({
      evidence_id: 'mw:evidence:postgres-synthetic',
      assertion_id: 'mw:assertion:postgres-synthetic',
      active: true,
      readable: true,
    });
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    const input = {
      authenticatedActor: { userId, companyId, role: 'superadmin' as const },
      envelope,
      resolverForTransaction,
    };
    const concurrent = await Promise.all([
      storeResearchSuggestions(db, input),
      storeResearchSuggestions(db, input),
    ]);
    expect(concurrent.flat().map(({ version }) => version)).toEqual([1, 1]);
    expect(concurrent.flat().filter(({ idempotent }) => idempotent)).toHaveLength(1);
    const stored = await readResearchSuggestionVersion(db, {
      authenticatedReader: input.authenticatedActor,
      suggestionId: 'mw:suggestion:postgres-integration',
      resolverForTransaction,
    });
    expect(stored).toMatchObject({ version: 1, visibility: 'INTERNAL', status: 'unreviewed' });
    const changed = await Promise.all([
      storeResearchSuggestions(db, {
        ...input,
        envelope: envelopeFor(
          'Synthetic PostgreSQL changed version A.',
          'fixture://postgres/suggestion/changed-a'
        ),
      }),
      storeResearchSuggestions(db, {
        ...input,
        envelope: envelopeFor(
          'Synthetic PostgreSQL changed version B.',
          'fixture://postgres/suggestion/changed-b'
        ),
      }),
    ]);
    expect(
      changed
        .flat()
        .map(({ version }) => version)
        .sort()
    ).toEqual([2, 3]);
    expect(changed.flat().every(({ idempotent }) => !idempotent)).toBe(true);
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(3);
    await expect(
      db('knowledge_research_suggestion_versions')
        .where({ suggestion_id: 'mw:suggestion:postgres-integration' })
        .update({ visibility: 'PUBLIC' })
    ).rejects.toThrow('Knowledge research suggestions are append-only');
    await expect(
      db('knowledge_research_suggestion_versions')
        .where({ suggestion_id: 'mw:suggestion:postgres-integration' })
        .delete()
    ).rejects.toThrow('Knowledge research suggestions are append-only');
    await db('partners').insert({
      name: 'Synthetic PostgreSQL suggestion reviewer',
      company_id: companyId,
      is_company: false,
    });
    await db('users').insert({
      login: 'pg-suggestion-reviewer',
      partner_id: (
        await db('partners').where({ name: 'Synthetic PostgreSQL suggestion reviewer' }).first('id')
      )?.id,
      role: 'user',
    });
    const reviewerId = Number(
      (await db('users').where({ login: 'pg-suggestion-reviewer' }).first('id'))?.id
    );
    await db('company_memberships').insert({
      user_id: reviewerId,
      company_id: companyId,
      is_default: false,
    });
    const decision = await recordResearchSuggestionReviewDecision(db, {
      authenticatedReviewer: { userId: reviewerId, companyId, role: 'user' },
      suggestionId: 'mw:suggestion:postgres-integration',
      outcome: 'accepted',
      rationale: 'Synthetic PostgreSQL review of the citation-only candidate.',
    });
    expect(decision).toMatchObject({ reviewed_version: 3, reviewer_id: String(reviewerId) });
    await expect(
      resolveResearchSuggestionReviewDecision(db, {
        authenticatedReader: { userId: reviewerId, companyId, role: 'user' },
        suggestionId: decision.suggestion_id,
        suggestionDigest: decision.suggestion_digest,
      })
    ).resolves.toMatchObject({ id: decision.id });
    const decisionRowId = Number(
      (
        await db('knowledge_research_suggestion_review_decisions')
          .where({ suggestion_digest: decision.suggestion_digest })
          .first('id')
      )?.id
    );
    await expect(
      db('knowledge_research_suggestion_review_decisions')
        .where({ id: decisionRowId })
        .update({ outcome: 'rejected' })
    ).rejects.toThrow('Research suggestion review decisions are append-only');
    await expect(
      db('knowledge_research_suggestion_review_decisions').where({ id: decisionRowId }).delete()
    ).rejects.toThrow('Research suggestion review decisions are append-only');
    await db('test_research_evidence_access')
      .where({ evidence_id: 'mw:evidence:postgres-synthetic' })
      .update({ active: false, readable: false });
    await expect(
      readResearchSuggestionVersion(db, {
        authenticatedReader: input.authenticatedActor,
        suggestionId: 'mw:suggestion:postgres-integration',
        resolverForTransaction,
      })
    ).rejects.toThrow(/trusted source and evidence validation/u);
  }, 30000);
});
