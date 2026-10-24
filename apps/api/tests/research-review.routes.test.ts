import Fastify from 'fastify';
import { readQuranPassage, readTextualWitnessPassage } from '@moonwitness/corpus';
import { workflowRoutes } from '../src/routes/workflow.routes.js';
import { resolveCorpusDataRoot } from '../src/routes/corpus.routes.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import {
  activateResearchGraphRelease,
  createResearchGraphRelease,
  manifest as knowledgeManifest,
  readActiveResearchGraphRelease,
} from '@moonwitness/orm-knowledge';
import { ensureResearchReviewWorkflow } from '../src/research-review-workflow.js';
import { researchReviewRoutes } from '../src/routes/research-review.routes.js';

const subjectId = 'mw:assertion:api-review-001';
const scopeId = 'mw:concept:api-review-scope';
const webpSubjectId = 'mw:assertion:api-review-webp-001';
const webpScopeId = 'mw:concept:api-review-webp-scope';
const sourceId = 'mw:source:tanzil-quran-text';
const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const evidenceId = 'mw:evidence:api-review-quran';
const webpEvidenceId = 'mw:evidence:api-review-webp';
const webpSourceId = 'mw:source:ebible-webp-protestant';
const webpExpressionId = 'mw:expression:webp-protestant';
const webpEditionId = 'mw:edition:webp-protestant-2020-stable';
const releaseInput = (contentSha256: string, webpContentSha256: string) => ({
  corpusKey: 'research',
  schemaVersion: 'research-graph/v1',
  records: [
    {
      key: sourceId,
      kind: 'source' as const,
      visibility: 'PUBLIC' as const,
      content: { id: sourceId, kind: 'Artifact', visibility: 'PUBLIC_APPROVED' },
    },
    {
      key: editionId,
      kind: 'expression' as const,
      visibility: 'PUBLIC' as const,
      content: { id: editionId, kind: 'Edition', visibility: 'PUBLIC_APPROVED' },
    },
    {
      key: webpSourceId,
      kind: 'source' as const,
      visibility: 'PUBLIC' as const,
      content: { id: webpSourceId, kind: 'Artifact', visibility: 'PUBLIC_APPROVED' },
    },
    {
      key: webpExpressionId,
      kind: 'expression' as const,
      visibility: 'PUBLIC' as const,
      content: { id: webpExpressionId, kind: 'Expression', visibility: 'PUBLIC_APPROVED' },
    },
    {
      key: webpEditionId,
      kind: 'expression' as const,
      visibility: 'PUBLIC' as const,
      content: { id: webpEditionId, kind: 'Edition', visibility: 'PUBLIC_APPROVED' },
    },
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
      key: subjectId,
      kind: 'assertion' as const,
      visibility: 'INTERNAL' as const,
      content: {
        id: subjectId,
        kind: 'Assertion',
        schema_version: 1,
        lifecycle: 'candidate',
        created_at: '2026-10-16T00:00:00.000Z',
        updated_at: '2026-10-16T00:00:00.000Z',
        origin_ref: 'fixture://research/api-review/001',
        visibility: 'INTERNAL',
        content_revision: 1,
        claim: 'Synthetic API review fixture.',
        polarity: 'positive',
        scope: { kind: 'research_context', reference_id: scopeId },
        context: { mode: 'analysis', reference_id: scopeId },
        epistemic_status: 'hypothesized',
        review_status: 'pending',
      },
    },
    {
      key: webpScopeId,
      kind: 'node' as const,
      visibility: 'INTERNAL' as const,
      content: {
        id: webpScopeId,
        kind: 'Concept',
        identity_class: 'ConceptIdentity',
        visibility: 'INTERNAL',
      },
    },
    {
      key: webpSubjectId,
      kind: 'assertion' as const,
      visibility: 'INTERNAL' as const,
      content: {
        id: webpSubjectId,
        kind: 'Assertion',
        schema_version: 1,
        lifecycle: 'candidate',
        created_at: '2026-10-16T00:00:00.000Z',
        updated_at: '2026-10-16T00:00:00.000Z',
        origin_ref: 'fixture://research/api-review/webp-001',
        visibility: 'INTERNAL',
        content_revision: 1,
        claim: 'Synthetic review fixture scoped only to the approved WEBP Genesis 1:1 sample.',
        polarity: 'positive',
        scope: { kind: 'research_context', reference_id: webpScopeId },
        context: { mode: 'analysis', reference_id: webpScopeId },
        epistemic_status: 'hypothesized',
        review_status: 'pending',
      },
    },
    {
      key: evidenceId,
      kind: 'evidence' as const,
      visibility: 'INTERNAL' as const,
      content: {
        id: evidenceId,
        kind: 'Evidence',
        visibility: 'INTERNAL',
        assertion_id: subjectId,
        direction: 'supporting',
        selector: {
          source_id: sourceId,
          edition_id: editionId,
          locator: 'Q7:46',
          content_sha256: contentSha256,
        },
      },
    },
    {
      key: webpEvidenceId,
      kind: 'evidence' as const,
      visibility: 'INTERNAL' as const,
      content: {
        id: webpEvidenceId,
        kind: 'Evidence',
        visibility: 'INTERNAL',
        assertion_id: webpSubjectId,
        direction: 'supporting',
        selector: {
          source_id: webpSourceId,
          expression_id: webpExpressionId,
          edition_id: webpEditionId,
          locator: 'Genesis 1:1',
          content_sha256: webpContentSha256,
        },
      },
    },
  ],
});

