import { defineAddon, ref, seed } from '@moonwitness/orm';
import { ModelAccess } from '@moonwitness/orm-base';
import { Notification, NotificationPreference, NotificationTemplate } from './models.js';
import { views } from './views.js';

export const manifest = defineAddon({
  name: 'notification',
  version: '1.0.0',
  depends: ['base', 'jobs'],
  models: [NotificationTemplate, NotificationPreference, Notification],
  data: [
    seed(NotificationTemplate, 'notification.template_example_in_app', {
      code: 'example.in_app',
      channel: 'in_app',
      title: 'Example in-app notification',
      body: 'Template example only. It does not create or deliver a message.',
    }),
    seed(NotificationTemplate, 'notification.template_example_email', {
      code: 'example.email',
      channel: 'email',
      title: 'Example email notification',
      body: 'Fake adapter example only. No email is sent.',
    }),
    seed(NotificationTemplate, 'notification.template_whatsapp_inbound', {
      code: 'whatsapp.inbound_message',
      channel: 'in_app',
      locale: 'en',
      title: 'New WhatsApp message',
      body: 'A new message arrived in your company WhatsApp inbox.',
    }),
    ...(['in_app', 'email'] as const).flatMap((channel) =>
      (
        [
          ['system', 'base.user_system'],
          ['superadmin', 'base.user_superadmin'],
        ] as const
      ).map(([userKey, userRef]) =>
        seed(NotificationPreference, `notification.preference_${userKey}_${channel}`, {
          user: ref(userRef),
          company: ref('base.company_default'),
          channel,
          enabled: channel === 'in_app',
        })
      )
    ),
    seed(ModelAccess, 'notification.access_user_inbox_read', {
      group: ref('base.group_user'),
      model_name: Notification.modelName,
      read: true,
      create: false,
      write: false,
      unlink: false,
    }),
    seed(ModelAccess, 'notification.access_user_preference_read', {
      group: ref('base.group_user'),
      model_name: NotificationPreference.modelName,
      read: true,
      create: false,
      write: false,
      unlink: false,
    }),
  ],
  views,
  menus: [
    { model: Notification.modelName, label: 'Notifications', group: 'Workspace', sequence: 15 },
    {
      model: NotificationPreference.modelName,
      label: 'Notification Preferences',
      group: 'Settings',
      sequence: 80,
    },
    {
      model: NotificationTemplate.modelName,
      label: 'Notification Templates',
      group: 'Technical',
      sequence: 470,
      developmentOnly: true,
    },
  ],
});
