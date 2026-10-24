import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest, User } from '@moonwitness/orm-base';
import { manifest } from '../src/manifest.js';
import { provisionResearchActorIdentity } from '../src/research-actor-identity.js';

describe('governed research actor identity provisioning', () => {
  let db: Knex;
  let superadminId: number;
  let targetId: number;

  const request = (overrides: Record<string, unknown> = {}) => ({
    authenticatedProvisioner: { userId: superadminId, role: 'superadmin' as const },
    targetUserId: targetId,
    canonicalUserId: 'mw:user:explicit-test-target',
    reason: 'Approved synthetic identity mapping for a focused test.',
    requestId: 'identity-provision-test-0001',
    ...overrides,
  });

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
    User.knex(db);
    await installAddons(db, [baseManifest, manifest]);
    superadminId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
    targetId = Number((await db('users').where({ login: 'system' }).first('id'))?.id);
  });

  afterEach(async () => db.destroy());

  it('requires trusted superadmin context and validates explicit inputs', async () => {
    await expect(
      db.transaction((trx) =>
        provisionResearchActorIdentity(
          trx,
          request({ authenticatedProvisioner: { userId: superadminId, role: 'user' } })
        )
      )
    ).rejects.toThrow('authenticated active superadmin');
    await expect(
      db.transaction((trx) =>
        provisionResearchActorIdentity(
          trx,
          request({ authenticatedProvisioner: { userId: targetId, role: 'superadmin' } })
        )
      )
    ).rejects.toThrow('authenticated active superadmin');
    await expect(
      db.transaction((trx) =>
        provisionResearchActorIdentity(trx, request({ canonicalUserId: 'system' }))
      )
    ).rejects.toThrow('explicit identity fields');
    await expect(
      db.transaction((trx) => provisionResearchActorIdentity(trx, request({ reason: '  ' })))
    ).rejects.toThrow('explicit identity fields');
    await expect(
      db.transaction((trx) => provisionResearchActorIdentity(trx, request({ requestId: '' })))
    ).rejects.toThrow('explicit identity fields');
    expect(await db('knowledge_research_actor_identities')).toHaveLength(0);
  });

  it('fails closed for a missing or inactive target', async () => {
    await expect(
      db.transaction((trx) =>
        provisionResearchActorIdentity(trx, request({ targetUserId: 999999 }))
      )
    ).rejects.toThrow('does not exist or is inactive');
    await db('users').where({ id: targetId }).update({ active: false });
    await expect(
      db.transaction((trx) => provisionResearchActorIdentity(trx, request()))
    ).rejects.toThrow('does not exist or is inactive');
    expect(await db('knowledge_research_actor_identities')).toHaveLength(0);
  });

  it('inserts an explicit mapping and its append-only audit event atomically', async () => {
    const result = await db.transaction((trx) => provisionResearchActorIdentity(trx, request()));
    expect(result).toMatchObject({
      userId: targetId,
      canonicalUserId: 'mw:user:explicit-test-target',
      requestId: 'identity-provision-test-0001',
    });
    const mapping = await db('knowledge_research_actor_identities').first();
    expect(mapping).toMatchObject({
      user_id: targetId,
      canonical_user_id: 'mw:user:explicit-test-target',
      request_id: 'identity-provision-test-0001',
      provisioned_by_id: superadminId,
    });
    expect(await db('audit_logs').where({ record_id: result.id })).toMatchObject([
      {
        model: 'knowledge.research_actor_identity',
        operation: 'provision',
        actor_id: superadminId,
        changes: expect.stringContaining('identity-provision-test-0001'),
      },
    ]);
  });

  it('rejects duplicate user, canonical identity, and request ID without changing a mapping', async () => {
    await db.transaction((trx) => provisionResearchActorIdentity(trx, request()));
    const conflicts = [
      request({ canonicalUserId: 'mw:user:different' }),
      request({ targetUserId: superadminId, canonicalUserId: 'mw:user:other' }),
      request({
        targetUserId: superadminId,
        canonicalUserId: 'mw:user:other',
        requestId: 'identity-provision-test-0001',
      }),
    ];
    for (const input of conflicts) {
      await expect(
        db.transaction((trx) => provisionResearchActorIdentity(trx, input))
      ).rejects.toThrow('already provisioned');
    }
    expect(await db('knowledge_research_actor_identities')).toHaveLength(1);
    expect(await db('audit_logs')).toHaveLength(1);
  });

  it('replays the exact request without duplicating the mapping or audit event', async () => {
    const first = await db.transaction((trx) => provisionResearchActorIdentity(trx, request()));
    const replay = await db.transaction((trx) => provisionResearchActorIdentity(trx, request()));
    expect(replay).toEqual(first);
    expect(await db('knowledge_research_actor_identities')).toHaveLength(1);
    expect(await db('audit_logs')).toHaveLength(1);
  });

  it('rolls back the mapping when the audit insert fails', async () => {
    await db.raw(`
      CREATE TRIGGER fail_identity_audit BEFORE INSERT ON audit_logs
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END
    `);
    await expect(
      db.transaction((trx) => provisionResearchActorIdentity(trx, request()))
    ).rejects.toThrow('injected audit failure');
    expect(await db('knowledge_research_actor_identities')).toHaveLength(0);
    expect(await db('audit_logs')).toHaveLength(0);
  });

  it('protects provisioned mappings from update and deletion', async () => {
    const result = await db.transaction((trx) => provisionResearchActorIdentity(trx, request()));
    await expect(
      db('knowledge_research_actor_identities')
        .where({ id: result.id })
        .update({ canonical_user_id: 'mw:user:replacement' })
    ).rejects.toThrow('append-only');
    await expect(
      db('knowledge_research_actor_identities').where({ id: result.id }).delete()
    ).rejects.toThrow('append-only');
  });
});
