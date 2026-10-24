import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { E2E_SUPERADMIN_PASSWORD } from './constants.js';

test('company WhatsApp inbox displays chats and sends a reply', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  await page.route('**/whatsapp/account', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          status: 'connected',
          phone_number: '6281234567890',
          webhook_configured: false,
          permissions: { manage: true, createConversation: true, send: true, manageMessages: true },
        },
      },
    })
  );
  await page.route('**/whatsapp/contacts/check', async (route) => {
    const request = route.request().postDataJSON() as { phone: string };
    const phone = request.phone.replace(/\D/gu, '');
    await route.fulfill({
      json: {
        success: true,
        data: { phone: `+${phone}`, is_on_whatsapp: phone === '6285893429926' },
      },
    });
  });
  await page.route('**/whatsapp/conversations/*/contact', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          name: 'Rani Putri',
          phone_number: '628111222333',
          verified_name: 'Rani Finance',
          status: 'Ready to help',
          picture_id: 'profile-1',
          avatar_available: true,
        },
      },
    })
  );
  await page.route('**/whatsapp/conversations/*/contact/avatar', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=',
        'base64'
      ),
    })
  );
  await page.route('**/whatsapp/conversations/*/group/avatar', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=',
        'base64'
      ),
    })
  );
  let managedMemberAdmin = false;
  let groupLocked = false;
  let groupAnnounce = false;
  const groupSettingRequests: Array<{ setting: string; enabled: boolean }> = [];
  let addedManagedParticipant: string | null = null;
  let simulateUnknownGroupRemoval = false;
  await page.route('**/whatsapp/conversations/*/group', (route) => {
    const isCreatedGroup = new URL(route.request().url()).pathname.endsWith('/222/group');
    return route.fulfill({
      json: {
        success: true,
        data: {
          name: 'Project group',
          topic: 'Project updates',
          participant_count: 2,
          is_locked: groupLocked,
          is_announce: groupAnnounce,
          is_ephemeral: true,
          avatar_available: true,
          participants: [
            {
              jid: '628111222333@s.whatsapp.net',
              phone_number: '628111222333@s.whatsapp.net',
              display_name: 'Rani Finance',
              is_admin: isCreatedGroup ? managedMemberAdmin : true,
              is_super_admin: false,
            },
            {
              jid: '888888888@lid',
              phone_number: null,
              display_name: 'Anonymous member',
              is_admin: false,
              is_super_admin: false,
            },
            ...(isCreatedGroup && addedManagedParticipant
              ? [
                  {
                    jid: `${addedManagedParticipant}@s.whatsapp.net`,
                    phone_number: `${addedManagedParticipant}@s.whatsapp.net`,
                    display_name: 'New participant',
                    is_admin: false,
                    is_super_admin: false,
                  },
                ]
              : []),
          ],
          synced_at: new Date().toISOString(),
          stale: false,
        },
      },
    });
  });
  await page.route('**/whatsapp/conversations/*/group/settings', async (route) => {
    const body = route.request().postDataJSON() as { setting: string; enabled: boolean };
    groupSettingRequests.push(body);
    if (body.setting === 'locked') groupLocked = body.enabled;
    if (body.setting === 'announce') groupAnnounce = body.enabled;
    await route.fulfill({ json: { success: true, data: body } });
  });
  let failSearchConversationLoad = false;
  let failInboxRefresh = false;
  let createdGroup: Record<string, unknown> | null = null;
  const groupCreateRequests: Array<{ key: string; body: Record<string, unknown> }> = [];
  const groupParticipantActions: Array<{
    action: string;
    key: string;
    body: Record<string, unknown>;
  }> = [];
  let groupInviteResetCount = 0;
  let includeNewInboundMessage = false;
  let ownReaction: { emoji: string; is_from_me: boolean } | null = null;
  let editedMessageContent = 'A sent reply';
  let messageDeleted = false;
  let holdMessageResponse = false;
  let releaseMessageResponse: (() => void) | null = null;
  const forwardDestinationQueries: Array<{ archived: string | null; offset: string | null }> = [];
  await page.route('**/whatsapp/conversations*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('unread')) {
      forwardDestinationQueries.push({
        archived: url.searchParams.get('archived'),
        offset: url.searchParams.get('offset'),
      });
    }
    if (failSearchConversationLoad && url.searchParams.get('search') === 'trigger-error') {
      return route.fulfill({ status: 503, json: { success: false, error: 'temporary failure' } });
    }
    if (
      failInboxRefresh &&
      url.pathname === '/whatsapp/conversations' &&
      !url.searchParams.has('search')
    ) {
      return route.fulfill({ status: 503, json: { success: false, error: 'temporary failure' } });
    }
    if (url.searchParams.get('search')?.toLocaleLowerCase() === 'older destination') {
      return route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 99,
              jid: '628999000111@s.whatsapp.net',
              name: 'Older destination',
              is_group: false,
              is_archived: false,
              unread_count: 0,
            },
          ],
        },
      });
    }
    if (Number(url.searchParams.get('offset')) >= 50) {
      return route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 99,
              jid: '628999000111@s.whatsapp.net',
              name: 'Older conversation',
              is_group: false,
              unread_count: 0,
            },
          ],
        },
      });
    }
    const conversations = [
      {
        id: 42,
        jid: '120363000@g.us',
        name: 'Project group',
        is_group: true,
        unread_count: 1,
        last_message: 'Can you help?',
        last_message_at: new Date().toISOString(),
      },
      {
        id: 43,
        jid: '628111222333@s.whatsapp.net',
        name: 'Rani Putri',
        is_group: false,
        unread_count: 0,
        last_message: 'See you soon',
        last_message_at: new Date().toISOString(),
      },
      ...Array.from({ length: 48 }, (_, index) => ({
        id: 100 + index,
        jid: `${628200000000 + index}@s.whatsapp.net`,
        name: `Contact ${index}`,
        is_group: false,
        unread_count: 0,
      })),
      ...(createdGroup ? [createdGroup] : []),
    ];
    const search = url.searchParams.get('search')?.toLocaleLowerCase();
    return route.fulfill({
      json: {
        success: true,
        data: search
          ? conversations.filter((chat) =>
              `${chat.name} ${chat.jid} ${chat.last_message ?? ''}`
                .toLocaleLowerCase()
                .includes(search)
            )
          : conversations,
      },
    });
  });
  await page.route('**/whatsapp/groups', async (route) => {
    groupCreateRequests.push({
      key: route.request().headers()['idempotency-key'] ?? '',
      body: route.request().postDataJSON() as Record<string, unknown>,
    });
    if (groupCreateRequests.length === 1) {
      await route.fulfill({
        status: 502,
        json: {
          success: false,
          error: 'Group creation could not be confirmed; check the inbox before retrying',
        },
      });
      return;
    }
    createdGroup = {
      id: 222,
      jid: '120363123456789@g.us',
      name: 'Board project team',
      is_group: true,
      is_archived: false,
      is_pinned: false,
      unread_count: 0,
    };
    await route.fulfill({ json: { success: true, data: createdGroup } });
  });
  await page.route('**/whatsapp/conversations/*/group/participants/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    groupParticipantActions.push({
      action: path.split('/').at(-1) ?? '',
      key: route.request().headers()['idempotency-key'] ?? '',
      body: route.request().postDataJSON() as Record<string, unknown>,
    });
    const action = path.split('/').at(-1);
    const body = route.request().postDataJSON() as { participants?: string[] };
    if (action === 'promote') managedMemberAdmin = true;
    if (action === 'demote') managedMemberAdmin = false;
    if (action === 'add') addedManagedParticipant = body.participants?.[0] ?? null;
    if (action === 'remove') addedManagedParticipant = null;
    if (action === 'remove' && simulateUnknownGroupRemoval) {
      simulateUnknownGroupRemoval = false;
      await route.fulfill({
        status: 502,
        json: { success: false, error: 'Group action result is unknown; refresh group details' },
      });
      return;
    }
    await route.fulfill({
      json: { success: true, data: { status: 'completed', results: [{ status: 'success' }] } },
    });
  });
  await page.route('**/whatsapp/conversations/*/group/invite-link**', async (route) => {
    const reset = new URL(route.request().url()).pathname.endsWith('/reset');
    if (reset) groupInviteResetCount++;
    await route.fulfill({
      json: {
        success: true,
        data: {
          invite_link: `https://chat.whatsapp.com/AbCdEfGh1234567${groupInviteResetCount}`,
        },
      },
    });
  });
  const groupLeaveRequests: string[] = [];
  await page.route('**/whatsapp/conversations/*/group/leave', async (route) => {
    groupLeaveRequests.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({ json: { success: true, data: { left: true } } });
  });
  const groupInviteJoins: string[] = [];
  await page.route('**/whatsapp/groups/invite-preview', async (route) => {
    await route.fulfill({
      json: {
        success: true,
        data: { name: 'Joined by invite', topic: 'A preview topic', participant_count: 8 },
      },
    });
  });
  await page.route('**/whatsapp/groups/join', async (route) => {
    groupInviteJoins.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      status: 201,
      json: {
        success: true,
        data: {
          id: 333,
          jid: '120363000000004@g.us',
          name: 'Joined by invite',
          is_group: true,
          is_archived: false,
          unread_count: 0,
        },
      },
    });
  });
  const sentMessages: string[] = [];
  const sentReactions: Array<{ sourceId: string; emoji: string }> = [];
  await page.route('**/whatsapp/messages/*/reaction', async (route) => {
    const sourceId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    const body = route.request().postDataJSON() as { emoji: string };
    sentReactions.push({ sourceId, emoji: body.emoji });
    ownReaction = { emoji: body.emoji, is_from_me: true };
    await route.fulfill({
      status: 200,
      json: { success: true, data: { reactions: [{ emoji: body.emoji, is_from_me: true }] } },
    });
  });
  await page.route('**/whatsapp/messages/*/edit', async (route) => {
    editedMessageContent = (route.request().postDataJSON() as { content: string }).content;
    await route.fulfill({
      json: { success: true, data: { content: editedMessageContent, is_edited: true } },
    });
  });
  await page.route('**/whatsapp/messages/*/revoke', async (route) => {
    messageDeleted = true;
    await route.fulfill({ json: { success: true, data: { is_deleted: true } } });
  });
  const forwardedMessages: Array<{ sourceId: string; body: Record<string, unknown>; key: string }> =
    [];
  await page.route('**/whatsapp/messages/*/forward', async (route) => {
    const sourceId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    forwardedMessages.push({
      sourceId,
      body: route.request().postDataJSON() as Record<string, unknown>,
      key: route.request().headers()['idempotency-key'] ?? '',
    });
    await route.fulfill({ status: 202, json: { success: true, data: { status: 'queued' } } });
  });
  await page.route('**/whatsapp/conversations/222/messages*', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: [
          ['join', 'joined the group'],
          ['leave', 'left the group'],
          ['promote', 'became an admin'],
          ['demote', 'is no longer an admin'],
        ].map(([action, label], index) => ({
          id: 670 + index,
          direction: 'inbound',
          content: `628222222222@s.whatsapp.net ${label}`,
          status: 'received',
          message_type: 'text',
          provider_type: `group_event_${action}`,
          create_date: new Date(Date.now() - index * 1000).toISOString(),
        })),
      },
    })
  );
  await page.route('**/whatsapp/conversations/42/messages*', async (route) => {
    if (route.request().method() === 'POST') {
      const expectedMessages = [
        { content: 'Thanks, I will take a look.\nChecking this multiline reply.' },
        { content: 'Draft before newline' },
        { content: 'Quoted response', reply_to_message_id: 50 },
      ];
      expect(route.request().postDataJSON()).toMatchObject(expectedMessages[sentMessages.length]);
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      sentMessages.push(route.request().postDataJSON().content);
      await route.fulfill({
        status: 202,
        json: { success: true, data: { id: 50 + sentMessages.length, status: 'queued' } },
      });
      return;
    }
    if (holdMessageResponse) {
      holdMessageResponse = false;
      await new Promise<void>((resolve) => {
        releaseMessageResponse = resolve;
      });
    }
    const url = new URL(route.request().url());
    if (Number(url.searchParams.get('offset')) >= 50) {
      await route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 1,
              direction: 'inbound',
              content: 'Older history',
              status: 'received',
              message_type: 'text',
              create_date: new Date(Date.now() - 60_000).toISOString(),
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        success: true,
        data: [
          ...(includeNewInboundMessage
            ? [
                {
                  id: 55,
                  direction: 'inbound',
                  content: 'New inbound message',
                  status: 'received',
                  is_unread: true,
                  message_type: 'text',
                  create_date: new Date(Date.now() + 1000).toISOString(),
                },
              ]
            : []),
          {
            id: 52,
            direction: 'outbound',
            content: messageDeleted ? 'This message was deleted' : editedMessageContent,
            status: 'sent',
            is_edited: editedMessageContent !== 'A sent reply',
            is_deleted: messageDeleted,
            message_type: 'text',
            reply_to: { id: 50, content: 'Can you help?', message_type: 'text' },
            create_date: new Date(Date.now() - 60_000).toISOString(),
          },
          {
            id: 56,
            direction: 'outbound',
            content: 'A delivered reply',
            status: 'delivered',
            message_type: 'text',
            create_date: new Date().toISOString(),
          },
          {
            id: 57,
            direction: 'outbound',
            content: 'A read reply',
            status: 'read',
            message_type: 'text',
            create_date: new Date().toISOString(),
          },
          {
            id: 58,
            direction: 'outbound',
            content: 'A failed reply',
            status: 'failed',
            retryable: true,
            last_error: 'Gateway rejected the message',
            message_type: 'text',
            create_date: new Date().toISOString(),
          },
          {
            id: 59,
            direction: 'inbound',
            content: 'View-once media',
            status: 'received',
            message_type: 'text',
            provider_type: 'view_once',
            create_date: new Date().toISOString(),
          },
          {
            id: 60,
            direction: 'inbound',
            content: '',
            status: 'received',
            message_type: 'text',
            provider_type: 'future_interactive_card',
            create_date: new Date().toISOString(),
          },
          {
            id: 50,
            direction: 'inbound',
            is_unread: true,
            is_last_read: false,
            content: 'Can you help?',
            sender_jid: '628222222222@s.whatsapp.net',
            sender_display_name: 'Rani from Finance',
            status: 'received',
            reactions: [
              { emoji: '👀', sender_display_name: 'Rani Putri', is_from_me: false },
              ...(ownReaction ? [ownReaction] : []),
            ],
            message_type: 'text',
            create_date: new Date().toISOString(),
          },
          {
            id: 53,
            direction: 'inbound',
            is_unread: true,
            content: 'Storage failure attachment',
            status: 'received',
            message_type: 'image',
            create_date: new Date(Date.now() - 500).toISOString(),
          },
          {
            id: 54,
            direction: 'inbound',
            is_unread: true,
            content: 'Gateway failure attachment',
            status: 'received',
            message_type: 'image',
            create_date: new Date(Date.now() - 250).toISOString(),
          },
          {
            id: 61,
            direction: 'inbound',
            content: 'Download progress attachment',
            sender_jid: '628222222222@s.whatsapp.net',
            sender_display_name: 'Rani Finance',
            status: 'received',
            message_type: 'image',
            media_file_name: 'download.png',
            create_date: new Date(Date.now() - 100).toISOString(),
          },
          {
            id: 62,
            direction: 'inbound',
            content: 'PDF attachment',
            status: 'received',
            message_type: 'document',
            media_file_name: 'statement.pdf',
            create_date: new Date(Date.now() - 75).toISOString(),
          },
          {
            id: 63,
            direction: 'inbound',
            content: 'Active extension attachment',
            status: 'received',
            message_type: 'document',
            media_file_name: 'invoice.html',
            create_date: new Date(Date.now() - 50).toISOString(),
          },
          {
            id: 64,
            direction: 'inbound',
            content: 'Quarantined attachment',
            status: 'received',
            message_type: 'image',
            media_file_name: 'blocked.png',
            media_scan_status: 'infected',
            create_date: new Date(Date.now() - 25).toISOString(),
          },
          {
            id: 65,
            direction: 'inbound',
            content: 'Video preview',
            status: 'received',
            message_type: 'video',
            media_file_name: 'clip.mp4',
            create_date: new Date(Date.now() - 10).toISOString(),
          },
          {
            id: 66,
            direction: 'inbound',
            content: 'Audio preview',
            status: 'received',
            message_type: 'audio',
            media_file_name: 'voice.ogg',
            create_date: new Date(Date.now() - 5).toISOString(),
          },
          ...Array.from({ length: 35 }, (_, index) => ({
            id: 49 - index,
            direction: 'inbound',
            is_unread: true,
            content: `Older item ${index}`,
            status: 'received',
            message_type: 'text',
            create_date: new Date(Date.now() - (index + 1) * 1000).toISOString(),
          })),
        ],
      },
    });
  });
  await page.route('**/whatsapp/conversations/100/messages*', (route) =>
    route.fulfill({ json: { success: true, data: [] } })
  );
  await page.route('**/whatsapp/conversations/42/read', (route) =>
    route.fulfill({ json: { success: true, data: { marked: true, message_id: 50 } } })
  );
  await page.route('**/whatsapp/media/53/thumbnail', (route) =>
    route.fulfill({
      status: 503,
      json: { success: false, error: 'Media storage is temporarily unavailable' },
    })
  );
  await page.route('**/whatsapp/media/54/thumbnail', (route) =>
    route.fulfill({
      status: 502,
      json: { success: false, error: 'WhatsApp gateway returned incomplete media' },
    })
  );
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  let downloadCancelled = false;
  let downloadAttempts = 0;
  await page.route('**/whatsapp/media/61/thumbnail', async (route) => {
    downloadAttempts += 1;
    if (downloadAttempts === 1) {
      await downloadGate;
      if (downloadCancelled) return route.abort();
    }
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=',
        'base64'
      ),
    });
  });
  let fullImageLoads = 0;
  await page.route('**/whatsapp/media/61', async (route) => {
    fullImageLoads++;
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l0sAAAAASUVORK5CYII=',
        'base64'
      ),
    });
  });
  await page.route('**/whatsapp/media/65/thumbnail', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      headers: { 'X-Original-Content-Type': 'video/mp4', 'X-Original-Content-Length': '1024' },
      body: Buffer.from(
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAB//2Q==',
        'base64'
      ),
    })
  );
  await page.route('**/whatsapp/media/65', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]),
    })
  );
  await page.route('**/whatsapp/media/66', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'audio/ogg',
      body: Buffer.from('OggS'),
    })
  );
  await page.route('**/whatsapp/media/62', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF'),
    })
  );
  await page.route('**/whatsapp/media/63', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: Buffer.from('<!doctype html><script>alert(1)</script>'),
    })
  );
  await page.route('**/whatsapp/media/64', (route) =>
    route.fulfill({
      status: 410,
      json: { success: false, error: 'Attachment blocked by malware scan' },
    })
  );

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  holdMessageResponse = true;
  await page.goto('/board/whatsapp');
  await expect(
    page.getByRole('status').filter({ hasText: 'Live callbacks are not configured.' })
  ).toBeVisible();
  await expect(page.getByText('+6281234567890')).toBeVisible();
  await page.getByRole('button', { name: /Project group/u }).click();
  await expect(page.getByLabel('Loading messages')).toBeVisible();
  releaseMessageResponse?.();
  releaseMessageResponse = null;
  await expect(page.getByRole('heading', { name: 'Project group' })).toBeVisible();
  const inboxRefreshError = page
    .getByRole('alert')
    .filter({ hasText: 'WhatsApp data could not be refreshed.' });
  failInboxRefresh = true;
  await expect(inboxRefreshError).toContainText('Showing inbox data last updated at', {
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: /Project group/u })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const retryInboxButton = inboxRefreshError.getByRole('button', { name: 'Retry' });
  await expect(retryInboxButton).toBeEnabled();
  failInboxRefresh = false;
  await retryInboxButton.click();
  await expect(inboxRefreshError).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const accessibility = await new AxeBuilder({ page })
    .include('main')
    .exclude('iframe')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    accessibility.violations.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    }))
  ).toEqual([]);
  await expect(page.getByRole('img', { name: 'Project group WhatsApp group photo' })).toBeVisible();
  await page.getByRole('button', { name: 'Mention participants' }).click();
  await page.getByRole('button', { name: '@Rani Finance' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Mention preview (1/100): @Rani Finance' })
  ).toBeVisible();
  await page.getByRole('button', { name: '@everyone' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Mention preview (1/100): @everyone' })
  ).toBeVisible();
  await page.getByRole('button', { name: '@everyone' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Mention preview' })).toHaveCount(0);
  await expect(page.getByText('2 participants')).toBeVisible();
  await expect(page.getByText('Disappearing messages are on')).toBeVisible();
  await page.getByText('Show participants').click();
  await expect(page.getByText('Rani Finance · admin')).toBeVisible();
  await page.getByRole('button', { name: 'Restrict group info edits' }).click();
  await expect(page.getByRole('alertdialog')).toContainText(
    'Restrict group information changes to admins?'
  );
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(
    page.getByRole('button', { name: 'Allow members to edit group info' })
  ).toBeVisible();
  expect(groupSettingRequests).toContainEqual({ setting: 'locked', enabled: true });
  await page.getByRole('button', { name: 'Admins only can send messages' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('button', { name: 'Allow members to send messages' })).toBeVisible();
  expect(groupSettingRequests).toContainEqual({ setting: 'announce', enabled: true });
  await page.getByLabel('Phone number with country code').fill('+62 (858) 9342-9926');
  await page.getByRole('button', { name: 'Check number' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '+6285893429926 is on WhatsApp' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New chat' })).toBeEnabled();
  await page.getByLabel('Phone number with country code').fill('+62 811 1111 2222');
  await page.getByRole('button', { name: 'Check number' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '+6281111112222 is not registered, or GoWA could not verify it' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New chat' })).toBeDisabled();
  await expect(page.locator('#whatsapp-message-50').getByText('Rani from Finance')).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: 'Download progress for download.png' })
  ).toBeVisible();
  const progressAttachment = page.locator('#whatsapp-message-61');
  await expect(progressAttachment.getByText('Rani Finance')).toBeVisible();
  await expect(progressAttachment.getByText('Download progress attachment')).toBeVisible();
  await expect(progressAttachment.getByRole('button', { name: 'Cancel download' })).toBeVisible();
  await progressAttachment.getByRole('button', { name: 'Cancel download' }).click();
  downloadCancelled = true;
  releaseDownload();
  await expect(page.getByText('Download cancelled. Try again when ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).last().click();
  await expect(page.locator('img[alt="download.png preview"]')).toBeVisible();
  await expect(
    progressAttachment.getByRole('button', { name: 'Load original image' })
  ).toBeVisible();
  await progressAttachment.getByRole('button', { name: 'Load original image' }).click();
  await expect(page.locator('img[alt="download.png"]')).toBeVisible();
  expect(fullImageLoads).toBe(1);
  const videoPreview = page.locator('#whatsapp-message-65');
  await expect(videoPreview.locator('img[alt="clip.mp4 preview"]')).toBeVisible();
  await expect(videoPreview.getByText(/Original 1\.0 KB/u)).toBeVisible();
  await videoPreview.getByRole('button', { name: 'Load video' }).click();
  await expect(videoPreview.locator('video[controls]')).toBeVisible();
  const audioPreview = page.locator('#whatsapp-message-66');
  await expect(audioPreview.locator('audio[controls]')).toBeVisible();
  await expect(audioPreview.getByText('voice.ogg')).toBeVisible();
  await page.getByRole('button', { name: /Rani Putri/u }).click();
  await expect(page.getByText('Rani Finance', { exact: true })).toBeVisible();
  await expect(
    page.locator('span.block').getByText('+628111222333', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('About: Ready to help')).toBeVisible();
  await expect(page.getByAltText('Rani Putri WhatsApp profile photo')).toBeVisible();
  await page.getByRole('button', { name: /Project group/u }).click();
  await expect(page.getByRole('heading', { name: 'Project group' })).toBeVisible();
  const pdfPreview = page.getByTitle('Sandboxed PDF preview: statement.pdf');
  await expect(pdfPreview).toBeVisible();
  await expect(pdfPreview).toHaveAttribute('sandbox', '');
  await expect(page.locator('article').getByText(/application\/pdf · \d+ B/u)).toBeVisible();
  const dangerousAttachment = page.locator('#whatsapp-message-63');
  await expect(dangerousAttachment.getByText('invoice.html.download').first()).toBeVisible();
  await expect(
    page.getByText('Potentially active file type (.html) is renamed for safer download.')
  ).toBeVisible();
  await expect(
    dangerousAttachment.getByRole('link', { name: 'Download attachment' })
  ).toHaveAttribute('download', 'invoice.html.download');
  const quarantinedAttachment = page.locator('#whatsapp-message-64');
  await expect(quarantinedAttachment.getByText(/blocked by malware scan/iu)).toBeVisible();
  await expect(
    quarantinedAttachment.getByRole('link', { name: 'Download attachment' })
  ).toHaveCount(0);
  await expect(page.getByText('Group ID: 120363000')).toBeVisible();
  await expect(page.getByRole('separator', { name: 'New messages' })).toBeVisible();
  await expect(
    page.locator('article').filter({ hasText: 'A sent reply' }).getByText('Sent', { exact: true })
  ).toBeVisible();
  await expect(
    page
      .locator('article')
      .filter({ hasText: 'A delivered reply' })
      .getByText('Delivered', { exact: true })
  ).toBeVisible();
  await expect(
    page.locator('article').filter({ hasText: 'A read reply' }).getByText('Read', { exact: true })
  ).toBeVisible();
  await expect(
    page
      .locator('article')
      .filter({ hasText: 'A failed reply' })
      .getByText('Failed', { exact: true })
  ).toBeVisible();
  await expect(
    page
      .locator('article')
      .filter({ hasText: 'Can you help?' })
      .getByText('Received', { exact: true })
  ).toBeVisible();
  const viewOnceArticle = page.locator('#whatsapp-message-59');
  await expect(viewOnceArticle.getByText('View-once media')).toBeVisible();
  await expect(viewOnceArticle.getByRole('button', { name: 'Reply to message' })).toHaveCount(0);
  const unknownTypeArticle = page.locator('#whatsapp-message-60');
  await expect(unknownTypeArticle.getByText('Unsupported message type')).toBeVisible();
  await expect(unknownTypeArticle.getByRole('button', { name: 'Forward message' })).toHaveCount(0);
  await expect(
    page.locator('article').filter({ hasText: 'A failed reply' }).getByRole('button', {
      name: 'Retry send',
    })
  ).toBeVisible();
  await expect(
    page.locator('article').getByText('Attachment storage is temporarily unavailable. Try again.')
  ).toBeVisible();
  await expect(
    page.locator('article').getByText('WhatsApp could not retrieve this attachment. Try again.')
  ).toBeVisible();
  await page.getByRole('button', { name: 'Unread' }).click();
  await expect(page.getByRole('button', { name: /Project group/u })).toBeVisible();
  await expect(page.getByRole('button', { name: /Rani Putri/u })).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'Mark latest as read' }).click();
  await page.getByRole('button', { name: 'Load more conversations' }).click();
  await expect(page.getByRole('button', { name: /Older conversation/u })).toBeVisible();
  await expect(page.locator('#whatsapp-message-50').getByText('Can you help?')).toBeVisible();
  await page.locator('#whatsapp-message-50').getByRole('button', { name: /React/u }).click();
  await page
    .getByRole('dialog', { name: 'React to message' })
    .getByRole('button', { name: 'React with 👍' })
    .click();
  await expect.poll(() => sentReactions).toEqual([{ sourceId: '50', emoji: '👍' }]);
  await expect(
    page.locator('#whatsapp-message-50').getByRole('img', { name: /👍 reaction/u })
  ).toBeVisible();
  await expect(page.locator('article time').first()).toHaveAttribute(
    'datetime',
    /^\d{4}-\d{2}-\d{2}T/u
  );
  await expect(page.locator('article time').first()).not.toHaveText('—');
  const loadOlderButton = page.getByRole('button', { name: 'Load older messages' });
  if (await loadOlderButton.isVisible().catch(() => false)) await loadOlderButton.click();
  await expect(page.locator('article').getByText('Older history')).toBeVisible();
  const inboundMessage = page.locator('#whatsapp-message-50');
  await inboundMessage.getByRole('button', { name: 'Copy message' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Can you help?');
  await page.getByRole('button', { name: 'Jump to quoted message' }).click();
  await expect(page.locator('#whatsapp-message-50')).toBeFocused();
  const messageScroller = page.locator('div.overflow-y-auto').last();
  await expect
    .poll(() => messageScroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await page.locator('article').last().scrollIntoViewIfNeeded();
  await expect
    .poll(() => messageScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(-48);
  includeNewInboundMessage = true;
  await expect(page.getByRole('button', { name: 'New messages · Jump to latest' })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'New messages · Jump to latest' }).click();
  await expect(page.locator('article').getByText('New inbound message')).toBeVisible();
  const composer = page.getByPlaceholder('Write a message…');
  await composer.fill('Thanks, I will take a look.');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('Checking this multiline reply.');
  await expect(composer).toHaveValue('Thanks, I will take a look.\nChecking this multiline reply.');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(page.locator('article').getByText('Sent', { exact: true })).toBeVisible();
  const enterToSend = page.getByRole('checkbox', { name: 'Press Enter to send' });
  await enterToSend.uncheck();
  await composer.fill('Draft before newline');
  await composer.press('Enter');
  await expect(composer).toHaveValue('Draft before newline\n');
  await composer.press('Control+Enter');
  await expect(composer).toHaveValue('');
  const replyTarget = page.locator('#whatsapp-message-50');
  await replyTarget.getByRole('button', { name: 'Reply to message' }).click();
  await expect(page.getByText('Replying to: Can you help?')).toBeVisible();
  await composer.fill('Quoted response');
  await composer.press('Control+Enter');
  await expect(composer).toHaveValue('');
  await expect(page.getByText('Replying to: Can you help?')).toHaveCount(0);
  expect(sentMessages).toEqual([
    'Thanks, I will take a look.\nChecking this multiline reply.',
    'Draft before newline',
    'Quoted response',
  ]);
  await page
    .locator('#whatsapp-message-50')
    .getByRole('button', { name: 'Forward message' })
    .click();
  const forwardDialog = page.getByRole('dialog', { name: 'Forward message' });
  await forwardDialog
    .getByRole('textbox', { name: 'Search forward destinations' })
    .fill('Older destination');
  await forwardDialog.getByRole('button', { name: 'Forward to Older destination' }).click();
  await expect(page.getByText('Forward queued')).toBeVisible();
  expect(forwardedMessages).toHaveLength(1);
  expect(forwardedMessages[0]).toMatchObject({
    sourceId: '50',
    body: { conversation_id: 99 },
  });
  expect(forwardedMessages[0]?.key).toBeTruthy();
  const ownReply = page.locator('#whatsapp-message-52');
  await expect(ownReply.locator('time')).toHaveAttribute('aria-label', /^Message time:/u);
  await ownReply.getByRole('button', { name: 'Edit message' }).click();
  await page.getByLabel('Edited message text').fill('Edited reply text');
  await page.getByRole('button', { name: 'Save edit' }).click();
  await expect(ownReply.getByText('Edited', { exact: true })).toBeVisible();
  await expect(ownReply.getByText('Edited reply text')).toBeVisible();
  await ownReply.getByRole('button', { name: 'Delete message for everyone' }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete for everyone?' })
    .getByRole('button', { name: 'Delete message' })
    .click();
  await expect(ownReply.getByText('This message was deleted')).toBeVisible();
  await expect(ownReply.getByRole('button', { name: 'Edit message' })).toHaveCount(0);
  await page
    .locator('#whatsapp-message-50')
    .getByRole('button', { name: 'Forward message' })
    .click();
  const secondForwardDialog = page.getByRole('dialog', { name: 'Forward message' });
  await expect(
    secondForwardDialog.getByRole('button', { name: 'Load more destinations' })
  ).toBeVisible();
  await secondForwardDialog.getByRole('button', { name: 'Load more destinations' }).click();
  await expect(
    secondForwardDialog.getByRole('button', { name: 'Forward to Older conversation' })
  ).toBeVisible();
  await secondForwardDialog
    .getByRole('checkbox', { name: 'Include archived conversations' })
    .check();
  await expect
    .poll(() => forwardDestinationQueries.some((query) => query.archived === 'true'))
    .toBe(true);
  await secondForwardDialog.getByRole('button', { name: 'Cancel' }).click();
  const conversationSearch = page.getByLabel('Search conversations by name, number, or message');
  const projectChat = page.getByRole('button', { name: /Project group/u });
  const raniChat = page.getByRole('button', { name: /Rani Putri/u });
  await raniChat.focus();
  await page.keyboard.press('ArrowUp');
  await expect(projectChat).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(raniChat).toBeFocused();
  await page.keyboard.press('Home');
  await expect(projectChat).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: /Contact 47/u })).toBeFocused();
  await projectChat.focus();
  await page.keyboard.press('/');
  await expect(conversationSearch).toBeFocused();
  await expect(conversationSearch).toHaveAttribute('aria-keyshortcuts', '/');
  await conversationSearch.fill('Rani');
  await expect(page.getByRole('button', { name: /Rani Putri/u })).toBeVisible();
  await conversationSearch.fill('');
  await page.getByRole('button', { name: 'Groups' }).click();
  await expect(page.getByRole('button', { name: /Project group/u })).toBeVisible();
  await expect(page.getByRole('button', { name: /Rani Putri/u })).toHaveCount(0);
  await page.getByLabel('Search conversations by name, number, or message').fill('120363000');
  await expect(page.getByRole('button', { name: /Project group/u })).toBeVisible();
  await page.getByLabel('Search conversations by name, number, or message').fill('help');
  await expect(page.getByRole('button', { name: /Project group/u })).toBeVisible();
  await page.getByLabel('Search conversations by name, number, or message').fill('');
  await page.waitForTimeout(300);
  failSearchConversationLoad = true;
  await page.getByLabel('Search conversations by name, number, or message').fill('trigger-error');
  await expect(page.getByRole('button', { name: 'Retry inbox' })).toBeVisible();
  failSearchConversationLoad = false;
  await page.getByRole('button', { name: 'Retry inbox' }).click();
  await page.getByLabel('Search conversations by name, number, or message').fill('');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('button', { name: /Rani Putri/u })).toBeVisible();
  await page.getByRole('button', { name: 'Private' }).click();
  await page.getByRole('button', { name: /Contact 0/u }).click();
  await expect(page.getByRole('heading', { name: 'Contact 0' })).toBeVisible();
  await expect(
    page.getByText(
      'No messages in this conversation yet. Send a message to start the conversation.'
    )
  ).toBeVisible();
  await expect(page.getByText('+628200000000')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Press Enter to send' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Private' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('heading', { name: 'Contact 0' })).toBeVisible();
  const conversationList = page.getByRole('complementary', { name: 'Conversation inbox' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(conversationList).toBeVisible();
  await page.getByRole('button', { name: /Contact 0/u }).click();
  await expect(conversationList).toBeHidden();
  const mobileComposer = page.getByRole('textbox', { name: 'Write a message' });
  await expect(mobileComposer).toBeVisible();
  expect(
    await mobileComposer.evaluate(
      (element) => element.getBoundingClientRect().bottom <= window.innerHeight
    )
  ).toBe(true);
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(conversationList).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.getByLabel('Group name').fill('Board project team');
  const participantInput = page.getByLabel('Participant phone number');
  await participantInput.fill('not a phone');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#whatsapp-group-creator').getByRole('alert')).toContainText(
    'valid international number'
  );
  await participantInput.fill('+62 811-1222-333');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Group participants' })).toContainText(
    '+628111222333'
  );
  await participantInput.fill('628111222333');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#whatsapp-group-creator').getByRole('alert')).toContainText(
    'already in the list'
  );
  await participantInput.fill('+62 812-3333-444');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('2 of 100 participants')).toBeVisible();
  const createGroupButton = page.getByRole('button', { name: 'Create group', exact: true }).last();
  await createGroupButton.click();
  await expect(page.locator('#whatsapp-group-creator').getByRole('alert')).toContainText(
    'result is not confirmed'
  );
  await expect(page.getByLabel('Group name')).toBeDisabled();
  await page.getByRole('button', { name: 'Check group result' }).click();
  await expect(page.getByRole('heading', { name: 'Board project team' })).toBeVisible();
  for (const eventText of [
    '628222222222@s.whatsapp.net joined the group',
    '628222222222@s.whatsapp.net left the group',
    '628222222222@s.whatsapp.net became an admin',
    '628222222222@s.whatsapp.net is no longer an admin',
  ]) {
    await expect(page.locator('article').getByText(eventText, { exact: true })).toBeVisible();
  }
  expect(groupCreateRequests).toHaveLength(2);
  expect(groupCreateRequests[0]?.key).toBeTruthy();
  expect(groupCreateRequests[1]?.key).toBe(groupCreateRequests[0]?.key);
  expect(groupCreateRequests[0]?.body).toEqual({
    title: 'Board project team',
    participants: ['+628111222333', '+628123333444'],
  });
  await page.getByText('Show participants', { exact: true }).click();
  await page.getByRole('button', { name: 'Make admin' }).click();
  await page
    .getByRole('alertdialog', { name: 'Confirm group participant action' })
    .getByRole('button', { name: 'Confirm promote' })
    .click();
  await expect.poll(() => groupParticipantActions.length).toBe(1);
  expect(groupParticipantActions[0]).toMatchObject({
    action: 'promote',
    body: { participants: ['628111222333'] },
  });
  expect(groupParticipantActions[0]?.key).toBeTruthy();
  await page.getByRole('button', { name: 'Demote' }).click();
  await page
    .getByRole('alertdialog', { name: 'Confirm group participant action' })
    .getByRole('button', { name: 'Confirm demote' })
    .click();
  await expect.poll(() => groupParticipantActions.length).toBe(2);
  expect(groupParticipantActions[1]?.action).toBe('demote');
  await expect(page.getByRole('button', { name: 'Make admin' })).toBeVisible();
  await page.getByLabel('Add group participant phone number').fill('+62 811-5555-666');
  await page.getByRole('button', { name: 'Add participant' }).click();
  await page
    .getByRole('alertdialog', { name: 'Confirm group participant action' })
    .getByRole('button', { name: 'Confirm add' })
    .click();
  await expect.poll(() => groupParticipantActions.length).toBe(3);
  expect(groupParticipantActions[2]).toMatchObject({
    action: 'add',
    body: { participants: ['628115555666'] },
  });
  expect(groupParticipantActions[2]?.key).toBeTruthy();
  expect(groupParticipantActions[2]?.key).not.toBe(groupParticipantActions[0]?.key);
  await expect(page.getByText('New participant', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await page
    .getByRole('alertdialog', { name: 'Confirm group participant action' })
    .getByRole('button', { name: 'Confirm remove' })
    .click();
  await expect.poll(() => groupParticipantActions.length).toBe(4);
  expect(groupParticipantActions[3]?.action).toBe('remove');
  await expect(page.getByText('New participant', { exact: true })).toHaveCount(0);
  await page.getByLabel('Add group participant phone number').fill('+62 811-5555-666');
  await page.getByRole('button', { name: 'Add participant' }).click();
  await page
    .getByRole('alertdialog', { name: 'Confirm group participant action' })
    .getByRole('button', { name: 'Confirm add' })
    .click();
  await expect.poll(() => groupParticipantActions.length).toBe(5);
  await expect(page.getByText('New participant', { exact: true })).toBeVisible();
  simulateUnknownGroupRemoval = true;
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await page
    .getByRole('alertdialog', { name: 'Confirm group participant action' })
    .getByRole('button', { name: 'Confirm remove' })
    .click();
  await expect.poll(() => groupParticipantActions.length).toBe(6);
  await expect(page.getByText(/unknown; refresh group details/u)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add participant' })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh group details' }).click();
  await expect(page.getByText('New participant', { exact: true })).toHaveCount(0);
  await page.getByLabel('Add group participant phone number').fill('+62 811-5555-666');
  await expect(page.getByRole('button', { name: 'Add participant' })).toBeEnabled();
  await page.getByRole('button', { name: 'Get invite link' }).click();
  await expect(page.getByRole('link', { name: 'Open group invite link' })).toHaveAttribute(
    'href',
    'https://chat.whatsapp.com/AbCdEfGh12345670'
  );
  await page.getByRole('button', { name: 'Reset invite link' }).click();
  await page
    .getByRole('alertdialog', { name: 'Confirm invite link reset' })
    .getByRole('button', { name: 'Confirm reset' })
    .click();
  await expect.poll(() => groupInviteResetCount).toBe(1);
  await expect(page.getByRole('link', { name: 'Open group invite link' })).toHaveAttribute(
    'href',
    'https://chat.whatsapp.com/AbCdEfGh12345671'
  );
  await page.getByRole('button', { name: 'Leave group' }).click();
  await page
    .getByRole('alertdialog', { name: 'Confirm leaving group' })
    .getByRole('button', { name: 'Confirm leave' })
    .click();
  await expect.poll(() => groupLeaveRequests.length).toBe(1);
  expect(groupLeaveRequests[0]).toBeTruthy();
  await expect(conversationList).toBeVisible();
  await page.getByRole('button', { name: 'Join group from invite link' }).click();
  await page.getByLabel('Group invitation link').fill('https://chat.whatsapp.com/AbCdEfGh12345678');
  await page.getByRole('button', { name: 'Preview group' }).click();
  await expect(page.getByText('Joined by invite', { exact: true })).toBeVisible();
  await expect(page.getByText('A preview topic')).toBeVisible();
  await page.getByRole('button', { name: 'Join this group' }).click();
  await page
    .getByRole('alertdialog', { name: 'Confirm joining WhatsApp group' })
    .getByRole('button', { name: 'Confirm join' })
    .click();
  await expect.poll(() => groupInviteJoins.length).toBe(1);
  expect(groupInviteJoins[0]).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Joined by invite' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: '../../test-results/whatsapp-board.png', fullPage: true });
});

test('publishes WhatsApp text and image Status from the dedicated composer', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  await page.route('**/whatsapp/account', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { status: 'connected', permissions: { send: true } },
      },
    })
  );
  const published: Array<{
    content: string;
    type: 'text' | 'image' | 'video';
    allow_reshare: boolean;
    status: 'queued' | 'sent' | 'failed';
    last_error?: string | null;
  }> = [];
  await page.route('**/whatsapp/statuses', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          success: true,
          data: published.map((item, index) => ({
            id: index + 1,
            status_type: item.type,
            content: item.content,
            media_file_name:
              item.type === 'image' ? 'status.png' : item.type === 'video' ? 'status.mp4' : null,
            allow_reshare: item.allow_reshare,
            status: item.status,
            attempt_count: 0,
            last_error: item.last_error ?? null,
            published_at: null,
            create_date: new Date().toISOString(),
          })),
        },
      });
    }
    const request = route.request();
    const contentType = request.headers()['content-type'] ?? '';
    if (contentType.includes('multipart/form-data')) {
      const body = (await request.postDataBuffer())?.toString('latin1') ?? '';
      const type = body.includes('status.mp4') ? 'video' : 'image';
      published.push({
        content: body.includes('Image caption')
          ? 'Image caption'
          : body.includes('Video caption')
            ? 'Video caption'
            : '',
        type,
        allow_reshare: body.includes('name="allow_reshare"\r\n\r\ntrue'),
        status: 'queued',
      });
    } else {
      const body = request.postDataJSON() as { content: string; allow_reshare: boolean };
      published.push({
        content: body.content,
        type: 'text',
        allow_reshare: body.allow_reshare,
        status: 'queued',
      });
    }
    await route.fulfill({
      status: 202,
      json: { success: true, data: { id: published.length, status: 'queued' } },
    });
  });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/board/whatsapp/status');
  await page.getByLabel('Status text or caption').fill('A text Status');
  await page.getByRole('button', { name: 'Publish Status' }).click();
  await expect(page.getByText('text · Queued')).toBeVisible();
  expect(published[0]).toMatchObject({
    content: 'A text Status',
    type: 'text',
    allow_reshare: false,
  });

  await page.getByLabel('Status text or caption').fill('Image caption');
  await page.getByLabel('Choose Status image or video').setInputFiles({
    name: 'status.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=',
      'base64'
    ),
  });
  await expect(page.getByRole('img', { name: 'WhatsApp Status image preview' })).toBeVisible();
  await page.getByLabel('Allow resharing this Status').check();
  await page.getByRole('button', { name: 'Publish Status' }).click();
  await expect(page.getByText('image · Queued')).toBeVisible();
  expect(published[1]).toMatchObject({
    content: 'Image caption',
    type: 'image',
    allow_reshare: true,
  });

  await page.getByLabel('Status text or caption').fill('Video caption');
  await page.getByLabel('Choose Status image or video').setInputFiles({
    name: 'status.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('0000ftypisom'),
  });
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: 'Publish Status' }).click();
  await expect(page.getByText('video · Queued')).toBeVisible();
  expect(published[2]).toMatchObject({
    content: 'Video caption',
    type: 'video',
    allow_reshare: false,
  });

  published[0]!.status = 'sent';
  published[1]!.status = 'failed';
  published[1]!.last_error = 'GoWA rejected the Status media';
  await expect(page.getByText('text · Published')).toBeVisible({ timeout: 7_000 });
  await expect(page.getByText('image · Failed')).toBeVisible({ timeout: 7_000 });
  await expect(page.getByText('GoWA rejected the Status media')).toBeVisible();
});

