import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  createLocalAiRuntime,
  readLocalAiConfig,
  type LocalAiFetch,
  type LocalAiResult,
} from '@moonwitness/local-ai';
import { readQuranPassageSnapshot, readTextualWitnessPassageSnapshot } from '@moonwitness/corpus';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import { manifest as knowledgeManifest } from '@moonwitness/orm-knowledge';
import {
  activateResearchGraphRelease,
  createResearchGraphRelease,
} from '@moonwitness/orm-knowledge';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localAiSuggestionRoutes } from '../src/routes/local-ai-suggestion.routes.js';
import { resolveCorpusDataRoot } from '../src/routes/corpus.routes.js';

const sourceId = 'mw:source:tanzil-quran-text';
const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const assertionId = 'mw:assertion:local-ai-suggestion-001';
const evidenceId = 'mw:evidence:local-ai-suggestion-001';
const scopeId = 'mw:concept:local-ai-suggestion-scope';

describe('local AI suggestion generation route authorization boundary', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let userId: number;
  let companyId: number;
  const generate = vi.fn(async () => ({ status: 'generated' as const, text: '{}' }));

  beforeEach(async () => {
    generate.mockClear();
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
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
    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.decorate('localAi', { generate });
    app.addHook('onRequest', async (request) => {
      if (request.headers.authorization === 'Bearer test')
        request.auth = {
          userId,
          companyId: request.headers['x-test-company'] === 'foreign' ? companyId + 999 : companyId,
          role: 'superadmin',
          groupPermissions: [],
        };
    });
    await app.register(rateLimit, { global: false });
    await app.register(localAiSuggestionRoutes);
  });

  async function publishEvidence(
    options: { webp?: boolean; assertion?: string; evidence?: string } = {}
  ) {
    const selectedSourceId = options.webp ? 'mw:source:ebible-webp-protestant' : sourceId;
    const selectedEditionId = options.webp ? 'mw:edition:webp-protestant-2020-stable' : editionId;
    const selectedLocator = options.webp ? 'Genesis 1:1' : 'Q7:46';
    const selectedAssertionId = options.assertion ?? assertionId;
    const selectedEvidenceId = options.evidence ?? evidenceId;
    const snapshot = options.webp
      ? await readTextualWitnessPassageSnapshot({
          rootDirectory: resolveCorpusDataRoot(),
          expressionId: 'mw:expression:webp-protestant',
          editionId: selectedEditionId,
          locator: selectedLocator,
          use: 'read_analyze',
        })
      : await readQuranPassageSnapshot({
          rootDirectory: resolveCorpusDataRoot(),
          editionId: selectedEditionId,
          locator: selectedLocator,
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
            key: selectedSourceId,
            kind: 'source',
            visibility: 'PUBLIC',
            content: { id: selectedSourceId, kind: 'Artifact', visibility: 'PUBLIC_APPROVED' },
          },
          {
            key: selectedEditionId,
            kind: 'expression',
            visibility: 'PUBLIC',
            content: { id: selectedEditionId, kind: 'Edition', visibility: 'PUBLIC_APPROVED' },
          },
          ...(options.webp
            ? [
                {
                  key: 'mw:expression:webp-protestant',
                  kind: 'expression' as const,
                  visibility: 'PUBLIC' as const,
                  content: {
                    id: 'mw:expression:webp-protestant',
                    kind: 'Expression',
                    visibility: 'PUBLIC_APPROVED',
                  },
                },
              ]
            : []),
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
            key: selectedAssertionId,
            kind: 'assertion',
            visibility: 'INTERNAL',
            content: {
              id: selectedAssertionId,
              kind: 'Assertion',
              schema_version: 1,
              lifecycle: 'candidate',
              created_at: '2026-10-17T00:00:00.000Z',
              updated_at: '2026-10-17T00:00:00.000Z',
              origin_ref: 'fixture://local-ai-suggestion/assertion',
              visibility: 'INTERNAL',
              content_revision: 1,
              claim: 'Synthetic local AI suggestion authorization fixture.',
              polarity: 'positive',
              scope: { kind: 'research_context', reference_id: scopeId },
              context: { mode: 'analysis', reference_id: scopeId },
              epistemic_status: 'hypothesized',
              review_status: 'pending',
            },
          },
          {
            key: selectedEvidenceId,
            kind: 'evidence',
            visibility: 'INTERNAL',
            content: {
              id: selectedEvidenceId,
              kind: 'Evidence',
              visibility: 'INTERNAL',
              assertion_id: selectedAssertionId,
              direction: 'supporting',
              selector: {
                ...(options.webp ? { expression_id: 'mw:expression:webp-protestant' } : {}),
                source_id: selectedSourceId,
                edition_id: selectedEditionId,
                locator: selectedLocator,
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
    return snapshot;
  }

  afterEach(async () => {
    if (app) await app.close();
    await db.destroy();
  });

  it('requires an authenticated active company context before generation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      payload: { kind: 'term', evidence_ids: ['mw:evidence:pilot'] },
    });
    expect(response.statusCode).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rate-limits generation requests before invoking the local runtime', async () => {
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/api/research/suggestions/generate',
          payload: { kind: 'term', evidence_ids: [evidenceId] },
        })
      );
    }
    expect(responses.slice(0, 10).every((response) => response.statusCode === 401)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects malformed requests before generation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: ['mw:evidence:pilot'], company_id: companyId },
    });
    expect(response.statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not call the model when active tenant evidence is unavailable', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: ['mw:evidence:pilot'] },
    });
    expect(response.statusCode).toBe(404);
    expect(generate).not.toHaveBeenCalled();
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(0);
  });

  it('does not allow evidence to be reused under a different company context', async () => {
    await publishEvidence();
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
      payload: { kind: 'term', evidence_ids: [evidenceId] },
    });
    expect(response.statusCode).toBe(404);
    expect(generate).not.toHaveBeenCalled();
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(0);
  });

  it('validates and stores a local extractive candidate for active tenant evidence', async () => {
    const snapshot = await publishEvidence();
    const firstScalar = Array.from(snapshot.passage.text)[0] ?? '';
    const spanDigest = createHash('sha256').update(firstScalar, 'utf8').digest('hex');
    generate.mockResolvedValueOnce({
      status: 'generated',
      text: JSON.stringify({
        format: 'mw-local-ai-suggestion-envelope/v1',
        suggestions: [
          {
            id: 'mw:suggestion:local-ai-suggestion-001',
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
                  selected_span_sha256: spanDigest,
                },
              },
            ],
          },
        ],
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: [evidenceId] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data).toMatchObject({
      status: 'unreviewed',
      visibility: 'INTERNAL',
      candidates: [{ version: 1, idempotent: false }],
    });
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(1);
    const read = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions/mw:suggestion:local-ai-suggestion-001?version=1',
      headers: { authorization: 'Bearer test' },
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.json().data).toMatchObject({
      suggestionId: 'mw:suggestion:local-ai-suggestion-001',
      version: 1,
      visibility: 'INTERNAL',
      status: 'unreviewed',
      suggestion: { text: firstScalar },
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions/mw:suggestion:local-ai-suggestion-001',
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ success: false, error: 'Suggestion is unavailable' });
  });

  it('requires authentication and a canonical positive version for candidate reads', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions/mw:suggestion:missing',
    });
    expect(unauthenticated.statusCode).toBe(401);
    const invalidVersion = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions/mw:suggestion:missing?version=01',
      headers: { authorization: 'Bearer test' },
    });
    expect(invalidVersion.statusCode).toBe(400);
  });

  it('supports only the separately approved local WEBP Genesis 1:1 sample', async () => {
    const webpAssertion = 'mw:assertion:local-ai-webp-001';
    const webpEvidence = 'mw:evidence:local-ai-webp-001';
    const snapshot = await publishEvidence({
      webp: true,
      assertion: webpAssertion,
      evidence: webpEvidence,
    });
    const firstScalar = Array.from(snapshot.passage.text)[0] ?? '';
    generate.mockResolvedValueOnce({
      status: 'generated',
      text: JSON.stringify({
        format: 'mw-local-ai-suggestion-envelope/v1',
        suggestions: [
          {
            id: 'mw:suggestion:local-ai-webp-001',
            status: 'unreviewed',
            visibility: 'INTERNAL',
            kind: 'term',
            text: firstScalar,
            citations: [
              {
                evidence_id: webpEvidence,
                assertion_id: webpAssertion,
                selector: {
                  source_id: 'mw:source:ebible-webp-protestant',
                  edition_id: 'mw:edition:webp-protestant-2020-stable',
                  locator: 'Genesis 1:1',
                  content_sha256: snapshot.passage.sha256,
                  range: { unit: 'unicode_scalar', start: 0, end: 1 },
                  selected_span_sha256: createHash('sha256')
                    .update(firstScalar, 'utf8')
                    .digest('hex'),
                },
              },
            ],
          },
        ],
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: [webpEvidence] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ status: 'unreviewed', visibility: 'INTERNAL' });
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(1);
  });

  it('rechecks tenant membership after provider await and stores nothing when access is revoked', async () => {
    const snapshot = await publishEvidence();
    const firstScalar = Array.from(snapshot.passage.text)[0] ?? '';
    const candidate = JSON.stringify({
      format: 'mw-local-ai-suggestion-envelope/v1',
      suggestions: [
        {
          id: 'mw:suggestion:revoked-during-generation',
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
                selected_span_sha256: createHash('sha256')
                  .update(firstScalar, 'utf8')
                  .digest('hex'),
              },
            },
          ],
        },
      ],
    });
    generate.mockImplementationOnce(async () => {
      await db('company_memberships')
        .where({ user_id: userId, company_id: companyId })
        .update({ active: false });
      return { status: 'generated', text: candidate };
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: [evidenceId] },
    });
    expect(response.statusCode).toBe(400);
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(0);
  });

  it('rejects a model citation that substitutes an out-of-scope source identity', async () => {
    const snapshot = await publishEvidence();
    const firstScalar = Array.from(snapshot.passage.text)[0] ?? '';
    generate.mockResolvedValueOnce({
      status: 'generated',
      text: JSON.stringify({
        format: 'mw-local-ai-suggestion-envelope/v1',
        suggestions: [
          {
            id: 'mw:suggestion:out-of-scope-source',
            status: 'unreviewed',
            visibility: 'INTERNAL',
            kind: 'term',
            text: firstScalar,
            citations: [
              {
                evidence_id: evidenceId,
                assertion_id: assertionId,
                selector: {
                  source_id: 'mw:source:unapproved-external',
                  edition_id: 'mw:edition:unapproved-external',
                  locator: 'External 1:1',
                  content_sha256: snapshot.passage.sha256,
                  range: { unit: 'unicode_scalar', start: 0, end: 1 },
                  selected_span_sha256: createHash('sha256')
                    .update(firstScalar, 'utf8')
                    .digest('hex'),
                },
              },
            ],
          },
        ],
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: [evidenceId] },
    });
    expect(response.statusCode).toBe(400);
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(0);
  });

  it('rejects tool and publication fields from a syntactically valid model envelope before storage', async () => {
    const snapshot = await publishEvidence();
    const firstScalar = Array.from(snapshot.passage.text)[0] ?? '';
    const selectedSpanSha256 = createHash('sha256').update(firstScalar, 'utf8').digest('hex');
    generate.mockResolvedValueOnce({
      status: 'generated',
      text: JSON.stringify({
        format: 'mw-local-ai-suggestion-envelope/v1',
        execute_shell: 'echo forbidden',
        publish: true,
        suggestions: [
          {
            id: 'mw:suggestion:high-risk-action-payload',
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
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: [evidenceId] },
    });

    expect(response.statusCode).toBe(400);
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(0);
  });

  async function storeTermCandidate(
    suggestionId: string,
    scalarIndex: number,
    snapshot: Awaited<ReturnType<typeof publishEvidence>>
  ) {
    const scalar = Array.from(snapshot.passage.text)[scalarIndex] ?? '';
    generate.mockResolvedValueOnce({
      status: 'generated',
      text: JSON.stringify({
        format: 'mw-local-ai-suggestion-envelope/v1',
        suggestions: [
          {
            id: suggestionId,
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
                  range: { unit: 'unicode_scalar', start: scalarIndex, end: scalarIndex + 1 },
                  selected_span_sha256: createHash('sha256').update(scalar, 'utf8').digest('hex'),
                },
              },
            ],
          },
        ],
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: [evidenceId] },
    });
    expect(response.statusCode).toBe(200);
  }

  it('lists the newest candidate identity per suggestion id for the authenticated company', async () => {
    const snapshot = await publishEvidence();
    await storeTermCandidate('mw:suggestion:list-002', 0, snapshot);
    await storeTermCandidate('mw:suggestion:list-001', 0, snapshot);
    await storeTermCandidate('mw:suggestion:list-001', 1, snapshot);
    const response = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions',
      headers: { authorization: 'Bearer test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const data = response.json().data as {
      visibility: string;
      status: string;
      truncated: boolean;
      items: Record<string, unknown>[];
    };
    expect([data.visibility, data.status, data.truncated]).toEqual([
      'INTERNAL',
      'unreviewed',
      false,
    ]);
    expect(data.items.map((item) => [item.suggestionId, item.version])).toEqual([
      ['mw:suggestion:list-001', 2],
      ['mw:suggestion:list-002', 1],
    ]);
    expect(Object.keys(data.items[0]!).sort()).toEqual([
      'digest',
      'status',
      'suggestionId',
      'version',
      'visibility',
    ]);
    expect(data.items[0]!.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(data)).not.toContain('citation');
  });

  it('returns an empty bounded page when the company has no stored candidates', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions',
      headers: { authorization: 'Bearer test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      visibility: 'INTERNAL',
      status: 'unreviewed',
      truncated: false,
      items: [],
    });
  });

  it('bounds the review queue page and rejects non-canonical or unknown query fields', async () => {
    const snapshot = await publishEvidence();
    await storeTermCandidate('mw:suggestion:list-002', 0, snapshot);
    await storeTermCandidate('mw:suggestion:list-001', 0, snapshot);
    const page = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions?limit=1',
      headers: { authorization: 'Bearer test' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data).toMatchObject({
      truncated: true,
      items: [{ suggestionId: 'mw:suggestion:list-001', version: 1 }],
    });
    for (const limit of ['0', '01', '101', '999', '1.0', '']) {
      const rejected = await app.inject({
        method: 'GET',
        url: `/api/research/suggestions?limit=${limit}`,
        headers: { authorization: 'Bearer test' },
      });
      expect([rejected.statusCode, rejected.json()]).toEqual([
        400,
        { success: false, error: 'Invalid suggestion list page size' },
      ]);
    }
    const cursor = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions?limit=1&offset=1',
      headers: { authorization: 'Bearer test' },
    });
    expect(cursor.statusCode).toBe(400);
  });

  it('refuses the candidate queue without an active authenticated company membership', async () => {
    const snapshot = await publishEvidence();
    await storeTermCandidate('mw:suggestion:list-001', 0, snapshot);
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/research/suggestions' });
    expect(unauthenticated.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions',
      headers: { authorization: 'Bearer test', 'x-test-company': 'foreign' },
    });
    expect([foreign.statusCode, foreign.json()]).toEqual([
      403,
      { success: false, error: 'Suggestion list is unavailable' },
    ]);
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/research/suggestions',
      headers: { authorization: 'Bearer test' },
    });
    expect(revoked.statusCode).toBe(403);
  });

  /**
   * Outage certification for K7-006. These cases replace the decorated runtime with the real
   * `createLocalAiRuntime` and a recorded transport, so the chain under test is route → suggestion
   * adapter → configured runtime → transport, not a stub returning the shape the route expects. The
   * route reads `fastify.localAi.generate` per request, so the swap happens after the shared setup.
   */
  type OutageCall = {
    readonly url: string;
    readonly method: unknown;
    readonly redirect: unknown;
    readonly bounded: boolean;
  };

  const loopbackEndpoint = 'http://127.0.0.1:41234';
  const outageDetail = [
    'timeout',
    'provider_unreachable',
    'invalid_response',
    'DOWN-FOR-MAINTENANCE',
    '127.0.0.1',
    '41234',
  ];

  function installRuntime(generate: (request: { prompt: string }) => Promise<LocalAiResult>) {
    (app as unknown as { localAi: { generate: typeof generate } }).localAi = { generate };
  }

  function transportFor(respond: () => Promise<Response>, calls: OutageCall[]): LocalAiFetch {
    return (async (input: unknown, init?: Record<string, unknown>) => {
      calls.push({
        url: String(input),
        method: init?.method,
        redirect: init?.redirect,
        bounded: init?.signal !== undefined,
      });
      return respond();
    }) as unknown as LocalAiFetch;
  }

  function localRuntimeFor(respond: () => Promise<Response>, calls: OutageCall[]) {
    return createLocalAiRuntime(
      readLocalAiConfig({ AI_MODE: 'local', LOCAL_AI_ENDPOINT: loopbackEndpoint }),
      transportFor(respond, calls)
    );
  }

  const timeoutRespond = () =>
    Promise.reject(
      Object.assign(new Error('model did not answer in time'), { name: 'TimeoutError' })
    );
  const unreachableRespond = () => Promise.resolve(new Response('', { status: 503 }));
  const invalidRespond = () =>
    Promise.resolve(
      new Response(JSON.stringify({ note: 'DOWN-FOR-MAINTENANCE' }), { status: 200 })
    );

  it('certifies each model-outage mode as a bounded 503 that stores nothing and leaks no provider detail', async () => {
    await publishEvidence();
    const outageCases = [
      { mode: 'disabled', respond: undefined },
      { mode: 'timeout', respond: timeoutRespond },
      { mode: 'provider_unreachable', respond: unreachableRespond },
      { mode: 'invalid_response', respond: invalidRespond },
    ];
    for (const entry of outageCases) {
      const calls: OutageCall[] = [];
      const runtime =
        entry.respond === undefined
          ? createLocalAiRuntime({ mode: 'disabled', timeoutMs: 250 }, async () =>
              Promise.reject(new Error('the disabled runtime must not reach a transport'))
            )
          : localRuntimeFor(entry.respond, calls);
      installRuntime((request) => runtime.generate(request));
      const response = await generateDown();
      expect([entry.mode, response.statusCode]).toEqual([entry.mode, 503]);
      expect([entry.mode, response.json()]).toEqual([
        entry.mode,
        { success: false, error: 'Local suggestion generation is unavailable' },
      ]);
      expect([entry.mode, response.headers['cache-control']]).toEqual([
        entry.mode,
        'private, no-store',
      ]);
      for (const detail of outageDetail) {
        expect([entry.mode, response.body.includes(detail)]).toEqual([entry.mode, false]);
      }
      expect([entry.mode, await db('knowledge_research_suggestion_versions')]).toEqual([
        entry.mode,
        [],
      ]);
      expect([entry.mode, calls.length]).toEqual([entry.mode, entry.mode === 'disabled' ? 0 : 1]);
      expect(calls.every((call) => call.url === `${loopbackEndpoint}/v1/generate`)).toBe(true);
    }
  });

  it('keeps an outage request on the configured loopback endpoint inside the configured timeout', async () => {
    await publishEvidence();
    const calls: OutageCall[] = [];
    installRuntime((request) => localRuntimeFor(unreachableRespond, calls).generate(request));
    expect((await generateDown()).statusCode).toBe(503);
    expect(calls).toEqual([
      {
        url: `${loopbackEndpoint}/v1/generate`,
        method: 'POST',
        redirect: 'error',
        bounded: true,
      },
    ]);
    expect(() =>
      createLocalAiRuntime(
        { mode: 'local', endpoint: new URL('http://model.example.com'), timeoutMs: 250 },
        async () => Promise.reject(new Error('a refused endpoint must not reach a transport'))
      )
    ).toThrow(/loopback endpoints only/u);
    expect(() =>
      readLocalAiConfig({ AI_MODE: 'local', LOCAL_AI_ENDPOINT: 'http://model.example.com:8080/v1' })
    ).toThrow(/localhost, 127\.0\.0\.1, or ::1 only/u);
  });

  it('keeps the generation rate limit armed while the model is down', async () => {
    await publishEvidence();
    const calls: OutageCall[] = [];
    const runtime = localRuntimeFor(timeoutRespond, calls);
    installRuntime((request) => runtime.generate(request));
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      statuses.push((await generateDown()).statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 503));
    expect(statuses[10]).toBe(429);
    expect(calls).toHaveLength(10);
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(0);
  });

  async function generateDown() {
    return app.inject({
      method: 'POST',
      url: '/api/research/suggestions/generate',
      headers: { authorization: 'Bearer test' },
      payload: { kind: 'term', evidence_ids: [evidenceId] },
    });
  }
});
