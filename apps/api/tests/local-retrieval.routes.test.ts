import Fastify from 'fastify';
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localRetrievalRoutes } from '../src/routes/local-retrieval.routes.js';
import { resolveCorpusDataRoot } from '../src/routes/corpus.routes.js';

const sourceId = 'mw:source:tanzil-quran-text';
const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const scopeId = 'mw:concept:local-retrieval-scope';
const assertionId = 'mw:assertion:local-retrieval-001';
const evidenceId = 'mw:evidence:local-retrieval-001';
const corpusRootDirectory = resolveCorpusDataRoot();

describe('authenticated local Quran passage retrieval route', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let userId: number;
  let ordinaryUserId: number;
  let companyId: number;
  let otherCompanyId: number;

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
    await installAddons(db, [
      baseManifest,
      jobsManifest,
      notificationManifest,
      workflowManifest,
      knowledgeManifest,
    ]);
    userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    companyId = Number((await db('companies').first('id'))?.id);
    await db('company_memberships')
      .insert({ user_id: userId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    const partnerId = Number(
      (
        await db('partners')
          .insert({
            name: 'Synthetic local retrieval member',
            company_id: companyId,
            is_company: false,
          })
          .returning('id')
      )[0]?.id
    );
    ordinaryUserId = Number(
      (
        await db('users')
          .insert({ login: 'local-retrieval-member', partner_id: partnerId, role: 'user' })
          .returning('id')
      )[0]?.id
    );
    await db('company_memberships').insert({
      user_id: ordinaryUserId,
      company_id: companyId,
      is_default: true,
    });
    otherCompanyId = Number(
      (
        await db('companies')
          .insert({ name: 'Synthetic Foreign Retrieval Company', timezone: 'UTC' })
          .returning('id')
      )[0]?.id
    );
    await publishEvidence();

    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request) => {
      const role = request.headers['x-test-role'];
      if (role === 'user' || role === 'superadmin') {
        request.auth = {
          userId: role === 'user' ? ordinaryUserId : userId,
          role,
          companyId: request.headers['x-test-company'] === 'foreign' ? otherCompanyId : companyId,
          groupPermissions: [],
        };
      }
    });
    await app.register(localRetrievalRoutes);
  });

  afterEach(async () => {
    if (app) await app.close();
    await db.destroy();
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
              origin_ref: 'fixture://local-retrieval/assertion',
              visibility: assertionContentVisibility,
              content_revision: 1,
              claim: 'Synthetic local retrieval authorization fixture.',
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

  it('returns only the approved citation-bound chunk and source span for active authorized evidence', async () => {
    const snapshot = await readQuranPassageSnapshot({
      rootDirectory: corpusRootDirectory,
      editionId,
      locator: 'Q7:46',
      use: 'read_analyze',
    });
    const firstScalar = Array.from(snapshot.passage.text)[0] ?? '';
    const firstScalarByteLength = Buffer.byteLength(firstScalar, 'utf8');
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-role': 'superadmin' },
      payload: { evidence_id: evidenceId, byte_start: 0, byte_end: firstScalarByteLength },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data).toMatchObject({
      chunk: firstScalar,
      citation: {
        sourceId,
        editionId,
        locator: 'Q7:46',
        sourceSha256: snapshot.passage.sha256,
        sourceManifestPath: 'corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json',
        attribution: snapshot.passage.attribution,
      },
      span: { basis: 'resolved_passage_text', byteStart: 0, byteEnd: firstScalarByteLength },
    });
    expect(Object.keys(response.json().data).sort()).toEqual(['chunk', 'citation', 'span']);
    expect(response.body).not.toContain('reviewStatus');
  });

  it('allows an ordinary active company member to retrieve the approved passage from internal evidence', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-role': 'user' },
      payload: { evidence_id: evidenceId },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.citation.locator).toBe('Q7:46');
  });

  it('denies missing authentication and an active user in an unassigned company', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      payload: { evidence_id: evidenceId },
    });
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-role': 'superadmin', 'x-test-company': 'foreign' },
      payload: { evidence_id: evidenceId },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(anonymousError());
  });

  it('denies an inactive company membership without revealing the source', async () => {
    const snapshot = await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    expect(snapshot).toBe(1);
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-role': 'superadmin' },
      payload: { evidence_id: evidenceId },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(anonymousError());
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: true });
    await db('users').where({ id: userId }).update({ active: false });
    const inactiveUser = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-role': 'superadmin' },
      payload: { evidence_id: evidenceId },
    });
    expect(inactiveUser.statusCode).toBe(404);
    expect(inactiveUser.body).toBe(anonymousError());
  });

  it('denies restricted canonical evidence with the same generic response', async () => {
    await publishEvidence({ assertionVisibility: 'RESTRICTED' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-role': 'superadmin' },
      payload: { evidence_id: evidenceId },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(anonymousError());
  });

  it('denies a restricted Evidence record with the same generic response', async () => {
    await publishEvidence({ evidenceVisibility: 'RESTRICTED' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-role': 'superadmin' },
      payload: { evidence_id: evidenceId },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(anonymousError());
  });

  it('denies CHILD_SENSITIVE assertion and Evidence content with the same generic response', async () => {
    for (const visibility of ['assertionContentVisibility', 'evidenceContentVisibility'] as const) {
      await publishEvidence({ [visibility]: 'CHILD_SENSITIVE' });
      const response = await app.inject({
        method: 'POST',
        url: '/api/research/retrieval/chunk',
        headers: { 'x-test-role': 'superadmin' },
        payload: { evidence_id: evidenceId },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(anonymousError());
      expect(response.body).not.toContain('CHILD_SENSITIVE');
    }
  });

  it('denies a canonical evidence selector whose source digest mismatches the pinned passage', async () => {
    await publishEvidence({ sourceSha256: '0'.repeat(64) });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/retrieval/chunk',
      headers: { 'x-test-role': 'superadmin' },
      payload: { evidence_id: evidenceId },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(anonymousError());
  });
});

function anonymousError(): string {
  return JSON.stringify({ success: false, error: 'Evidence is unavailable' });
}