test('internal notes stay outside the WhatsApp message timeline', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const conversation = {
    id: 81,
    name: 'Internal notes test',
    jid: '628555111222@s.whatsapp.net',
    is_group: false,
    is_archived: false,
    is_pinned: false,
    unread_count: 0,
  };
  let notes: Array<{
    id: number;
    user_id: number;
    author_name: string;
    body: string;
    create_date: string;
  }> = [];
  await page.route('**/whatsapp/account', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          status: 'connected',
          permissions: {
            manage: true,
            manageConversations: true,
            createConversation: true,
            send: true,
            manageMessages: true,
          },
        },
      },
    })
  );
  await page.route('**/whatsapp/conversations**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contact'))
      return route.fulfill({
        json: {
          success: true,
          data: {
            name: conversation.name,
            phone_number: '628555111222',
            verified_name: null,
            status: null,
          },
        },
      });
    if (url.pathname.endsWith('/notes')) {
      if (route.request().method() === 'POST') {
        const { content } = route.request().postDataJSON();
        notes = [
          {
            id: 101,
            user_id: 1,
            author_name: 'superadmin',
            body: content,
            create_date: new Date().toISOString(),
          },
        ];
        return route.fulfill({ status: 201, json: { success: true, data: notes[0] } });
      }
      return route.fulfill({ json: { success: true, data: notes } });
    }
    if (url.pathname.endsWith('/messages'))
      return route.fulfill({ json: { success: true, data: [] } });
    return route.fulfill({ json: { success: true, data: [conversation] } });
  });

  await page.goto('/board/whatsapp');
  const internalNotesButton = page.getByRole('button', { name: /^Internal notes \(0\)$/u });
  await expect(internalNotesButton).toBeVisible();
  await internalNotesButton.click();
  await expect(page.getByText('No internal notes yet.')).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Internal note' })
    .fill('Call back tomorrow; never send this note.');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await expect(page.getByText('Call back tomorrow; never send this note.')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Internal notes' }).getByText('superadmin', { exact: true })
  ).toBeVisible();
  await expect(page.locator('article')).toHaveCount(0);
});

