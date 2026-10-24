import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { readQuranPassage } from '@moonwitness/corpus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evidenceRoutes } from '../src/routes/evidence.routes.js';
import { resolveCorpusDataRoot } from '../src/routes/corpus.routes.js';

const quranSelector = {
  source_id: 'mw:source:tanzil-quran-text',
  edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
  locator: 'Q7:46',
};

describe('research evidence API', () => {
  afterEach(() => vi.unstubAllEnvs());

  function createEvidenceApp(
    role?: 'user' | 'superadmin' | 'system',
    companyId: number | null = 12
  ) {
    const app = Fastify();
    app.decorateRequest('auth', null);
    app.addHook('onRequest', async (request) => {
      if (role) {
        request.auth = {
          userId: 1,
          role,
          companyId: companyId ?? undefined,
          groupPermissions: [],
        };
      }
    });
    app.setErrorHandler((error, _request, reply) => {
      const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
      return reply.code(statusCode).send({ success: false, error: error.message });
    });
    return app;
  }

  it('resolves exact local evidence and preserves counterevidence direction', async () => {
    const passage = await readQuranPassage({
      rootDirectory: resolveCorpusDataRoot(),
      editionId: quranSelector.edition_id,
      locator: quranSelector.locator,
      use: 'quote_excerpt',
    });
    const app = createEvidenceApp('user');
    await app.register(evidenceRoutes);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/research/evidence/resolve',
        payload: {
          id: 'mw:evidence:test-1',
          assertion_id: 'mw:assertion:test-1',
          direction: 'counterevidence',
          selector: { ...quranSelector, content_sha256: passage.sha256 },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        data: {
          direction: 'counterevidence',
          source_id: quranSelector.source_id,
          edition_id: quranSelector.edition_id,
          locator: quranSelector.locator,
          content_sha256: passage.sha256,
          excerpt: passage.text,
        },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects content hash mismatches and dangling/noncanonical selectors', async () => {
    const app = createEvidenceApp('user');
    await app.register(evidenceRoutes);

    try {
      const base = {
        id: 'mw:evidence:test-2',
        assertion_id: 'mw:assertion:test-2',
        direction: 'supporting',
      };
      const mismatch = await app.inject({
        method: 'POST',
        url: '/api/research/evidence/resolve',
        payload: {
          ...base,
          selector: { ...quranSelector, content_sha256: '0'.repeat(64) },
        },
      });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().error).toContain('content hash');

      const dangling = await app.inject({
        method: 'POST',
        url: '/api/research/evidence/resolve',
        payload: {
          ...base,
          selector: {
            ...quranSelector,
            locator: 'Q7:47',
            content_sha256: '0'.repeat(64),
          },
        },
      });
      expect(dangling.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects anonymous requests for both approved local samples without returning excerpts', async () => {
    const app = createEvidenceApp();
    await app.register(evidenceRoutes);

    try {
      const selectors = [
        { ...quranSelector, content_sha256: 'a'.repeat(64) },
        {
          source_id: 'mw:source:ebible-webp-protestant',
          expression_id: 'mw:expression:webp-protestant',
          edition_id: 'mw:edition:webp-protestant-2020-stable',
          locator: 'Genesis 1:1',
          content_sha256: 'b'.repeat(64),
        },
      ];

      for (const [index, selector] of selectors.entries()) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/research/evidence/resolve',
          payload: {
            id: `mw:evidence:anonymous-${index}`,
            assertion_id: `mw:assertion:anonymous-${index}`,
            direction: 'supporting',
            selector,
          },
        });

        expect(response.statusCode, response.body).toBe(401);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.json()).toEqual({ success: false, error: 'Authentication required' });
        expect(response.body).not.toContain('In the name');
        expect(response.body).not.toContain('In the beginning');
      }

      const malformed = await app.inject({
        method: 'POST',
        url: '/api/research/evidence/resolve',
        payload: {},
      });
      expect(malformed.statusCode).toBe(401);
      expect(malformed.json()).toEqual({
        success: false,
        error: 'Authentication required',
      });
    } finally {
      await app.close();
    }
  });

  it('requires a human role with an active company context', async () => {
    for (const [role, companyId] of [
      ['system', 12],
      ['user', null],
      ['superadmin', null],
    ] as const) {
      const app = createEvidenceApp(role, companyId);
      await app.register(evidenceRoutes);

      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/research/evidence/resolve',
          payload: {
            id: `mw:evidence:denied-${role}`,
            assertion_id: `mw:assertion:denied-${role}`,
            direction: 'supporting',
            selector: { ...quranSelector, content_sha256: 'a'.repeat(64) },
          },
        });

        expect(response.statusCode, `${role} ${companyId}: ${response.body}`).toBe(403);
        expect(response.json()).toEqual({ success: false, error: 'Research access denied' });
      } finally {
        await app.close();
      }
    }
  });

  it('documents exact selectors, response bodies and authenticated access', async () => {
    const app = createEvidenceApp();
    await app.register(swagger, {
      openapi: {
        info: { title: 'Test API', version: '1.0.0' },
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      },
    });
    await app.register(evidenceRoutes);
    await app.ready();

    try {
      const path = (app.swagger().paths as Record<string, EvidenceRouteOpenApiPath>)[
        '/api/research/evidence/resolve'
      ]!.post;
      expect(path.security).toEqual([{ bearerAuth: [] }]);
      expect(path.requestBody.content['application/json'].schema).toBeDefined();
      expect(Object.keys(path.responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '404',
        '409',
        '503',
      ]);
      for (const response of Object.values(path.responses)) {
        expect(response.content?.['application/json']?.schema).toBeDefined();
      }
      const successSchema = path.responses[200].content['application/json'].schema;
      const dataSchema = successSchema.properties.data;
      expect(dataSchema.properties.evidence).toMatchObject({
        type: 'object',
        required: ['id', 'assertion_id', 'direction', 'selector'],
      });
      expect(dataSchema.properties.range).toMatchObject({
        type: 'object',
        required: ['unit', 'start', 'end'],
        properties: {
          unit: { enum: ['unicode_scalar'] },
          start: { type: 'integer', minimum: 0 },
          end: { type: 'integer', minimum: 1 },
        },
      });
    } finally {
      await app.close();
    }
  });
});

interface EvidenceRouteOpenApiPath {
  post: {
    security: unknown;
    requestBody: { content: Record<string, { schema?: unknown }> };
    responses: Record<number, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
  };
}
