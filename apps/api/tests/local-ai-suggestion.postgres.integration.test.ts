import { randomUUID, createHash } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { readQuranPassageSnapshot } from '@moonwitness/corpus';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import {
  activateResearchGraphRelease,
  createResearchGraphRelease,
  manifest as knowledgeManifest,
} from '@moonwitness/orm-knowledge';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localAiSuggestionRoutes } from '../src/routes/local-ai-suggestion.routes.js';
import { resolveCorpusDataRoot } from '../src/routes/corpus.routes.js';

const connectionString = process.env.POSTGRES_TEST_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === 'true' && !connectionString) {
  throw new Error('POSTGRES_TEST_URL is required when REQUIRE_POSTGRES_TESTS=true');
}
const postgresDescribe = connectionString ? describe : describe.skip;

const sourceId = 'mw:source:tanzil-quran-text';
const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const assertionId = 'mw:assertion:postgres-local-ai-suggestion-001';
const evidenceId = 'mw:evidence:postgres-local-ai-suggestion-001';
const scopeId = 'mw:concept:postgres-local-ai-suggestion-scope';
const suggestionId = 'mw:suggestion:postgres-local-ai-suggestion-001';

postgresDescribe('local AI suggestion route PostgreSQL integration', () => {
  const schema = `mw_local_ai_suggestion_${randomUUID().replaceAll('-', '')}`;
  let adminDb: Knex;
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let userId: number;
  let companyId: number;
  let foreignCompanyId: number;
  const generate = vi.fn(async () => ({ status: 'generated' as const, text: '{}' }));

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
    await installAddons(db, [
      baseManifest,
      jobsManifest,
      notificationManifest,
      workflowManifest,
      knowledgeManifest,
    ]);
    userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    companyId = Number((await db('companies').first('id'))?.id);
    if (!userId || !companyId) throw new Error('Synthetic PostgreSQL actor/company is unavailable');
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    foreignCompanyId = Number(
      (
        await db('companies')
          .insert({ name: 'Synthetic Unassigned Suggestion Company', timezone: 'UTC' })
          .returning('id')
      )[0]?.id
    );

    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.decorate('localAi', { generate });
    app.addHook('onRequest', async (request: FastifyRequest) => {
      if (request.headers['x-test-auth'] !== 'allowed') return;
      request.auth = {
        userId,
        role: 'superadmin',
        companyId: request.headers['x-test-company'] === 'foreign' ? foreignCompanyId : companyId,
        groupPermissions: [],
      };
    });
    await app.register(rateLimit, { global: false });
    await app.register(localAiSuggestionRoutes);
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    if (adminDb) {
      await adminDb.raw('drop schema if exists ?? cascade', [schema]);
      await adminDb.destroy();
    }
  });

  it('stores an INTERNAL unreviewed candidate through the authenticated HTTP route', async () => {
    const snapshot = await readQuranPassageSnapshot({
      rootDirectory: resolveCorpusDataRoot(),
      editionId,
      locator: 'Q7:46',
      use: 'read_analyze',
    });
    const current = await db('knowledge_research_active_releases as active')
      .join('knowledge_research_graph_releases as release', 'release.id', 'active.release_id')
      .where({ 'active.corpus_key': 'research' })
      .first('release.release_digest');
    const release = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        corpusKey: 'research',
        schemaVersion: 'research-graph/v1',
        previousReleaseDigest: current?.release_digest ?? null,
        records: [
          {
            key: sourceId,
            kind: 'source',
            visibility: 'PUBLIC',
            content: { id: sourceId, kind: 'Artifact', visibility: 'PUBLIC_APPROVED' },
          },
          {
            key: editionId,
            kind: 'expression',
            visibility: 'PUBLIC',
            content: { id: editionId, kind: 'Edition', visibility: 'PUBLIC_APPROVED' },
          },
          {
            key: scopeId,
            kind: 'node',
            visibility: 'INTERNAL',
            content: {
              id: scopeId,
              kind: 'Concept',
              identity_class: 'ConceptIdentity',
              visibility: 'INTERNAL',
            },
          },
          {
            key: assertionId,
            kind: 'assertion',
            visibility: 'INTERNAL',
            content: {
              id: assertionId,
              kind: 'Assertion',
              schema_version: 1,
              lifecycle: 'candidate',
              created_at: '2026-10-17T00:00:00.000Z',
              updated_at: '2026-10-17T00:00:00.000Z',
              origin_ref: 'fixture://postgres-local-ai-suggestion/assertion',
              visibility: 'INTERNAL',
              content_revision: 1,
              claim: 'Synthetic PostgreSQL local AI authorization fixture.',
              polarity: 'positive',
              scope: { kind: 'research_context', reference_id: scopeId },
              context: { mode: 'analysis', reference_id: scopeId },
              epistemic_status: 'hypothesized',
              review_status: 'pending',
            },
          },
          {
            key: evidenceId,
            kind: 'evidence',
            visibility: 'INTERNAL',
            content: {
              id: evidenceId,
              kind: 'Evidence',
              visibility: 'INTERNAL',
              assertion_id: assertionId,
              direction: 'supporting',
              selector: {
                source_id: sourceId,
                edition_id: editionId,
                locator: 'Q7:46',
                content_sha256: snapshot.passage.sha256,
              },
            },
          },
        ],
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: 'research',
        releaseDigest: release.releaseDigest,
        expectedCurrentReleaseDigest: current?.release_digest ?? null,
        activatedAt: new Date().toISOString(),
      })
    );

    const firstScalar = Array.from(snapshot.passage.text)[0] ?? '';
    const selectedSpanSha256 = createHash('sha256').update(firstScalar, 'utf8').digest('hex');
    const validOutput = {
      status: 'generated',
      text: JSON.stringify({
        format: 'mw-local-ai-suggestion-envelope/v1',
        suggestions: [
          {
            id: suggestionId,
            status: 'unreviewed',
            visibility: 'INTERNAL',
            kind: 'term',
            text: firstScalar,
            citations: [
              {
                evidence_id: evidenceId,
                assertion_id: assertionId,
                selector: {
                  source_id: sourceId,
                  edition_id: editionId,
                  locator: 'Q7:46',
                  content_sha256: snapshot.passage.sha256,
                  range: { unit: 'unicode_scalar', start: 0, end: 1 },
                  selected_span_sha256: selectedSpanSha256,
                },
              },
            ],
          },
        ],
      }),
    } as const;

    const payload = { kind: 'term', evidence_ids: [evidenceId] };
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      payload,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const foreignCompany = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { 'x-test-auth': 'allowed', 'x-test-company': 'foreign' },
      payload,
    });
    expect(foreignCompany.statusCode).toBe(404);
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    const inactiveMembership = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { 'x-test-auth': 'allowed' },
      payload,
    });
    expect(inactiveMembership.statusCode).toBe(404);
    expect(generate).not.toHaveBeenCalled();
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: true });

    generate.mockResolvedValueOnce(validOutput);

    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { 'x-test-auth': 'allowed' },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data).toMatchObject({
      status: 'unreviewed',
      visibility: 'INTERNAL',
      candidates: [{ suggestionId, version: 1, idempotent: false }],
    });
    expect(generate).toHaveBeenCalledTimes(1);

    const rows = await db('knowledge_research_suggestion_versions').where({
      suggestion_id: suggestionId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      suggestion_id: suggestionId,
      recorded_by_id: userId,
      company_id: companyId,
      version: 1,
      visibility: 'INTERNAL',
      status: 'unreviewed',
    });

    generate.mockImplementationOnce(async () => {
      await db('company_memberships')
        .where({ user_id: userId, company_id: companyId })
        .update({ active: false });
      return validOutput;
    });
    const revokedDuringGeneration = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { 'x-test-auth': 'allowed' },
      payload,
    });
    expect([400, 404]).toContain(revokedDuringGeneration.statusCode);
    expect(
      await db('knowledge_research_suggestion_versions').where({ suggestion_id: suggestionId })
    ).toHaveLength(1);
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: true });
  }, 30000);

  it('pages newest INTERNAL candidate identities through the PostgreSQL list route', async () => {
    const snapshot = await readQuranPassageSnapshot({
      rootDirectory: resolveCorpusDataRoot(),
      editionId,
      locator: 'Q7:46',
      use: 'read_analyze',
    });
    const secondSuggestionId = 'mw:suggestion:postgres-local-ai-suggestion-002';
    const scalar = Array.from(snapshot.passage.text)[0] ?? '';
    generate.mockResolvedValueOnce({
      status: 'generated',
      text: JSON.stringify({
        format: 'mw-local-ai-suggestion-envelope/v1',
        suggestions: [
          {
            id: secondSuggestionId,
            status: 'unreviewed',
            visibility: 'INTERNAL',
            kind: 'term',
            text: scalar,
            citations: [
              {
                evidence_id: evidenceId,
                assertion_id: assertionId,
                selector: {
                  source_id: sourceId,
                  edition_id: editionId,
                  locator: 'Q7:46',
                  content_sha256: snapshot.passage.sha256,
                  range: { unit: 'unicode_scalar', start: 0, end: 1 },
                  selected_span_sha256: createHash('sha256').update(scalar, 'utf8').digest('hex'),
                },
              },
            ],
          },
        ],
      }),
    });
    const generated = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { 'x-test-auth': 'allowed' },
      payload: { kind: 'term', evidence_ids: [evidenceId] },
    });
    expect(generated.statusCode, generated.body).toBe(200);

    const page = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions',
      headers: { 'x-test-auth': 'allowed' },
    });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    const data = page.json().data as {
      visibility: string;
      status: string;
      truncated: boolean;
      items: {
        suggestionId: string;
        version: number;
        digest: string;
        visibility: string;
        status: string;
      }[];
    };
    expect([data.visibility, data.status]).toEqual(['INTERNAL', 'unreviewed']);
    const ids = data.items.map((item) => item.suggestionId);
    expect(ids).toContain(secondSuggestionId);
    expect(ids).toEqual([...ids].sort());
    expect(
      data.items.every(
        (item) =>
          item.visibility === 'INTERNAL' &&
          item.status === 'unreviewed' &&
          /^[a-f0-9]{64}$/u.test(item.digest) &&
          Number.isSafeInteger(item.version)
      )
    ).toBe(true);
    expect(JSON.stringify(page.json())).not.toContain('citation');
    const bounded = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions?limit=1',
      headers: { 'x-test-auth': 'allowed' },
    });
    expect(bounded.statusCode, bounded.body).toBe(200);
    expect(bounded.json().data.truncated).toBe(data.items.length > 1);
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/research/suggestions' });
    expect(unauthenticated.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions',
      headers: { 'x-test-auth': 'allowed', 'x-test-company': 'foreign' },
    });
    expect([foreign.statusCode, foreign.json()]).toEqual([
      403,
      { success: false, error: 'Suggestion list is unavailable' },
    ]);
    const unknownField = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions?limit=1&offset=1',
      headers: { 'x-test-auth': 'allowed' },
    });
    expect(unknownField.statusCode).toBe(400);
  }, 30000);
});