test('creates labels, applies them to a conversation, and filters the inbox', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const conversations = [
    {
      id: 91,
      name: 'Target conversation',
      jid: '628555111222@s.whatsapp.net',
      is_group: false,
      is_archived: false,
      is_pinned: false,
      unread_count: 0,
      labels: [] as Array<{ id: number; name: string; color: string }>,
    },
    {
      id: 92,
      name: 'Untagged conversation',
      jid: '628555333444@s.whatsapp.net',
      is_group: false,
      is_archived: false,
      is_pinned: false,
      unread_count: 0,
      labels: [] as Array<{ id: number; name: string; color: string }>,
    },
  ];
  let labels: Array<{ id: number; name: string; color: string }> = [];
  await page.route('**/whatsapp/account', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          status: 'connected',
          permissions: { manage: true, manageConversations: true, send: true },
        },
      },
    })
  );
  await page.route('**/whatsapp/labels**', async (route) => {
    if (route.request().method() === 'POST') {
      labels = [{ id: 8, name: 'Priority', color: '#f1d340' }];
      return route.fulfill({ status: 201, json: { success: true, data: labels[0] } });
    }
    if (route.request().method() === 'DELETE') {
      labels = [];
      conversations[0].labels = [];
      return route.fulfill({ json: { success: true, data: { id: 8 } } });
    }
    return route.fulfill({ json: { success: true, data: labels } });
  });
  await page.route('**/whatsapp/conversations**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/contact'))
      return route.fulfill({
        json: {
          success: true,
          data: {
            name: conversations[0].name,
            phone_number: '628555111222',
            verified_name: null,
            status: null,
          },
        },
      });
    if (url.pathname.endsWith('/labels') && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { label_ids: number[] };
      conversations[0].labels = body.label_ids.includes(8) ? [...labels] : [];
      return route.fulfill({ json: { success: true, data: conversations[0].labels } });
    }
    if (url.pathname.endsWith('/messages'))
      return route.fulfill({ json: { success: true, data: [] } });
    const labelFilter = url.searchParams.get('label_id');
    const matches = labelFilter
      ? conversations.filter((conversation) => conversation.labels.some((label) => label.id === 8))
      : conversations;
    return route.fulfill({ json: { success: true, data: matches } });
  });

  await page.goto('/board/whatsapp');
  await page.getByRole('textbox', { name: 'New conversation label' }).fill('Priority');
  await page.getByRole('button', { name: 'Add label' }).click();
  await expect(page.getByRole('button', { name: 'Add Priority' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Priority' }).click();
  await page.getByRole('button', { name: 'Priority', exact: true }).click();
  await expect(page.getByRole('button', { name: /Target conversation/u })).toBeVisible();
  await expect(page.getByRole('button', { name: /Untagged conversation/u })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Priority', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: /Untagged conversation/u })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete label Priority' }).click();
  await page.getByRole('button', { name: 'Confirm delete label Priority' }).click();
  await expect(page.getByRole('button', { name: 'Priority', exact: true })).toHaveCount(0);
});

