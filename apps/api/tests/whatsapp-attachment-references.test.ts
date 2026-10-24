import knex, { type Knex } from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { whatsappAttachmentReferences } from '../src/commands/whatsapp-attachment-references.js';

describe('WhatsApp attachment references', () => {
  let db: Knex | null = null;

  afterEach(async () => {
    await db?.destroy();
    db = null;
  });

  it('keeps status media, message media, thumbnails, contact and group avatars, and unexpired upload objects', async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await db.schema.createTable('whatsapp_messages', (table) => {
      table.string('media_key');
      table.string('media_thumbnail_key');
    });
    await db.schema.createTable('whatsapp_statuses', (table) => {
      table.string('media_key');
    });
    await db.schema.createTable('whatsapp_conversations', (table) => {
      table.string('contact_avatar_key');
      table.string('group_avatar_key');
    });
    await db.schema.createTable('whatsapp_upload_tickets', (table) => {
      table.string('storage_key');
      table.string('expires_at');
    });

    await db('whatsapp_messages').insert({
      media_key: 'message-media',
      media_thumbnail_key: 'message-thumbnail',
    });
    await db('whatsapp_statuses').insert({ media_key: 'status-media' });
    await db('whatsapp_conversations').insert({
      contact_avatar_key: 'contact-avatar',
      group_avatar_key: 'group-avatar',
    });
    await db('whatsapp_upload_tickets').insert([
      { storage_key: 'active-upload', expires_at: '2026-10-25T12:00:01.000Z' },
      { storage_key: 'expired-upload', expires_at: '2026-10-25T11:59:59.000Z' },
    ]);

    const references = [];
    for await (const reference of whatsappAttachmentReferences(
      db,
      new Date('2026-10-25T12:00:00.000Z')
    )) {
      references.push(reference.storageKey);
    }

    expect(references).toEqual([
      'message-media',
      'message-thumbnail',
      'status-media',
      'contact-avatar',
      'group-avatar',
      'active-upload',
    ]);
  });
});
