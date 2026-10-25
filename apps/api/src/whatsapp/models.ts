import { defineModel, fields } from '@moonwitness/orm';
import { Company } from '@moonwitness/orm-base';

export const WHATSAPP_ACCOUNT_STATUSES = [
  'disconnected',
  'connecting',
  'qr',
  'qr_expired',
  'connected',
  'reconnecting',
  'error',
] as const;

export const WhatsappAccount = defineModel('whatsapp.account', {
  table: 'whatsapp_accounts',
  order: 'id asc',
  unique: [['company']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    status: fields.enum(WHATSAPP_ACCOUNT_STATUSES, { required: true, default: 'disconnected' }),
    phone_number: fields.string(),
    gateway_device_id: fields.string({ hidden: true }),
    qr_code: fields.text({ hidden: true, sensitive: true }),
    last_error: fields.string(),
  },
});

export const WhatsappConversation = defineModel('whatsapp.conversation', {
  table: 'whatsapp_conversations',
  order: 'is_pinned desc, last_message_at desc, id desc',
  unique: [['company', 'jid']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    account: fields.belongsTo(WhatsappAccount, { required: true }),
    jid: fields.string({ required: true }),
    name: fields.string({ required: true }),
    contact_verified_name: fields.string(),
    contact_status: fields.text(),
    contact_picture_id: fields.string(),
    contact_avatar_picture_id: fields.string({ hidden: true }),
    contact_avatar_key: fields.string({ hidden: true, sensitive: true }),
    contact_profile_synced_at: fields.string(),
    group_topic: fields.text(),
    group_avatar_picture_id: fields.string({ hidden: true }),
    group_avatar_key: fields.string({ hidden: true, sensitive: true }),
    group_participant_count: fields.integer(),
    group_participants_json: fields.text({ hidden: true, sensitive: true }),
    group_metadata_synced_at: fields.string({ hidden: true }),
    group_is_locked: fields.boolean(),
    group_is_announce: fields.boolean(),
    group_is_ephemeral: fields.boolean(),
    is_group: fields.boolean({ required: true, default: false }),
    is_archived: fields.boolean({ required: true, default: false }),
    is_pinned: fields.boolean({ required: true, default: false }),
    assigned_user_id: fields.integer(),
    assigned_team_id: fields.integer(),
    work_state: fields.enum(['open', 'closed'], { required: true, default: 'open' }),
    unread_count: fields.integer({ required: true, default: 0, hidden: true }),
    last_message: fields.text(),
    last_message_at: fields.string(),
    last_message_sync_at: fields.string({ hidden: true }),
    history_sync_offset: fields.integer({ required: true, default: 0, hidden: true }),
  },
});

export const WhatsappMessage = defineModel('whatsapp.message', {
  table: 'whatsapp_messages',
  order: 'create_date desc, id desc',
  unique: [
    ['company', 'external_id'],
    ['company', 'idempotency_key'],
  ],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    account: fields.belongsTo(WhatsappAccount, { required: true }),
    conversation: fields.belongsTo(WhatsappConversation, { required: true }),
    external_id: fields.string({ required: true }),
    idempotency_key: fields.string({ hidden: true, sensitive: true }),
    request_hash: fields.string({ hidden: true, sensitive: true }),
    direction: fields.enum(['inbound', 'outbound'], { required: true }),
    message_type: fields.enum(['text', 'image', 'video', 'audio', 'document', 'sticker'], {
      required: true,
      default: 'text',
    }),
    provider_type: fields.string(),
    content: fields.text(),
    status: fields.enum(
      ['received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown'],
      {
        required: true,
        default: 'received',
      }
    ),
    attempt_count: fields.integer({ required: true, default: 0 }),
    retryable: fields.boolean({ required: true, default: false }),
    last_error: fields.string(),
    media_key: fields.string({ hidden: true, sensitive: true }),
    media_thumbnail_key: fields.string({ hidden: true, sensitive: true }),
    media_mime_type: fields.string(),
    media_size_bytes: fields.integer(),
    media_file_name: fields.string(),
    media_scan_status: fields.enum(['not_applicable', 'pending', 'clean', 'infected'], {
      required: true,
      default: 'not_applicable',
    }),
    sender_jid: fields.string(),
    sender_display_name: fields.string(),
    reply_to_message_id: fields.integer(),
    reply_to_external_id: fields.string({ hidden: true }),
    is_forwarded: fields.boolean({ required: true, default: false }),
    forward_from_external_id: fields.string({ hidden: true }),
    reactions: fields.text(),
    is_edited: fields.boolean({ required: true, default: false }),
    is_deleted: fields.boolean({ required: true, default: false }),
  },
});

