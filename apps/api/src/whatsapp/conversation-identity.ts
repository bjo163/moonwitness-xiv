import type { Knex } from 'knex';

const privateJidPattern = /^[^\s@]{1,200}@s\.whatsapp\.net$/u;
const lidJidPattern = /^[^\s@]{1,200}@lid$/u;

type ConversationRow = {
  id: number;
  jid: string;
  name: string;
  is_pinned: boolean | number;
  is_archived: boolean | number;
  unread_count: number;
  last_message?: string | null;
  last_message_at?: string | null;
  last_message_sync_at?: string | null;
  contact_verified_name?: string | null;
  contact_status?: string | null;
  contact_picture_id?: string | null;
  contact_avatar_picture_id?: string | null;
  contact_avatar_key?: string | null;
  contact_profile_synced_at?: string | null;
};

function validTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function cursorIsNewer(
  candidate: { last_read_at: string | Date; last_read_message_id: number },
  current: { last_read_at: string | Date; last_read_message_id: number }
): boolean {
  const candidateTime = validTime(candidate.last_read_at) ?? Number.NEGATIVE_INFINITY;
  const currentTime = validTime(current.last_read_at) ?? Number.NEGATIVE_INFINITY;
  return (
    candidateTime > currentTime ||
    (candidateTime === currentTime && candidate.last_read_message_id > current.last_read_message_id)
  );
}

export async function mergeWhatsappConversations(
  trx: Knex.Transaction,
  companyId: number,
  keepConversationId: number,
  removeConversationId: number
): Promise<number> {
  if (keepConversationId === removeConversationId) return keepConversationId;
  const keep = (await trx('whatsapp_conversations')
    .where({ company_id: companyId, id: keepConversationId })
    .first()) as ConversationRow | undefined;
  const remove = (await trx('whatsapp_conversations')
    .where({ company_id: companyId, id: removeConversationId })
    .first()) as ConversationRow | undefined;
  if (!keep) return remove ? removeConversationId : keepConversationId;
  if (!remove) return keepConversationId;

  await trx('whatsapp_messages')
    .where({ company_id: companyId, conversation_id: removeConversationId })
    .update({ conversation_id: keepConversationId, write_date: new Date().toISOString() });

  const readCursors = (await trx('whatsapp_conversation_reads').where({
    company_id: companyId,
    conversation_id: removeConversationId,
  })) as Array<{
    user_id: number;
    last_read_message_id: number;
    last_read_at: string | Date;
  }>;
  for (const cursor of readCursors) {
    const existing = (await trx('whatsapp_conversation_reads')
      .where({
        company_id: companyId,
        conversation_id: keepConversationId,
        user_id: cursor.user_id,
      })
      .first()) as
      { id: number; last_read_message_id: number; last_read_at: string | Date } | undefined;
    if (!existing) {
      await trx('whatsapp_conversation_reads')
        .where({
          company_id: companyId,
          conversation_id: removeConversationId,
          user_id: cursor.user_id,
        })
        .update({ conversation_id: keepConversationId, write_date: new Date().toISOString() });
    } else {
      if (cursorIsNewer(cursor, existing)) {
        await trx('whatsapp_conversation_reads')
          .where({ id: existing.id, company_id: companyId })
          .update({
            last_read_message_id: cursor.last_read_message_id,
            last_read_at: String(cursor.last_read_at),
            write_date: new Date().toISOString(),
          });
      }
      await trx('whatsapp_conversation_reads')
        .where({
          company_id: companyId,
          conversation_id: removeConversationId,
          user_id: cursor.user_id,
        })
        .delete();
    }
  }

  const aliasesToMove = (await trx('whatsapp_conversation_aliases')
    .select('alias_jid')
    .where({ company_id: companyId, conversation_id: removeConversationId })) as Array<{
    alias_jid: string;
  }>;
  for (const alias of aliasesToMove) {
    await trx('whatsapp_conversation_aliases')
      .insert({
        company_id: companyId,
        conversation_id: keepConversationId,
        alias_jid: alias.alias_jid,
      })
      .onConflict(['company_id', 'alias_jid'])
      .merge({ conversation_id: keepConversationId, write_date: new Date().toISOString() });
  }
  await trx('whatsapp_conversation_aliases')
    .where({ company_id: companyId, conversation_id: removeConversationId })
    .delete();

  const keepTime = validTime(keep.last_message_at);
  const removeTime = validTime(remove.last_message_at);
  const removeHasLaterMessage = removeTime !== null && (keepTime === null || removeTime > keepTime);
  const keepSyncTime = validTime(keep.last_message_sync_at);
  const removeSyncTime = validTime(remove.last_message_sync_at);
  const name = keep.name === keep.jid && remove.name !== remove.jid ? remove.name : keep.name;
  await trx('whatsapp_conversations')
    .where({ company_id: companyId, id: keepConversationId })
    .update({
      name,
      contact_verified_name: keep.contact_verified_name ?? remove.contact_verified_name ?? null,
      contact_status: keep.contact_status ?? remove.contact_status ?? null,
      contact_picture_id: keep.contact_picture_id ?? remove.contact_picture_id ?? null,
      contact_avatar_picture_id: keep.contact_avatar_key
        ? keep.contact_avatar_picture_id
        : (remove.contact_avatar_picture_id ?? null),
      contact_avatar_key: keep.contact_avatar_key ?? remove.contact_avatar_key ?? null,
      contact_profile_synced_at:
        keep.contact_profile_synced_at ?? remove.contact_profile_synced_at ?? null,
      is_pinned: Boolean(keep.is_pinned || remove.is_pinned),
      unread_count: Number(keep.unread_count ?? 0) + Number(remove.unread_count ?? 0),
      ...(removeHasLaterMessage
        ? { last_message: remove.last_message, last_message_at: remove.last_message_at }
        : {}),
      ...(removeSyncTime !== null && (keepSyncTime === null || removeSyncTime > keepSyncTime)
        ? { last_message_sync_at: remove.last_message_sync_at }
        : {}),
      write_date: new Date().toISOString(),
    });

  await trx('whatsapp_conversation_aliases')
    .insert({ company_id: companyId, conversation_id: keepConversationId, alias_jid: remove.jid })
    .onConflict(['company_id', 'alias_jid'])
    .merge({ conversation_id: keepConversationId, write_date: new Date().toISOString() });
  await trx('whatsapp_conversations')
    .where({ company_id: companyId, id: removeConversationId })
    .delete();
  return keepConversationId;
}

