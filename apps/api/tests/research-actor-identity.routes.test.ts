import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { manifest as knowledgeManifest } from '@moonwitness/orm-knowledge';
import { researchActorIdentityRoutes } from '../src/routes/research-actor-identity.routes.js';

describe('research actor identity provisioning API', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let superadminId: number;
  let targetUserId: number;

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
    await installAddons(db, [baseManifest, knowledgeManifest]);
    superadminId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    targetUserId = Number((await db('users').where({ login: 'system' }).first('id'))?.id);

    app = Fastify({
      genReqId(request) {
        const requestId = request.headers['x-request-id'];
        return typeof requestId === 'string' ? requestId : 'identity-api-test-request';
      },
    });
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request) => {
      const role = request.headers['x-test-role'];
      if (role === 'superadmin' || role === 'system' || role === 'user') {
        request.auth = { userId: superadminId, role, groupPermissions: [] };
      }
    });
    await app.register(researchActorIdentityRoutes);
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it('requires authentication and limits provisioning to superadmins', async () => {
    const body = {
      target_user_id: targetUserId,
      canonical_user_id: 'mw:user:explicit-api-target',
      reason: 'Approved synthetic test mapping.',
    };
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/research/actor-identities',
      payload: body,
    });
    const ordinary = await app.inject({
      method: 'POST',
      url: '/api/research/actor-identities',
      headers: { 'x-test-role': 'user' },
      payload: body,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(ordinary.statusCode).toBe(403);
    expect(await db('knowledge_research_actor_identities')).toHaveLength(0);
  });

  it('rejects client-supplied audit identity fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/actor-identities',
      headers: { 'x-test-role': 'superadmin' },
      payload: {
        target_user_id: targetUserId,
        canonical_user_id: 'mw:user:explicit-api-target',
        reason: 'Approved synthetic test mapping.',
        provisioned_by_user_id: targetUserId,
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(await db('knowledge_research_actor_identities')).toHaveLength(0);
  });

  it('provisions and exactly replays an audited explicit mapping', async () => {
    const body = {
      target_user_id: targetUserId,
      canonical_user_id: 'mw:user:explicit-api-target',
      reason: 'Approved synthetic test mapping.',
    };
    const requestId = 'identity-api-test-0001';
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/research/actor-identities',
        headers: { 'x-test-role': 'superadmin', 'x-request-id': requestId },
        payload: body,
      });
    const first = await send();
    const replay = await send();
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(replay.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      success: true,
      data: {
        target_user_id: targetUserId,
        canonical_user_id: 'mw:user:explicit-api-target',
        request_id: requestId,
      },
    });
    expect(await db('knowledge_research_actor_identities')).toHaveLength(1);
    expect(await db('audit_logs')).toHaveLength(1);
    expect(await db('audit_logs').first()).toMatchObject({
      model: 'knowledge.research_actor_identity',
      operation: 'provision',
      actor_id: superadminId,
    });
  });

  it('returns a conflict for a new request that reuses an existing user', async () => {
    const payload = {
      target_user_id: targetUserId,
      canonical_user_id: 'mw:user:explicit-api-target',
      reason: 'Approved synthetic test mapping.',
    };
    await app.inject({
      method: 'POST',
      url: '/api/research/actor-identities',
      headers: { 'x-test-role': 'superadmin', 'x-request-id': 'identity-api-first' },
      payload,
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/research/actor-identities',
      headers: { 'x-test-role': 'superadmin', 'x-request-id': 'identity-api-second' },
      payload: { ...payload, canonical_user_id: 'mw:user:another-explicit-id' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('Identity mapping conflicts with an existing mapping');
    expect(await db('knowledge_research_actor_identities')).toHaveLength(1);
    expect(await db('audit_logs')).toHaveLength(1);
  });

  it('documents the bearer-authenticated request and conflict/permission responses', async () => {
    const docsApp = Fastify();
    await docsApp.register(swagger, {
      openapi: {
        info: { title: 'Test API', version: '1.0.0' },
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      },
    });
    await docsApp.register(researchActorIdentityRoutes);
    await docsApp.ready();
    try {
      const operation = (
        docsApp.swagger().paths as Record<
          string,
          {
            post: {
              security: unknown;
              requestBody: {
                content: Record<string, { schema?: { additionalProperties?: boolean } }>;
              };
              responses: Record<string, unknown>;
            };
          }
        >
      )['/api/research/actor-identities']!.post;
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation.requestBody.content['application/json']?.schema?.additionalProperties).toBe(
        false
      );
      expect(Object.keys(operation.responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '403',
        '404',
        '409',
      ]);
    } finally {
      await docsApp.close();
    }
  });
});