export const WhatsappStatus = defineModel('whatsapp.status', {
  table: 'whatsapp_statuses',
  order: 'create_date desc, id desc',
  unique: [
    ['company', 'idempotency_key'],
    ['company', 'external_id'],
  ],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    account: fields.belongsTo(WhatsappAccount, { required: true }),
    status_type: fields.enum(['text', 'image', 'video'], { required: true }),
    content: fields.text(),
    media_key: fields.string({ hidden: true, sensitive: true }),
    media_mime_type: fields.string(),
    media_file_name: fields.string(),
    media_size_bytes: fields.integer(),
    allow_reshare: fields.boolean({ required: true, default: false }),
    idempotency_key: fields.string({ required: true, hidden: true, sensitive: true }),
    request_hash: fields.string({ required: true, hidden: true, sensitive: true }),
    external_id: fields.string({ required: true }),
    status: fields.enum(['queued', 'sending', 'sent', 'failed', 'unknown'], {
      required: true,
      default: 'queued',
    }),
    attempt_count: fields.integer({ required: true, default: 0 }),
    retryable: fields.boolean({ required: true, default: false }),
    last_error: fields.string(),
    published_at: fields.string(),
  },
});

export const WhatsappUploadTicket = defineModel('whatsapp.upload.ticket', {
  table: 'whatsapp_upload_tickets',
  order: 'id asc',
  unique: [['storage_key']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    conversation: fields.belongsTo(WhatsappConversation, { required: true }),
    user_id: fields.integer({ required: true }),
    storage_key: fields.string({ required: true, hidden: true, sensitive: true }),
    file_name: fields.string({ required: true }),
    content_type: fields.string({ required: true }),
    size_bytes: fields.integer({ required: true }),
    expires_at: fields.string({ required: true }),
    consumed_message_id: fields.integer(),
  },
});

export const WhatsappConversationRead = defineModel('whatsapp.conversation.read', {
  table: 'whatsapp_conversation_reads',
  order: 'id asc',
  unique: [['company', 'conversation', 'user_id']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    conversation: fields.belongsTo(WhatsappConversation, { required: true }),
    user_id: fields.integer({ required: true }),
    last_read_message_id: fields.integer({ required: true }),
    last_read_at: fields.string({ required: true }),
  },
});

export const WhatsappInternalNote = defineModel('whatsapp.internal_note', {
  table: 'whatsapp_internal_notes',
  order: 'create_date asc, id asc',
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    conversation: fields.belongsTo(WhatsappConversation, { required: true }),
    user_id: fields.integer({ required: true }),
    body: fields.text({ required: true }),
  },
});

export const WhatsappLabel = defineModel('whatsapp.label', {
  table: 'whatsapp_labels',
  order: 'name asc, id asc',
  unique: [['company', 'normalized_name']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    name: fields.string({ required: true }),
    normalized_name: fields.string({ required: true, hidden: true }),
    color: fields.string({ required: true, default: '#f1d340' }),
  },
});

export const WhatsappConversationLabel = defineModel('whatsapp.conversation.label', {
  table: 'whatsapp_conversation_labels',
  order: 'id asc',
  unique: [['company', 'conversation', 'label']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    conversation: fields.belongsTo(WhatsappConversation, { required: true }),
    label: fields.belongsTo(WhatsappLabel, { required: true }),
  },
});

export const WhatsappConversationAlias = defineModel('whatsapp.conversation.alias', {
  table: 'whatsapp_conversation_aliases',
  order: 'id asc',
  unique: [['company', 'alias_jid']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    conversation: fields.belongsTo(WhatsappConversation, { required: true }),
    alias_jid: fields.string({ required: true, hidden: true }),
  },
});

export const WhatsappGroupCreation = defineModel('whatsapp.group.creation', {
  table: 'whatsapp_group_creations',
  order: 'id desc',
  unique: [['company', 'idempotency_key']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    idempotency_key: fields.string({ required: true, hidden: true, sensitive: true }),
    request_hash: fields.string({ required: true, hidden: true, sensitive: true }),
    status: fields.enum(['started', 'completed', 'unknown', 'failed'], {
      required: true,
      default: 'started',
    }),
    group_jid: fields.string({ hidden: true, sensitive: true }),
  },
});

export const WhatsappGroupJoin = defineModel('whatsapp.group.join', {
  table: 'whatsapp_group_joins',
  order: 'id desc',
  unique: [['company', 'idempotency_key']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    idempotency_key: fields.string({ required: true, hidden: true, sensitive: true }),
    request_hash: fields.string({ required: true, hidden: true, sensitive: true }),
    status: fields.enum(['started', 'completed', 'unknown', 'failed'], {
      required: true,
      default: 'started',
    }),
    group_jid: fields.string({ hidden: true, sensitive: true }),
    group_name: fields.string(),
  },
});

export const WhatsappGroupOperation = defineModel('whatsapp.group.operation', {
  table: 'whatsapp_group_operations',
  order: 'id desc',
  unique: [['company', 'idempotency_key']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    conversation: fields.belongsTo(WhatsappConversation, { required: true }),
    idempotency_key: fields.string({ required: true, hidden: true, sensitive: true }),
    request_hash: fields.string({ required: true, hidden: true, sensitive: true }),
    action: fields.enum(['add', 'remove', 'promote', 'demote', 'leave'], { required: true }),
    participants_json: fields.text({ required: true, hidden: true, sensitive: true }),
    result_json: fields.text({ hidden: true, sensitive: true }),
    status: fields.enum(['started', 'completed', 'unknown', 'failed'], {
      required: true,
      default: 'started',
    }),
  },
});