test('assigns conversations to agents and teams and closes or reopens queue items', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const conversations = [
    {
      id: 501,
      name: 'My open conversation',
      jid: '628555000501@s.whatsapp.net',
      is_group: false,
      is_archived: false,
      is_pinned: false,
      assigned_user_id: 2,
      assigned_user_name: 'superadmin',
      assigned_team_id: 5,
      assigned_team_name: 'API',
      work_state: 'open' as 'open' | 'closed',
      unread_count: 0,
    },
    {
      id: 502,
      name: 'Unassigned conversation',
      jid: '628555000502@s.whatsapp.net',
      is_group: false,
      is_archived: false,
      is_pinned: false,
      assigned_user_id: null as number | null,
      assigned_user_name: null as string | null,
      assigned_team_id: null as number | null,
      assigned_team_name: null as string | null,
      work_state: 'open' as 'open' | 'closed',
      unread_count: 0,
    },
  ];
  let assignmentRequestCount = 0;
  await page.route('**/whatsapp/account', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          status: 'connected',
          permissions: { manage: true, manageConversations: true, send: true },
        },
      },
    })
  );
  await page.route('**/whatsapp/agents', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          members: [
            { id: 2, login: 'superadmin', team_id: 5, team_name: 'API' },
            { id: 3, login: 'agent-b', team_id: 5, team_name: 'API' },
          ],
          teams: [{ id: 5, name: 'API' }],
        },
      },
    })
  );
  await page.route('**/whatsapp/conversations**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.endsWith('/contact')) {
      const conversationId = Number(path.split('/').at(-2));
      const conversation = conversations.find((item) => item.id === conversationId);
      return route.fulfill({
        json: {
          success: true,
          data: {
            name: conversation?.name ?? 'Unknown contact',
            phone_number: null,
            verified_name: null,
            status: null,
          },
        },
      });
    }
    if (path.endsWith('/assignment') && method === 'PUT') {
      assignmentRequestCount++;
      const body = route.request().postDataJSON() as {
        assigned_user_id: number | null;
        assigned_team_id: number | null;
      };
      const conversationId = Number(path.split('/').at(-2));
      const conversation = conversations.find((item) => item.id === conversationId)!;
      conversation.assigned_user_id = body.assigned_user_id;
      conversation.assigned_team_id = body.assigned_team_id;
      conversation.assigned_user_name =
        body.assigned_user_id === 2 ? 'superadmin' : body.assigned_user_id === 3 ? 'agent-b' : null;
      conversation.assigned_team_name = body.assigned_team_id === 5 ? 'API' : null;
      return route.fulfill({
        json: {
          success: true,
          data: {
            id: conversationId,
            assigned_user_id: body.assigned_user_id,
            assigned_team_id: body.assigned_team_id,
          },
        },
      });
    }
    if (path.endsWith('/state') && method === 'PUT') {
      const body = route.request().postDataJSON() as { work_state: 'open' | 'closed' };
      const conversationId = Number(path.split('/').at(-2));
      const conversation = conversations.find((item) => item.id === conversationId)!;
      conversation.work_state = body.work_state;
      return route.fulfill({ json: { success: true, data: { work_state: body.work_state } } });
    }
    if (path.endsWith('/messages')) return route.fulfill({ json: { success: true, data: [] } });
    const queue = url.searchParams.get('queue') ?? 'all';
    const teamId = url.searchParams.get('team_id');
    const workState = url.searchParams.get('work_state') ?? 'all';
    const matches = conversations.filter(
      (conversation) =>
        (queue === 'all' ||
          (queue === 'mine' && conversation.assigned_user_id === 2) ||
          (queue === 'unassigned' &&
            conversation.assigned_user_id === null &&
            conversation.assigned_team_id === null)) &&
        (!teamId || conversation.assigned_team_id === Number(teamId)) &&
        (workState === 'all' || conversation.work_state === workState)
    );
    return route.fulfill({ json: { success: true, data: matches } });
  });

  await page.goto('/board/whatsapp');
  await expect(page.getByRole('button', { name: /My open conversation/u })).toBeVisible();
  await page.getByRole('button', { name: 'Unassigned', exact: true }).click();
  await expect(page.getByRole('button', { name: /Unassigned conversation/u })).toBeVisible();
  await page.getByRole('button', { name: 'Assign chat' }).click();
  await page.getByRole('button', { name: 'Assign to team API' }).click();
  await expect.poll(() => assignmentRequestCount).toBe(1);
  await expect.poll(() => conversations[1]?.assigned_team_id).toBe(5);
  await expect(page.getByRole('button', { name: /Unassigned conversation/u })).toHaveCount(0);
  await page.getByRole('button', { name: 'Queue: All', exact: true }).click();
  await page.getByRole('button', { name: 'API', exact: true }).click();
  await expect(page.getByRole('button', { name: /Unassigned conversation/u })).toBeVisible();
  await page.getByRole('button', { name: /Unassigned conversation/u }).click();
  await page.getByRole('button', { name: 'Assign chat' }).click();
  await page.getByRole('button', { name: 'Assign to agent-b' }).click();
  await expect.poll(() => assignmentRequestCount).toBe(2);
  await expect.poll(() => conversations[1]?.assigned_user_id).toBe(3);
  await expect(page.getByRole('button', { name: /Unassigned conversation/u })).toContainText(
    'Assigned to agent-b'
  );
  await page.getByRole('button', { name: 'Assign chat' }).click();
  await expect(
    page.getByRole('region', { name: 'Assign conversation' }).getByText('Assigned to agent-b')
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mine', exact: true }).click();
  await expect(page.getByRole('button', { name: /My open conversation/u })).toBeVisible();
  await expect(page.getByRole('button', { name: /Unassigned conversation/u })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.getByRole('button', { name: 'Closed', exact: true }).click();
  await expect(page.getByRole('button', { name: /My open conversation/u })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /My open conversation/u }).getByText('Closed', { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reopen chat' }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: /My open conversation/u })).toBeVisible();
});

test('connect shows QR, media is sent, and failures preserve the draft', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  let status = 'disconnected';
  let directUploads = false;
  let accountRequests = 0;
  let connectRequests = 0;
  let disconnectRequests = 0;
  await page.route('**/whatsapp/account**', (route) => {
    accountRequests++;
    return route.fulfill({
      json: {
        success: true,
        data: {
          status,
          direct_uploads: directUploads,
          qr_code: status === 'qr' ? 'mock-qr-for-test' : null,
          permissions: { manage: true, createConversation: true, send: true, manageMessages: true },
        },
      },
    });
  });
  await page.route('**/whatsapp/connect', (route) => {
    connectRequests++;
    status = 'qr';
    return route.fulfill({ status: 202, json: { success: true } });
  });
  await page.route('**/whatsapp/disconnect', (route) => {
    disconnectRequests++;
    status = 'disconnected';
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/whatsapp/contacts/check', (route) =>
    route.fulfill({
      json: { success: true, data: { phone: '+6281234567890', is_on_whatsapp: true } },
    })
  );
  let createdChat = false;
  const contact = {
    id: 12,
    name: 'Test contact',
    jid: '123@s.whatsapp.net',
    is_group: false,
    unread_count: 0,
  };
  await page.route('**/whatsapp/conversations*', (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ phone: '+6281234567890' });
      createdChat = true;
      return route.fulfill({ status: 201, json: { success: true, data: contact } });
    }
    return route.fulfill({ json: { success: true, data: createdChat ? [contact] : [] } });
  });
  await page.route('**/whatsapp/conversations/12/uploads**', (route) =>
    route.fulfill({
      status: 201,
      json: {
        success: true,
        data: {
          upload_id: 34,
          url: 'https://storage.test/private-attachments',
          method: 'POST',
          fields: { key: 'signed-key', Policy: 'signed-policy', 'X-Amz-Signature': 'signed' },
        },
      },
    })
  );
  let signedStorageUpload = 0;
  let failSignedStorageUpload = false;
  await page.route('https://storage.test/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }
    signedStorageUpload++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBeUndefined();
    const payload = route.request().postDataBuffer();
    expect(payload?.toString('latin1')).toContain('name="key"');
    expect(payload?.toString('latin1')).toContain('signed-key');
    expect(payload?.includes(Buffer.from('test attachment'))).toBe(true);
    if (failSignedStorageUpload) {
      return route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': '*' },
      });
    }
    await route.fulfill({
      status: 204,
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  let fail = false,
    queued = false,
    uploadAttempts = 0;
  const uploadKeys: string[] = [];
  await page.route('**/whatsapp/conversations/12/messages*', async (route) => {
    if (route.request().method() === 'POST') {
      if (fail)
        return route.fulfill({
          status: 503,
          json: { success: false, error: 'Service unavailable' },
        });
      uploadAttempts += 1;
      const contentType = route.request().headers()['content-type'] ?? '';
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      if (contentType.includes('multipart/form-data')) {
        const payload = route.request().postDataBuffer();
        expect(payload?.toString('latin1')).toContain('name="content"');
        expect(payload?.toString('latin1')).toContain('Test caption');
        expect(payload?.toString('latin1')).toContain('filename="sample.txt"');
        expect(payload?.includes(Buffer.from('test attachment'))).toBe(true);
      } else {
        expect(route.request().postDataJSON()).toMatchObject({
          content: 'Direct caption',
          upload_ticket_id: 34,
        });
      }
      uploadKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (uploadAttempts === 1) await new Promise((resolve) => setTimeout(resolve, 1_500));
      else await new Promise((resolve) => setTimeout(resolve, 500));
      queued = true;
      return route.fulfill({
        status: 202,
        json: { success: true, data: { id: 2, status: 'queued' } },
      });
    }
    return route.fulfill({
      json: {
        success: true,
        data: queued
          ? [
              {
                id: 2,
                direction: 'outbound',
                content: 'Test caption',
                status: 'sent',
                message_type: 'text',
                create_date: new Date().toISOString(),
              },
            ]
          : [],
      },
    });
  });
  await page.goto('/board/whatsapp');
  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await expect(
    page.getByRole('button', { name: 'Switch company. Current scope: MoonWitness' })
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole('button', { name: 'Connect WhatsApp' }).click();
  await expect.poll(() => connectRequests).toBe(1);
  const qrCode = page.getByAltText('WhatsApp connection QR code');
  await expect(qrCode).toBeVisible();
  await page.getByText('QR scan help', { exact: true }).click();
  await expect(page.getByText(/Android: open the menu/u)).toBeVisible();
  await expect(page.getByText(/iPhone: open Settings/u)).toBeVisible();
  await expect(page.getByText(/Keep this QR code private/u)).toBeVisible();
  await page.getByText('QR scan help', { exact: true }).click();
  expect((await qrCode.boundingBox())?.width).toBeLessThanOrEqual(256);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Cancel connection' }).click();
  const cancelPairingDialog = page.getByRole('alertdialog', {
    name: 'Cancel WhatsApp connection?',
  });
  await expect(cancelPairingDialog).toBeVisible();
  await cancelPairingDialog.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect.poll(() => disconnectRequests).toBe(1);
  await expect(page.getByRole('button', { name: 'Connect WhatsApp' })).toBeVisible();
  status = 'qr_expired';
  await expect(page.getByText('QR code expired')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh QR code' }).click();
  await expect(page.getByAltText('WhatsApp connection QR code')).toBeVisible();
  const accountPollBeforeConnect = accountRequests;
  status = 'connected';
  await expect.poll(() => accountRequests).toBeGreaterThan(accountPollBeforeConnect);
  await page.getByLabel('Phone number with country code').fill('6281234567890');
  await page.getByRole('button', { name: 'Check number', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'is on WhatsApp' })).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByPlaceholder('Write a message…').fill('Test caption');
  await page.getByLabel('Attach media', { exact: true }).setInputFiles({
    name: 'preview.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5sAAAAASUVORK5CYII=',
      'base64'
    ),
  });
  await expect(page.getByAltText('Preview of preview.png')).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByAltText('Preview of preview.png')).toHaveCount(0);
  await page.getByLabel('Attach media', { exact: true }).setInputFiles({
    name: 'sample.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('test attachment'),
  });
  await expect(page.getByText('Attached: sample.txt')).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Draft saved on this device' })
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await expect(
    page.getByRole('button', { name: 'Switch company. Current scope: MoonWitness' })
  ).toBeVisible();
  await page.locator('[data-wa-conversation]').click();
  await expect(page.getByPlaceholder('Write a message…')).toHaveValue('Test caption');
  await expect(page.getByText('Attached: sample.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByRole('progressbar', { name: 'Upload progress for sample.txt' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel upload' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel upload' }).click();
  await expect(page.getByPlaceholder('Write a message…')).toHaveValue('Test caption');
  await expect(page.getByText(/Upload stopped/u)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Sending message' })).toBeDisabled();
  await expect(page.getByPlaceholder('Write a message…')).toHaveValue('');
  expect(uploadKeys).toHaveLength(2);
  expect(uploadKeys[1]).toBe(uploadKeys[0]);
  await expect(page.locator('article').getByText('sent')).toBeVisible();
  const accountPollBeforeDirectUpload = accountRequests;
  directUploads = true;
  await page.reload();
  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await expect(
    page.getByRole('button', { name: 'Switch company. Current scope: MoonWitness' })
  ).toBeVisible();
  await page.locator('[data-wa-conversation]').click();
  await expect.poll(() => accountRequests).toBeGreaterThan(accountPollBeforeDirectUpload);
  await page.getByPlaceholder('Write a message…').fill('Direct caption');
  await page.getByLabel('Attach media', { exact: true }).setInputFiles({
    name: 'sample.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('test attachment'),
  });
  failSignedStorageUpload = true;
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByPlaceholder('Write a message…')).toHaveValue('Direct caption');
  await expect(page.getByText('Attached: sample.txt')).toBeVisible();
  await expect(page.getByText('Storage rejected the media upload', { exact: true })).toBeVisible();
  expect(signedStorageUpload).toBe(1);
  failSignedStorageUpload = false;
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByPlaceholder('Write a message…')).toHaveValue('');
  expect(signedStorageUpload).toBe(2);
  fail = true;
  await page.getByPlaceholder('Write a message…').fill('Keep this draft');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByPlaceholder('Write a message…')).toHaveValue('Keep this draft');
  await expect(page.getByText('Service unavailable', { exact: true })).toBeVisible();
  const disconnectRequestsBeforeLogout = disconnectRequests;
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const disconnectDialog = page.getByRole('alertdialog', { name: 'Disconnect WhatsApp?' });
  await expect(disconnectDialog).toBeVisible();
  expect(disconnectRequests).toBe(disconnectRequestsBeforeLogout);
  await disconnectDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(disconnectDialog).toHaveCount(0);
  expect(disconnectRequests).toBe(disconnectRequestsBeforeLogout);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Disconnect WhatsApp?' })
    .getByRole('button', { name: 'Confirm disconnect' })
    .click();
  await expect.poll(() => disconnectRequests).toBe(disconnectRequestsBeforeLogout + 1);
  await expect.poll(() => status).toBe('disconnected');
  await page.reload();
  const globalScopeSwitcher = page.getByRole('button', {
    name: 'Switch company. Current scope: Global Scope',
  });
  const companyScopeSwitcher = page.getByRole('button', {
    name: 'Switch company. Current scope: MoonWitness',
  });
  await expect(globalScopeSwitcher.or(companyScopeSwitcher).first()).toBeVisible();
  if (await globalScopeSwitcher.isVisible().catch(() => false)) {
    await globalScopeSwitcher.click();
    await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  }
  await expect(companyScopeSwitcher).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect WhatsApp' })).toBeVisible();
});

