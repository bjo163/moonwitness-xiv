import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localRetrievalRoutes } from '../src/routes/local-retrieval.routes.js';
import { resolveCorpusDataRoot } from '../src/routes/corpus.routes.js';

const connectionString = process.env.POSTGRES_TEST_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === 'true' && !connectionString) {
  throw new Error('POSTGRES_TEST_URL is required when REQUIRE_POSTGRES_TESTS=true');
}
const postgresDescribe = connectionString ? describe : describe.skip;

const sourceId = 'mw:source:tanzil-quran-text';
const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const scopeId = 'mw:concept:postgres-local-retrieval-scope';
const assertionId = 'mw:assertion:postgres-local-retrieval-001';
const evidenceId = 'mw:evidence:postgres-local-retrieval-001';
const corpusRootDirectory = resolveCorpusDataRoot();
const genericUnavailable = JSON.stringify({ success: false, error: 'Evidence is unavailable' });

postgresDescribe('local retrieval PostgreSQL integration', () => {
  const schema = `mw_retrieval_${randomUUID().replaceAll('-', '')}`;
  let adminDb: Knex;
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let userId: number;
  let companyId: number;
  let foreignCompanyId: number;

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
    if (!userId || !companyId) throw new Error('Synthetic base accounts are unavailable');
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    foreignCompanyId = Number(
      (
        await db('companies')
          .insert({ name: 'Synthetic Unassigned Retrieval Company', timezone: 'UTC' })
          .returning('id')
      )[0]?.id
    );

    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request: FastifyRequest) => {
      if (request.headers['x-test-auth'] !== 'allowed') return;
      request.auth = {
        userId,
        role: 'superadmin',
        companyId: request.headers['x-test-company'] === 'foreign' ? foreignCompanyId : companyId,
        groupPermissions: [],
      };
    });
    await app.register(localRetrievalRoutes);
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    if (adminDb) {
      await adminDb.raw('drop schema if exists ?? cascade', [schema]);
      await adminDb.destroy();
    }
  });

  async function publishEvidence(input?: {
    assertionVisibility?: 'INTERNAL' | 'RESTRICTED';
    assertionContentVisibility?: 'INTERNAL' | 'RESTRICTED' | 'CHILD_SENSITIVE';
    evidenceVisibility?: 'INTERNAL' | 'RESTRICTED';
    evidenceContentVisibility?: 'INTERNAL' | 'RESTRICTED' | 'CHILD_SENSITIVE';
    sourceSha256?: string;
  }) {
    const snapshot = await readQuranPassageSnapshot({
      rootDirectory: corpusRootDirectory,
      editionId,
      locator: 'Q7:46',
      use: 'read_analyze',
    });
    const assertionVisibility = input?.assertionVisibility ?? 'INTERNAL';
    const assertionContentVisibility = input?.assertionContentVisibility ?? assertionVisibility;
    const evidenceVisibility = input?.evidenceVisibility ?? 'INTERNAL';
    const evidenceContentVisibility = input?.evidenceContentVisibility ?? evidenceVisibility;
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
            visibility: assertionVisibility,
            content: {
              id: assertionId,
              kind: 'Assertion',
              schema_version: 1,
              lifecycle: 'candidate',
              created_at: '2026-10-17T00:00:00.000Z',
              updated_at: '2026-10-17T00:00:00.000Z',
              origin_ref: 'fixture://postgres-local-retrieval/assertion',
              visibility: assertionContentVisibility,
              content_revision: 1,
              claim: 'Synthetic PostgreSQL retrieval authorization fixture.',
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
            visibility: evidenceVisibility,
            content: {
              id: evidenceId,
              kind: 'Evidence',
              visibility: evidenceContentVisibility,
              assertion_id: assertionId,
              direction: 'supporting',
              selector: {
                source_id: sourceId,
                edition_id: editionId,
                locator: 'Q7:46',
                content_sha256: input?.sourceSha256 ?? snapshot.passage.sha256,
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
    return snapshot;
  }

  async function requestChunk(headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-auth': 'allowed', ...headers },
      payload: { evidence_id: evidenceId },
    });
  }

  it('returns the approved Q7:46 citation and exact requested span for active evidence', async () => {
    const snapshot = await publishEvidence();
    const scalar = Array.from(snapshot.passage.text)[0] ?? '';
    const byteEnd = Buffer.byteLength(scalar, 'utf8');
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-auth': 'allowed' },
      payload: { evidence_id: evidenceId, byte_start: 0, byte_end: byteEnd },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data).toMatchObject({
      chunk: scalar,
      citation: {
        sourceId,
        editionId,
        locator: 'Q7:46',
        sourceSha256: snapshot.passage.sha256,
        sourceManifestPath: 'corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json',
        attribution: snapshot.passage.attribution,
      },
      span: { basis: 'resolved_passage_text', byteStart: 0, byteEnd },
    });
    expect(Object.keys(response.json().data).sort()).toEqual(['chunk', 'citation', 'span']);
  });

  it('returns a generic denial for restricted canonical evidence', async () => {
    await publishEvidence({ evidenceVisibility: 'RESTRICTED' });
    const response = await requestChunk();
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(genericUnavailable);
    expect(response.body).not.toContain('Synthetic');
    expect(response.body).not.toContain('Q7:46');
  });

  it('returns a generic denial for CHILD_SENSITIVE assertion and Evidence content', async () => {
    for (const visibility of ['assertionContentVisibility', 'evidenceContentVisibility'] as const) {
      await publishEvidence({ [visibility]: 'CHILD_SENSITIVE' });
      const response = await requestChunk();
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(genericUnavailable);
      expect(response.body).not.toContain('CHILD_SENSITIVE');
      expect(response.body).not.toContain('Q7:46');
    }
  });

  it('returns a generic denial for an active user in a foreign unassigned company', async () => {
    await publishEvidence();
    const response = await requestChunk({ 'x-test-company': 'foreign' });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(genericUnavailable);
    expect(response.body).not.toContain('Q7:46');
  });

  it('returns a generic denial when the authenticated user company membership is inactive', async () => {
    await publishEvidence();
    const updated = await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    expect(updated).toBe(1);
    try {
      const response = await requestChunk();
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(genericUnavailable);
      expect(response.body).not.toContain('Q7:46');
    } finally {
      await db('company_memberships')
        .where({ user_id: userId, company_id: companyId })
        .update({ active: true });
    }
  });
});
