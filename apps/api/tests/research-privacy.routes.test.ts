import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { manifest as knowledgeManifest } from '@moonwitness/orm-knowledge';
import { researchPrivacyRoutes } from '../src/routes/research-privacy.routes.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('synthetic research privacy API', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let superadminId: number;
  let systemId: number;
  let companyId: number;
  let unassignedCompanyId: number;

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
    systemId = Number((await db('users').where({ login: 'system' }).first('id'))?.id);
    companyId = Number((await db('companies').first('id'))?.id);
    const unassignedCompany = await db('companies')
      .insert({ name: 'Synthetic Unassigned Privacy Test Company', timezone: 'UTC' })
      .returning('id');
    unassignedCompanyId = Number(unassignedCompany[0]?.id);
    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request) => {
      const role = request.headers['x-test-role'];
      if (role === 'superadmin' || role === 'user') {
        request.auth = {
          userId: request.headers['x-test-user'] === 'system' ? systemId : superadminId,
          role,
          companyId:
            request.headers['x-test-company'] === 'unassigned' ? unassignedCompanyId : companyId,
          groupPermissions: [],
        };
      }
    });
    await app.register(researchPrivacyRoutes);
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  function body(overrides: Record<string, unknown> = {}) {
    return {
      subject_ref_sha256: sha256('synthetic-api-subject'),
      consent_decision_ref_sha256: sha256('synthetic-api-consent'),
      idempotency_key: 'synthetic-api-revoke-0001',
      ...overrides,
    };
  }

  it('requires authentication and denies ordinary users and non-stewards', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/research/privacy/projections',
    });
    const ordinary = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers: { 'x-test-role': 'user' },
      payload: body(),
    });
    const nonSteward = await app.inject({
      method: 'GET',
      url: '/api/research/privacy/projections',
      headers: { 'x-test-role': 'superadmin', 'x-test-user': 'system' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(ordinary.statusCode).toBe(403);
    expect(nonSteward.statusCode).toBe(403);
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
  });

  it('denies projection reads and revocations after steward membership or group deactivation', async () => {
    const subjectHash = sha256('inactive-steward-api-subject');
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: 'inactive-steward-api-search-001',
      subject_ref_sha256: subjectHash,
      projection_json: JSON.stringify({ excerpt: 'INACTIVE-STEWARD-CANARY' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'INACTIVE-STEWARD-CANARY' })),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    const stewardMembership = await db('group_memberships as membership')
      .join('access_groups as access_group', 'access_group.id', 'membership.group_id')
      .where({
        'membership.user_id': superadminId,
        'access_group.code': 'knowledge_privacy_steward',
      })
      .select('membership.id', 'access_group.id as group_id')
      .first();
    expect(stewardMembership).toBeDefined();

    const getProjections = () =>
      app.inject({
        method: 'GET',
        url: '/api/research/privacy/projections',
        headers: { 'x-test-role': 'superadmin' },
      });
    const revoke = () =>
      app.inject({
        method: 'POST',
        url: '/api/research/privacy/revocations',
        headers: { 'x-test-role': 'superadmin' },
        payload: body({ subject_ref_sha256: subjectHash }),
      });

    await db('group_memberships').where({ id: stewardMembership!.id }).update({ active: false });
    expect(
      await db('group_memberships').where({ id: stewardMembership!.id }).first('active')
    ).toMatchObject({ active: 0 });
    const inactiveMembershipGet = await getProjections();
    const inactiveMembershipPost = await revoke();
    expect(inactiveMembershipGet.statusCode).toBe(403);
    expect(inactiveMembershipPost.statusCode).toBe(403);
    expect(inactiveMembershipGet.body).not.toContain('INACTIVE-STEWARD-CANARY');
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);

    await db('group_memberships').where({ id: stewardMembership!.id }).update({ active: true });
    await db('access_groups').where({ id: stewardMembership!.group_id }).update({ active: false });
    const inactiveGroupGet = await getProjections();
    const inactiveGroupPost = await revoke();
    expect(inactiveGroupGet.statusCode).toBe(403);
    expect(inactiveGroupPost.statusCode).toBe(403);
    expect(inactiveGroupGet.body).not.toContain('INACTIVE-STEWARD-CANARY');
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
    expect(
      await db('knowledge_privacy_projections').where({
        subject_ref_sha256: subjectHash,
        state: 'active',
      })
    ).toHaveLength(1);
  });

  it('rejects raw references, forged actor/tenant fields, and malformed hashes', async () => {
    const rawReference = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers: { 'x-test-role': 'superadmin' },
      payload: body({ subject_ref: 'real-person@example.test' }),
    });
    const forgedActor = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers: { 'x-test-role': 'superadmin' },
      payload: body({ actor_id: systemId, company_id: companyId + 1 }),
    });
    const malformedHash = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers: { 'x-test-role': 'superadmin' },
      payload: body({ subject_ref_sha256: 'not-a-digest' }),
    });
    expect(rawReference.statusCode).toBe(400);
    expect(forgedActor.statusCode).toBe(400);
    expect(malformedHash.statusCode).toBe(400);
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
  });

  it('denies a valid but unassigned tenant for projection reads and revocation writes', async () => {
    const subjectHash = sha256('cross-tenant-synthetic-subject');
    const projectionJson = JSON.stringify({ excerpt: 'CROSS-TENANT-SYNTHETIC-CANARY' });
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: 'cross-tenant-synthetic-search-001',
      subject_ref_sha256: subjectHash,
      projection_json: projectionJson,
      projection_digest: sha256(projectionJson),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });

    const headers = { 'x-test-role': 'superadmin', 'x-test-company': 'unassigned' };
    const read = await app.inject({
      method: 'GET',
      url: '/api/research/privacy/projections',
      headers,
    });
    const revoke = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers,
      payload: body({ subject_ref_sha256: subjectHash }),
    });

    expect(read.statusCode).toBe(403);
    expect(read.body).not.toContain('CROSS-TENANT-SYNTHETIC-CANARY');
    expect(revoke.statusCode).toBe(403);
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
    expect(
      await db('knowledge_privacy_projections')
        .where({ projection_key: 'cross-tenant-synthetic-search-001' })
        .first('state')
    ).toMatchObject({ state: 'active' });
  });

  it('records a hash-only withdrawal, clears one projection, and replays idempotently', async () => {
    const subjectRef = 'synthetic-api-subject';
    const consentDecisionRef = 'synthetic-api-consent';
    const subjectHash = sha256(subjectRef);
    const consentHash = sha256(consentDecisionRef);
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: 'synthetic-api-search-001',
      subject_ref_sha256: subjectHash,
      projection_json: JSON.stringify({ excerpt: 'SYNTHETIC-API-ONLY-CANARY' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'SYNTHETIC-API-ONLY-CANARY' })),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/research/privacy/revocations',
        headers: { 'x-test-role': 'superadmin' },
        payload: body(),
      });

    const first = await send();
    const replay = await send();
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json()).toMatchObject({
      success: true,
      data: { replayed: false, invalidated_projection_count: 1 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ success: true, data: { replayed: true } });
    expect(first.body).not.toContain('synthetic-api-subject');
    expect(first.body).not.toContain('synthetic-api-consent');
    expect(
      await db('knowledge_privacy_projections').where({
        projection_key: 'synthetic-api-search-001',
        state: 'active',
      })
    ).toHaveLength(0);
    expect(await db('knowledge_privacy_revocations')).toHaveLength(1);

    const afterRevocation = await app.inject({
      method: 'GET',
      url: '/api/research/privacy/projections',
      headers: { 'x-test-role': 'superadmin' },
    });
    expect(afterRevocation.statusCode).toBe(200);
    expect(afterRevocation.headers['cache-control']).toBe('private, no-store');
    expect(afterRevocation.body).not.toContain('SYNTHETIC-API-ONLY-CANARY');
    expect(afterRevocation.body).not.toContain('synthetic-api-search-001');
    expect(afterRevocation.body).not.toContain(subjectRef);
    expect(afterRevocation.body).not.toContain(consentDecisionRef);
    expect(afterRevocation.body).not.toContain(subjectHash);
    expect(afterRevocation.body).not.toContain(consentHash);
  });

  it('keeps reactivated or reinserted projections hidden after a subject withdrawal', async () => {
    const subjectHash = sha256('synthetic-resurrection-subject');
    const initialJson = JSON.stringify({ excerpt: 'SYNTHETIC-ORIGINAL-CANARY' });
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: 'synthetic-resurrection-search-001',
      subject_ref_sha256: subjectHash,
      projection_json: initialJson,
      projection_digest: sha256(initialJson),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });

    const withdrawal = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers: { 'x-test-role': 'superadmin' },
      payload: body({
        subject_ref_sha256: subjectHash,
        idempotency_key: 'synthetic-resurrection-revoke-001',
      }),
    });
    expect(withdrawal.statusCode).toBe(201);
    expect(withdrawal.json().data.invalidated_projection_count).toBe(1);

    // Simulate a stale writer reactivating the tombstoned row and inserting a
    // fresh projection for the same subject after the withdrawal committed.
    const reactivatedJson = JSON.stringify({ excerpt: 'SYNTHETIC-REACTIVATED-CANARY' });
    await db('knowledge_privacy_projections')
      .where({ company_id: companyId, projection_key: 'synthetic-resurrection-search-001' })
      .update({
        projection_json: reactivatedJson,
        projection_digest: sha256(reactivatedJson),
        state: 'active',
        revoked_at: null,
      });
    const reinsertedJson = JSON.stringify({ excerpt: 'SYNTHETIC-REINSERTED-CANARY' });
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: 'synthetic-resurrection-search-002',
      subject_ref_sha256: subjectHash,
      projection_json: reinsertedJson,
      projection_digest: sha256(reinsertedJson),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/research/privacy/projections',
      headers: { 'x-test-role': 'superadmin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).not.toContain('SYNTHETIC-REACTIVATED-CANARY');
    expect(response.body).not.toContain('SYNTHETIC-REINSERTED-CANARY');
    expect(response.body).not.toContain('synthetic-resurrection-search-001');
    expect(response.body).not.toContain('synthetic-resurrection-search-002');
  });

  it('rejects a client-supplied decision timestamp', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers: { 'x-test-role': 'superadmin' },
      payload: body({ decided_at: '1900-01-01T00:00:00.000Z' }),
    });
    expect(response.statusCode).toBe(400);
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
  });

  it('does not accept a withdrawal for a matching non-synthetic projection', async () => {
    const subjectHash = sha256('non-synthetic-subject');
    const projectionJson = JSON.stringify({ excerpt: 'NON-SYNTHETIC-PRIVATE-CANARY' });
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: 'non-synthetic-private-projection',
      subject_ref_sha256: subjectHash,
      projection_json: projectionJson,
      projection_digest: sha256(projectionJson),
      synthetic: false,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers: { 'x-test-role': 'superadmin' },
      payload: body({ subject_ref_sha256: subjectHash }),
    });
    expect(response.statusCode).toBe(404);
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
    expect(
      await db('knowledge_privacy_projections')
        .where({ projection_key: 'non-synthetic-private-projection' })
        .first('state')
    ).toMatchObject({ state: 'active' });
  });

  it('returns only active privacy projections and never their subject hashes', async () => {
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: 'non-synthetic-private-projection',
      subject_ref_sha256: sha256('non-synthetic-subject'),
      projection_json: JSON.stringify({ excerpt: 'MUST-NOT-RETURN' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'MUST-NOT-RETURN' })),
      synthetic: false,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/research/privacy/projections',
      headers: { 'x-test-role': 'superadmin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json().data).toMatchObject([
      {
        projection_key: 'synthetic-search-001',
        content: { excerpt: 'Synthetic privacy projection only; no witness data.' },
      },
    ]);
    expect(response.body).not.toContain(
      '357a432635adf14e8fcde203cfc900cb0ad8e43d9768a59a9052a4f52aca7623'
    );
    expect(response.body).not.toContain('MUST-NOT-RETURN');
  });
});
