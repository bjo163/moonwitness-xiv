import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { readQuranPassage } from '@moonwitness/corpus';
import type { StoredResearchGraphRelease } from '@moonwitness/orm-knowledge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCorpusDataRoot } from '../src/routes/corpus.routes.js';
import { researchExplanationRoutes } from '../src/routes/research-explanation.routes.js';

const relationId = 'mw:relation:api-fixture';
const evidenceId = 'mw:evidence:api-fixture';
const assertionId = 'mw:assertion:api-fixture';
const releaseDigest = 'a'.repeat(64);
const editionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';

describe('research relation explanation API', () => {
  afterEach(() => vi.unstubAllEnvs());

  async function fixtureRelease(
    overrides: {
      relationVisibility?: string;
      evidenceVisibility?: string;
      assertionVisibility?: string;
      evidenceHash?: string;
    } = {}
  ) {
    const passage = await readQuranPassage({
      rootDirectory: resolveCorpusDataRoot(),
      editionId,
      locator: 'Q7:46',
      use: 'quote_excerpt',
    });
    const visibility = overrides.relationVisibility ?? 'INTERNAL';
    return {
      corpusKey: 'research',
      releaseDigest,
      manifestDigest: releaseDigest,
      manifestJson: '{}',
      schemaVersion: 'research-graph/v1',
      previousReleaseDigest: null,
      records: [
        {
          key: 'mw:source:tanzil-quran-text',
          kind: 'source',
          visibility: 'PUBLIC',
          content: {
            id: 'mw:source:tanzil-quran-text',
            kind: 'Artifact',
            visibility: 'PUBLIC_APPROVED',
          },
          contentDigest: '7'.repeat(64),
        },
        {
          key: editionId,
          kind: 'expression',
          visibility: 'PUBLIC',
          content: { id: editionId, kind: 'Edition', visibility: 'PUBLIC_APPROVED' },
          contentDigest: '8'.repeat(64),
        },
        {
          key: 'mw:entity:api-left',
          kind: 'node',
          visibility: 'PUBLIC',
          content: {
            id: 'mw:entity:api-left',
            kind: 'Entity',
            identity_class: 'Entity',
            visibility: 'PUBLIC_APPROVED',
          },
          contentDigest: '1'.repeat(64),
        },
        {
          key: 'mw:entity:api-right',
          kind: 'node',
          visibility: 'INTERNAL',
          content: {
            id: 'mw:entity:api-right',
            kind: 'Entity',
            identity_class: 'Entity',
            visibility: 'INTERNAL',
          },
          contentDigest: '2'.repeat(64),
        },
        {
          key: 'mw:concept:api-scope',
          kind: 'node',
          visibility: 'INTERNAL',
          content: { id: 'mw:concept:api-scope', kind: 'Concept', visibility: 'INTERNAL' },
          contentDigest: '3'.repeat(64),
        },
        {
          key: assertionId,
          kind: 'assertion',
          visibility: 'PUBLIC',
          content: {
            id: assertionId,
            kind: 'Assertion',
            schema_version: 1,
            lifecycle: 'candidate',
            created_at: '2026-10-16T00:00:00.000Z',
            updated_at: '2026-10-16T00:00:00.000Z',
            origin_ref: 'fixture://research/api/001',
            visibility: overrides.assertionVisibility ?? 'PUBLIC_APPROVED',
            content_revision: 1,
            claim: 'Synthetic explanation fixture.',
            polarity: 'positive',
            scope: { kind: 'research_context', reference_id: 'mw:concept:api-scope' },
            context: { mode: 'analysis', reference_id: 'mw:concept:api-scope' },
            epistemic_status: 'hypothesized',
            review_status: 'pending',
          },
          contentDigest: '4'.repeat(64),
        },
        {
          key: evidenceId,
          kind: 'evidence',
          visibility: 'PUBLIC',
          content: {
            id: evidenceId,
            kind: 'Evidence',
            visibility: overrides.evidenceVisibility ?? 'PUBLIC_APPROVED',
            assertion_id: assertionId,
            direction: 'supporting',
            selector: {
              source_id: 'mw:source:tanzil-quran-text',
              edition_id: editionId,
              locator: 'Q7:46',
              content_sha256: overrides.evidenceHash ?? passage.sha256,
            },
          },
          contentDigest: '5'.repeat(64),
        },
        {
          key: relationId,
          kind: 'relation',
          visibility: visibility === 'RESTRICTED' ? 'RESTRICTED' : 'PUBLIC',
          content: {
            id: relationId,
            kind: 'ResearchRelation',
            schema_version: 1,
            lifecycle: 'candidate',
            created_at: '2026-10-16T00:00:00.000Z',
            updated_at: '2026-10-16T00:00:00.000Z',
            origin_ref: 'fixture://research/api/001',
            content_revision: 1,
            visibility,
            predicate: 'related_to',
            subject_id: 'mw:entity:api-left',
            object_id: 'mw:entity:api-right',
            scope: { kind: 'research_context', reference_id: 'mw:concept:api-scope' },
            supporting_evidence_ids: [evidenceId],
            counterevidence_ids: [],
            alternative_relation_ids: [],
            epistemic_status: 'unreviewed',
            review_status: 'pending',
          },
          contentDigest: '6'.repeat(64),
        },
      ],
    } satisfies StoredResearchGraphRelease;
  }

  async function createApp(
    release: StoredResearchGraphRelease,
    lookupPassage?: () => Promise<null>
  ) {
    const app = Fastify({ ajv: { customOptions: { coerceTypes: false } } });
    app.decorateRequest('auth', null);
    let membershipState = 'active';
    app.decorate('knex', {
      transaction: async (callback: (trx: object) => Promise<unknown>) => {
        const trx = ((table: string) => {
          let filters: Record<string, unknown> = {};
          const query = {
            where(value: Record<string, unknown>) {
              filters = value;
              return query;
            },
            forUpdate() {
              return query;
            },
            async first() {
              if (table === 'companies')
                return membershipState === 'company-inactive' ? undefined : { id: 12 };
              if (table === 'company_memberships') {
                return membershipState === 'active' &&
                  filters.user_id === 1 &&
                  filters.company_id === 12
                  ? { id: 1 }
                  : undefined;
              }
              return undefined;
            },
          };
          return query;
        }) as object;
        return callback(trx);
      },
    } as never);
    app.addHook('onRequest', async (request) => {
      const role = request.headers['x-test-role'];
      membershipState = String(request.headers['x-test-membership'] ?? 'active');
      if (role === 'system' || role === 'superadmin' || role === 'user') {
        request.auth = {
          userId: 1,
          role,
          ...(request.headers['x-test-company'] === 'missing' || role === 'system'
            ? {}
            : { companyId: 12 }),
          groupPermissions: [],
        };
      }
    });
    const readActiveRelease = vi.fn(async (_trx, key: string) => {
      expect(key).toBe('research');
      return release;
    });
    await app.register(researchExplanationRoutes, {
      readActiveRelease,
      ...(lookupPassage ? { lookupPassage } : {}),
    });
    return { app, readActiveRelease };
  }

  it('requires authentication and denies human readers without an active company membership', async () => {
    const release = await fixtureRelease();
    const { app, readActiveRelease } = await createApp(release);
    try {
      const anonymous = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['cache-control']).toBe('private, no-store');
      const ordinary = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'user' },
      });
      expect(ordinary.statusCode).toBe(200);
      const noCompany = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'user', 'x-test-company': 'missing' },
      });
      expect(noCompany.statusCode).toBe(403);
      const inactive = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'superadmin', 'x-test-membership': 'inactive' },
      });
      expect(inactive.statusCode).toBe(403);
      expect(inactive.json().error).toBe('Research explanation access denied');
      const inactiveUserMembership = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'user', 'x-test-membership': 'inactive' },
      });
      expect(inactiveUserMembership.statusCode).toBe(403);
      const inactiveCompany = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'user', 'x-test-membership': 'company-inactive' },
      });
      expect(inactiveCompany.statusCode).toBe(403);
      expect(readActiveRelease).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('explains only records/evidence from the exact active release for an authorized role', async () => {
    const release = await fixtureRelease();
    const { app, readActiveRelease } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'superadmin' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(readActiveRelease).toHaveBeenCalledTimes(1);
      expect(response.json()).toMatchObject({
        success: true,
        data: {
          release_digest: releaseDigest,
          explanation: {
            id: relationId,
            supporting_evidence: [{ evidence: { id: evidenceId }, locator: 'Q7:46' }],
            counterevidence: [],
            alternatives: [],
            interpretation_boundary: 'linked_evidence_only',
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('searches readable assertions and linked evidence without exposing source text', async () => {
    const release = await fixtureRelease();
    const { app } = await createApp(release);
    try {
      const anonymousSearch = await app.inject({
        method: 'GET',
        url: '/api/research/graph/search?q=Synthetic+explanation',
      });
      expect(anonymousSearch.statusCode).toBe(401);
      const missingCompany = await app.inject({
        method: 'GET',
        url: '/api/research/graph/search?q=Synthetic+explanation',
        headers: { 'x-test-role': 'user', 'x-test-company': 'missing' },
      });
      expect(missingCompany.statusCode).toBe(403);
      const assertionSearch = await app.inject({
        method: 'GET',
        url: '/api/research/graph/search?q=Synthetic+explanation',
        headers: { 'x-test-role': 'user' },
      });
      expect(assertionSearch.statusCode).toBe(200);
      expect(assertionSearch.headers['cache-control']).toBe('private, no-store');
      expect(assertionSearch.json()).toMatchObject({
        success: true,
        data: {
          release_digest: releaseDigest,
          results: [
            { id: assertionId, kind: 'assertion', title: 'Synthetic explanation fixture.' },
          ],
        },
      });
      expect(assertionSearch.json().data.truncated).toBe(false);

      const evidenceSearch = await app.inject({
        method: 'GET',
        url: '/api/research/graph/search?q=Q7%3A46',
        headers: { 'x-test-role': 'user' },
      });
      expect(evidenceSearch.statusCode).toBe(200);
      expect(evidenceSearch.json().data.results).toEqual([
        {
          id: evidenceId,
          kind: 'evidence',
          title: 'supporting · Q7:46',
          summary: 'mw:source:tanzil-quran-text',
          assertion_id: assertionId,
          source_id: 'mw:source:tanzil-quran-text',
          edition_id: editionId,
          locator: 'Q7:46',
        },
      ]);
      expect(evidenceSearch.body).not.toContain('A verified local passage excerpt');

      const relationSearch = await app.inject({
        method: 'GET',
        url: `/api/research/graph/search?q=${encodeURIComponent(relationId)}`,
        headers: { 'x-test-role': 'user' },
      });
      expect(relationSearch.statusCode).toBe(200);
      expect(relationSearch.json().data.results).toEqual([
        {
          id: relationId,
          kind: 'relation',
          title: 'related_to · mw:entity:api-left → mw:entity:api-right',
          summary: 'unreviewed · pending',
        },
      ]);

      const limitedSearch = await app.inject({
        method: 'GET',
        url: '/api/research/graph/search?q=api-fixture&limit=1',
        headers: { 'x-test-role': 'user' },
      });
      expect(limitedSearch.statusCode).toBe(200);
      expect(limitedSearch.json()).toMatchObject({
        data: { results: expect.any(Array), truncated: true },
      });
      expect(limitedSearch.json().data.results).toHaveLength(1);

      const oversizedSearch = await app.inject({
        method: 'GET',
        url: '/api/research/graph/search?q=api-fixture&limit=26',
        headers: { 'x-test-role': 'user' },
      });
      expect(oversizedSearch.statusCode).toBe(400);

      const nonIntegerSearch = await app.inject({
        method: 'GET',
        url: '/api/research/graph/search?q=api-fixture&limit=1.5',
        headers: { 'x-test-role': 'user' },
      });
      expect(nonIntegerSearch.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('fails closed for hidden assertions, their evidence, and whitespace-only searches', async () => {
    const release = await fixtureRelease({ assertionVisibility: 'CHILD_SENSITIVE' });
    const evidence = release.records.find((record) => record.key === evidenceId)!;
    evidence.content = { ...evidence.content, visibility: 'INTERNAL' };
    const { app } = await createApp(release);
    try {
      const hidden = await app.inject({
        method: 'GET',
        url: `/api/research/graph/search?q=${encodeURIComponent(assertionId)}`,
        headers: { 'x-test-role': 'system' },
      });
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json().data.results).toEqual([]);
      expect(hidden.body).not.toContain(assertionId);
      expect(hidden.body).not.toContain(evidenceId);

      const relation = await app.inject({
        method: 'GET',
        url: `/api/research/graph/search?q=${encodeURIComponent(relationId)}`,
        headers: { 'x-test-role': 'system' },
      });
      expect(relation.statusCode).toBe(200);
      expect(relation.json().data.results).toEqual([]);
      expect(relation.body).not.toContain(relationId);

      const whitespace = await app.inject({
        method: 'GET',
        url: '/api/research/graph/search?q=%20%20',
        headers: { 'x-test-role': 'system' },
      });
      expect(whitespace.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('does not expose a relation when either endpoint is hidden', async () => {
    const release = await fixtureRelease();
    const hiddenNode = release.records.find((record) => record.key === 'mw:entity:api-right')!;
    hiddenNode.visibility = 'RESTRICTED';
    const { app } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/graph/search?q=${encodeURIComponent(relationId)}`,
        headers: { 'x-test-role': 'system' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.results).toEqual([]);
      expect(response.body).not.toContain(relationId);
      expect(response.body).not.toContain('mw:entity:api-right');
    } finally {
      await app.close();
    }
  });

  it('does not expose evidence or relations backed by a hidden source or edition', async () => {
    for (const hiddenKey of ['mw:source:tanzil-quran-text', editionId]) {
      const release = await fixtureRelease();
      const hiddenRecord = release.records.find((record) => record.key === hiddenKey)!;
      hiddenRecord.content = { ...hiddenRecord.content, visibility: 'CHILD_SENSITIVE' };
      const { app } = await createApp(release);
      try {
        for (const query of [evidenceId, relationId]) {
          const response = await app.inject({
            method: 'GET',
            url: `/api/research/graph/search?q=${encodeURIComponent(query)}`,
            headers: { 'x-test-role': 'system' },
          });
          expect(response.statusCode).toBe(200);
          expect(response.json().data.results).toEqual([]);
          expect(response.body).not.toContain(evidenceId);
          expect(response.body).not.toContain(relationId);
        }
      } finally {
        await app.close();
      }
    }
  });

  it('requires selector identities to resolve to their matching record categories', async () => {
    const cases = [
      { id: 'mw:source:tanzil-quran-text', contentKind: 'Entity' },
      { id: editionId, contentKind: 'Entity' },
      { id: 'mw:expression:webp-protestant', contentKind: 'Entity' },
    ];
    for (const identity of cases) {
      const release = await fixtureRelease();
      const evidence = release.records.find((record) => record.key === evidenceId)!;
      const selector = { ...(evidence.content as { selector: Record<string, unknown> }).selector };
      if (identity.id === 'mw:expression:webp-protestant') {
        release.records = release.records.filter(
          (record) => record.key !== 'mw:source:tanzil-quran-text' && record.key !== editionId
        );
        release.records.push(
          {
            key: 'mw:source:ebible-webp-protestant',
            kind: 'source',
            visibility: 'PUBLIC',
            content: {
              id: 'mw:source:ebible-webp-protestant',
              kind: 'Artifact',
              visibility: 'PUBLIC_APPROVED',
            },
            contentDigest: 'a'.repeat(64),
          },
          {
            key: 'mw:edition:webp-protestant-2020-stable',
            kind: 'expression',
            visibility: 'PUBLIC',
            content: {
              id: 'mw:edition:webp-protestant-2020-stable',
              kind: 'Edition',
              visibility: 'PUBLIC_APPROVED',
            },
            contentDigest: 'b'.repeat(64),
          }
        );
        Object.assign(selector, {
          source_id: 'mw:source:ebible-webp-protestant',
          expression_id: identity.id,
          edition_id: 'mw:edition:webp-protestant-2020-stable',
          locator: 'Genesis 1:1',
          content_sha256: 'c'.repeat(64),
        });
        evidence.content = { ...evidence.content, selector };
      }
      release.records = release.records.filter((record) => record.key !== identity.id);
      release.records.push({
        key: identity.id,
        kind: 'node',
        visibility: 'PUBLIC',
        content: {
          id: identity.id,
          kind: identity.contentKind,
          identity_class: 'Entity',
          visibility: 'PUBLIC_APPROVED',
        },
        contentDigest: '9'.repeat(64),
      });
      const { app } = await createApp(release);
      try {
        for (const query of [evidenceId, relationId]) {
          const response = await app.inject({
            method: 'GET',
            url: `/api/research/graph/search?q=${encodeURIComponent(query)}`,
            headers: { 'x-test-role': 'system' },
          });
          expect([200, 503]).toContain(response.statusCode);
          if (response.statusCode === 200) {
            expect(response.json().data.results).toEqual([]);
          } else {
            expect(response.body).not.toContain(evidenceId);
            expect(response.body).not.toContain(relationId);
          }
        }
      } finally {
        await app.close();
      }
    }
  });

  it('does not expose a relation when its referenced evidence has a hidden parent assertion', async () => {
    const release = await fixtureRelease({ assertionVisibility: 'CHILD_SENSITIVE' });
    const { app } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/graph/search?q=${encodeURIComponent(relationId)}`,
        headers: { 'x-test-role': 'system' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.results).toEqual([]);
      expect(response.body).not.toContain(relationId);
      expect(response.body).not.toContain(evidenceId);
      expect(response.body).not.toContain(assertionId);
    } finally {
      await app.close();
    }
  });

  it('omits evidence and its relation when the pinned source is hidden', async () => {
    const release = await fixtureRelease();
    const source = release.records.find((record) => record.key === 'mw:source:tanzil-quran-text')!;
    source.visibility = 'RESTRICTED';
    const { app } = await createApp(release);
    try {
      const [evidence, relation] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/api/research/graph/search?q=Q7%3A46',
          headers: { 'x-test-role': 'system' },
        }),
        app.inject({
          method: 'GET',
          url: `/api/research/graph/search?q=${encodeURIComponent(relationId)}`,
          headers: { 'x-test-role': 'system' },
        }),
      ]);
      expect(evidence.statusCode).toBe(200);
      expect(evidence.json().data.results).toEqual([]);
      expect(evidence.body).not.toContain('mw:source:tanzil-quran-text');
      expect(relation.statusCode).toBe(200);
      expect(relation.json().data.results).toEqual([]);
      expect(relation.body).not.toContain(relationId);
    } finally {
      await app.close();
    }
  });

  it('allows a trusted system reader without a company membership', async () => {
    const release = await fixtureRelease();
    const { app } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'system' },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('keeps storage PUBLIC at the INTERNAL floor and hides restricted relation records', async () => {
    const release = await fixtureRelease({ relationVisibility: 'RESTRICTED' });
    const { app } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'system' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('Research relation was not found');
    } finally {
      await app.close();
    }
  });

  it('hides a confidential relation and its confidential selected evidence', async () => {
    const release = await fixtureRelease({
      relationVisibility: 'CONFIDENTIAL',
      evidenceVisibility: 'CONFIDENTIAL',
    });
    const { app } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'system' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('Q7:46');
      expect(response.body).not.toContain('excerpt');
    } finally {
      await app.close();
    }
  });

  it('fails closed when exact local evidence cannot be verified', async () => {
    const release = await fixtureRelease({ evidenceHash: '0'.repeat(64) });
    const { app } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'system' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe('Research explanation is unavailable');
    } finally {
      await app.close();
    }
  });

  it('fails closed when an injected release has a semantically invalid graph', async () => {
    const release = await fixtureRelease();
    const relation = release.records.find((record) => record.key === relationId)!;
    relation.content = { ...relation.content, subject_id: 'mw:entity:missing-endpoint' };
    const { app } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'system' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe('Research explanation is unavailable');
    } finally {
      await app.close();
    }
  });

  it('fails closed when an evidence selector names a source outside the injected release', async () => {
    const release = await fixtureRelease();
    const evidence = release.records.find((record) => record.key === evidenceId)!;
    evidence.content = {
      ...evidence.content,
      selector: {
        ...(evidence.content.selector as Record<string, unknown>),
        source_id: 'mw:source:missing-from-release',
      },
    };
    const { app } = await createApp(release);
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/research/relations/${relationId}/explanation`,
        headers: { 'x-test-role': 'system' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe('Research explanation is unavailable');
    } finally {
      await app.close();
    }
  });

  it('registers authenticated GET OpenAPI docs with cache and failure contracts', async () => {
    const app = Fastify();
    await app.register(swagger, {
      openapi: {
        info: { title: 'Test API', version: '1.0.0' },
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      },
    });
    await app.register(researchExplanationRoutes, {
      readActiveRelease: async () => null,
      lookupPassage: async () => null,
    });
    await app.ready();
    try {
      const operation = (
        app.swagger().paths as Record<
          string,
          { get: { security: unknown; responses: Record<string, unknown> } }
        >
      )['/api/research/relations/{relationId}/explanation']!.get;
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '401', '403', '404', '503']);
      const searchOperation = (
        app.swagger().paths as Record<string, { get: { security: unknown } }>
      )['/api/research/graph/search']!.get;
      expect(searchOperation.security).toEqual([{ bearerAuth: [] }]);
    } finally {
      await app.close();
    }
  });
});
