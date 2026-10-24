import { Model } from 'objection';
import knex, { type Knex } from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { manifest } from '../src/manifest.js';
import {
  expireDueWorkflows,
  listAvailableWorkflowDefinitions,
  startWorkflow,
  transitionWorkflow,
  WorkflowError,
} from '../src/runtime.js';
import { WorkflowEvent, WorkflowInstance } from '../src/models.js';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';

let db: Knex | undefined;

async function setup(): Promise<Knex> {
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  Model.knex(db);
  await installAddons(db, [baseManifest, jobsManifest, notificationManifest, manifest]);
  return db;
}

afterEach(async () => {
  if (db) await db.destroy();
  db = undefined;
});

async function actors(database: Knex) {
  const system = await database('users').where({ login: 'system' }).first('id');
  const admin = await database('users').where({ login: 'superadmin' }).first('id');
  const company = await database('companies').first('id');
  const partner = await database('partners').first('id');
  if (!system || !admin || !company || !partner) throw new Error('Base addon fixtures are missing');
  return {
    systemId: Number(system.id),
    adminId: Number(admin.id),
    companyId: Number(company.id),
    resourceId: Number(partner.id),
  };
}

function rejectAfterCommit(database: Knex, afterCommit?: () => Promise<void>): void {
  const transaction = database.transaction.bind(database);
  let rejectNextAcknowledgement = true;
  Object.defineProperty(database, 'transaction', {
    configurable: true,
    value: async (handler: unknown) => {
      const callback = handler as (trx: Knex.Transaction) => Promise<unknown>;
      const result = await transaction(callback);
      if (rejectNextAcknowledgement) {
        rejectNextAcknowledgement = false;
        await afterCommit?.();
        throw new Error('Simulated acknowledgement loss after commit');
      }
      return result;
    },
  });
}

