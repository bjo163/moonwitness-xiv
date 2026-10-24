import { createHash, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { Company, manifest as baseManifest } from '@moonwitness/orm-base';
import { manifest } from '../src/manifest.js';
import {
  applyPrivacyRevocation,
  readActivePrivacyProjections,
  type AuthenticatedPrivacySteward,
} from '../src/privacy-revocation.js';

const connectionString = process.env.POSTGRES_TEST_URL;
const postgresDescribe = connectionString ? describe : describe.skip;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

postgresDescribe('synthetic privacy revocation PostgreSQL integration', () => {
  const schema = `mw_privacy_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `mw_privacy_test_${randomUUID().replaceAll('-', '')}`;
  let adminDb: Knex;
  let db: Knex;
  let steward: AuthenticatedPrivacySteward;

  beforeAll(async () => {
    if (!connectionString) throw new Error('POSTGRES_TEST_URL is required');
    adminDb = knex({ client: 'pg', connection: connectionString, pool: { min: 0, max: 2 } });
    await adminDb.raw('select 1');
    await adminDb.raw('create schema ??', [schema]);
    const testConnection = new URL(connectionString);
    testConnection.searchParams.set('application_name', applicationName);
    db = knex({
      client: 'pg',
      connection: testConnection.toString(),
      searchPath: [schema],
      pool: { min: 0, max: 2 },
    });
    await installAddons(db, [baseManifest, manifest]);
    Company.knex(db);
    const user = await db('users').where({ login: 'superadmin' }).first('id');
    const company = await db('companies').first('id');
    if (!user || !company) throw new Error('Synthetic superadmin and company seed are required');
    steward = { userId: Number(user.id), companyId: Number(company.id), role: 'superadmin' };
  }, 30000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (adminDb) {
      await adminDb.raw('drop schema if exists ?? cascade', [schema]);
      await adminDb.destroy();
    }
  });

  it('replays concurrent exact idempotency requests after the projection lock wait', async () => {
    const subjectRefSha256 = sha256(`synthetic-pg-race-${randomUUID()}`);
    const consentDecisionRefSha256 = sha256(`synthetic-pg-race-consent-${randomUUID()}`);
    const idempotencyKey = `privacy-pg-race-${randomUUID()}`;
    const projectionKey = `synthetic-search-race-${randomUUID()}`;
    const lockId = randomInt(1, 2_000_000_000);
    await db('knowledge_privacy_projections').insert({
      company_id: steward.companyId,
      projection_key: projectionKey,
      subject_ref_sha256: subjectRefSha256,
      projection_json: JSON.stringify({ excerpt: 'POSTGRES-CONCURRENCY-CANARY' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'POSTGRES-CONCURRENCY-CANARY' })),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    await db.raw(`
      CREATE FUNCTION hold_privacy_projection_update()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${lockId});
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.raw(`
      CREATE TRIGGER hold_privacy_projection_update
      BEFORE UPDATE ON knowledge_privacy_projections
      FOR EACH ROW EXECUTE FUNCTION hold_privacy_projection_update()
    `);

    const gate = await adminDb.transaction();
    await gate.raw('SELECT pg_advisory_lock(?)', [lockId]);
    const input = {
      steward,
      subjectRefSha256,
      consentDecisionRefSha256,
      idempotencyKey,
    };
    const pending: Promise<Awaited<ReturnType<typeof applyPrivacyRevocation>>>[] = [];
    const waitForLockWaiters = async (minimum: number) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await adminDb.raw(
          `SELECT count(*)::int AS count
           FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND query LIKE '%knowledge_privacy_projections%'
             AND application_name = ?
             AND pid <> pg_backend_pid()`,
          [applicationName]
        );
        if (Number(result.rows[0]?.count) >= minimum) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Expected ${minimum} privacy projection lock waiters`);
    };

    let waiterError: unknown;
    try {
      pending.push(applyPrivacyRevocation(db, input));
      await waitForLockWaiters(1);
      pending.push(applyPrivacyRevocation(db, input));
      await waitForLockWaiters(2);
    } catch (error) {
      waiterError = error;
    } finally {
      await gate.raw('SELECT pg_advisory_unlock(?)', [lockId]);
      await gate.commit();
    }

    if (waiterError) {
      await Promise.allSettled(pending);
      throw waiterError;
    }

    const results = await Promise.all(pending);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.revocationId)).size).toBe(1);
    expect(results.reduce((count, result) => count + result.invalidatedProjectionCount, 0)).toBe(1);
    expect(
      await db('knowledge_privacy_revocations').where({
        company_id: steward.companyId,
        idempotency_key: idempotencyKey,
      })
    ).toHaveLength(1);
    expect(
      await db('knowledge_privacy_projections').where({
        projection_key: projectionKey,
        state: 'active',
      })
    ).toHaveLength(0);
  }, 30000);

  it('atomically persists redaction, idempotent replay, tenant denial, and rollback', async () => {
    const subjectRef = `synthetic-pg-subject-${randomUUID()}`;
    const consentDecisionRef = `synthetic-pg-consent-${randomUUID()}`;
    const subjectRefSha256 = sha256(subjectRef);
    const consentDecisionRefSha256 = sha256(consentDecisionRef);
    const idempotencyKey = `privacy-pg-${randomUUID()}`;
    const projectionKey = `search-pg-${randomUUID()}`;
    const secondProjectionKey = `search-pg-second-${randomUUID()}`;
    const otherCompany = await Company.query().insertAndFetch({
      name: `Synthetic isolation ${randomUUID()}`,
    });
    const otherCompanyProjectionKey = `search-pg-other-company-${randomUUID()}`;
    await db('knowledge_privacy_projections').insert({
      company_id: steward.companyId,
      projection_key: projectionKey,
      subject_ref_sha256: subjectRefSha256,
      projection_json: JSON.stringify({ excerpt: 'POSTGRES-SYNTHETIC-CANARY' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'POSTGRES-SYNTHETIC-CANARY' })),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    await db('knowledge_privacy_projections').insert([
      {
        company_id: steward.companyId,
        projection_key: secondProjectionKey,
        subject_ref_sha256: subjectRefSha256,
        projection_json: JSON.stringify({ excerpt: 'POSTGRES-SYNTHETIC-CANARY-SECOND' }),
        projection_digest: sha256(JSON.stringify({ excerpt: 'POSTGRES-SYNTHETIC-CANARY-SECOND' })),
        synthetic: true,
        visibility: 'RESTRICTED',
        state: 'active',
      },
      {
        company_id: otherCompany.id,
        projection_key: otherCompanyProjectionKey,
        subject_ref_sha256: subjectRefSha256,
        projection_json: JSON.stringify({ excerpt: 'POSTGRES-OTHER-COMPANY-CANARY' }),
        projection_digest: sha256(JSON.stringify({ excerpt: 'POSTGRES-OTHER-COMPANY-CANARY' })),
        synthetic: true,
        visibility: 'RESTRICTED',
        state: 'active',
      },
    ]);
    const input = {
      steward,
      subjectRefSha256,
      consentDecisionRefSha256,
      idempotencyKey,
    };

    const first = await applyPrivacyRevocation(db, input);
    const replay = await applyPrivacyRevocation(db, input);
    expect(first).toMatchObject({ replayed: false, invalidatedProjectionCount: 2 });
    expect(replay).toEqual({
      revocationId: first.revocationId,
      replayed: true,
      invalidatedProjectionCount: 0,
    });
    const activeAfterRevocation = await readActivePrivacyProjections(db, steward);
    expect(activeAfterRevocation.map((projection) => projection.projectionKey)).toEqual([
      'synthetic-search-001',
    ]);
    expect(JSON.stringify(activeAfterRevocation)).not.toContain('POSTGRES-SYNTHETIC-CANARY');
    expect(
      activeAfterRevocation.some((projection) => projection.projectionKey === projectionKey)
    ).toBe(false);
    expect(
      activeAfterRevocation.some((projection) => projection.projectionKey === secondProjectionKey)
    ).toBe(false);
    const revocation = await db('knowledge_privacy_revocations')
      .where({ id: first.revocationId })
      .first();
    expect(JSON.stringify(revocation)).not.toContain(subjectRef);
    expect(JSON.stringify(revocation)).not.toContain(consentDecisionRef);
    expect(JSON.stringify(first)).not.toContain('POSTGRES-SYNTHETIC-CANARY');
    const revokedProjections = await db('knowledge_privacy_projections')
      .whereIn('projection_key', [projectionKey, secondProjectionKey])
      .orderBy('projection_key');
    expect(revokedProjections).toHaveLength(2);
    expect(revokedProjections.every((projection) => projection.state === 'revoked')).toBe(true);
    expect(revokedProjections.every((projection) => projection.projection_json === '{}')).toBe(
      true
    );
    expect(revokedProjections.every((projection) => projection.projection_digest === null)).toBe(
      true
    );
    const otherCompanyProjection = await db('knowledge_privacy_projections')
      .where({ projection_key: otherCompanyProjectionKey })
      .first();
    expect(otherCompanyProjection).toMatchObject({
      company_id: otherCompany.id,
      state: 'active',
      projection_json: JSON.stringify({ excerpt: 'POSTGRES-OTHER-COMPANY-CANARY' }),
    });
    await expect(
      readActivePrivacyProjections(db, { ...steward, companyId: steward.companyId + 999 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const rollbackSubject = `synthetic-pg-rollback-${randomUUID()}`;
    const rollbackSubjectSha256 = sha256(rollbackSubject);
    await db('knowledge_privacy_projections').insert({
      company_id: steward.companyId,
      projection_key: `search-pg-rollback-${randomUUID()}`,
      subject_ref_sha256: rollbackSubjectSha256,
      projection_json: JSON.stringify({ excerpt: 'ROLLBACK-SYNTHETIC-CANARY' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'ROLLBACK-SYNTHETIC-CANARY' })),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    await db.raw(`
      CREATE FUNCTION fail_privacy_projection_invalidation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'fixture projection invalidation failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.raw(`
      CREATE TRIGGER fail_privacy_projection_invalidation
      BEFORE UPDATE ON knowledge_privacy_projections
      FOR EACH ROW EXECUTE FUNCTION fail_privacy_projection_invalidation()
    `);
    await expect(
      applyPrivacyRevocation(db, {
        steward,
        subjectRefSha256: rollbackSubjectSha256,
        consentDecisionRefSha256: sha256(`synthetic-pg-rollback-consent-${randomUUID()}`),
        idempotencyKey: `privacy-pg-rollback-${randomUUID()}`,
      })
    ).rejects.toThrow('fixture projection invalidation failure');
    expect(
      await db('knowledge_privacy_revocations').where({
        subject_ref_sha256: rollbackSubjectSha256,
      })
    ).toHaveLength(0);
    expect(
      await db('knowledge_privacy_projections').where({
        subject_ref_sha256: rollbackSubjectSha256,
        state: 'active',
      })
    ).toHaveLength(1);
  }, 30000);

  it('denies reads and revocations when the PostgreSQL steward group membership is inactive', async () => {
    const subjectRefSha256 = sha256(`synthetic-pg-inactive-steward-${randomUUID()}`);
    const revocationCountBefore = await db('knowledge_privacy_revocations').count<
      { count: string }[]
    >('* as count');
    await db('knowledge_privacy_projections').insert({
      company_id: steward.companyId,
      projection_key: `search-pg-inactive-steward-${randomUUID()}`,
      subject_ref_sha256: subjectRefSha256,
      projection_json: JSON.stringify({ excerpt: 'POSTGRES-INACTIVE-STEWARD-CANARY' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'POSTGRES-INACTIVE-STEWARD-CANARY' })),
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    const membership = await db('group_memberships as membership')
      .join('access_groups as access_group', 'access_group.id', 'membership.group_id')
      .where({
        'membership.user_id': steward.userId,
        'access_group.code': 'knowledge_privacy_steward',
      })
      .select('membership.id', 'access_group.id as group_id')
      .first();
    expect(membership).toBeDefined();
    await db('group_memberships').where({ id: membership!.id }).update({ active: false });

    await expect(readActivePrivacyProjections(db, steward)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      applyPrivacyRevocation(db, {
        steward,
        subjectRefSha256,
        consentDecisionRefSha256: sha256(`synthetic-pg-inactive-consent-${randomUUID()}`),
        idempotencyKey: `privacy-pg-inactive-${randomUUID()}`,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await db('knowledge_privacy_projections').where({
        subject_ref_sha256: subjectRefSha256,
        state: 'active',
      })
    ).toHaveLength(1);
    const revocationCountAfter = await db('knowledge_privacy_revocations').count<
      { count: string }[]
    >('* as count');
    expect(Number(revocationCountAfter[0]?.count)).toBe(Number(revocationCountBefore[0]?.count));

    await db('group_memberships').where({ id: membership!.id }).update({ active: true });
    await db('access_groups').where({ id: membership!.group_id }).update({ active: false });
    await expect(readActivePrivacyProjections(db, steward)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      applyPrivacyRevocation(db, {
        steward,
        subjectRefSha256,
        consentDecisionRefSha256: sha256(`synthetic-pg-inactive-group-consent-${randomUUID()}`),
        idempotencyKey: `privacy-pg-inactive-group-${randomUUID()}`,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const revocationCountAfterInactiveGroup = await db('knowledge_privacy_revocations').count<
      { count: string }[]
    >('* as count');
    expect(Number(revocationCountAfterInactiveGroup[0]?.count)).toBe(
      Number(revocationCountBefore[0]?.count)
    );
    expect(
      await db('knowledge_privacy_projections').where({
        subject_ref_sha256: subjectRefSha256,
        state: 'active',
      })
    ).toHaveLength(1);
  }, 30000);
});
