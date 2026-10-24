import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { manifest } from '../src/manifest.js';
import { provisionResearchActorIdentity } from '../src/research-actor-identity.js';

const connectionString = process.env.POSTGRES_TEST_URL;
const postgresDescribe = connectionString ? describe : describe.skip;

postgresDescribe('governed research actor identity PostgreSQL integration', () => {
  const schema = `mw_identity_${randomUUID().replaceAll('-', '')}`;
  let adminDb: Knex;
  let db: Knex;

  beforeAll(async () => {
    if (!connectionString) throw new Error('POSTGRES_TEST_URL is required');
    adminDb = knex({ client: 'pg', connection: connectionString, pool: { min: 0, max: 2 } });
    await adminDb.raw('select 1');
    await adminDb.raw('create schema ??', [schema]);
    db = knex({
      client: 'pg',
      connection: connectionString,
      searchPath: [schema],
      pool: { min: 0, max: 2 },
    });
    await installAddons(db, [baseManifest, manifest]);
  }, 30000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (adminDb) {
      await adminDb.raw('drop schema if exists ?? cascade', [schema]);
      await adminDb.destroy();
    }
  });

  it('commits the mapping and audit event together and rolls both back on audit failure', async () => {
    const superadminId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    const targetId = Number((await db('users').where({ login: 'system' }).first('id'))?.id);
    if (!superadminId || !targetId) throw new Error('Synthetic base users are unavailable');
    const baseInput = {
      authenticatedProvisioner: { userId: superadminId, role: 'superadmin' as const },
      targetUserId: targetId,
      canonicalUserId: 'mw:user:postgres-integration-target',
      reason: 'Synthetic PostgreSQL integration mapping.',
      requestId: 'identity-provision-pg-0001',
    };
    const result = await db.transaction((trx) => provisionResearchActorIdentity(trx, baseInput));
    expect(await db('knowledge_research_actor_identities').where({ id: result.id })).toHaveLength(
      1
    );
    expect(
      await db('audit_logs').where({
        model: 'knowledge.research_actor_identity',
        record_id: result.id,
      })
    ).toHaveLength(1);
    await expect(
      db.transaction((trx) =>
        provisionResearchActorIdentity(trx, {
          ...baseInput,
          targetUserId: superadminId,
          canonicalUserId: 'mw:user:postgres-integration-other',
        })
      )
    ).rejects.toThrow('already provisioned');

    await db.raw(`
      CREATE FUNCTION mw_test_fail_identity_audit()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected PostgreSQL identity audit failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.raw(`
      CREATE TRIGGER mw_test_fail_identity_audit
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION mw_test_fail_identity_audit()
    `);
    await expect(
      db.transaction((trx) =>
        provisionResearchActorIdentity(trx, {
          ...baseInput,
          targetUserId: superadminId,
          canonicalUserId: 'mw:user:postgres-integration-rollback',
          requestId: 'identity-provision-pg-rollback-0001',
        })
      )
    ).rejects.toThrow('injected PostgreSQL identity audit failure');
    expect(
      await db('knowledge_research_actor_identities').where({
        canonical_user_id: 'mw:user:postgres-integration-rollback',
      })
    ).toHaveLength(0);
    expect(await db('audit_logs').where({ operation: 'provision' })).toHaveLength(1);
  }, 30000);
});