describe('workflow addon', () => {
  it('seeds versioned example definition, access, menus, and views programmatically', async () => {
    const database = await setup();
    expect(await database('workflow_definitions').count({ count: '*' }).first()).toMatchObject({
      count: 1,
    });
    expect(await database('workflow_events').count({ count: '*' }).first()).toMatchObject({
      count: 0,
    });
    expect(
      await database('model_access')
        .where({ model_name: 'workflow.instance' })
        .count({ count: '*' })
        .first()
    ).toMatchObject({ count: 1 });
    expect(
      await database('_orm_addons').where({ name: 'workflow', version: '1.2.0' }).first()
    ).toBeDefined();
    await installAddons(database, [baseManifest, jobsManifest, notificationManifest, manifest]);
    expect(await database('workflow_definitions').count({ count: '*' }).first()).toMatchObject({
      count: 1,
    });
  });

  it('exposes reviewer workflows while distinguishing definitions the reviewer cannot start', async () => {
    const database = await setup();
    const definition = await database('workflow_definitions')
      .where({ code: 'sample.request_approval' })
      .first();
    if (!definition) throw new Error('Example workflow definition is missing');
    const config = JSON.parse(String(definition.config)) as Record<string, unknown>;
    await database('workflow_definitions')
      .where({ id: definition.id })
      .update({ config: JSON.stringify({ ...config, startRoles: ['system'] }) });

    await expect(
      listAvailableWorkflowDefinitions(database, 'base.partner', 'user')
    ).resolves.toMatchObject([{ code: 'sample.request_approval', canStart: false }]);
  });

  it('hides workflows from ineligible roles and ignores older definition versions', async () => {
    const database = await setup();
    const definition = await database('workflow_definitions')
      .where({ code: 'sample.request_approval' })
      .first();
    if (!definition) throw new Error('Example workflow definition is missing');
    await database('workflow_definitions').insert({
      code: definition.code,
      version: 0,
      name: 'Older request approval',
      config: definition.config,
      enabled: true,
    });
    const config = JSON.parse(String(definition.config)) as Record<string, unknown>;
    const transitions = config.transitions;
    if (!Array.isArray(transitions)) throw new Error('Example transitions are missing');
    await database('workflow_definitions')
      .where({ id: definition.id })
      .update({
        config: JSON.stringify({
          ...config,
          startRoles: ['system'],
          transitions: transitions.map((transition) => {
            if (typeof transition !== 'object' || transition === null) return transition;
            return { ...transition, roles: ['system'] };
          }),
        }),
      });

    await expect(
      listAvailableWorkflowDefinitions(database, 'base.partner', 'user')
    ).resolves.toEqual([]);
  });

  it('replays workflow starts and rejects key reuse by a different actor', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const input = {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system' as const,
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'repeat-start-key-01',
      now: new Date('2026-10-05T00:00:00.000Z'),
    };

    const first = await startWorkflow(database, input);
    const replay = await startWorkflow(database, input);

    expect(replay).toMatchObject({ id: first.id, revision: 0 });
    await expect(
      startWorkflow(database, { ...input, actorId: adminId, role: 'superadmin' })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      await database('workflow_instances').where({ id: first.id }).count({ count: '*' }).first()
    ).toMatchObject({ count: 1 });
    expect(
      await database('workflow_events')
        .where({ idempotency_key: 'start:repeat-start-key-01' })
        .count({ count: '*' })
        .first()
    ).toMatchObject({ count: 1 });
  });

  it('replays concurrent starts with one idempotency key as one workflow instance', async () => {
    const database = await setup();
    const { systemId, companyId, resourceId } = await actors(database);
    const input = {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system' as const,
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'concurrent-start-0001',
      now: new Date('2026-10-05T00:00:00.000Z'),
    };

    const results = await Promise.all([
      startWorkflow(database, input),
      startWorkflow(database, input),
    ]);

    expect(results[0]?.id).toBe(results[1]?.id);
    expect(await database('workflow_instances').count({ count: '*' }).first()).toMatchObject({
      count: 1,
    });
    expect(await database('workflow_events').count({ count: '*' }).first()).toMatchObject({
      count: 1,
    });
  });

  it('replays a committed start after a transaction acknowledgement failure', async () => {
    const database = await setup();
    const { systemId, companyId, resourceId } = await actors(database);
    const input = {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system' as const,
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'lost-start-ack-0001',
    };
    rejectAfterCommit(database);

    const result = await startWorkflow(database, input);

    expect(result).toMatchObject({ revision: 0, status: 'active' });
    expect(await database('workflow_instances').count({ count: '*' }).first()).toMatchObject({
      count: 1,
    });
  });

  it('replays a committed transition after a transaction acknowledgement failure', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'lost-action-start-01',
    });
    let replayChecks = 0;
    rejectAfterCommit(database);

    const result = await transitionWorkflow(database, {
      instanceId: started.id,
      companyId,
      actorId: adminId,
      role: 'superadmin',
      action: 'submit',
      expectedRevision: 0,
      idempotencyKey: 'lost-action-ack-0001',
      payload: { request: 'stable' },
      preparePayload: async () => ({ committed: true }),
      verifyPreparedPayloadReplay: async ({ trx, instance, event }) => {
        replayChecks += 1;
        expect(instance.id).toBe(started.id);
        expect(event.action).toBe('submit');
        expect(await trx('workflow_events').where({ id: event.id }).first()).toBeDefined();
      },
    });

    expect(result).toMatchObject({ currentState: 'submitted', revision: 1, status: 'active' });
    expect(await database('workflow_events').where({ instance_id: started.id })).toHaveLength(2);
    expect(replayChecks).toBe(1);
  });

  it('stores canonical transition payloads and checks them on idempotent replay', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'payload-start-key-01',
    });
    const input = {
      instanceId: started.id,
      companyId,
      actorId: adminId,
      role: 'superadmin' as const,
      action: 'submit',
      expectedRevision: 0,
      idempotencyKey: 'payload-action-key-01',
      payload: { z: [1, true], a: { second: 'two', first: 'one' } },
    };

    await transitionWorkflow(database, input);
    const stored = await database('workflow_events')
      .where({ idempotency_key: input.idempotencyKey })
      .first('payload');
    expect(stored?.payload).toBe('{"a":{"first":"one","second":"two"},"z":[1,true]}');
    expect(new WorkflowEvent().$formatJson({ payload: stored?.payload, action: 'submit' })).toEqual(
      {
        action: 'submit',
      }
    );
    await expect(
      transitionWorkflow(database, {
        ...input,
        payload: { a: { first: 'one', second: 'two' }, z: [1, true] },
      })
    ).resolves.toMatchObject({ currentState: 'submitted', revision: 1 });
    await expect(
      transitionWorkflow(database, { ...input, payload: { changed: true } })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      transitionWorkflow(database, { ...input, payload: { invalid: undefined } as never })
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    let tooDeep: unknown = 'leaf';
    for (let index = 0; index < 34; index += 1) tooDeep = [tooDeep];
    await expect(
      transitionWorkflow(database, { ...input, payload: tooDeep as never })
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    await expect(
      transitionWorkflow(database, { ...input, payload: 'x'.repeat(65_537) as never })
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
  });

  it('prepares event payloads from the locked transition and replays by stable request payload', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'prepared-start-key-01',
      now: new Date('2026-10-16T00:00:00.000Z'),
    });
    let prepareCalls = 0;
    let replayChecks = 0;
    const input = {
      instanceId: started.id,
      companyId,
      actorId: adminId,
      role: 'superadmin' as const,
      action: 'submit',
      expectedRevision: 0,
      idempotencyKey: 'prepared-action-key-01',
      payload: { subject: 'synthetic-subject', revision: 3 },
      now: new Date('2026-10-16T00:01:00.000Z'),
      preparePayload: async (context: {
        trx: Knex.Transaction;
        instance: { id: number; started_by_id: number; revision: number; current_state: string };
        action: string;
        fromState: string;
        toState: string;
        sequence: number;
        revision: number;
        actorId: number;
        role: string;
        idempotencyKey: string;
        eventTime: string;
      }) => {
        prepareCalls += 1;
        expect(Object.isFrozen(context.instance)).toBe(true);
        expect(context).toMatchObject({
          instance: {
            id: started.id,
            started_by_id: systemId,
            revision: 0,
            current_state: 'draft',
          },
          action: 'submit',
          fromState: 'draft',
          toState: 'submitted',
          sequence: 1,
          revision: 1,
          actorId: adminId,
          role: 'superadmin',
          idempotencyKey: input.idempotencyKey,
          eventTime: '2026-10-16T00:01:00.000Z',
        });
        await expect(
          context.trx('workflow_instances').where({ id: started.id }).first('revision')
        ).resolves.toMatchObject({ revision: 0 });
        return { requesterId: context.instance.started_by_id, subject: 'synthetic-subject' };
      },
      verifyPreparedPayloadReplay: async ({
        instance,
        event,
      }: {
        instance: { id: number };
        event: Record<string, unknown>;
      }) => {
        replayChecks += 1;
        expect(instance.id).toBe(started.id);
        expect(event.action).toBe('submit');
      },
    };

    await transitionWorkflow(database, input);
    const stored = await database('workflow_events')
      .where({ idempotency_key: input.idempotencyKey })
      .first('payload');
    expect(JSON.parse(String(stored?.payload))).toEqual({
      event: { requesterId: systemId, subject: 'synthetic-subject' },
      request: { revision: 3, subject: 'synthetic-subject' },
      workflowPreparedPayload: 1,
    });
    await expect(transitionWorkflow(database, input)).resolves.toMatchObject({
      revision: 1,
      currentState: 'submitted',
    });
    expect(prepareCalls).toBe(1);
    expect(replayChecks).toBe(1);

    const verifierError = new Error('injected read-only verifier failure');
    await expect(
      transitionWorkflow(database, {
        ...input,
        verifyPreparedPayloadReplay: () => {
          throw verifierError;
        },
      })
    ).rejects.toBe(verifierError);

    await expect(
      transitionWorkflow(database, {
        ...input,
        payload: { subject: 'different-subject', revision: 3 },
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      transitionWorkflow(database, {
        ...input,
        preparePayload: undefined,
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(prepareCalls).toBe(1);
  });

  it('rolls back state and event writes when the payload preparer fails', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'prepared-failure-start-01',
    });
    await expect(
      transitionWorkflow(database, {
        instanceId: started.id,
        companyId,
        actorId: adminId,
        role: 'superadmin',
        action: 'submit',
        expectedRevision: 0,
        idempotencyKey: 'prepared-failure-action-01',
        payload: { subject: 'synthetic-subject' },
        preparePayload: async (context) => {
          expect(context.instance.started_by_id).toBe(systemId);
          throw new Error('injected payload preparation failure');
        },
      })
    ).rejects.toThrow('injected payload preparation failure');

    await expect(
      database('workflow_instances').where({ id: started.id }).first('current_state', 'revision')
    ).resolves.toMatchObject({ current_state: 'draft', revision: 0 });
    await expect(
      database('workflow_events').where({ idempotency_key: 'prepared-failure-action-01' })
    ).resolves.toHaveLength(0);
  });

  it('rejects workflow event updates and deletes through ORM and raw SQL', async () => {
    const database = await setup();
    const { systemId, companyId, resourceId } = await actors(database);
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'immutable-start-0001',
    });
    const event = await database('workflow_events').where({ instance_id: started.id }).first('id');
    if (!event) throw new Error('Workflow start event is missing');

    await expect(
      database('workflow_events').where({ id: event.id }).update({ action: 'rewritten' })
    ).rejects.toThrow('Workflow events are append-only');
    await expect(database('workflow_events').where({ id: event.id }).delete()).rejects.toThrow(
      'Workflow events are append-only'
    );
    await expect(
      WorkflowEvent.query(database).findById(event.id).patch({ action: 'rewritten' })
    ).rejects.toThrow('Workflow events are append-only');
    await expect(WorkflowEvent.query(database).deleteById(event.id)).rejects.toThrow(
      'Workflow events are append-only'
    );
    await expect(
      database('workflow_events').where({ id: event.id }).first('action')
    ).resolves.toMatchObject({ action: 'start' });
  });

  it('rolls back the workflow transition when its event payload cannot be persisted', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'atomic-start-key-0001',
    });
    await database.raw(`
      CREATE TRIGGER fail_submit_event
      BEFORE INSERT ON workflow_events
      WHEN NEW.action = 'submit'
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END
    `);

    await expect(
      transitionWorkflow(database, {
        instanceId: started.id,
        companyId,
        actorId: adminId,
        role: 'superadmin',
        action: 'submit',
        expectedRevision: 0,
        idempotencyKey: 'atomic-action-key-0001',
        payload: { reason: 'synthetic test' },
      })
    ).rejects.toThrow('injected event failure');

    await expect(
      database('workflow_instances').where({ id: started.id }).first('current_state', 'revision')
    ).resolves.toMatchObject({ current_state: 'draft', revision: 0 });
    await expect(
      database('workflow_events').where({ idempotency_key: 'atomic-action-key-0001' })
    ).resolves.toHaveLength(0);
  });

  it('adds the nullable event payload column while upgrading legacy workflow rows', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'legacy-start-key-01',
    });
    await transitionWorkflow(database, {
      instanceId: started.id,
      companyId,
      actorId: adminId,
      role: 'superadmin',
      action: 'submit',
      expectedRevision: 0,
      idempotencyKey: 'legacy-action-key-01',
    });
    await database('_orm_addons').where({ name: 'workflow' }).update({ version: '1.0.0' });
    await database.schema.alterTable('workflow_events', (table) => table.dropColumn('payload'));

    await installAddons(database, [baseManifest, jobsManifest, notificationManifest, manifest]);

    const legacy = await database('workflow_events')
      .where({ idempotency_key: 'legacy-action-key-01' })
      .first('payload');
    expect(legacy?.payload).toBeNull();
    expect(
      await database('_orm_addons').where({ name: 'workflow' }).first('version')
    ).toMatchObject({
      version: '1.2.0',
    });
  });

  it('propagates start failures when no committed idempotency event exists', async () => {
    const database = await setup();
    const { systemId, companyId, resourceId } = await actors(database);
    const existing = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'preexisting-start-001',
    });
    Object.defineProperty(database, 'transaction', {
      configurable: true,
      value: async () => {
        throw new Error('Simulated transaction failure before commit');
      },
    });

    await expect(
      startWorkflow(database, {
        code: 'sample.request_approval',
        companyId,
        actorId: systemId,
        role: 'system',
        resourceModel: 'base.partner',
        resourceId,
        idempotencyKey: 'uncommitted-start-0001',
      })
    ).rejects.toThrow('Simulated transaction failure before commit');
    await expect(
      transitionWorkflow(database, {
        instanceId: existing.id,
        companyId,
        actorId: systemId,
        role: 'system',
        action: 'submit',
        expectedRevision: 0,
        idempotencyKey: 'uncommitted-action-01',
      })
    ).rejects.toThrow('Simulated transaction failure before commit');
  });

  it('enforces submitter separation, optimistic revision, approval quorum, snapshots, and idempotent retries', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const reviewerPartner = await database('partners')
      .insert({ name: 'Workflow reviewer' })
      .returning('id');
    const reviewerPartnerId = Number(
      typeof reviewerPartner[0] === 'object' ? reviewerPartner[0].id : reviewerPartner[0]
    );
    const reviewerUser = await database('users')
      .insert({ login: 'workflow-reviewer', partner_id: reviewerPartnerId, role: 'user' })
      .returning('id');
    const reviewerId = Number(
      typeof reviewerUser[0] === 'object' ? reviewerUser[0].id : reviewerUser[0]
    );
    const definition = await database('workflow_definitions')
      .where({ code: 'sample.request_approval' })
      .first();
    if (!definition) throw new Error('Example workflow definition is missing');
    const config = JSON.parse(String(definition.config)) as Record<string, unknown>;
    const transitions = config.transitions;
    if (!Array.isArray(transitions)) throw new Error('Example transitions are missing');
    const revisedTransitions = transitions.map((item) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        !('action' in item) ||
        item.action !== 'approve'
      )
        return item;
      return { ...item, requiredApprovals: 2 };
    });
    await database('workflow_definitions')
      .where({ id: definition.id })
      .update({ config: JSON.stringify({ ...config, transitions: revisedTransitions }) });

    const now = new Date('2026-10-05T00:00:00.000Z');
    const started = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: adminId,
      role: 'superadmin',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'start-request-0001',
      now,
    });
    expect(started).toMatchObject({ currentState: 'draft', revision: 0, status: 'active' });
    expect(
      await startWorkflow(database, {
        code: 'sample.request_approval',
        companyId,
        actorId: adminId,
        role: 'superadmin',
        resourceModel: 'base.partner',
        resourceId,
        idempotencyKey: 'start-request-0001',
        now,
      })
    ).toMatchObject({ id: started.id, revision: 0 });

    const submitted = await transitionWorkflow(database, {
      instanceId: started.id,
      companyId,
      actorId: adminId,
      role: 'superadmin',
      action: 'submit',
      expectedRevision: 0,
      idempotencyKey: 'submit-request-0001',
      now,
    });
    expect(submitted).toMatchObject({ currentState: 'submitted', revision: 1, status: 'active' });
    await expect(
      transitionWorkflow(database, {
        instanceId: started.id,
        companyId,
        actorId: adminId,
        role: 'superadmin',
        action: 'approve',
        expectedRevision: 1,
        idempotencyKey: 'self-approval-0001',
        now,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      transitionWorkflow(database, {
        instanceId: started.id,
        companyId,
        actorId: systemId,
        role: 'system',
        action: 'approve',
        expectedRevision: 0,
        idempotencyKey: 'stale-approval-0001',
        now,
      })
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });

    await database('workflow_definitions')
      .where({ id: definition.id })
      .update({ config: JSON.stringify({ ...config, transitions }) });
    const firstVote = await transitionWorkflow(database, {
      instanceId: started.id,
      companyId,
      actorId: systemId,
      role: 'system',
      action: 'approve',
      expectedRevision: 1,
      idempotencyKey: 'approve-vote-0001',
      now,
    });
    expect(firstVote).toMatchObject({ currentState: 'submitted', revision: 2, status: 'active' });
    await expect(
      transitionWorkflow(database, {
        instanceId: started.id,
        companyId,
        actorId: systemId,
        role: 'system',
        action: 'approve',
        expectedRevision: 2,
        idempotencyKey: 'duplicate-vote-0001',
        now,
      })
    ).rejects.toMatchObject({ code: 'DUPLICATE_APPROVAL' });
    const completed = await transitionWorkflow(database, {
      instanceId: started.id,
      companyId,
      actorId: reviewerId,
      role: 'user',
      action: 'approve',
      expectedRevision: 2,
      idempotencyKey: 'approve-vote-0002',
      now,
    });
    expect(completed).toMatchObject({ currentState: 'approved', revision: 3, status: 'completed' });
    expect(
      await transitionWorkflow(database, {
        instanceId: started.id,
        companyId,
        actorId: reviewerId,
        role: 'user',
        action: 'approve',
        expectedRevision: 2,
        idempotencyKey: 'approve-vote-0002',
        now,
      })
    ).toMatchObject({ revision: 3, status: 'completed' });
    expect(
      await database('workflow_events')
        .where({ instance_id: started.id })
        .count({ count: '*' })
        .first()
    ).toMatchObject({ count: 4 });
    expect(
      await database('workflow_approvals')
        .where({ instance_id: started.id })
        .count({ count: '*' })
        .first()
    ).toMatchObject({ count: 2 });
    const stored = await WorkflowInstance.query().findById(started.id);
    expect(stored?.definition_version).toBe(1);
  });

  it('isolates companies, records rejections, and expires overdue requests once', async () => {
    const database = await setup();
    const { systemId, adminId, companyId, resourceId } = await actors(database);
    const otherCompany = await database('companies')
      .insert({ name: 'Workflow Example Company' })
      .returning('id');
    const otherCompanyId = Number(
      typeof otherCompany[0] === 'object' ? otherCompany[0].id : otherCompany[0]
    );
    const now = new Date('2026-10-05T00:00:00.000Z');
    const rejected = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'reject-start-0001',
      now,
    });
    await expect(
      transitionWorkflow(database, {
        instanceId: rejected.id,
        companyId: otherCompanyId,
        actorId: adminId,
        role: 'superadmin',
        action: 'submit',
        expectedRevision: 0,
        idempotencyKey: 'cross-company-0001',
        now,
      })
    ).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' });
    await transitionWorkflow(database, {
      instanceId: rejected.id,
      companyId,
      actorId: adminId,
      role: 'superadmin',
      action: 'submit',
      expectedRevision: 0,
      idempotencyKey: 'reject-submit-0001',
      now,
    });
    const decision = await transitionWorkflow(database, {
      instanceId: rejected.id,
      companyId,
      actorId: adminId,
      role: 'superadmin',
      action: 'reject',
      expectedRevision: 1,
      idempotencyKey: 'reject-decision-0001',
      comment: 'Example rejection',
      now,
    });
    expect(decision).toMatchObject({ status: 'rejected', currentState: 'rejected' });
    expect(
      await database('workflow_approvals')
        .where({ instance_id: rejected.id, decision: 'rejected' })
        .count({ count: '*' })
        .first()
    ).toMatchObject({ count: 1 });

    const overdue = await startWorkflow(database, {
      code: 'sample.request_approval',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: 'base.partner',
      resourceId,
      idempotencyKey: 'timeout-start-0001',
      now: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
    });
    expect(await expireDueWorkflows(database, now)).toBe(1);
    expect(await expireDueWorkflows(database, now)).toBe(0);
    expect(await WorkflowInstance.query().findById(overdue.id)).toMatchObject({
      status: 'timed_out',
      revision: 1,
    });
    const timeoutEvents = await WorkflowEvent.query().where({
      instance_id: overdue.id,
      action: 'timeout',
    });
    expect(timeoutEvents).toHaveLength(1);
  });

  it('rejects malformed definitions and unauthorized resource models', async () => {
    const database = await setup();
    const { adminId, companyId, resourceId } = await actors(database);
    await expect(
      startWorkflow(database, {
        code: 'missing.workflow',
        companyId,
        actorId: adminId,
        role: 'superadmin',
        resourceModel: 'base.partner',
        resourceId,
        idempotencyKey: 'missing-definition-1',
      })
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      startWorkflow(database, {
        code: 'sample.request_approval',
        companyId,
        actorId: adminId,
        role: 'superadmin',
        resourceModel: 'base.user',
        resourceId,
        idempotencyKey: 'forbidden-resource-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('validates every workflow configuration and transition boundary', async () => {
    const database = await setup();
    const definition = await database('workflow_definitions')
      .where({ code: 'sample.request_approval' })
      .first();
    if (!definition) throw new Error('Example workflow definition is missing');
    const config = JSON.parse(String(definition.config)) as Record<string, unknown>;
    const transitions = config.transitions as Record<string, unknown>[];
    const firstTransition = transitions[0];
    if (!firstTransition) throw new Error('Example workflow transition is missing');
    const invalidConfigs = [
      '{',
      'null',
      JSON.stringify({ ...config, startState: 1 }),
      JSON.stringify({ ...config, startRoles: ['owner'] }),
      JSON.stringify({ ...config, timeoutMinutes: '60' }),
      JSON.stringify({ ...config, timeoutMinutes: 1.5 }),
      JSON.stringify({ ...config, timeoutMinutes: 0 }),
      JSON.stringify({ ...config, timeoutMinutes: 525601 }),
      JSON.stringify({ ...config, resourceModels: ['base'] }),
      JSON.stringify({ ...config, resourceModels: ['Invalid.Model'] }),
      JSON.stringify({ ...config, transitions: [] }),
      JSON.stringify({ ...config, transitions: [null] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, action: 1 }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, action: 'Bad Action' }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, from: 1 }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, to: 1 }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, roles: ['owner'] }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, roles: [] }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, requiredApprovals: 1.5 }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, requiredApprovals: 0 }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, requiredApprovals: 101 }] }),
      JSON.stringify({
        ...config,
        transitions: [{ ...firstTransition, requireDifferentActor: 1 }],
      }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, notifyStarter: 1 }] }),
      JSON.stringify({ ...config, transitions: [{ ...firstTransition, notifyStarter: 'x' }] }),
      JSON.stringify({ ...config, transitions: [firstTransition, firstTransition] }),
    ];

    for (const invalidConfig of invalidConfigs) {
      await database('workflow_definitions')
        .where({ id: definition.id })
        .update({ config: invalidConfig });
      await expect(
        listAvailableWorkflowDefinitions(database, 'base.partner', 'user')
      ).rejects.toMatchObject({ code: 'INVALID_DEFINITION' });
    }
  });
});
