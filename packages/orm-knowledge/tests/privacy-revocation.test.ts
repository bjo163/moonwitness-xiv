import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest, Company, ModelAccess, User } from '@moonwitness/orm-base';
import {
  applyPrivacyRevocation,
  manifest,
  PrivacyRevocationError,
  readActivePrivacyProjections,
  type ApplyPrivacyRevocationInput,
  type AuthenticatedPrivacySteward,
} from '../src/index.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('persisted synthetic privacy revocation', () => {
  let db: Knex;
  let steward: AuthenticatedPrivacySteward;
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
    await installAddons(db, [baseManifest, manifest]);
    const user = await db('users').where({ login: 'superadmin' }).first('id');
    const company = await db('companies').first('id');
    if (!user || !company) throw new Error('Synthetic superadmin and company seed are required');
    User.knex(db);
    Company.knex(db);
    steward = { userId: Number(user.id), companyId: Number(company.id), role: 'superadmin' };
    companyId = Number(company.id);
  });

  afterEach(async () => db.destroy());

  function revocationInput(
    subjectRef = `synthetic-private-subject-${randomUUID()}`,
    consentDecisionRef = `synthetic-consent-decision-${randomUUID()}`,
    idempotencyKey = `privacy-revoke-${randomUUID()}`
  ): ApplyPrivacyRevocationInput {
    return {
      steward,
      subjectRefSha256: sha256(subjectRef),
      consentDecisionRefSha256: sha256(consentDecisionRef),
      idempotencyKey,
    };
  }

  async function addProjection(
    subjectHash: string,
    projectionKey = `search-${randomUUID()}`,
    projectionCompanyId = companyId,
    synthetic = true
  ) {
    await db('knowledge_privacy_projections').insert({
      company_id: projectionCompanyId,
      projection_key: projectionKey,
      subject_ref_sha256: subjectHash,
      projection_json: JSON.stringify({ excerpt: 'SYNTHETIC-PRIVATE-CANARY' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'SYNTHETIC-PRIVATE-CANARY' })),
      synthetic,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    return projectionKey;
  }

  it('atomically records only hashes and removes the subject from active search projections', async () => {
    const subjectRef = `synthetic-private-subject-${randomUUID()}`;
    const consentDecisionRef = `synthetic-consent-decision-${randomUUID()}`;
    const input = revocationInput(subjectRef, consentDecisionRef);
    const projectionKey = await addProjection(input.subjectRefSha256);
    const secondProjectionKey = await addProjection(input.subjectRefSha256);
    const otherCompany = await Company.query().insertAndFetch({
      name: `Synthetic isolation ${randomUUID()}`,
    });
    const otherCompanyProjectionKey = await addProjection(
      input.subjectRefSha256,
      `other-company-${randomUUID()}`,
      Number(otherCompany.id)
    );
    await db('knowledge_privacy_projections').insert({
      company_id: companyId,
      projection_key: `non-synthetic-${randomUUID()}`,
      subject_ref_sha256: input.subjectRefSha256,
      projection_json: JSON.stringify({ excerpt: 'NON-SYNTHETIC-CANARY' }),
      projection_digest: sha256(JSON.stringify({ excerpt: 'NON-SYNTHETIC-CANARY' })),
      synthetic: false,
      visibility: 'RESTRICTED',
      state: 'active',
    });
    const initialProjections = await readActivePrivacyProjections(db, steward);
    expect(
      initialProjections.find((projection) => projection.projectionKey === projectionKey)
    ).toMatchObject({
      content: { excerpt: 'SYNTHETIC-PRIVATE-CANARY' },
    });

    const result = await applyPrivacyRevocation(db, input);

    expect(result).toMatchObject({ replayed: false, invalidatedProjectionCount: 2 });
    const activeAfterRevocation = await readActivePrivacyProjections(db, steward);
    expect(
      activeAfterRevocation.some((projection) => projection.projectionKey === projectionKey)
    ).toBe(false);
    expect(
      activeAfterRevocation.some((projection) => projection.projectionKey === secondProjectionKey)
    ).toBe(false);
    const stored = await db('knowledge_privacy_revocations')
      .where({ id: result.revocationId })
      .first();
    expect(stored).toMatchObject({
      company_id: companyId,
      actor_id: steward.userId,
      subject_ref_sha256: input.subjectRefSha256,
      consent_decision_ref_sha256: input.consentDecisionRefSha256,
    });
    expect(JSON.stringify(stored)).not.toContain(subjectRef);
    expect(JSON.stringify(stored)).not.toContain(consentDecisionRef);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-PRIVATE-CANARY');
    await expect(
      db('knowledge_privacy_revocations')
        .where({ id: result.revocationId })
        .update({ decided_at: 'changed' })
    ).rejects.toThrow('append-only');
    await expect(
      db('knowledge_privacy_revocations').where({ id: result.revocationId }).delete()
    ).rejects.toThrow('append-only');
    const projection = await db('knowledge_privacy_projections')
      .where({ projection_key: projectionKey })
      .first();
    expect(projection).toMatchObject({
      state: 'revoked',
      projection_json: '{}',
      projection_digest: null,
    });
    const secondProjection = await db('knowledge_privacy_projections')
      .where({ projection_key: secondProjectionKey })
      .first();
    expect(secondProjection).toMatchObject({
      state: 'revoked',
      projection_json: '{}',
      projection_digest: null,
    });
    const otherCompanyProjection = await db('knowledge_privacy_projections')
      .where({ projection_key: otherCompanyProjectionKey })
      .first();
    expect(otherCompanyProjection).toMatchObject({
      company_id: otherCompany.id,
      state: 'active',
      projection_json: JSON.stringify({ excerpt: 'SYNTHETIC-PRIVATE-CANARY' }),
    });
    expect(
      await db('knowledge_privacy_projections')
        .where({
          company_id: companyId,
          subject_ref_sha256: input.subjectRefSha256,
          synthetic: false,
        })
        .first('state')
    ).toMatchObject({ state: 'active' });
  });

  it('does not record a withdrawal without an active synthetic projection', async () => {
    const input = revocationInput();
    await expect(applyPrivacyRevocation(db, input)).rejects.toMatchObject({
      code: 'SUBJECT_NOT_FOUND',
    });
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
  });

  it('replays an exact intent and rejects a conflicting decision', async () => {
    const input = revocationInput();
    await addProjection(input.subjectRefSha256);
    const first = await applyPrivacyRevocation(db, input);
    const replay = await applyPrivacyRevocation(db, input);
    expect(replay).toEqual({
      revocationId: first.revocationId,
      replayed: true,
      invalidatedProjectionCount: 0,
    });
    await expect(
      applyPrivacyRevocation(db, {
        ...input,
        subjectRefSha256: sha256(`different-${randomUUID()}`),
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const storedEvent = await db('knowledge_privacy_revocations')
      .where({ id: first.revocationId })
      .first('decided_at');
    expect(storedEvent?.decided_at).toEqual(expect.any(String));
    expect(new Date(String(storedEvent?.decided_at)).toISOString()).toBe(storedEvent?.decided_at);
    expect(await db('knowledge_privacy_revocations')).toHaveLength(1);
  });

  it('rolls the decision back if projection invalidation fails', async () => {
    const input = revocationInput();
    const projectionKey = await addProjection(input.subjectRefSha256);
    await db.raw(`
      CREATE TRIGGER fail_privacy_projection_invalidation
      BEFORE UPDATE ON knowledge_privacy_projections
      BEGIN SELECT RAISE(ABORT, 'fixture projection invalidation failure'); END
    `);

    await expect(applyPrivacyRevocation(db, input)).rejects.toThrow(
      'fixture projection invalidation failure'
    );
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
    const projection = await db('knowledge_privacy_projections')
      .where({ projection_key: projectionKey })
      .first();
    expect(projection).toMatchObject({ state: 'active' });
  });

  it('fails closed for a different company and rejects non-steward mutation', async () => {
    const input = revocationInput();
    await addProjection(input.subjectRefSha256);
    await expect(
      readActivePrivacyProjections(db, { ...steward, companyId: companyId + 999 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      readActivePrivacyProjections(db, { ...steward, role: 'user' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      applyPrivacyRevocation(db, {
        ...input,
        steward: { ...steward, role: 'user' },
      })
    ).rejects.toBeInstanceOf(PrivacyRevocationError);
    const activeProjections = await readActivePrivacyProjections(db, steward);
    expect(
      activeProjections.some(
        (projection) => projection.content.excerpt === 'SYNTHETIC-PRIVATE-CANARY'
      )
    ).toBe(true);
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
  });

  it('denies the privacy operations after the steward membership or group is deactivated', async () => {
    const input = revocationInput();
    await addProjection(input.subjectRefSha256);
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
    await expect(applyPrivacyRevocation(db, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);

    await db('group_memberships').where({ id: membership!.id }).update({ active: true });
    await db('access_groups').where({ id: membership!.group_id }).update({ active: false });
    await expect(readActivePrivacyProjections(db, steward)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(applyPrivacyRevocation(db, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await db('knowledge_privacy_revocations')).toHaveLength(0);
    expect(
      await db('knowledge_privacy_projections').where({
        subject_ref_sha256: input.subjectRefSha256,
        state: 'active',
      })
    ).toHaveLength(1);
  });

  it('keeps both privacy models unavailable through generic user model access', async () => {
    for (const modelName of ['knowledge.privacy_revocation', 'knowledge.privacy_projection']) {
      await expect(
        ModelAccess.query().findOne({ model_name: modelName, read: false, write: false })
      ).resolves.toBeDefined();
    }
  });

  it('fails closed when a stored projection digest does not match its JSON bytes', async () => {
    await db('knowledge_privacy_projections')
      .where({ projection_key: 'synthetic-search-001' })
      .update({ projection_digest: '0'.repeat(64) });

    await expect(readActivePrivacyProjections(db, steward)).rejects.toMatchObject({
      code: 'INVALID_STORED_PROJECTION',
    });
  });
});