export async function attachPrivateLidAlias(
  trx: Knex.Transaction,
  companyId: number,
  conversationId: number,
  canonicalJid: string,
  aliasJid: string
): Promise<number> {
  if (!privateJidPattern.test(canonicalJid) || !lidJidPattern.test(aliasJid)) return conversationId;
  let survivorId = conversationId;
  const aliasConversation = (await trx('whatsapp_conversations')
    .select('id')
    .where({ company_id: companyId, jid: aliasJid })
    .first()) as { id: number } | undefined;
  if (aliasConversation && Number(aliasConversation.id) !== survivorId) {
    survivorId = await mergeWhatsappConversations(
      trx,
      companyId,
      survivorId,
      Number(aliasConversation.id)
    );
  }
  const existingAlias = (await trx('whatsapp_conversation_aliases')
    .select('conversation_id')
    .where({ company_id: companyId, alias_jid: aliasJid })
    .first()) as { conversation_id: number } | undefined;
  if (existingAlias && Number(existingAlias.conversation_id) !== survivorId) {
    survivorId = await mergeWhatsappConversations(
      trx,
      companyId,
      survivorId,
      Number(existingAlias.conversation_id)
    );
  }
  await trx('whatsapp_conversation_aliases')
    .insert({ company_id: companyId, conversation_id: survivorId, alias_jid: aliasJid })
    .onConflict(['company_id', 'alias_jid'])
    .merge({ conversation_id: survivorId, write_date: new Date().toISOString() });
  return survivorId;
}
