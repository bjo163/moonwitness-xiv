import { randomUUID } from 'node:crypto';
import { PermanentJobError, registerOutboxConsumer } from '@moonwitness/jobs';
import type { AttachmentStorage } from '@moonwitness/orm-storage';
import {
  WhatsappAccount,
  WhatsappConversation,
  WhatsappMessage,
  WhatsappStatus,
} from './models.js';
import { mediaType } from './media.js';
import { GowaError, gowaRequest } from './gowa-client.js';

export const WHATSAPP_SEND_EVENT = 'whatsapp.message.send';
export const WHATSAPP_STATUS_PUBLISH_EVENT = 'whatsapp.status.publish';
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_DELIVERY_AGE_MS = 24 * 60 * 60 * 1_000;

function deliveryExpired(createDate: unknown, now = Date.now()): boolean {
  const createdAt = Date.parse(String(createDate ?? ''));
  return Number.isFinite(createdAt) && now - createdAt > MAX_DELIVERY_AGE_MS;
}

async function patchMessage(
  messageId: number,
  companyId: number,
  patch: Record<string, unknown>
): Promise<void> {
  await WhatsappMessage.query()
    .where({ id: messageId, company_id: companyId })
    .patch({
      ...patch,
      write_date: new Date().toISOString(),
    });
}

async function safelyRetryOrFail(
  messageId: number,
  companyId: number,
  eventId: number,
  attemptCount: number,
  createDate: unknown,
  errorCode: string
): Promise<void> {
  const event = await WhatsappMessage.knex()('outbox_events')
    .where({ id: eventId })
    .first('attempts', 'max_attempts');
  if (
    event &&
    Number(event.attempts) < Number(event.max_attempts) &&
    attemptCount < MAX_DELIVERY_ATTEMPTS &&
    !deliveryExpired(createDate)
  ) {
    await patchMessage(messageId, companyId, {
      status: 'queued',
      last_error: errorCode,
      retryable: false,
    });
    throw new Error(errorCode);
  }
  await patchMessage(messageId, companyId, {
    status: 'failed',
    last_error: errorCode,
    retryable: attemptCount < MAX_DELIVERY_ATTEMPTS && !deliveryExpired(createDate),
  });
}

async function updateConversationPreview(
  message: {
    conversation_id: number;
    content?: string | null;
    media_file_name?: string | null;
    write_date?: string | null;
  },
  companyId: number,
  sentAt?: string
): Promise<void> {
  const preview = message.content || message.media_file_name || '[media]';
  const candidateTime = sentAt ?? message.write_date ?? new Date().toISOString();
  const lastMessageAt = Number.isFinite(Date.parse(candidateTime))
    ? new Date(candidateTime).toISOString()
    : new Date().toISOString();
  await WhatsappConversation.query()
    .where({ id: message.conversation_id, company_id: companyId })
    .where((query) =>
      query.whereNull('last_message_at').orWhere('last_message_at', '<=', lastMessageAt)
    )
    .patch({
      last_message: preview,
      last_message_at: lastMessageAt,
      write_date: new Date().toISOString(),
    });
}

