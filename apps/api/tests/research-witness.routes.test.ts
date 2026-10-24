import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest, Company } from '@moonwitness/orm-base';
import {
  manifest as knowledgeManifest,
  syntheticWitnessSubjectRefSha256,
  WitnessTestimony,
} from '@moonwitness/orm-knowledge';
import { researchWitnessRoutes } from '../src/routes/research-witness.routes.js';
import { researchPrivacyRoutes } from '../src/routes/research-privacy.routes.js';

describe('owner-scoped synthetic witness API', () => {
  let db: Knex;
  let app: ReturnType<typeof Fastify>;
  let superadminId: number;
  let systemId: number;
  let companyId: number;
  let otherCompanyId: number;
  let scopedWitnessId: number;

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
    const otherCompany = await Company.query().insertAndFetch({
      name: 'Witness isolation fixture',
    });
    otherCompanyId = Number(otherCompany.id);
    await db('company_memberships').insert({
      user_id: superadminId,
      company_id: otherCompanyId,
      is_default: false,
    });
    scopedWitnessId = Number(
      (
        await db('knowledge_witness_testimonies')
          .where({ external_key: 'synthetic-witness-scoped-001' })
          .first('id')
      )?.id
    );

    app = Fastify();
    app.decorateRequest('auth', null);
    app.decorate('db', db);
    app.addHook('onRequest', async (request) => {
      const role = request.headers['x-test-role'];
      if (role === 'superadmin' || role === 'system' || role === 'user') {
        const userHeader = request.headers['x-test-user'];
        const companyHeader = request.headers['x-test-company'];
        request.auth = {
          userId: userHeader === 'system' ? systemId : superadminId,
          role,
          companyId: companyHeader === 'other' ? otherCompanyId : companyId,
          groupPermissions: [],
        };
      }
    });
    await app.register(researchWitnessRoutes);
    await app.register(researchPrivacyRoutes);
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it('requires authentication and a database-verified least-privilege steward', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
    });
    const ordinary = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
      headers: { 'x-test-role': 'user' },
    });
    const wrongRole = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
      headers: { 'x-test-role': 'system', 'x-test-user': 'system' },
    });
    const witnessGroup = await db('access_groups')
      .where({ code: 'knowledge_witness_steward' })
      .first('id');
    await db('group_memberships')
      .where({ user_id: superadminId, group_id: Number(witnessGroup?.id) })
      .delete();
    const missingStewardGrant = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
      headers: { 'x-test-role': 'superadmin' },
    });
    await db('group_memberships').insert({
      user_id: superadminId,
      group_id: Number(witnessGroup?.id),
    });
    const witnessMembershipId = Number(
      (
        await db('group_memberships')
          .where({ user_id: superadminId, group_id: Number(witnessGroup?.id) })
          .first('id')
      )?.id
    );
    await db('group_memberships').where({ id: witnessMembershipId }).update({ active: false });
    const inactiveStewardMembership = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
      headers: { 'x-test-role': 'superadmin' },
    });
    await db('group_memberships').where({ id: witnessMembershipId }).update({ active: true });
    await db('access_groups').where({ id: witnessGroup?.id }).update({ active: false });
    const inactiveStewardGroup = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
      headers: { 'x-test-role': 'superadmin' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(ordinary.statusCode).toBe(403);
    expect(wrongRole.statusCode).toBe(403);
    expect(missingStewardGrant.statusCode).toBe(403);
    expect(inactiveStewardMembership.statusCode).toBe(403);
    expect(inactiveStewardGroup.statusCode).toBe(403);
    expect(ordinary.body).not.toContain('Synthetic owner-scoped example');
  });

  it('returns only the authenticated owner’s restricted synthetic record and provenance', async () => {
    await db('knowledge_witness_corrections').insert({
      testimony_id: scopedWitnessId,
      sequence: 2,
      correction_text: 'NON-SYNTHETIC-WITNESS-CHILD-CANARY',
      reason: 'Test that non-synthetic corrections are excluded.',
      source_label: 'Unclassified test record',
      source_locator: 'fixture://unclassified-child',
      source_digest: '8'.repeat(64),
      asserted_time_text: 'unknown',
      asserted_time_precision: 'unknown',
      synthetic: false,
      recorded_by_id: superadminId,
    });
    await db('knowledge_witness_interpretations').insert({
      testimony_id: scopedWitnessId,
      assertion_ref: 'assertion://unclassified-child',
      evidence_ref: 'evidence://unclassified-child',
      interpretation_text: 'NON-SYNTHETIC-WITNESS-CHILD-CANARY',
      method_label: 'Unclassified test record',
      method_version: '1',
      epistemic_status: 'hypothesis',
      visibility: 'RESTRICTED',
      synthetic: false,
      recorded_by_id: superadminId,
    });
    await db('knowledge_witness_corrections').insert({
      testimony_id: scopedWitnessId,
      sequence: 3,
      correction_text: 'INACTIVE-WITNESS-CHILD-CANARY',
      reason: 'Test that inactive corrections are excluded.',
      source_label: 'Inactive test record',
      source_locator: 'fixture://inactive-child',
      source_digest: '7'.repeat(64),
      asserted_time_text: 'unknown',
      asserted_time_precision: 'unknown',
      synthetic: true,
      active: false,
      recorded_by_id: superadminId,
    });
    await db('knowledge_witness_interpretations').insert({
      testimony_id: scopedWitnessId,
      assertion_ref: 'assertion://inactive-child',
      evidence_ref: 'evidence://inactive-child',
      interpretation_text: 'INACTIVE-WITNESS-CHILD-CANARY',
      method_label: 'Inactive test record',
      method_version: '1',
      epistemic_status: 'hypothesis',
      visibility: 'RESTRICTED',
      synthetic: true,
      active: false,
      recorded_by_id: superadminId,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
      headers: { 'x-test-role': 'superadmin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        id: scopedWitnessId,
        external_key: 'synthetic-witness-scoped-001',
        original_text: 'Synthetic owner-scoped example: a lamp was near the doorway.',
        corrections: [
          {
            sequence: 1,
            correction_text: 'Synthetic correction: the lamp was beside the side entrance.',
          },
        ],
        interpretations: [
          {
            assertion_ref: 'assertion://synthetic/witness-scoped-001',
            epistemic_status: 'hypothesis',
          },
        ],
      },
    });
    expect(response.body).not.toContain('created_by_id');
    expect(response.body).not.toContain('company_id');
    expect(response.body).not.toContain('NON-SYNTHETIC-WITNESS-CHILD-CANARY');
    expect(response.body).not.toContain('INACTIVE-WITNESS-CHILD-CANARY');
    expect(response.json().data.corrections).toHaveLength(1);
    expect(response.json().data.interpretations).toHaveLength(1);
  });

  it('conceals an owned synthetic witness after its tenant-scoped privacy withdrawal', async () => {
    const externalKey = 'synthetic-witness-scoped-001';
    const subjectRefSha256 = syntheticWitnessSubjectRefSha256(companyId, externalKey);
    const projection = JSON.stringify({ canary: 'SYNTHETIC-WITNESS-REVOCATION-CANARY' });
    const projectionDigest = createHash('sha256').update(projection).digest('hex');
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: 'synthetic-witness-withdrawal-fixture',
      subject_ref_sha256: subjectRefSha256,
      projection_json: projection,
      projection_digest: projectionDigest,
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });

    const withdrawal = await app.inject({
      method: 'POST',
      url: '/api/research/privacy/revocations',
      headers: { 'x-test-role': 'superadmin' },
      payload: {
        subject_ref_sha256: subjectRefSha256,
        consent_decision_ref_sha256: createHash('sha256')
          .update('synthetic-consent-decision-fixture')
          .digest('hex'),
        idempotency_key: 'witness-withdrawal-001',
      },
    });
    const concealedRead = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
      headers: { 'x-test-role': 'superadmin' },
    });

    expect(withdrawal.statusCode).toBe(201);
    expect(concealedRead.statusCode).toBe(404);
    expect(concealedRead.body).toBe(
      JSON.stringify({ success: false, error: 'Witness record not found' })
    );
    expect(concealedRead.body).not.toContain('Synthetic owner-scoped example');
    expect(await db('knowledge_witness_testimonies').where({ id: scopedWitnessId })).toHaveLength(
      1
    );
  });

  it('hides guessed, non-synthetic, wrong-owner and foreign-tenant records identically', async () => {
    const nonSynthetic = await WitnessTestimony.query().insertAndFetch({
      external_key: 'non-synthetic-witness-fixture',
      original_text: 'Non-synthetic fixture must remain invisible.',
      source_label: 'Test-only unclassified record',
      source_locator: 'fixture://non-synthetic',
      source_digest: 'f'.repeat(64),
      received_time_text: 'unknown',
      received_time_precision: 'unknown',
      visibility: 'RESTRICTED',
      synthetic: false,
      company_id: companyId,
      created_by_id: superadminId,
    });
    const foreignTenant = await WitnessTestimony.query().insertAndFetch({
      external_key: 'foreign-tenant-witness-fixture',
      original_text: 'Foreign tenant synthetic fixture.',
      source_label: 'Test-only tenant fixture',
      source_locator: 'fixture://foreign-tenant',
      source_digest: '9'.repeat(64),
      received_time_text: 'unknown',
      received_time_precision: 'unknown',
      visibility: 'RESTRICTED',
      synthetic: true,
      company_id: otherCompanyId,
      created_by_id: superadminId,
    });
    const wrongOwner = await WitnessTestimony.query().insertAndFetch({
      external_key: 'wrong-owner-witness-fixture',
      original_text: 'Synthetic fixture owned by another user.',
      source_label: 'Test-only owner fixture',
      source_locator: 'fixture://wrong-owner',
      source_digest: '6'.repeat(64),
      received_time_text: 'unknown',
      received_time_precision: 'unknown',
      visibility: 'RESTRICTED',
      synthetic: true,
      company_id: companyId,
      created_by_id: systemId,
    });
    const inactiveTestimony = await WitnessTestimony.query().insertAndFetch({
      external_key: 'inactive-witness-fixture',
      original_text: 'Inactive synthetic testimony.',
      source_label: 'Test-only inactive fixture',
      source_locator: 'fixture://inactive',
      source_digest: '5'.repeat(64),
      received_time_text: 'unknown',
      received_time_precision: 'unknown',
      visibility: 'RESTRICTED',
      synthetic: true,
      active: false,
      company_id: companyId,
      created_by_id: superadminId,
    });
    const inaccessibleIds = [
      Number(nonSynthetic.id),
      Number(foreignTenant.id),
      Number(wrongOwner.id),
      Number(inactiveTestimony.id),
      999999,
    ];
    const responses = await Promise.all(
      inaccessibleIds.map((id) =>
        app.inject({
          method: 'GET',
          url: `/api/research/witnesses/${id}`,
          headers: { 'x-test-role': 'superadmin' },
        })
      )
    );
    const crossTenantResponse = await app.inject({
      method: 'GET',
      url: `/api/research/witnesses/${scopedWitnessId}`,
      headers: { 'x-test-role': 'superadmin', 'x-test-company': 'other' },
    });
    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);
    expect(crossTenantResponse.statusCode).toBe(404);
    expect(crossTenantResponse.body).toBe(responses[4]?.body);
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
    expect(responses.every((response) => !response.body.includes('Foreign tenant'))).toBe(true);
  });

  it('exposes no witness list, create, update or delete endpoint', async () => {
    const responses = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/research/witnesses',
        headers: { 'x-test-role': 'superadmin' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/research/witnesses/${scopedWitnessId}`,
        headers: { 'x-test-role': 'superadmin' },
        payload: {},
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/research/witnesses/${scopedWitnessId}`,
        headers: { 'x-test-role': 'superadmin' },
        payload: {},
      }),
      app.inject({
        method: 'DELETE',
        url: `/api/research/witnesses/${scopedWitnessId}`,
        headers: { 'x-test-role': 'superadmin' },
      }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404]);
    expect(
      await db('knowledge_witness_testimonies').where({
        external_key: 'synthetic-witness-scoped-001',
      })
    ).toHaveLength(1);
  });

  it('rejects malformed witness identifiers before database lookup', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/research/witnesses/01',
      headers: { 'x-test-role': 'superadmin' },
    });
    expect(response.statusCode).toBe(400);
  });
});