describe('research review API', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let superadminId: number;
  let reviewerId: number;
  let companyId: number;

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
    await ensureResearchReviewWorkflow(db);
    superadminId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    companyId = Number((await db('companies').first('id'))?.id);
    await db('company_memberships')
      .insert({ user_id: superadminId, company_id: companyId, is_default: true })
      .onConflict(['user_id', 'company_id'])
      .ignore();
    await db('knowledge_research_actor_identities').insert({
      user_id: superadminId,
      canonical_user_id: 'mw:user:api-reviewer',
    });
    await db('partners').insert({
      name: 'Synthetic API reviewer',
      company_id: companyId,
      is_company: false,
    });
    const reviewerPartnerId = Number(
      (await db('partners').where({ name: 'Synthetic API reviewer' }).first('id'))?.id
    );
    await db('users').insert({
      login: 'api-reviewer',
      partner_id: reviewerPartnerId,
      role: 'user',
    });
    reviewerId = Number((await db('users').where({ login: 'api-reviewer' }).first('id'))?.id);
    await db('company_memberships').insert({
      user_id: reviewerId,
      company_id: companyId,
      is_default: true,
    });
    await db('knowledge_research_actor_identities').insert({
      user_id: reviewerId,
      canonical_user_id: 'mw:user:api-review-decision-maker',
    });
    const quran = await readQuranPassage({
      rootDirectory: resolveCorpusDataRoot(),
      editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      use: 'read_analyze',
    });
    const webp = await readTextualWitnessPassage({
      rootDirectory: resolveCorpusDataRoot(),
      expressionId: webpExpressionId,
      editionId: webpEditionId,
      locator: 'Genesis 1:1',
    });
    expect(webp.sha256).toBe('ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1');
    const release = await db.transaction((trx) =>
      createResearchGraphRelease(trx, releaseInput(quran.sha256, webp.sha256))
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: 'research',
        releaseDigest: release.releaseDigest,
        expectedCurrentReleaseDigest: null,
        activatedAt: '2026-10-16T00:00:01.000Z',
      })
    );

    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request) => {
      if (
        request.headers['x-test-auth'] === 'superadmin' ||
        request.headers['x-test-auth'] === 'user'
      ) {
        const isSuperadmin = request.headers['x-test-auth'] === 'superadmin';
        request.auth = {
          userId: isSuperadmin ? superadminId : reviewerId,
          role: isSuperadmin ? 'superadmin' : 'user',
          companyId,
          groupPermissions: [],
        };
      }
    });
    await app.register(researchReviewRoutes);
    await app.register(workflowRoutes);
  });

  afterEach(async () => {
    if (app) await app.close();
    await db.destroy();
  });

  it('authenticates review starts and binds an idempotent workflow to an active subject revision', async () => {
    const body = { subject_id: subjectId, idempotency_key: 'api-review-start-0001' };
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/research/reviews',
      payload: body,
    });
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/research/reviews',
        headers: { 'x-test-auth': 'superadmin' },
        payload: body,
      });
    const first = await send();
    const replay = await send();
    expect(anonymous.statusCode).toBe(401);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(first.json()).toMatchObject({
      success: true,
      data: { subject_id: subjectId, subject_revision: 1, revision: 0, state: 'submitted' },
    });
    expect(await db('workflow_instances')).toHaveLength(1);
    expect(await db('workflow_events')).toHaveLength(1);
  });

  it('keeps the approved Quran and WEBP samples on separate subjects without a relation claim', async () => {
    const release = await db.transaction((trx) => readActiveResearchGraphRelease(trx, 'research'));
    expect(release).not.toBeNull();
    const quranEvidence = release!.records.find((record) => record.key === evidenceId);
    const webpEvidence = release!.records.find((record) => record.key === webpEvidenceId);
    expect((quranEvidence?.content as Record<string, unknown>).assertion_id).toBe(subjectId);
    expect((webpEvidence?.content as Record<string, unknown>).assertion_id).toBe(webpSubjectId);
    expect((quranEvidence?.content as Record<string, unknown>).assertion_id).not.toBe(
      (webpEvidence?.content as Record<string, unknown>).assertion_id
    );
    expect(release!.records.filter((record) => record.kind === 'relation')).toHaveLength(0);
  });

  it('fails closed when a newer enabled review workflow version changes the API contract', async () => {
    await db('workflow_definitions').insert({
      code: 'research.review',
      version: 2,
      name: 'Unsupported research review version',
      config: JSON.stringify({
        startState: 'draft',
        startRoles: ['user'],
        timeoutMinutes: 10080,
        resourceModels: ['knowledge.research_graph_record'],
        transitions: [],
      }),
      enabled: true,
    });
    await expect(ensureResearchReviewWorkflow(db)).rejects.toThrow(
      'The selected research.review workflow definition differs from the API contract'
    );
  });

  it('rejects unknown, restricted-shape, and extra-field starts without creating workflow rows', async () => {
    const headers = { 'x-test-auth': 'superadmin' };
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/research/reviews',
      headers,
      payload: { subject_id: 'mw:assertion:missing', idempotency_key: 'api-review-missing-01' },
    });
    const extra = await app.inject({
      method: 'POST',
      url: '/api/research/reviews',
      headers,
      payload: { subject_id: subjectId, idempotency_key: 'api-review-extra-001', resource_id: 1 },
    });
    expect(unknown.statusCode).toBe(403);
    expect(extra.statusCode).toBe(400);
    expect(await db('workflow_instances')).toHaveLength(0);
  });

  it('does not disclose or start review for a confidential subject', async () => {
    const current = await db.transaction((trx) => readActiveResearchGraphRelease(trx, 'research'));
    expect(current).not.toBeNull();
    const next = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        corpusKey: 'research',
        schemaVersion: 'research-graph/v1',
        previousReleaseDigest: current!.releaseDigest,
        records: current!.records.map((record) =>
          record.key === subjectId
            ? {
                ...record,
                content: {
                  ...(record.content as Record<string, unknown>),
                  visibility: 'CONFIDENTIAL',
                  claim: 'This hidden claim must not be returned by the API.',
                },
              }
            : record
        ),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: 'research',
        releaseDigest: next.releaseDigest,
        expectedCurrentReleaseDigest: current!.releaseDigest,
        activatedAt: '2026-10-16T00:00:02.000Z',
      })
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/reviews',
      headers: { 'x-test-auth': 'superadmin' },
      payload: { subject_id: subjectId, idempotency_key: 'api-review-hidden-0001' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('hidden claim');
    expect(await db('workflow_instances')).toHaveLength(0);
    expect(await db('workflow_events')).toHaveLength(0);
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('returns bounded verified history through the dedicated endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/research/reviews/${subjectId}/history`,
      headers: { 'x-test-auth': 'superadmin' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      success: true,
      data: { events: [], truncated: false, nextCursor: null },
    });
  });

  it('reviews the approved WEBP sample as an independent INTERNAL subject', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/research/reviews',
      headers: { 'x-test-auth': 'superadmin' },
      payload: { subject_id: webpSubjectId, idempotency_key: 'api-review-webp-start-01' },
    });
    expect(start.statusCode, start.body).toBe(201);

    const decision = await app.inject({
      method: 'POST',
      url: `/api/research/reviews/${start.json().data.id}/decision`,
      headers: { 'x-test-auth': 'user' },
      payload: {
        action: 'approve',
        expected_workflow_revision: 0,
        subject_id: webpSubjectId,
        expected_subject_revision: 1,
        evidence_ids: [webpEvidenceId],
        idempotency_key: 'api-review-webp-decision-01',
      },
    });
    expect(decision.statusCode, decision.body).toBe(200);

    const stored = await db('knowledge_research_review_events')
      .where({ subject_id: webpSubjectId })
      .first('event_json');
    expect(JSON.parse(String(stored?.event_json))).toMatchObject({
      subject_id: webpSubjectId,
      evidence_ids: [webpEvidenceId],
      visibility: 'INTERNAL',
      reviewer_role: 'user',
    });
    const history = await app.inject({
      method: 'GET',
      url: `/api/research/reviews/${webpSubjectId}/history`,
      headers: { 'x-test-auth': 'user' },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().data.events).toMatchObject([
      { subject_id: webpSubjectId, evidence_ids: [webpEvidenceId], visibility: 'INTERNAL' },
    ]);
    expect(history.body).not.toContain('In the beginning, God created the heavens and the earth.');
  });

  it('records a decision atomically and blocks generic workflow paths for research reviews', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/research/reviews',
      headers: { 'x-test-auth': 'superadmin' },
      payload: { subject_id: subjectId, idempotency_key: 'api-review-decision-start-01' },
    });
    expect(started.statusCode, started.body).toBe(201);
    const instanceId = started.json().data.id as number;
    const genericStart = await app.inject({
      method: 'POST',
      url: '/workflows/instances',
      headers: { 'x-test-auth': 'superadmin' },
      payload: {
        code: 'research.review',
        resource_model: 'knowledge.research_graph_record',
        resource_id: 1,
        idempotency_key: 'generic-review-start-001',
      },
    });
    const genericAction = await app.inject({
      method: 'POST',
      url: `/workflows/instances/${instanceId}/actions`,
      headers: { 'x-test-auth': 'user' },
      payload: {
        action: 'approve',
        expected_revision: 0,
        idempotency_key: 'generic-review-action-01',
      },
    });
    expect(genericStart.statusCode).toBe(404);
    expect(genericAction.statusCode).toBe(404);
    expect(
      await db('workflow_instances').where({ id: instanceId }).first('revision')
    ).toMatchObject({ revision: 0 });

    const decision = await app.inject({
      method: 'POST',
      url: `/api/research/reviews/${instanceId}/decision`,
      headers: { 'x-test-auth': 'user' },
      payload: {
        action: 'approve',
        expected_workflow_revision: 0,
        subject_id: subjectId,
        expected_subject_revision: 1,
        evidence_ids: [evidenceId],
        idempotency_key: 'api-review-decision-0001',
      },
    });
    expect(decision.statusCode, decision.body).toBe(200);
    expect(decision.headers['cache-control']).toBe('private, no-store');
    expect(
      await db('workflow_instances').where({ id: instanceId }).first('revision')
    ).toMatchObject({ revision: 1 });
    expect(await db('knowledge_research_review_events')).toHaveLength(1);
    const history = await app.inject({
      method: 'GET',
      url: `/api/research/reviews/${subjectId}/history`,
      headers: { 'x-test-auth': 'user' },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().data.events).toHaveLength(1);

    const activeRelease = await db.transaction((trx) =>
      readActiveResearchGraphRelease(trx, 'research')
    );
    expect(activeRelease).not.toBeNull();
    const revisedRelease = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        corpusKey: 'research',
        schemaVersion: 'research-graph/v1',
        previousReleaseDigest: activeRelease!.releaseDigest,
        records: activeRelease!.records.map((record) =>
          record.key === subjectId
            ? {
                ...record,
                content: {
                  ...(record.content as Record<string, unknown>),
                  content_revision: 2,
                  updated_at: '2026-10-16T00:00:03.000Z',
                },
              }
            : record
        ),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey: 'research',
        releaseDigest: revisedRelease.releaseDigest,
        expectedCurrentReleaseDigest: activeRelease!.releaseDigest,
        activatedAt: '2026-10-16T00:00:03.000Z',
      })
    );
    const secondStarted = await app.inject({
      method: 'POST',
      url: '/api/research/reviews',
      headers: { 'x-test-auth': 'superadmin' },
      payload: { subject_id: subjectId, idempotency_key: 'api-review-decision-start-02' },
    });
    expect(secondStarted.statusCode, secondStarted.body).toBe(201);
    const secondInstanceId = secondStarted.json().data.id as number;
    const secondDecision = await app.inject({
      method: 'POST',
      url: `/api/research/reviews/${secondInstanceId}/decision`,
      headers: { 'x-test-auth': 'user' },
      payload: {
        action: 'reject',
        expected_workflow_revision: 0,
        subject_id: subjectId,
        expected_subject_revision: 2,
        evidence_ids: [evidenceId],
        idempotency_key: 'api-review-decision-0002',
      },
    });
    expect(secondDecision.statusCode, secondDecision.body).toBe(200);

    const firstPage = await app.inject({
      method: 'GET',
      url: `/api/research/reviews/${subjectId}/history?limit=1`,
      headers: { 'x-test-auth': 'user' },
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json().data).toMatchObject({
      events: [{ workflow_instance_id: secondInstanceId }],
      truncated: true,
      nextCursor: { workflowInstanceId: secondInstanceId, workflowEventSequence: 1 },
    });
    const nextCursor = firstPage.json().data.nextCursor;
    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/research/reviews/${subjectId}/history?limit=1&before_workflow_instance_id=${nextCursor.workflowInstanceId}&before_workflow_event_sequence=${nextCursor.workflowEventSequence}`,
      headers: { 'x-test-auth': 'user' },
    });
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json().data).toMatchObject({
      events: [{ workflow_instance_id: instanceId }],
      truncated: false,
      nextCursor: null,
    });
  });
});