export async function dispatchQueuedWhatsAppStatus(
  statusId: number,
  companyId: number,
  storage: AttachmentStorage
): Promise<void> {
  const status = await WhatsappStatus.query().findOne({ id: statusId, company_id: companyId });
  if (
    !status ||
    status.status === 'sent' ||
    status.status === 'failed' ||
    status.status === 'unknown'
  )
    return;
  if (status.status === 'sending') {
    await WhatsappStatus.query()
      .where({ id: statusId, company_id: companyId, status: 'sending' })
      .patch({
        status: 'unknown',
        retryable: false,
        last_error: 'Status publication was interrupted; verify WhatsApp before retrying.',
        write_date: new Date().toISOString(),
      });
    return;
  }
  const claimed = await WhatsappStatus.query()
    .where({ id: statusId, company_id: companyId, status: 'queued' })
    .patch({
      status: 'sending',
      attempt_count: Number(status.attempt_count ?? 0) + 1,
      retryable: false,
      last_error: null,
      write_date: new Date().toISOString(),
    });
  if (claimed !== 1) return;

  let providerCallStarted = false;
  let providerAccepted = false;
  try {
    const account = await WhatsappAccount.query().findOne({
      id: status.account_id,
      company_id: companyId,
    });
    if (!account?.gateway_device_id || account.status !== 'connected') {
      await WhatsappStatus.query().where({ id: statusId, company_id: companyId }).patch({
        status: 'failed',
        retryable: false,
        last_error: 'WhatsApp account is not connected.',
      });
      return;
    }

    let sent: { id?: string; message_id?: string } | undefined;
    if (status.media_key) {
      const bytes = await storage.get(status.media_key);
      if (!bytes?.byteLength) {
        await WhatsappStatus.query().where({ id: statusId, company_id: companyId }).patch({
          status: 'failed',
          retryable: false,
          last_error: 'Stored media is unavailable; choose the attachment again.',
        });
        return;
      }
      const endpoint = status.status_type === 'image' ? '/send/image' : '/send/video';
      const form = new FormData();
      form.set('phone', 'status@broadcast');
      form.set('allow_reshare', String(Boolean(status.allow_reshare)));
      if (status.content?.trim()) form.set('caption', status.content);
      form.set(
        status.status_type,
        new Blob([bytes], { type: status.media_mime_type ?? 'application/octet-stream' }),
        status.media_file_name ?? `status.${status.status_type === 'image' ? 'jpg' : 'mp4'}`
      );
      providerCallStarted = true;
      sent = await gowaRequest<{ id?: string; message_id?: string }>(endpoint, {
        method: 'POST',
        deviceId: account.gateway_device_id,
        body: form,
      });
    } else {
      providerCallStarted = true;
      sent = await gowaRequest<{ id?: string; message_id?: string }>('/send/message', {
        method: 'POST',
        deviceId: account.gateway_device_id,
        contentType: 'application/json',
        body: JSON.stringify({
          phone: 'status@broadcast',
          message: status.content ?? '',
          allow_reshare: Boolean(status.allow_reshare),
        }),
      });
    }
    providerAccepted = true;
    const externalId =
      typeof sent?.message_id === 'string'
        ? sent.message_id
        : typeof sent?.id === 'string'
          ? sent.id
          : `gowa-${randomUUID()}`;
    const publishedAt = new Date().toISOString();
    await WhatsappStatus.query()
      .where({ id: statusId, company_id: companyId })
      .patch({
        external_id: externalId.slice(0, 255),
        status: 'sent',
        retryable: false,
        last_error: null,
        published_at: publishedAt,
        write_date: publishedAt,
      });
  } catch (error) {
    if (providerAccepted) throw error;
    if (error instanceof GowaError && error.statusCode === 429) {
      await WhatsappStatus.query().where({ id: statusId, company_id: companyId }).patch({
        status: 'queued',
        retryable: true,
        last_error: 'GoWA rate limited the Status publication; retrying safely.',
        write_date: new Date().toISOString(),
      });
      throw error;
    }
    await WhatsappStatus.query()
      .where({ id: statusId, company_id: companyId })
      .patch({
        status: providerCallStarted ? 'unknown' : 'failed',
        retryable: false,
        last_error: providerCallStarted
          ? 'GoWA did not confirm Status publication; verify WhatsApp before retrying.'
          : 'Status publication could not start.',
        write_date: new Date().toISOString(),
      });
  }
}

async function persistProviderAcknowledgement(
  eventId: number,
  companyId: number,
  messageId: number,
  externalId: string,
  acceptedAt: string
): Promise<void> {
  const events = await WhatsappMessage.knex()('outbox_events')
    .where({ id: eventId, company_id: companyId, event_type: WHATSAPP_SEND_EVENT })
    .select('payload')
    .first();
  if (!events) throw new Error('WhatsApp delivery event is unavailable');
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(events.payload ?? '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>;
  } catch {
    // Preserve the message ID supplied by the consumer even if an older payload is malformed.
  }
  const acknowledgement = {
    external_id: externalId.slice(0, 255),
    accepted_at: acceptedAt,
  };
  const updated = await WhatsappMessage.knex()('outbox_events')
    .where({ id: eventId, company_id: companyId, event_type: WHATSAPP_SEND_EVENT })
    .update({
      payload: JSON.stringify({
        ...payload,
        message_id: messageId,
        provider_ack: acknowledgement,
      }),
    });
  if (Number(updated) !== 1) throw new Error('WhatsApp provider acknowledgement was not persisted');
}