test('pins, archives, and restores a conversation from the inbox', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  let archived = false;
  let pinned = false;
  const conversation = {
    id: 77,
    jid: '628555111222@s.whatsapp.net',
    name: 'Archive and pin test',
    is_group: false,
    is_archived: false,
    is_pinned: false,
    unread_count: 0,
    last_message: 'Latest preview',
    last_message_at: new Date().toISOString(),
  };
  await page.route('**/whatsapp/account', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          status: 'connected',
          permissions: {
            manage: true,
            manageConversations: true,
            createConversation: true,
            send: true,
            manageMessages: true,
          },
        },
      },
    })
  );
  await page.route('**/whatsapp/conversations*', (route) => {
    const url = new URL(route.request().url());
    const requestedArchived = url.searchParams.get('archived') === 'true';
    return route.fulfill({
      json: {
        success: true,
        data:
          requestedArchived === archived
            ? [{ ...conversation, is_archived: archived, is_pinned: pinned }]
            : [],
      },
    });
  });
  await page.route('**/whatsapp/conversations/77/messages*', (route) =>
    route.fulfill({ json: { success: true, data: [] } })
  );
  await page.route('**/whatsapp/conversations/77/pin', async (route) => {
    pinned = route.request().postDataJSON().pinned;
    await route.fulfill({
      json: { success: true, data: { ...conversation, is_archived: archived, is_pinned: pinned } },
    });
  });
  await page.route('**/whatsapp/conversations/77/archive', async (route) => {
    archived = route.request().postDataJSON().archived;
    await route.fulfill({
      json: { success: true, data: { ...conversation, is_archived: archived, is_pinned: pinned } },
    });
  });

  await page.goto('/board/whatsapp');
  await expect(page.getByRole('button', { name: /Archive and pin test/u })).toBeVisible();
  await page.getByRole('button', { name: 'Pin chat' }).click();
  await expect(page.getByRole('button', { name: 'Unpin chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Archive chat' }).click();
  await expect(page.getByText('No conversations yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Archived' }).click();
  await expect(page.getByRole('button', { name: /Archive and pin test/u })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unpin chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Unarchive chat' }).click();
  await expect(page.getByText('No conversations yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Active' }).click();
  await expect(page.getByRole('button', { name: /Archive and pin test/u })).toBeVisible();
});

test('pauses WhatsApp account polling while the Board tab is hidden', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  let accountPolls = 0;
  await page.route('**/whatsapp/account', async (route) => {
    accountPolls += 1;
    await route.fulfill({
      json: {
        success: true,
        data: {
          status: 'connected',
          phone_number: '6281234567890',
          permissions: { manage: true, createConversation: true, send: true, manageMessages: true },
        },
      },
    });
  });
  await page.goto('/board/whatsapp');
  await expect.poll(() => accountPolls).toBe(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(4000);
  expect(accountPolls).toBe(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => accountPolls, { timeout: 5000 }).toBeGreaterThan(1);
});

test('guides the user to connect a WhatsApp account before opening the inbox', async ({ page }) => {
  await page.route('**/whatsapp/account', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          status: 'disconnected',
          permissions: { manage: true, createConversation: true, send: false },
        },
      },
    })
  );

  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  await page.goto('/board/whatsapp');
  await expect(page.getByRole('button', { name: 'Connect WhatsApp' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect a WhatsApp account' })).toBeVisible();
  await expect(page.getByText('One WhatsApp account is available for this company.')).toBeVisible();
});
