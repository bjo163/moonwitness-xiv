import Fastify from 'fastify';
import path from 'node:path';
import swagger from '@fastify/swagger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { corpusRoutes, resolveCorpusDataRoot } from '../src/routes/corpus.routes.js';

describe('corpus API contract', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves the configured container corpus directory to the data root', () => {
    const corpusDirectory = path.join(process.cwd(), 'runtime', 'app', 'corpus');
    vi.stubEnv('MOONWITNESS_CORPUS_ROOT', corpusDirectory);
    expect(resolveCorpusDataRoot()).toBe(path.join(process.cwd(), 'runtime', 'app'));
  });

  it('publishes typed source and passage response variants and documented failures', async () => {
    const app = Fastify();
    await app.register(swagger, {
      openapi: {
        info: { title: 'Test API', version: '1.0.0' },
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        },
      },
    });
    await app.register(corpusRoutes);
    await app.ready();

    try {
      const spec = app.swagger();
      const paths = spec.paths as Record<
        string,
        {
          get: {
            responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
          };
        }
      >;
      const sourceResponses = paths['/api/corpus/sources/{sourceId}']!.get.responses;
      const passageResponses = paths['/api/corpus/passages/{editionId}/{locator}']!.get.responses;
      for (const responses of [sourceResponses, passageResponses]) {
        expect(Object.keys(responses).sort()).toEqual(['200', '401', '404', '503']);
        expect(responses['401']!.content?.['application/json']?.schema).toBeDefined();
        expect(responses['404']!.content?.['application/json']?.schema).toBeDefined();
        expect(responses['503']!.content?.['application/json']?.schema).toBeDefined();
      }
      for (const responses of [sourceResponses, passageResponses]) {
        const successSchema = responses['200']!.content?.['application/json']?.schema as {
          properties?: { data?: { oneOf?: unknown[] } };
        };
        expect(successSchema.properties?.data?.oneOf).toHaveLength(2);
      }
    } finally {
      await app.close();
    }
  });
});
