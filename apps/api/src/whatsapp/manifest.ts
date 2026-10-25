import { defineAddon, defineView, ref, seed } from '@moonwitness/orm';
import { ModelAccess } from '@moonwitness/orm-base';
import {
  WhatsappAccount,
  WhatsappConversation,
  WhatsappConversationRead,
  WhatsappConversationAlias,
  WhatsappGroupCreation,
  WhatsappGroupJoin,
  WhatsappGroupOperation,
  WhatsappInternalNote,
  WhatsappLabel,
  WhatsappConversationLabel,
  WhatsappMessage,
  WhatsappStatus,
  WhatsappUploadTicket,
  WHATSAPP_ACCOUNT_STATUSES,
} from './models.js';

const models = [
  WhatsappAccount,
  WhatsappConversation,
  WhatsappMessage,
  WhatsappStatus,
  WhatsappUploadTicket,
  WhatsappConversationRead,
  WhatsappConversationAlias,
  WhatsappGroupCreation,
  WhatsappGroupJoin,
  WhatsappGroupOperation,
  WhatsappInternalNote,
  WhatsappLabel,
  WhatsappConversationLabel,
] as const;
const userFacingModels = [
  WhatsappAccount,
  WhatsappConversation,
  WhatsappMessage,
  WhatsappStatus,
] as const;
export const whatsappManifest = defineAddon({
  // Preserve the installed addon identity and seed IDs used by earlier builds.
  name: 'orm-whatsapp',
  version: '1.14.0',
  depends: ['base'],
  models: [...models],
  setup: async (trx) => {
    // The ORM creates enum checks for new tables, but does not update existing checks when an
    // enum grows. Repair this constraint idempotently so older databases can store qr_expired.
    if (trx.client.config.client !== 'pg') return;
    const result = (await trx.raw(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = to_regclass(?) AND conname = ?`,
      ['whatsapp_accounts', 'whatsapp_accounts_status_check']
    )) as { rows?: { definition?: string }[] };
    const definition = result.rows?.[0]?.definition;
    if (definition?.includes("'qr_expired'")) return;

    const statusValues = WHATSAPP_ACCOUNT_STATUSES.map(
      (status) => `'${status.replaceAll("'", "''")}'`
    ).join(', ');
    await trx.raw(
      'ALTER TABLE "whatsapp_accounts" DROP CONSTRAINT IF EXISTS "whatsapp_accounts_status_check"'
    );
    await trx.raw(
      `ALTER TABLE "whatsapp_accounts"
       ADD CONSTRAINT "whatsapp_accounts_status_check"
       CHECK ("status" IN (${statusValues}))`
    );
  },
  data: userFacingModels.flatMap((model) => [
    seed(ModelAccess, `orm-whatsapp.access_user_read_${model.modelName.replaceAll('.', '_')}`, {
      group: ref('base.group_user'),
      model_name: model.modelName,
      read: true,
      create: false,
      write: false,
      unlink: false,
    }),
    seed(ModelAccess, `orm-whatsapp.access_superadmin_${model.modelName.replaceAll('.', '_')}`, {
      group: ref('base.group_superadmin'),
      model_name: model.modelName,
      read: true,
      create: true,
      write: true,
      unlink: true,
    }),
  ]),
  views: [
    defineView(WhatsappAccount, {
      title: 'WhatsApp Accounts',
      list: { columns: ['company', 'status', 'phone_number'] },
      form: {
        sections: [
          { title: 'Account', fields: ['company', 'status', 'phone_number', 'last_error'] },
        ],
      },
      search: { fields: ['phone_number'] },
    }),
    defineView(WhatsappConversation, {
      title: 'WhatsApp Conversations',
      list: { columns: ['name', 'jid', 'is_group', 'unread_count', 'last_message_at'] },
      form: {
        sections: [
          {
            title: 'Conversation',
            fields: ['company', 'account', 'jid', 'name', 'is_group', 'unread_count'],
          },
        ],
      },
      search: { fields: ['name', 'jid'] },
    }),
    defineView(WhatsappMessage, {
      title: 'WhatsApp Messages',
      list: { columns: ['conversation', 'direction', 'message_type', 'status', 'create_date'] },
      form: {
        sections: [
          {
            title: 'Message',
            fields: [
              'conversation',
              'direction',
              'message_type',
              'content',
              'status',
              'media_mime_type',
              'media_scan_status',
            ],
          },
        ],
      },
      search: { fields: ['content'] },
    }),
  ],
  menus: userFacingModels.map((model, index) => ({
    model: model.modelName,
    label: model.modelName.split('.')[1],
    group: 'Technical',
    sequence: 520 + index,
    developmentOnly: true,
  })),
});
