import type { Knex } from 'knex';
import type { AttachmentReference } from '@moonwitness/orm-storage';

export async function* whatsappAttachmentReferences(
  db: Knex,
  now = new Date()
): AsyncIterable<AttachmentReference> {
  const mediaRows = await db('whatsapp_messages')
    .where((query) => query.whereNotNull('media_key').orWhereNotNull('media_thumbnail_key'))
    .select('media_key', 'media_thumbnail_key');
  for (const row of mediaRows) {
    if (typeof row.media_key === 'string') yield { storageKey: row.media_key };
    if (typeof row.media_thumbnail_key === 'string') yield { storageKey: row.media_thumbnail_key };
  }

  const statusRows = await db('whatsapp_statuses').whereNotNull('media_key').select('media_key');
  for (const row of statusRows) {
    if (typeof row.media_key === 'string') yield { storageKey: row.media_key };
  }

  const conversationRows = await db('whatsapp_conversations')
    .whereNotNull('contact_avatar_key')
    .select('contact_avatar_key');
  for (const row of conversationRows) {
    if (typeof row.contact_avatar_key === 'string') yield { storageKey: row.contact_avatar_key };
  }

  const pendingUploadRows = await db('whatsapp_upload_tickets')
    .where('expires_at', '>', now.toISOString())
    .select('storage_key');
  for (const row of pendingUploadRows) {
    if (typeof row.storage_key === 'string') yield { storageKey: row.storage_key };
  }
}