export async function dispatchQueuedWhatsAppMessage(
  messageId: number,
  companyId: number,
  eventId: number,
  storage: AttachmentStorage,
  providerAck?: { external_id: string; accepted_at?: string },
  mentions: string[] = []
): Promise<void> {
  const message = await WhatsappMessage.query().findOne({ id: messageId, company_id: companyId });
  if (!message) return;

  // A durable provider acknowledgement takes precedence over the in-memory message state. This
  // recovers a confirmed send if the message row could not be updated before the worker stopped.
  if (providerAck && typeof providerAck.external_id === 'string' && providerAck.external_id) {
    await patchMessage(messageId, companyId, {
      external_id: providerAck.external_id.slice(0, 255),
      status: 'sent',
      retryable: false,
      last_error: null,
    });
    const acknowledgedMessage = await WhatsappMessage.query().findOne({
      id: messageId,
      company_id: companyId,
    });
    if (!acknowledgedMessage)
      throw new Error('Acknowledged WhatsApp message could not be reloaded');
    await updateConversationPreview(acknowledgedMessage, companyId, providerAck.accepted_at);
    return;
  }

  // The provider acknowledgement and message row may already be durable while the conversation
  // preview update failed. Replaying this outbox event repairs that projection without resending.
  if (message.status === 'sent') {
    await updateConversationPreview(message, companyId);
    return;
  }

  if (message.status === 'sending') {
    await patchMessage(messageId, companyId, {
      status: 'unknown',
      retryable: false,
      last_error: 'Delivery was interrupted; verify WhatsApp before retrying.',
    });
    return;
  }
  if (message.status !== 'queued') return;

  if (deliveryExpired(message.create_date)) {
    await patchMessage(messageId, companyId, {
      status: 'failed',
      retryable: false,
      last_error: 'WhatsApp delivery expired after 24 hours in the queue.',
    });
    return;
  }

  const claimed = await WhatsappMessage.query()
    .where({ id: messageId, company_id: companyId, status: 'queued' })
    .patch({
      status: 'sending',
      attempt_count: Number(message.attempt_count ?? 0) + 1,
      retryable: false,
      last_error: null,
      write_date: new Date().toISOString(),
    });
  if (claimed !== 1) return;

  const attemptCount = Number(message.attempt_count ?? 0) + 1;
  let providerCallStarted = false;
  let providerAccepted = false;
  let providerAckAcceptedAt: string | undefined;
  try {
    const [account, conversation] = await Promise.all([
      WhatsappAccount.query().findOne({ id: message.account_id, company_id: companyId }),
      WhatsappConversation.query().findOne({
        id: message.conversation_id,
        company_id: companyId,
      }),
    ]);
    if (!account?.gateway_device_id || account.status !== 'connected' || !conversation) {
      await safelyRetryOrFail(
        messageId,
        companyId,
        eventId,
        attemptCount,
        message.create_date,
        'WhatsApp account or conversation is unavailable.'
      );
      return;
    }

    let sent: { id?: string; message_id?: string } | undefined;
    if (message.forward_from_external_id) {
      providerCallStarted = true;
      sent = await gowaRequest<{ id?: string; message_id?: string }>(
        `/message/${encodeURIComponent(message.forward_from_external_id)}/forward`,
        {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ phone: conversation.jid }),
        }
      );
    } else if (message.media_key) {
      const bytes = await storage.get(message.media_key);
      if (!bytes?.byteLength) {
        await patchMessage(messageId, companyId, {
          status: 'failed',
          retryable: false,
          last_error: 'Stored media is unavailable; choose the attachment again.',
        });
        return;
      }
      const type = mediaType(message.media_mime_type ?? 'application/octet-stream');
      const endpoint =
        type === 'image'
          ? '/send/image'
          : type === 'video'
            ? '/send/video'
            : type === 'audio'
              ? '/send/audio'
              : type === 'sticker'
                ? '/send/sticker'
                : '/send/file';
      const field =
        type === 'image'
          ? 'image'
          : type === 'video'
            ? 'video'
            : type === 'audio'
              ? 'audio'
              : type === 'sticker'
                ? 'sticker'
                : 'file';
      const form = new FormData();
      form.set('phone', conversation.jid);
      if (message.reply_to_external_id) form.set('reply_message_id', message.reply_to_external_id);
      if (message.content?.trim()) form.set('caption', message.content);
      for (const mention of mentions) form.append('mentions', mention);
      form.set(
        field,
        new Blob([bytes], { type: message.media_mime_type || 'application/octet-stream' }),
        message.media_file_name || 'attachment'
      );
      providerCallStarted = true;
      sent = await gowaRequest<{ id?: string; message_id?: string }>(endpoint, {
        method: 'POST',
        deviceId: account.gateway_device_id,
        body: form,
      });
    } else {
      providerCallStarted = true;
      sent = await gowaRequest<{ id?: string; message_id?: string }>('/send/message', {
        method: 'POST',
        deviceId: account.gateway_device_id,
        contentType: 'application/json',
        body: JSON.stringify({
          phone: conversation.jid,
          message: message.content ?? '',
          ...(message.reply_to_external_id
            ? { reply_message_id: message.reply_to_external_id }
            : {}),
          ...(mentions.length ? { mentions } : {}),
        }),
      });
    }

    const externalId =
      typeof sent?.message_id === 'string'
        ? sent.message_id
        : typeof sent?.id === 'string'
          ? sent.id
          : `gowa-${randomUUID()}`;
    providerAccepted = true;
    const acceptedAt = new Date().toISOString();
    providerAckAcceptedAt = acceptedAt;
    await persistProviderAcknowledgement(eventId, companyId, messageId, externalId, acceptedAt);
    await patchMessage(messageId, companyId, {
      external_id: externalId.slice(0, 255),
      status: 'sent',
      retryable: false,
      last_error: null,
    });
    const sentMessage = await WhatsappMessage.query().findOne({
      id: messageId,
      company_id: companyId,
    });
    if (!sentMessage) throw new Error('Acknowledged WhatsApp message could not be reloaded');
    await updateConversationPreview(sentMessage, companyId, providerAckAcceptedAt);
  } catch (error) {
    // Once GoWA acknowledged the send, a projection/database failure must never downgrade the
    // durable message to unknown or cause a second provider send. Let the outbox retry repair it.
    if (providerAccepted) throw error;
    if (
      error instanceof GowaError &&
      (error.statusCode === 429 ||
        error.upstreamCode === 'CIRCUIT_OPEN' ||
        error.upstreamCode === 'GATEWAY_BUSY')
    ) {
      await safelyRetryOrFail(
        messageId,
        companyId,
        eventId,
        attemptCount,
        message.create_date,
        error.upstreamCode === 'CIRCUIT_OPEN'
          ? 'WhatsApp gateway circuit is open; retrying safely.'
          : error.upstreamCode === 'GATEWAY_BUSY'
            ? 'WhatsApp gateway is busy; retrying safely.'
            : 'GoWA rate limited the send; retrying safely.'
      );
      return;
    }
    if (!providerCallStarted) {
      await safelyRetryOrFail(
        messageId,
        companyId,
        eventId,
        attemptCount,
        message.create_date,
        'WhatsApp delivery could not start; retrying safely.'
      );
      return;
    }
    if (error instanceof GowaError && error.statusCode >= 400 && error.statusCode < 500) {
      await patchMessage(messageId, companyId, {
        status: 'failed',
        retryable: false,
        last_error: `GoWA rejected the message (${error.statusCode}).`,
      });
      return;
    }
    await patchMessage(messageId, companyId, {
      status: 'unknown',
      retryable: false,
      last_error: 'GoWA did not confirm delivery; verify WhatsApp before retrying.',
    });
  }
}

