import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest, Company, User } from '@moonwitness/orm-base';
import { dispatchOneOutboxEvent, jobsManifest, OutboxEvent } from '@moonwitness/jobs';
import {
  enqueueNotification,
  manifest as notificationManifest,
  Notification,
  NotificationPreference,
  NotificationTemplate,
  registerNotificationOutboxConsumer,
} from '../src/index.js';

describe('notification addon', () => {
  let db: Knex;
  let unregisterConsumer: (() => void) | undefined;

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
    await installAddons(db, [baseManifest, jobsManifest, notificationManifest]);
  });

  afterEach(async () => {
    unregisterConsumer?.();
    await db.destroy();
  });

  async function enqueue(templateCode: string): Promise<number> {
    const company = await Company.query().first();
    const recipient = await User.query().findOne({ login: 'superadmin' });
    if (!company || !recipient) throw new Error('Required notification seed records are missing');
    return db.transaction((transaction) =>
      enqueueNotification(
        {
          recipientId: recipient.id,
          companyId: company.id,
          actorId: recipient.id,
          templateCode,
          resource: { model: 'base.partner', id: 3 },
        },
        transaction
      )
    );
  }

  async function idempotencyKey(eventId: number, channel: 'in_app' | 'email'): Promise<string> {
    const recipient = await User.query().findOne({ login: 'superadmin' });
    if (!recipient) throw new Error('Required notification recipient seed is missing');
    return `outbox:${eventId}:recipient:${recipient.id}:${channel}`;
  }

  it('installs idempotently and seeds templates, preferences, access, and menus', async () => {
    await installAddons(db, [baseManifest, jobsManifest, notificationManifest]);
    expect(notificationManifest.depends).toEqual(['base', 'jobs']);
    expect(notificationManifest.menus?.map(({ model }) => model).sort()).toEqual(
      notificationManifest.models.map(({ modelName }) => modelName).sort()
    );
    expect(await NotificationTemplate.query().count({ count: '*' }).first()).toMatchObject({
      count: 3,
    });
    expect(await NotificationPreference.query().count({ count: '*' }).first()).toMatchObject({
      count: 4,
    });
    expect(await Notification.query().count({ count: '*' }).first()).toMatchObject({ count: 0 });
  });

  it('delivers in-app notifications from outbox events with stable event-derived identity', async () => {
    unregisterConsumer = registerNotificationOutboxConsumer();
    const eventId = await enqueue('example.in_app');
    await expect(dispatchOneOutboxEvent('notifications-test-worker')).resolves.toBe(true);
    await expect(
      Notification.query().findOne({ idempotency_key: await idempotencyKey(eventId, 'in_app') })
    ).resolves.toMatchObject({
      channel: 'in_app',
      delivery_status: 'delivered',
      state: 'unread',
      resource_model: 'base.partner',
      resource_id: 3,
    });
    await expect(OutboxEvent.query().findById(eventId)).resolves.toMatchObject({
      status: 'published',
    });
  });

  it('suppresses the fake email channel without sending externally', async () => {
    unregisterConsumer = registerNotificationOutboxConsumer();
    const eventId = await enqueue('example.email');
    await expect(dispatchOneOutboxEvent('notifications-test-worker')).resolves.toBe(true);
    await expect(
      Notification.query().findOne({ idempotency_key: await idempotencyKey(eventId, 'email') })
    ).resolves.toMatchObject({
      channel: 'email',
      delivery_status: 'suppressed',
      state: 'archived',
      delivered_at: null,
    });
  });

  it('honors a recipient preference that disables in-app delivery', async () => {
    unregisterConsumer = registerNotificationOutboxConsumer();
    const company = await Company.query().first();
    const recipient = await User.query().findOne({ login: 'superadmin' });
    if (!company || !recipient) throw new Error('Required notification seed records are missing');
    await NotificationPreference.query()
      .where({ user_id: recipient.id, company_id: company.id, channel: 'in_app' })
      .patch({ enabled: false });
    const eventId = await enqueue('example.in_app');
    await expect(dispatchOneOutboxEvent('notifications-test-worker')).resolves.toBe(true);
    await expect(
      Notification.query().findOne({
        idempotency_key: `outbox:${eventId}:recipient:${recipient.id}:in_app`,
      })
    ).resolves.toMatchObject({ delivery_status: 'suppressed', state: 'archived' });
  });

  it('does not duplicate inbox rows when a successful consumer must be retried', async () => {
    unregisterConsumer = registerNotificationOutboxConsumer();
    const eventId = await enqueue('example.in_app');
    await db.raw(`
      CREATE TRIGGER reject_notification_ack
      BEFORE UPDATE ON outbox_events
      WHEN NEW.status = 'published'
      BEGIN SELECT RAISE(ABORT, 'ack unavailable'); END;
    `);
    await expect(dispatchOneOutboxEvent('notifications-test-worker')).resolves.toBe(true);
    expect(
      await Notification.query().where({ idempotency_key: await idempotencyKey(eventId, 'in_app') })
    ).toHaveLength(1);
    await db.raw('DROP TRIGGER reject_notification_ack');
    await OutboxEvent.query()
      .findById(eventId)
      .patch({
        available_at: new Date(0).toISOString(),
      });
    await expect(dispatchOneOutboxEvent('notifications-test-worker')).resolves.toBe(true);
    expect(
      await Notification.query().where({ idempotency_key: await idempotencyKey(eventId, 'in_app') })
    ).toHaveLength(1);
    await expect(OutboxEvent.query().findById(eventId)).resolves.toMatchObject({
      status: 'published',
    });
  });
});