export function registerWhatsAppOutboxConsumer(storage: AttachmentStorage): () => void {
  const unregisterMessage = registerOutboxConsumer(
    WHATSAPP_SEND_EVENT,
    async (payload, eventId, context) => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('message_id' in payload) ||
        !Number.isSafeInteger((payload as { message_id: unknown }).message_id) ||
        !context.companyId
      ) {
        throw new PermanentJobError('Invalid WhatsApp delivery event', 'INVALID_WHATSAPP_EVENT');
      }
      const rawMentions = (payload as { mentions?: unknown }).mentions;
      if (
        rawMentions !== undefined &&
        (!Array.isArray(rawMentions) ||
          rawMentions.length > 100 ||
          rawMentions.some(
            (mention) =>
              typeof mention !== 'string' ||
              (mention !== '@everyone' && !/^\d{7,15}$/u.test(mention))
          ))
      )
        throw new PermanentJobError('Invalid WhatsApp mention event', 'INVALID_WHATSAPP_MENTIONS');
      await dispatchQueuedWhatsAppMessage(
        (payload as { message_id: number }).message_id,
        context.companyId,
        eventId,
        storage,
        'provider_ack' in payload &&
          payload.provider_ack &&
          typeof payload.provider_ack === 'object' &&
          'external_id' in payload.provider_ack &&
          typeof payload.provider_ack.external_id === 'string'
          ? (payload.provider_ack as { external_id: string; accepted_at?: string })
          : undefined,
        Array.isArray(rawMentions) ? (rawMentions as string[]) : []
      );
    }
  );
  const unregisterStatus = registerOutboxConsumer(
    WHATSAPP_STATUS_PUBLISH_EVENT,
    async (payload, _eventId, context) => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('status_id' in payload) ||
        !Number.isSafeInteger((payload as { status_id: unknown }).status_id) ||
        !context.companyId
      ) {
        throw new PermanentJobError(
          'Invalid WhatsApp Status event',
          'INVALID_WHATSAPP_STATUS_EVENT'
        );
      }
      await dispatchQueuedWhatsAppStatus(
        (payload as { status_id: number }).status_id,
        context.companyId,
        storage
      );
    }
  );
  return () => {
    unregisterMessage();
    unregisterStatus();
  };
}
