import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3AttachmentStorage, type AttachmentStorage } from '@moonwitness/orm-storage';
import {
  WhatsappAccount,
  WhatsappConversation,
  WhatsappMessage,
  WhatsappStatus,
  WhatsappUploadTicket,
  WhatsappGroupCreation,
  WhatsappGroupOperation,
} from '../whatsapp/models.js';
import { attachPrivateLidAlias } from '../whatsapp/conversation-identity.js';
import { isRecord, MAX_ATTACHMENT_BYTES } from '@moonwitness/types';

import { mediaType, mimeMatchesSignature, safeMime, sniffMime } from '../whatsapp/media.js';
import { gowaBinary, gowaOriginPath, gowaRequest, GowaError } from '../whatsapp/gowa-client.js';
import parsePhoneNumberFromString from 'libphonenumber-js/max';
import { whatsappLogErrorContext } from '../whatsapp/log-redaction.js';
import { OutboxEvent } from '@moonwitness/jobs';
import { WHATSAPP_SEND_EVENT, WHATSAPP_STATUS_PUBLISH_EVENT } from '../whatsapp/outbox-consumer.js';
import { enqueueNotification } from '@moonwitness/orm-notification';
import {
  createAttachmentScanner,
  MalwareScannerUnavailableError,
  type AttachmentScanner,
} from '../whatsapp/clamav-scanner.js';
import {
  createImageThumbnail,
  createVideoPoster,
  type MediaThumbnail,
} from '../whatsapp/media-thumbnail.js';
import { recordWhatsAppMediaTransfer } from '../observability/metrics.js';

type Options = {
  attachmentStorage: AttachmentStorage;
  attachmentScanner?: AttachmentScanner | null;
  createVideoPoster?: typeof createVideoPoster;
  fetchContactAvatar?: typeof fetch;
};
type Params = { id: string };
const MAX_CONTACT_AVATAR_BYTES = 2 * 1024 * 1024;

type DirectUploadStorage = AttachmentStorage &
  Pick<S3AttachmentStorage, 'createPresignedUpload' | 'head'>;

function supportsDirectUploads(storage: AttachmentStorage): storage is DirectUploadStorage {
  return (
    typeof (storage as Partial<DirectUploadStorage>).createPresignedUpload === 'function' &&
    typeof (storage as Partial<DirectUploadStorage>).head === 'function'
  );
}

function whatsappRateLimit(max: number) {
  return {
    config: {
      rateLimit: {
        max,
        timeWindow: '1 minute',
        keyGenerator: (request: {
          auth: { companyId?: number; userId?: number } | null;
          ip: string;
        }) =>
          request.auth?.companyId && request.auth.userId
            ? `whatsapp:${request.auth.companyId}:${request.auth.userId}`
            : request.ip,
      },
    },
  };
}

class MediaTooLargeError extends Error {
  readonly statusCode = 413;
}
class MediaStorageError extends Error {
  readonly statusCode = 503;
}
class MediaIncompleteError extends Error {}
class MediaEmptyError extends Error {}
class MediaScanInfectedError extends Error {
  readonly statusCode = 422;
}
class UploadTicketConsumedError extends Error {
  readonly statusCode = 409;
}

type OutgoingUpload = {
  fields: Record<string, string>;
  mediaKey: string | null;
  mediaMime: string;
  mediaFileName: string | null;
  mediaDigest: string;
  mediaSizeBytes: number | null;
};

async function parseOutgoingUpload(
  req: FastifyRequest,
  storage: AttachmentStorage,
  scanner: AttachmentScanner | null,
  extraFields: string[] = []
): Promise<OutgoingUpload> {
  const fields: Record<string, string> = {};
  if (req.isMultipart() === false && req.headers['content-type']?.includes('application/json')) {
    const body = isRecord(req.body) ? req.body : null;
    if (
      !body ||
      Object.keys(body).some(
        (key) =>
          !['content', 'reply_to_message_id', 'upload_ticket_id', ...extraFields].includes(key)
      ) ||
      typeof body.content !== 'string' ||
      body.content.length > 8000 ||
      (body.reply_to_message_id !== undefined &&
        (!Number.isSafeInteger(body.reply_to_message_id) ||
          Number(body.reply_to_message_id) < 1)) ||
      (body.upload_ticket_id !== undefined &&
        (!Number.isSafeInteger(body.upload_ticket_id) || Number(body.upload_ticket_id) < 1))
    )
      throw Object.assign(new Error('Invalid message payload'), { statusCode: 400 });
    if (body.content) fields.content = body.content;
    if (body.reply_to_message_id !== undefined)
      fields.reply_to_message_id = String(body.reply_to_message_id);
    if (body.upload_ticket_id !== undefined)
      fields.upload_ticket_id = String(body.upload_ticket_id);
    for (const field of extraFields) {
      const value = body[field];
      if (value !== undefined) {
        if (typeof value !== 'boolean' && typeof value !== 'string')
          throw Object.assign(new Error('Invalid message payload'), { statusCode: 400 });
        fields[field] = String(value);
      }
    }
    return {
      fields,
      mediaKey: null,
      mediaMime: 'application/octet-stream',
      mediaFileName: null,
      mediaDigest: '',
      mediaSizeBytes: null,
    };
  }
  let mediaKey: string | null = null;
  let mediaMime = 'application/octet-stream';
  let mediaFileName: string | null = null;
  let mediaDigest = '';
  let mediaSizeBytes = 0;
  let fileCount = 0;
  try {
    for await (const part of req.parts({ limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } })) {
      if (part.type === 'field') {
        if (
          !['content', 'reply_to_message_id', ...extraFields].includes(part.fieldname) ||
          typeof part.value !== 'string' ||
          part.value.length > 8000
        ) {
          throw Object.assign(new Error('Invalid message payload'), { statusCode: 400 });
        }
        fields[part.fieldname] = part.value;
        continue;
      }
      fileCount++;
      if (part.fieldname !== 'media' || fileCount !== 1)
        throw Object.assign(new Error('Invalid media upload'), { statusCode: 400 });
      mediaKey = randomUUID();
      mediaFileName = safeFileName(part.filename);
      mediaMime = safeMime(part.mimetype);
      const digest = createHash('sha256');
      const prefix: Buffer[] = [];
      let prefixLength = 0;
      const inspector = new Transform({
        transform(chunk: Buffer | Uint8Array, _encoding, callback) {
          const bytes = Buffer.from(chunk);
          mediaSizeBytes += bytes.byteLength;
          digest.update(bytes);
          if (prefixLength < 64 * 1024) {
            const sample = bytes.subarray(0, 64 * 1024 - prefixLength);
            prefix.push(sample);
            prefixLength += sample.length;
          }
          callback(null, bytes);
        },
      });
      const passThrough = new PassThrough();
      if (!storage.putStream)
        throw new MediaStorageError('Attachment storage does not support streamed uploads');
      const transfer = pipeline(part.file, inspector, passThrough);
      const [transferred, stored] = await Promise.allSettled([
        transfer,
        storage.putStream(mediaKey, passThrough, MAX_ATTACHMENT_BYTES),
      ]);
      if (stored.status === 'rejected')
        throw new MediaStorageError('Attachment storage write failed', { cause: stored.reason });
      if (transferred.status === 'rejected') throw transferred.reason;
      if (part.file.truncated) throw new MediaTooLargeError('Media exceeds the 10 MiB limit');
      if (prefixLength === 0)
        throw Object.assign(new Error('Media file is empty'), { statusCode: 400 });
      const detectedMime = sniffMime(Buffer.concat(prefix, prefixLength));
      if (!mimeMatchesSignature(mediaMime, detectedMime))
        throw Object.assign(new Error('Media content does not match its declared file type'), {
          statusCode: 400,
        });
      if (mediaMime === 'application/octet-stream' && detectedMime) mediaMime = detectedMime;
      mediaDigest = digest.digest('hex');
      if (!scanner) throw new MalwareScannerUnavailableError();
      const scanResult = await scanStoredAttachment(storage, mediaKey, scanner);
      if (scanResult.status === 'infected')
        throw new MediaScanInfectedError('Attachment was blocked by the malware scanner');
    }
    if (fileCount === 0) mediaKey = null;
    return {
      fields,
      mediaKey,
      mediaMime,
      mediaFileName,
      mediaDigest,
      mediaSizeBytes: mediaKey ? mediaSizeBytes : null,
    };
  } catch (error) {
    if (mediaKey) await storage.delete(mediaKey).catch(() => undefined);
    throw error;
  }
}

async function scanStoredAttachment(
  storage: AttachmentStorage,
  key: string,
  scanner: AttachmentScanner
) {
  const stream = await storage.getStream?.(key);
  if (stream) return scanner.scan(stream);
  const bytes = await storage.get(key);
  if (!bytes) throw new MediaStorageError('Attachment was not found in storage');
  return scanner.scan(Readable.from([bytes]));
}

async function readStoredAttachmentBounded(
  storage: AttachmentStorage,
  key: string,
  maxBytes: number
): Promise<Buffer | null> {
  const stream = await storage.getStream?.(key);
  if (!stream) {
    const bytes = await storage.get(key);
    if (bytes && bytes.byteLength > maxBytes)
      throw new MediaTooLargeError('Media exceeds the 10 MiB limit');
    return bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new MediaTooLargeError('Media exceeds the 10 MiB limit');
    }
    chunks.push(bytes);
  }
  return total === 0 ? null : Buffer.concat(chunks, total);
}

const rawWebhookBodies = new WeakMap<FastifyRequest, Buffer>();
const MAX_GOWA_WEBHOOK_BYTES = 256 * 1024;

function captureGowaWebhookBody() {
  return async function captureRawBody(
    request: FastifyRequest,
    _reply: unknown,
    payload: Readable
  ): Promise<Readable> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of payload) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > MAX_GOWA_WEBHOOK_BYTES) {
        const error = new Error('GoWA webhook payload too large') as Error & { statusCode: number };
        error.statusCode = 413;
        throw error;
      }
      chunks.push(bytes);
    }
    const raw = Buffer.concat(chunks, total);
    rawWebhookBodies.set(request, raw);
    return Readable.from([raw]);
  };
}

function validGowaWebhookSignature(raw: Buffer, signature: unknown): boolean {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/iu.test(signature))
    return false;
  const supplied = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function safeFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value.replace(/[\\/"\p{Cc}]/gu, '_').slice(0, 255);
  return sanitized || null;
}

async function readLimitedMedia(response: Response): Promise<Buffer> {
  const rawDeclaredLength = response.headers.get('content-length');
  const declaredLength = rawDeclaredLength === null ? NaN : Number(rawDeclaredLength);
  const canVerifyLength =
    Number.isSafeInteger(declaredLength) &&
    declaredLength >= 0 &&
    (!response.headers.has('content-encoding') ||
      response.headers.get('content-encoding') === 'identity');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
    await response.body?.cancel();
    throw new MediaTooLargeError('Media exceeds the 10 MiB limit');
  }
  if (!response.body) throw new Error('WhatsApp gateway returned an empty media body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new MediaTooLargeError('Media exceeds the 10 MiB limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (canVerifyLength && totalBytes !== declaredLength)
    throw new MediaIncompleteError('WhatsApp gateway returned incomplete media');
  return Buffer.concat(chunks, totalBytes);
}

function createMediaInspector(headers: Headers) {
  const rawDeclaredLength = headers.get('content-length');
  const declaredLength = rawDeclaredLength === null ? NaN : Number(rawDeclaredLength);
  const canVerifyLength =
    Number.isSafeInteger(declaredLength) &&
    declaredLength >= 0 &&
    (!headers.has('content-encoding') || headers.get('content-encoding') === 'identity');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES)
    throw new MediaTooLargeError('Media exceeds the 10 MiB limit');

  let totalBytes = 0;
  let prefixBytes = 0;
  const prefix: Buffer[] = [];
  const transform = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_ATTACHMENT_BYTES) {
        callback(new MediaTooLargeError('Media exceeds the 10 MiB limit'));
        return;
      }
      if (prefixBytes < 64 * 1024) {
        const sample = bytes.subarray(0, 64 * 1024 - prefixBytes);
        prefix.push(sample);
        prefixBytes += sample.byteLength;
      }
      callback(null, bytes);
    },
    flush(callback) {
      if (canVerifyLength && totalBytes !== declaredLength) {
        callback(new MediaIncompleteError('WhatsApp gateway returned incomplete media'));
        return;
      }
      callback();
    },
  });
  return {
    transform,
    getPrefix: () => Buffer.concat(prefix, prefixBytes),
    getSize: () => totalBytes,
  };
}

async function streamResponseToStorage(
  response: Response,
  storage: AttachmentStorage,
  key: string
): Promise<{ mime: string; size: number }> {
  if (!response.body) throw new Error('WhatsApp gateway returned an empty media body');
  const readable = Readable.fromWeb(
    response.body as import('node:stream/web').ReadableStream<Uint8Array>
  );
  let inspector: ReturnType<typeof createMediaInspector>;
  try {
    inspector = createMediaInspector(response.headers);
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  const passThrough = new PassThrough();
  const transfer = pipeline(readable, inspector.transform, passThrough);
  const storing = storage.putStream!(key, passThrough, MAX_ATTACHMENT_BYTES);
  try {
    await Promise.all([transfer, storing]);
  } catch (error) {
    readable.destroy(error instanceof Error ? error : undefined);
    passThrough.destroy(error instanceof Error ? error : undefined);
    await Promise.allSettled([transfer, storing]);
    await storage.delete(key).catch(() => undefined);
    throw error;
  }
  if (inspector.getPrefix().length === 0) {
    await storage.delete(key).catch(() => undefined);
    throw new MediaEmptyError('WhatsApp gateway returned empty media');
  }
  return {
    mime: sniffMime(inspector.getPrefix()) ?? 'application/octet-stream',
    size: inspector.getSize(),
  };
}

async function peekReadable(
  source: Readable,
  maxPrefixBytes = 64 * 1024
): Promise<{ prefix: Buffer; stream: Readable }> {
  const iterator = source[Symbol.asyncIterator]();
  const prefix: Buffer[] = [];
  let prefixBytes = 0;
  let remainder: Buffer | null = null;
  while (prefixBytes < maxPrefixBytes) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    const length = Math.min(chunk.byteLength, maxPrefixBytes - prefixBytes);
    prefix.push(chunk.subarray(0, length));
    prefixBytes += length;
    if (length < chunk.byteLength) {
      remainder = chunk.subarray(length);
      break;
    }
  }
  const head = Buffer.concat(prefix, prefixBytes);
  const stream = Readable.from(
    (async function* () {
      if (head.length) yield head;
      if (remainder?.length) yield remainder;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    })()
  );
  return { prefix: head, stream };
}

function limitReadable(source: Readable, maxBytes: number): Readable {
  return Readable.from(
    (async function* () {
      let totalBytes = 0;
      for await (const chunk of source) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) throw new MediaTooLargeError('Media exceeds the 10 MiB limit');
        yield chunk;
      }
    })()
  );
}

function id(value: string): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function providerTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function trustedWhatsAppAvatarUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hostname !== 'pps.whatsapp.net'
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

async function readBoundedAvatar(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTACT_AVATAR_BYTES) {
    await response.body?.cancel();
    throw new Error('Contact avatar exceeds the allowed size');
  }
  if (!response.body) throw new Error('Contact avatar response is empty');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONTACT_AVATAR_BYTES) {
        await reader.cancel();
        throw new Error('Contact avatar exceeds the allowed size');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function providerReplyId(value: unknown): string | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const id = value.replied_to_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 255 ? id : null;
}

const WHATSAPP_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉'] as const;
type WhatsAppReaction = {
  emoji: string;
  sender_jid: string | null;
  sender_display_name?: string | null;
  is_from_me: boolean;
  timestamp?: string | null;
};

function normalizedReactions(value: unknown): WhatsAppReaction[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .flatMap((reaction) => {
      if (
        typeof reaction.emoji !== 'string' ||
        reaction.emoji.length > 32 ||
        reaction.emoji.trim() === '' ||
        /\p{Cc}/u.test(reaction.emoji)
      )
        return [];
      return [
        {
          emoji: reaction.emoji,
          sender_jid:
            typeof reaction.sender_jid === 'string' ? reaction.sender_jid.slice(0, 255) : null,
          ...(typeof reaction.sender_display_name === 'string'
            ? { sender_display_name: reaction.sender_display_name.slice(0, 255) }
            : {}),
          is_from_me: reaction.is_from_me === true,
          timestamp: providerTimestamp(reaction.timestamp),
        },
      ];
    })
    .slice(-100);
}

const AMBIGUOUS_SEND_MATCH_WINDOW_MS = 2 * 60 * 1_000;

async function reconcileAmbiguousOutboundMessage(input: {
  db: Knex;
  companyId: number;
  conversationId: number;
  externalId: string;
  content: string;
  messageType: string;
  timestamp: string;
}): Promise<boolean> {
  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const existing = await input
    .db('whatsapp_messages')
    .where({ company_id: input.companyId, external_id: input.externalId })
    .first();
  const pending = await input
    .db('whatsapp_messages')
    .where({
      company_id: input.companyId,
      conversation_id: input.conversationId,
      direction: 'outbound',
      message_type: input.messageType,
    })
    .where((builder: Knex.QueryBuilder) =>
      input.content
        ? builder.where('content', input.content)
        : builder.where('content', '').orWhereNull('content')
    )
    .whereIn('status', ['unknown', 'sending'])
    .where('external_id', 'like', 'pending:%');
  const candidates = pending.filter((message) => {
    const createdAt = Date.parse(String(message.create_date ?? ''));
    return (
      Number.isFinite(createdAt) &&
      Math.abs(createdAt - timestampMs) <= AMBIGUOUS_SEND_MATCH_WINDOW_MS
    );
  });
  if (candidates.length !== 1) return false;
  const candidate = candidates[0]!;
  const updateCandidate = async (db: Knex): Promise<number> =>
    Number(
      await db('whatsapp_messages')
        .where({
          id: candidate.id,
          company_id: input.companyId,
          status: candidate.status,
          external_id: candidate.external_id,
        })
        .update({
          external_id: input.externalId.slice(0, 255),
          status: 'sent',
          retryable: false,
          last_error: null,
          write_date: new Date().toISOString(),
        })
    );
  if (!existing) return (await updateCandidate(input.db)) === 1;

  // A concurrent history sync may have inserted GoWA's echo before this request claimed the
  // pending row. Collapse only an exact, uniquely matched outbound duplicate inside one transaction.
  const existingTime = Date.parse(String(existing.create_date ?? ''));
  const duplicateMatches =
    existing.id !== candidate.id &&
    existing.company_id === input.companyId &&
    existing.conversation_id === input.conversationId &&
    existing.direction === 'outbound' &&
    existing.message_type === input.messageType &&
    (existing.content ?? '') === input.content &&
    Number.isFinite(existingTime) &&
    Math.abs(existingTime - timestampMs) <= AMBIGUOUS_SEND_MATCH_WINDOW_MS;
  if (!duplicateMatches) return false;
  return input.db.transaction(async (trx) => {
    const deleted = await trx('whatsapp_messages')
      .where({
        id: existing.id,
        company_id: input.companyId,
        external_id: input.externalId,
      })
      .delete();
    if (Number(deleted) !== 1) return false;
    const updated = await updateCandidate(trx);
    if (updated !== 1) throw new Error('Ambiguous WhatsApp message changed during reconciliation');
    return true;
  });
}

function mediaDefaultMime(type: string): string | null {
  switch (type) {
    case 'image':
      return 'image/jpeg';
    case 'video':
      return 'video/mp4';
    case 'audio':
      return 'audio/ogg';
    case 'document':
      return 'application/octet-stream';
    default:
      return null;
  }
}

const GOWA_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);
const GOWA_KNOWN_NON_MEDIA_TYPES = new Set([
  'text',
  'contact',
  'location',
  'live_location',
  'poll',
  'call',
  'event',
  'protocol',
  'view_once',
]);

function classifyGoWaMessageType(
  rawType: unknown,
  viewOnce = false
): {
  messageType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker';
  providerType: string | null;
} {
  const value = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
  if (viewOnce || value === 'view_once' || value.startsWith('view_once_')) {
    return { messageType: 'text', providerType: 'view_once' };
  }
  if (GOWA_MEDIA_TYPES.has(value)) {
    return {
      messageType: value as 'image' | 'video' | 'audio' | 'document' | 'sticker',
      providerType: null,
    };
  }
  if (!value || value === 'text') return { messageType: 'text', providerType: null };
  if (GOWA_KNOWN_NON_MEDIA_TYPES.has(value)) return { messageType: 'text', providerType: value };
  return {
    messageType: 'text',
    providerType: /^[a-z][a-z0-9_]{0,39}$/u.test(value) ? value : 'unsupported',
  };
}
function requireCompany(
  req: { auth: { companyId?: number } | null },
  reply: { code: (n: number) => { send: (x: unknown) => unknown } }
): number | null {
  const companyId = req.auth?.companyId;
  if (!companyId) {
    reply.code(req.auth ? 403 : 401).send({ success: false, error: 'Active company is required' });
    return null;
  }
  return companyId;
}

type WhatsappAction = 'create' | 'write';
type WhatsappModel =
  | 'whatsapp.account'
  | 'whatsapp.conversation'
  | 'whatsapp.internal_note'
  | 'whatsapp.label'
  | 'whatsapp.message'
  | 'whatsapp.status'
  | 'whatsapp.group.creation';

function canPerformWhatsAppAction(
  auth: {
    role: string;
    groupPermissions: readonly { model_name: string; create: boolean; write: boolean }[];
  },
  model: WhatsappModel,
  action: WhatsappAction
): boolean {
  if (auth.role === 'system' || auth.role === 'superadmin') return true;
  return auth.groupPermissions.some((grant) => grant.model_name === model && grant[action]);
}

function requireWhatsAppAction(
  req: {
    auth: {
      role: string;
      groupPermissions: readonly { model_name: string; create: boolean; write: boolean }[];
    } | null;
  },
  reply: { code: (n: number) => { send: (x: unknown) => unknown } },
  model: WhatsappModel,
  action: WhatsappAction
): boolean {
  if (req.auth && canPerformWhatsAppAction(req.auth, model, action)) return true;
  reply
    .code(403)
    .send({ success: false, error: 'You do not have permission to perform this WhatsApp action' });
  return false;
}

function whatsappPermissions(auth: {
  role: string;
  groupPermissions: readonly { model_name: string; create: boolean; write: boolean }[];
}) {
  return {
    manage: canPerformWhatsAppAction(auth, 'whatsapp.account', 'write'),
    manageConversations: canPerformWhatsAppAction(auth, 'whatsapp.conversation', 'write'),
    createConversation: canPerformWhatsAppAction(auth, 'whatsapp.conversation', 'create'),
    send: canPerformWhatsAppAction(auth, 'whatsapp.message', 'create'),
    manageMessages: canPerformWhatsAppAction(auth, 'whatsapp.message', 'write'),
  };
}

async function recordWhatsAppAudit(
  req: FastifyRequest,
  model: WhatsappModel,
  operation: string,
  recordId: number,
  companyId: number,
  trx?: Knex.Transaction
): Promise<void> {
  const audit = trx ? trx('audit_logs') : req.server.db('audit_logs');
  await audit.insert({
    model,
    record_id: recordId,
    operation,
    actor_id: req.auth?.userId ?? null,
    changes: JSON.stringify({ area: 'whatsapp', company_id: companyId }),
  });
}

export const whatsappRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const attachmentScanner =
    options.attachmentScanner === undefined ? createAttachmentScanner() : options.attachmentScanner;
  await app.register(multipart, {
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 5, fieldSize: 16 * 1024 },
  });
  app.post<{ Params: { deviceId: string } }>(
    '/whatsapp/gowa/webhook/:deviceId',
    { bodyLimit: MAX_GOWA_WEBHOOK_BYTES, preParsing: captureGowaWebhookBody() },
    async (req, reply) => {
      const raw = rawWebhookBodies.get(req);
      if (!raw || !validGowaWebhookSignature(raw, req.headers['x-hub-signature-256']))
        return reply.code(401).send({ success: false, error: 'Invalid webhook signature' });
      const account = await WhatsappAccount.query().findOne({
        gateway_device_id: req.params.deviceId,
      });
      if (!account) return reply.code(404).send({ success: false, error: 'Unknown device' });
      const body = req.body as {
        event?: unknown;
        session_id?: unknown;
        payload?: Record<string, unknown>;
      } | null;
      if (body?.session_id !== account.gateway_device_id)
        return reply.code(403).send({ success: false, error: 'Webhook device mismatch' });
      if (body?.event === 'group.participants') {
        const payload = body.payload;
        const groupJid = typeof payload?.chat_id === 'string' ? payload.chat_id : '';
        const type = payload?.type;
        const jids = Array.isArray(payload?.jids) ? payload.jids : [];
        if (
          !/^[^\s@\p{Cc}\p{Cf}]{1,200}@g\.us$/u.test(groupJid) ||
          !['join', 'leave', 'promote', 'demote'].includes(String(type)) ||
          jids.length > 500 ||
          jids.some(
            (jid) =>
              typeof jid !== 'string' ||
              !/^[^\s@\p{Cc}\p{Cf}]{1,200}@(s\.whatsapp\.net|lid)$/u.test(jid)
          )
        )
          return reply.code(204).send();
        await app
          .db('whatsapp_conversations')
          .where({
            company_id: account.company_id,
            account_id: account.id,
            jid: groupJid,
            is_group: true,
          })
          .update({ group_metadata_synced_at: null, write_date: new Date().toISOString() });
        return reply.code(204).send();
      }
      if (body?.event === 'message.edited') {
        const payload = body.payload;
        const originalId =
          typeof payload?.original_message_id === 'string'
            ? payload.original_message_id.slice(0, 255)
            : '';
        const editedText = typeof payload?.body === 'string' ? payload.body.slice(0, 8000) : null;
        if (originalId && editedText !== null) {
          const target = (await app
            .db('whatsapp_messages')
            .select('id', 'conversation_id', 'content')
            .where({
              company_id: account.company_id,
              account_id: account.id,
              external_id: originalId,
            })
            .where({ message_type: 'text', is_deleted: false })
            .whereNull('provider_type')
            .first()) as
            { id: number; conversation_id: number; content: string | null } | undefined;
          if (target) {
            await app
              .db('whatsapp_messages')
              .where({ id: target.id, company_id: account.company_id })
              .update({
                content: editedText,
                is_edited: true,
                write_date: new Date().toISOString(),
              });
            await app
              .db('whatsapp_conversations')
              .where({
                id: target.conversation_id,
                company_id: account.company_id,
                last_message: target.content,
              })
              .update({ last_message: editedText, write_date: new Date().toISOString() });
          }
        }
        return reply.code(204).send();
      }
      if (body?.event === 'message.revoked' || body?.event === 'message.deleted') {
        const payload = body.payload;
        const targetId =
          typeof payload?.revoked_message_id === 'string'
            ? payload.revoked_message_id.slice(0, 255)
            : typeof payload?.deleted_message_id === 'string'
              ? payload.deleted_message_id.slice(0, 255)
              : '';
        if (targetId) {
          const target = (await app
            .db('whatsapp_messages')
            .select(
              'id',
              'media_key',
              'media_thumbnail_key',
              'conversation_id',
              'content',
              'media_file_name',
              'message_type'
            )
            .where({
              company_id: account.company_id,
              account_id: account.id,
              external_id: targetId,
            })
            .first()) as
            | {
                id: number;
                media_key: string | null;
                media_thumbnail_key: string | null;
                conversation_id: number;
                content: string | null;
                media_file_name: string | null;
                message_type: string;
              }
            | undefined;
          if (target) {
            await app
              .db('whatsapp_messages')
              .where({ id: target.id, company_id: account.company_id })
              .update({
                is_deleted: true,
                content: 'This message was deleted',
                media_mime_type: null,
                media_file_name: null,
                reactions: '[]',
                write_date: new Date().toISOString(),
              });
            await app
              .db('whatsapp_conversations')
              .where({ id: target.conversation_id, company_id: account.company_id })
              .whereIn('last_message', [
                ...new Set(
                  [target.content, target.media_file_name, `[${target.message_type}]`].filter(
                    (value): value is string => Boolean(value)
                  )
                ),
              ])
              .update({
                last_message: 'This message was deleted',
                write_date: new Date().toISOString(),
              });
            if (target.media_key) {
              await Promise.all(
                [target.media_key, target.media_thumbnail_key]
                  .filter((key): key is string => Boolean(key))
                  .map((key) => options.attachmentStorage.delete(key))
              )
                .then(async () => {
                  await app
                    .db('whatsapp_messages')
                    .where({ id: target.id, company_id: account.company_id, is_deleted: true })
                    .update({
                      media_key: null,
                      media_thumbnail_key: null,
                      write_date: new Date().toISOString(),
                    });
                })
                .catch((error: unknown) => {
                  req.log.warn(
                    { error: whatsappLogErrorContext(error) },
                    'WhatsApp revoked media cleanup failed'
                  );
                });
            }
          }
        }
        return reply.code(204).send();
      }
      if (body?.event === 'message') {
        const payload = body.payload;
        const externalId = typeof payload?.id === 'string' ? payload.id.slice(0, 255) : '';
        const providerJid = typeof payload?.chat_id === 'string' ? payload.chat_id : '';
        const timestamp = providerTimestamp(payload?.timestamp);
        const fromMe = payload?.is_from_me === true;
        const senderJid = typeof payload?.from === 'string' ? payload.from.slice(0, 255) : null;
        const isGroup = providerJid.endsWith('@g.us');
        const jid =
          !isGroup &&
          !fromMe &&
          typeof senderJid === 'string' &&
          /^[^\s@]{1,200}@s\.whatsapp\.net$/u.test(senderJid) &&
          providerJid.endsWith('@lid')
            ? senderJid
            : providerJid;
        const fromLid =
          typeof payload?.from_lid === 'string' && /^[^\s@]{1,200}@lid$/u.test(payload.from_lid)
            ? payload.from_lid
            : null;
        const chatLid =
          typeof payload?.chat_lid === 'string' && /^[^\s@]{1,200}@lid$/u.test(payload.chat_lid)
            ? payload.chat_lid
            : null;
        const lidAliasJids =
          !isGroup && !fromMe && senderJid === jid
            ? [
                ...new Set(
                  [fromLid, chatLid, providerJid.endsWith('@lid') ? providerJid : null].filter(
                    (value): value is string => Boolean(value)
                  )
                ),
              ]
            : [];
        if (!externalId || !/^[^\s@]{1,200}@(s\.whatsapp\.net|g\.us|lid)$/u.test(jid) || !timestamp)
          return reply.code(204).send();
        const mediaField = ['image', 'video', 'video_note', 'audio', 'document', 'sticker'].find(
          (field) => {
            const value = payload?.[field];
            return (
              (typeof value === 'string' && value.length > 0) ||
              (value !== null && typeof value === 'object')
            );
          }
        );
        const structuredField = [
          'contact',
          'location',
          'live_location',
          'poll',
          'call',
          'event',
          'protocol',
        ].find((field) => payload?.[field] !== undefined && payload[field] !== null);
        const viewOnce = payload?.view_once === true || payload?.is_view_once === true;
        const typeInfo = classifyGoWaMessageType(
          viewOnce
            ? 'view_once'
            : mediaField === 'video_note'
              ? 'video'
              : (mediaField ?? payload?.media_type ?? structuredField),
          viewOnce
        );
        const messageType = typeInfo.messageType;
        const providerType = typeInfo.providerType;
        const mediaValue = mediaField ? payload?.[mediaField] : null;
        const mediaCaption =
          isRecord(mediaValue) && typeof mediaValue.caption === 'string'
            ? mediaValue.caption
            : typeof payload?.caption === 'string'
              ? payload.caption
              : '';
        const content =
          providerType === 'view_once'
            ? 'View-once media'
            : typeof payload?.body === 'string' && payload.body.length > 0
              ? payload.body.slice(0, 8000)
              : mediaCaption.slice(0, 8000);
        const messageSenderDisplayName =
          typeof payload?.sender_display_name === 'string' && payload.sender_display_name.trim()
            ? payload.sender_display_name.trim().slice(0, 255)
            : typeof payload?.from_name === 'string' && payload.from_name.trim()
              ? payload.from_name.trim().slice(0, 255)
              : null;
        const replyToExternalId = providerReplyId(payload?.context_metadata);
        const chatName = typeof payload?.chat_name === 'string' ? payload.chat_name.trim() : '';
        const senderDisplayName =
          typeof payload?.sender_display_name === 'string'
            ? payload.sender_display_name.trim()
            : '';
        const fromName = typeof payload?.from_name === 'string' ? payload.from_name.trim() : '';
        const preserveConversationName =
          isGroup || fromMe || (!chatName && !senderDisplayName && !fromName);
        const conversationName =
          chatName || (preserveConversationName ? jid : senderDisplayName || fromName || jid);
        await app.db.transaction(async (trx) => {
          let conversationJid = jid;
          if (!isGroup && jid.endsWith('@lid')) {
            const knownAlias = (await trx('whatsapp_conversation_aliases')
              .select('conversation_id')
              .where({ company_id: account.company_id, alias_jid: jid })
              .first()) as { conversation_id: number } | undefined;
            if (knownAlias) {
              const knownConversation = (await trx('whatsapp_conversations')
                .select('jid')
                .where({ company_id: account.company_id, id: knownAlias.conversation_id })
                .first()) as { jid: string } | undefined;
              if (
                knownConversation &&
                /^[^\s@]{1,200}@s\.whatsapp\.net$/u.test(knownConversation.jid)
              ) {
                conversationJid = knownConversation.jid;
              }
            }
          }
          const [conversation] = await trx('whatsapp_conversations')
            .insert({
              company_id: account.company_id,
              account_id: account.id,
              jid: conversationJid,
              name: conversationName.slice(0, 255),
              is_group: isGroup,
              unread_count: 0,
              last_message:
                content ||
                (providerType ? `[${providerType}]` : mediaField ? `[${mediaField}]` : ''),
              last_message_at: timestamp,
            })
            .onConflict(['company_id', 'jid'])
            .merge({
              account_id: account.id,
              name:
                preserveConversationName && !chatName
                  ? trx.raw('whatsapp_conversations.name')
                  : conversationName.slice(0, 255),
              is_group: isGroup,
              last_message: trx.raw(
                'CASE WHEN whatsapp_conversations.last_message_at IS NULL OR excluded.last_message_at > whatsapp_conversations.last_message_at THEN excluded.last_message ELSE whatsapp_conversations.last_message END'
              ),
              last_message_at: trx.raw(
                'CASE WHEN whatsapp_conversations.last_message_at IS NULL OR excluded.last_message_at > whatsapp_conversations.last_message_at THEN excluded.last_message_at ELSE whatsapp_conversations.last_message_at END'
              ),
              write_date: new Date().toISOString(),
            })
            .returning(['id']);
          const storedConversation =
            conversation ??
            (await trx('whatsapp_conversations')
              .where({ company_id: account.company_id, jid: conversationJid })
              .first('id'));
          if (!storedConversation) throw new Error('GoWA webhook conversation upsert failed');
          let conversationId = Number(storedConversation.id);
          for (const aliasJid of lidAliasJids) {
            conversationId = await attachPrivateLidAlias(
              trx,
              account.company_id,
              conversationId,
              conversationJid,
              aliasJid
            );
          }
          if (
            fromMe &&
            (await reconcileAmbiguousOutboundMessage({
              db: trx,
              companyId: account.company_id,
              conversationId,
              externalId,
              content,
              messageType,
              timestamp,
            }))
          )
            return;
          const inserted = await trx('whatsapp_messages')
            .insert({
              company_id: account.company_id,
              account_id: account.id,
              conversation_id: conversationId,
              external_id: externalId,
              direction: fromMe ? 'outbound' : 'inbound',
              message_type: messageType,
              provider_type: providerType,
              content,
              status: fromMe ? 'sent' : 'received',
              media_mime_type:
                mediaField && !providerType
                  ? typeof payload?.mime_type === 'string'
                    ? safeMime(payload.mime_type)
                    : mediaDefaultMime(messageType)
                  : null,
              media_file_name:
                !providerType && typeof payload?.filename === 'string'
                  ? payload.filename.slice(0, 255)
                  : !providerType &&
                      mediaValue &&
                      typeof mediaValue === 'object' &&
                      'filename' in mediaValue &&
                      typeof mediaValue.filename === 'string'
                    ? mediaValue.filename.slice(0, 255)
                    : null,
              sender_jid: senderJid,
              sender_display_name: messageSenderDisplayName,
              reply_to_external_id: replyToExternalId,
            })
            .onConflict(['company_id', 'external_id'])
            .ignore()
            .returning(['id']);
          if (inserted.length && !fromMe) {
            await trx('whatsapp_conversations')
              .where({ id: conversationId, company_id: account.company_id })
              .increment('unread_count', 1);
            const recipients = await trx('company_memberships as membership')
              .join('users', 'users.id', 'membership.user_id')
              .where('membership.company_id', account.company_id)
              .where('users.active', true)
              .select('membership.user_id');
            for (const recipient of recipients) {
              await enqueueNotification(
                {
                  recipientId: Number(recipient.user_id),
                  companyId: Number(account.company_id),
                  templateCode: 'whatsapp.inbound_message',
                  resource: {
                    model: WhatsappConversation.modelName,
                    id: Number(conversationId),
                  },
                },
                trx
              );
            }
          }
        });
        return reply.code(204).send();
      }
      if (body?.event !== 'message.ack') return reply.code(204).send();
      const receipt = body.payload;
      const status =
        receipt?.receipt_type === 'read'
          ? 'read'
          : receipt?.receipt_type === 'delivered'
            ? 'delivered'
            : null;
      const ids = Array.isArray(receipt?.ids)
        ? [
            ...new Set(
              receipt.ids.filter(
                (value): value is string => typeof value === 'string' && value.length > 0
              )
            ),
          ].slice(0, 100)
        : [];
      if (!status || ids.length === 0) return reply.code(204).send();
      const eligibleStatuses = status === 'read' ? ['sent', 'delivered'] : ['sent'];
      for (const externalId of ids) {
        await app
          .db('whatsapp_messages')
          .where({ company_id: account.company_id, external_id: externalId, direction: 'outbound' })
          .whereIn('status', eligibleStatuses)
          .update({ status, write_date: new Date().toISOString() });
      }
      return reply.code(204).send();
    }
  );

  app.get('/whatsapp/statuses', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const rows = await WhatsappStatus.query()
      .where({ company_id: companyId })
      .select(
        'id',
        'status_type',
        'content',
        'media_mime_type',
        'media_file_name',
        'media_size_bytes',
        'allow_reshare',
        'external_id',
        'status',
        'attempt_count',
        'retryable',
        'last_error',
        'published_at',
        'create_date'
      )
      .limit(50);
    return { success: true, data: rows };
  });

  app.post('/whatsapp/statuses', whatsappRateLimit(5), async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'create')) return;
    const idempotencyKey = req.headers['idempotency-key'];
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey)
    ) {
      return reply.code(400).send({ success: false, error: 'A valid Idempotency-Key is required' });
    }
    let upload: OutgoingUpload;
    try {
      upload = await parseOutgoingUpload(req, options.attachmentStorage, attachmentScanner, [
        'allow_reshare',
      ]);
    } catch (error) {
      const statusCode =
        isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : 400;
      const message = error instanceof Error ? error.message : 'Invalid WhatsApp Status upload';
      return reply.code(statusCode).send({ success: false, error: message });
    }
    const content = upload.fields.content?.trim() ?? '';
    const allowReshareValue = upload.fields.allow_reshare ?? 'false';
    if (
      !['true', 'false'].includes(allowReshareValue) ||
      [...content].length > 700 ||
      (!content && !upload.mediaKey)
    ) {
      if (upload.mediaKey)
        await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
      return reply.code(400).send({ success: false, error: 'Invalid WhatsApp Status content' });
    }
    const allowReshare = allowReshareValue === 'true';
    let statusType: 'text' | 'image' | 'video' = 'text';
    if (upload.mediaKey) {
      const detectedType = mediaType(upload.mediaMime);
      if (detectedType !== 'image' && detectedType !== 'video') {
        await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
        return reply
          .code(400)
          .send({ success: false, error: 'Status media must be an image or video' });
      }
      statusType = detectedType;
    }
    if (!content && !upload.mediaKey) {
      if (upload.mediaKey)
        await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
      return reply.code(400).send({ success: false, error: 'Status must contain text or media' });
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          status_type: statusType,
          content,
          allow_reshare: allowReshare,
          media_mime_type: upload.mediaMime,
          media_file_name: upload.mediaFileName,
        })
      )
      .update(upload.mediaDigest)
      .digest('hex');
    const existing = await WhatsappStatus.query().findOne({
      company_id: companyId,
      idempotency_key: idempotencyKey,
    });
    if (existing) {
      if (upload.mediaKey)
        await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
      if (existing.request_hash !== requestHash)
        return reply
          .code(409)
          .send({ success: false, error: 'Idempotency key was used for another Status' });
      return reply.code(202).send({ success: true, data: existing });
    }
    const account = await WhatsappAccount.query().findOne({ company_id: companyId });
    if (!account?.gateway_device_id || account.status !== 'connected') {
      if (upload.mediaKey)
        await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
      return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
    }
    const result = await app.db
      .transaction(async (trx) => {
        const inserted = await trx('whatsapp_statuses')
          .insert({
            company_id: companyId,
            account_id: account.id,
            status_type: statusType,
            content: content || null,
            media_key: upload.mediaKey,
            media_mime_type: upload.mediaKey ? upload.mediaMime : null,
            media_file_name: upload.mediaKey ? upload.mediaFileName : null,
            media_size_bytes: upload.mediaKey ? upload.mediaSizeBytes : null,
            allow_reshare: allowReshare,
            idempotency_key: idempotencyKey,
            request_hash: requestHash,
            external_id: `pending:${idempotencyKey}`.slice(0, 255),
            status: 'queued',
            attempt_count: 0,
            retryable: false,
          })
          .onConflict(['company_id', 'idempotency_key'])
          .ignore()
          .returning(['id']);
        const id = inserted[0]?.id;
        if (!id) {
          const existing = await trx('whatsapp_statuses')
            .where({ company_id: companyId, idempotency_key: idempotencyKey })
            .first('id', 'request_hash');
          if (existing?.request_hash !== requestHash)
            throw Object.assign(new Error('Idempotency key conflict'), { statusCode: 409 });
          return { id: Number(existing.id), created: false, conflict: false };
        }
        await OutboxEvent.query(trx).insert({
          event_type: WHATSAPP_STATUS_PUBLISH_EVENT,
          aggregate_model: 'whatsapp.status',
          aggregate_id: id,
          company_id: companyId,
          payload: JSON.stringify({ status_id: id }),
          status: 'pending',
          attempts: 0,
          max_attempts: 4,
          available_at: new Date().toISOString(),
        });
        await recordWhatsAppAudit(
          req,
          'whatsapp.status',
          'publish_queued',
          Number(id),
          companyId,
          trx
        );
        return { id: Number(id), created: true, conflict: false };
      })
      .catch((error: unknown) => {
        if (isRecord(error) && error.statusCode === 409)
          return { id: 0, created: false, conflict: true };
        throw error;
      });
    if (!result.created && upload.mediaKey)
      await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
    if (result.created && upload.mediaSizeBytes !== null)
      recordWhatsAppMediaTransfer('outbound', upload.mediaSizeBytes);
    if (result.conflict)
      return reply
        .code(409)
        .send({ success: false, error: 'Idempotency key was used for another Status' });
    const status = await WhatsappStatus.query()
      .where({ id: result.id, company_id: companyId })
      .select(
        'id',
        'status_type',
        'content',
        'media_mime_type',
        'media_file_name',
        'media_size_bytes',
        'allow_reshare',
        'status',
        'last_error',
        'create_date'
      )
      .first();
    return reply.code(202).send({ success: true, data: status });
  });

  app.get('/whatsapp/account', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const account = await WhatsappAccount.query().findOne({ company_id: companyId });
    if (!account)
      return {
        success: true,
        data: {
          status: 'disconnected',
          phone_number: null,
          qr_code: null,
          direct_uploads: supportsDirectUploads(options.attachmentStorage),
          webhook_configured: Boolean(
            process.env.WHATSAPP_WEBHOOK_URL && process.env.WHATSAPP_WEBHOOK_SECRET
          ),
          permissions: whatsappPermissions(req.auth!),
        },
      };
    let status: typeof account.status;
    let phoneNumber = account.phone_number;
    let lastError = account.last_error;
    let qrCode: string | null = null;
    if (!account.gateway_device_id) {
      status = 'disconnected';
      phoneNumber = null;
      lastError =
        account.status === 'disconnected'
          ? account.last_error
          : 'WhatsApp device mapping is missing. Connect again.';
      await WhatsappAccount.query()
        .where({ id: account.id, company_id: companyId })
        .patch({ status, phone_number: null, qr_code: null, last_error: lastError });
    } else {
      try {
        const upstream = await gowaRequest<{
          is_connected?: boolean;
          is_logged_in?: boolean;
          jid?: string;
        }>(`/devices/${encodeURIComponent(account.gateway_device_id)}/status`);
        status =
          upstream.is_connected && upstream.is_logged_in
            ? 'connected'
            : upstream.is_logged_in
              ? 'reconnecting'
              : 'disconnected';
        phoneNumber = upstream.jid?.split('@')[0] ?? (upstream.is_logged_in ? phoneNumber : null);
        if (status === 'connected') {
          lastError = null;
          await WhatsappAccount.query()
            .where({ id: account.id, company_id: companyId })
            .patch({ status, phone_number: phoneNumber, qr_code: null, last_error: null });
        } else if (account.qr_code) {
          try {
            const image = await gowaBinary(gowaOriginPath(account.qr_code));
            qrCode = `data:${image.headers.get('content-type') || 'image/png'};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
            status = 'qr';
          } catch (error) {
            if (!(error instanceof GowaError && error.statusCode === 404)) throw error;
            status = 'qr_expired';
            lastError = 'QR code expired. Request a new code to continue pairing.';
            await WhatsappAccount.query()
              .where({ id: account.id, company_id: companyId })
              .patch({ status, qr_code: null, last_error: lastError });
          }
        } else {
          await WhatsappAccount.query()
            .where({ id: account.id, company_id: companyId })
            .patch({ status, phone_number: phoneNumber, qr_code: null, last_error: null });
          lastError = null;
        }
      } catch (error) {
        if (!(error instanceof GowaError && error.statusCode === 404)) {
          status = 'error';
          await WhatsappAccount.query()
            .where({ id: account.id, company_id: companyId })
            .patch({ status, last_error: 'WhatsApp gateway is temporarily unavailable' });
          lastError = 'WhatsApp gateway is temporarily unavailable';
        } else {
          status = 'disconnected';
          await WhatsappAccount.query()
            .where({ id: account.id, company_id: companyId })
            .patch({ status, qr_code: null, phone_number: null, last_error: null });
          phoneNumber = null;
          lastError = null;
        }
      }
    }
    return {
      success: true,
      data: {
        id: account.id,
        status,
        phone_number: phoneNumber,
        qr_code: qrCode,
        last_error: lastError,
        direct_uploads: supportsDirectUploads(options.attachmentStorage),
        webhook_configured: Boolean(
          process.env.WHATSAPP_WEBHOOK_URL && process.env.WHATSAPP_WEBHOOK_SECRET
        ),
        permissions: whatsappPermissions(req.auth!),
      },
    };
  });

  app.post('/whatsapp/connect', whatsappRateLimit(5), async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    if (!requireWhatsAppAction(req, reply, 'whatsapp.account', 'write')) return;
    const result = await app.db.transaction(async (trx) => {
      if (String(app.db.client.config.client).includes('pg')) {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), ?)', [
          'moonwitness.whatsapp.connect',
          companyId,
        ]);
      }
      await trx('whatsapp_accounts')
        .insert({ company_id: companyId, status: 'connecting' })
        .onConflict('company_id')
        .ignore();
      const account = await WhatsappAccount.query(trx).findOne({ company_id: companyId });
      if (!account) throw new Error('WhatsApp account could not be created');
      if (account.status === 'qr' && account.qr_code && account.gateway_device_id) {
        try {
          const gatewayStatus = await gowaRequest<{
            is_connected?: boolean;
            is_logged_in?: boolean;
            jid?: string;
          }>(`/devices/${encodeURIComponent(account.gateway_device_id ?? '')}/status`);
          if (gatewayStatus.is_connected && gatewayStatus.is_logged_in) {
            const phoneNumber = gatewayStatus.jid?.split('@')[0] ?? account.phone_number;
            await WhatsappAccount.query(trx)
              .where({ id: account.id, company_id: companyId })
              .patch({
                status: 'connected',
                phone_number: phoneNumber,
                qr_code: null,
                last_error: null,
              });
            await recordWhatsAppAudit(
              req,
              'whatsapp.account',
              'connect',
              account.id,
              companyId,
              trx
            );
            return {
              statusCode: 200,
              body: {
                success: true,
                data: { id: account.id, status: 'connected', phone_number: phoneNumber },
              },
            };
          }
        } catch {
          // Keep the current QR; the status endpoint will report gateway availability separately.
        }
        await recordWhatsAppAudit(req, 'whatsapp.account', 'connect', account.id, companyId, trx);
        return {
          statusCode: 202,
          body: { success: true, data: { id: account.id, status: 'qr' } },
        };
      }
      const deviceId = account.gateway_device_id || `moonwitness-company-${companyId}`;
      await WhatsappAccount.query(trx).where({ id: account.id, company_id: companyId }).patch({
        gateway_device_id: deviceId,
        status: 'connecting',
        last_error: null,
        write_date: new Date().toISOString(),
      });
      try {
        try {
          await gowaRequest(`/devices/${encodeURIComponent(deviceId)}`);
        } catch (error) {
          if (!(error instanceof GowaError && error.statusCode === 404)) throw error;
          await gowaRequest('/devices', {
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({
              device_id: deviceId,
              display_name: `Moonwitness company ${companyId}`,
            }),
          });
        }
        const webhookOrigin = process.env.WHATSAPP_WEBHOOK_URL;
        const webhookSecret = process.env.WHATSAPP_WEBHOOK_SECRET;
        if (Boolean(webhookOrigin) !== Boolean(webhookSecret))
          throw new Error('GoWA webhook URL and secret must be configured together');
        if (webhookOrigin && webhookSecret) {
          const origin = new URL(webhookOrigin);
          if (
            webhookSecret.length < 32 ||
            !['http:', 'https:'].includes(origin.protocol) ||
            origin.username ||
            origin.password ||
            origin.pathname !== '/' ||
            origin.search ||
            origin.hash ||
            (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')
          )
            throw new Error('Invalid GoWA webhook configuration');
          const callback = new URL(
            `/whatsapp/gowa/webhook/${encodeURIComponent(deviceId)}`,
            origin
          );
          await gowaRequest(`/devices/${encodeURIComponent(deviceId)}/webhook`, {
            method: 'PATCH',
            contentType: 'application/json',
            body: JSON.stringify({
              webhook_url: callback.toString(),
              webhook_secret: webhookSecret,
              webhook_events:
                'message,message.ack,message.edited,message.revoked,message.deleted,group.participants',
            }),
          });
        }
        const gatewayStatus = await gowaRequest<{
          is_connected?: boolean;
          is_logged_in?: boolean;
          jid?: string;
        }>(`/devices/${encodeURIComponent(deviceId)}/status`);
        if (gatewayStatus.is_connected && gatewayStatus.is_logged_in) {
          const phoneNumber = gatewayStatus.jid?.split('@')[0] ?? account.phone_number;
          await WhatsappAccount.query(trx).where({ id: account.id, company_id: companyId }).patch({
            status: 'connected',
            phone_number: phoneNumber,
            qr_code: null,
            last_error: null,
            write_date: new Date().toISOString(),
          });
          return {
            statusCode: 200,
            body: {
              success: true,
              data: { id: account.id, status: 'connected', phone_number: phoneNumber },
            },
          };
        }
        const qr = await gowaRequest<{ qr_link?: string }>(
          `/devices/${encodeURIComponent(deviceId)}/login`
        );
        const qrPath = typeof qr.qr_link === 'string' ? gowaOriginPath(qr.qr_link) : null;
        await WhatsappAccount.query(trx)
          .where({ id: account.id, company_id: companyId })
          .patch({
            status: qrPath ? 'qr' : 'connecting',
            qr_code: qrPath,
            last_error: null,
            write_date: new Date().toISOString(),
          });
        await recordWhatsAppAudit(req, 'whatsapp.account', 'connect', account.id, companyId, trx);
        return {
          statusCode: 202,
          body: { success: true, data: { id: account.id, status: qrPath ? 'qr' : 'connecting' } },
        };
      } catch {
        await WhatsappAccount.query(trx).where({ id: account.id, company_id: companyId }).patch({
          status: 'error',
          last_error: 'WhatsApp gateway is temporarily unavailable',
        });
        await recordWhatsAppAudit(
          req,
          'whatsapp.account',
          'connect_failed',
          account.id,
          companyId,
          trx
        );
        return {
          statusCode: 502,
          body: { success: false, error: 'Could not start WhatsApp pairing' },
        };
      }
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post('/whatsapp/disconnect', whatsappRateLimit(5), async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    if (!requireWhatsAppAction(req, reply, 'whatsapp.account', 'write')) return;
    const account = await WhatsappAccount.query().findOne({ company_id: companyId });
    if (account?.gateway_device_id) {
      try {
        await gowaRequest(`/devices/${encodeURIComponent(account.gateway_device_id)}/logout`, {
          method: 'POST',
        });
      } catch (error) {
        if (!(error instanceof GowaError && error.statusCode === 404)) throw error;
      }
    }
    await WhatsappAccount.query().where({ company_id: companyId }).patch({
      status: 'disconnected',
      qr_code: null,
      phone_number: null,
      last_error: null,
      write_date: new Date().toISOString(),
    });
    if (account)
      await recordWhatsAppAudit(req, 'whatsapp.account', 'disconnect', account.id, companyId);
    return { success: true, data: { status: 'disconnected' } };
  });

  app.get('/whatsapp/labels', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const data = await app
      .db('whatsapp_labels')
      .select('id', 'name', 'color')
      .where({ company_id: companyId })
      .orderBy('name', 'asc')
      .orderBy('id', 'asc');
    return { success: true, data };
  });

  app.get('/whatsapp/agents', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const members = await app
      .db('company_memberships as company_member')
      .join('users as agent', 'agent.id', 'company_member.user_id')
      .leftJoin(
        'organization_memberships as organization_member',
        function joinOrganizationMember() {
          this.on('organization_member.company_id', '=', 'company_member.company_id').andOn(
            'organization_member.user_id',
            '=',
            'company_member.user_id'
          );
        }
      )
      .leftJoin('organization_teams as team', function joinTeam() {
        this.on('team.id', '=', 'organization_member.team_id').andOn(
          'team.company_id',
          '=',
          'company_member.company_id'
        );
      })
      .select('agent.id', 'agent.login', 'team.id as team_id', 'team.name as team_name')
      .where('company_member.company_id', companyId)
      .whereNot('agent.role', 'system')
      .orderBy('agent.login', 'asc');
    const teams = await app
      .db('organization_teams')
      .select('id', 'name')
      .where({ company_id: companyId })
      .orderBy('name', 'asc');
    return {
      success: true,
      data: {
        members: members.map((member) => ({
          id: Number(member.id),
          login: member.login,
          team_id: member.team_id === null ? null : Number(member.team_id),
          team_name: member.team_name ?? null,
        })),
        teams: teams.map((team) => ({ id: Number(team.id), name: team.name })),
      },
    };
  });

  app.put<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations/:id/assignment',
    whatsappRateLimit(30),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
      const conversationId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      const assignedUserId = body?.assigned_user_id;
      const assignedTeamId = body?.assigned_team_id;
      if (
        !conversationId ||
        !body ||
        Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, 'assigned_user_id') ||
        !Object.hasOwn(body, 'assigned_team_id') ||
        (assignedUserId !== null &&
          (!Number.isSafeInteger(assignedUserId) || Number(assignedUserId) < 1)) ||
        (assignedTeamId !== null &&
          (!Number.isSafeInteger(assignedTeamId) || Number(assignedTeamId) < 1))
      )
        return reply.code(400).send({ success: false, error: 'Invalid conversation assignment' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      if (assignedUserId !== null) {
        const membership = await app
          .db('company_memberships')
          .where({ company_id: companyId, user_id: assignedUserId })
          .first();
        if (!membership)
          return reply.code(404).send({ success: false, error: 'Assigned agent not found' });
      }
      if (assignedTeamId !== null) {
        const team = await app
          .db('organization_teams')
          .where({ company_id: companyId, id: assignedTeamId })
          .first();
        if (!team)
          return reply.code(404).send({ success: false, error: 'Assigned team not found' });
      }
      if (assignedUserId !== null && assignedTeamId !== null) {
        const teamMember = await app
          .db('organization_memberships')
          .where({
            company_id: companyId,
            user_id: assignedUserId,
            team_id: assignedTeamId,
          })
          .first();
        if (!teamMember)
          return reply
            .code(400)
            .send({ success: false, error: 'Agent is not a member of that team' });
      }
      const assigned = {
        assigned_user_id: assignedUserId === null ? null : Number(assignedUserId),
        assigned_team_id: assignedTeamId === null ? null : Number(assignedTeamId),
        write_date: new Date().toISOString(),
      };
      await app.db.transaction(async (trx) => {
        await WhatsappConversation.query(trx)
          .where({ id: conversationId, company_id: companyId })
          .patch(assigned);
        await recordWhatsAppAudit(
          req,
          'whatsapp.conversation',
          'assignment.update',
          conversationId,
          companyId,
          trx
        );
      });
      return { success: true, data: { id: conversationId, ...assigned } };
    }
  );

  app.put<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations/:id/state',
    whatsappRateLimit(30),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
      const conversationId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      const workState = body?.work_state;
      if (
        !conversationId ||
        !body ||
        Object.keys(body).length !== 1 ||
        !['open', 'closed'].includes(String(workState))
      )
        return reply.code(400).send({ success: false, error: 'Invalid conversation work state' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      await app.db.transaction(async (trx) => {
        await WhatsappConversation.query(trx)
          .where({ id: conversationId, company_id: companyId })
          .patch({
            work_state: workState as 'open' | 'closed',
            write_date: new Date().toISOString(),
          });
        await recordWhatsAppAudit(
          req,
          'whatsapp.conversation',
          `state.${workState}`,
          conversationId,
          companyId,
          trx
        );
      });
      return { success: true, data: { id: conversationId, work_state: workState } };
    }
  );

  app.post<{ Body: unknown }>('/whatsapp/labels', whatsappRateLimit(30), async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
    const body = isRecord(req.body) ? req.body : null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const color = typeof body?.color === 'string' ? body.color : '#f1d340';
    if (
      !body ||
      Object.keys(body).some((key) => !['name', 'color'].includes(key)) ||
      name.length < 1 ||
      name.length > 40 ||
      !/^#[0-9a-f]{6}$/iu.test(color)
    )
      return reply.code(400).send({ success: false, error: 'Invalid label name or color' });
    const normalizedName = name.toLocaleLowerCase();
    const inserted = await app
      .db('whatsapp_labels')
      .insert({
        company_id: companyId,
        name,
        normalized_name: normalizedName,
        color: color.toLowerCase(),
      })
      .onConflict(['company_id', 'normalized_name'])
      .ignore()
      .returning(['id', 'name', 'color']);
    const label = inserted[0];
    if (!label) return reply.code(409).send({ success: false, error: 'Label already exists' });
    await recordWhatsAppAudit(req, 'whatsapp.label', 'create', Number(label.id), companyId);
    return reply.code(201).send({ success: true, data: label });
  });

  app.delete<{ Params: Params }>('/whatsapp/labels/:id', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
    const labelId = id(req.params.id);
    if (!labelId) return reply.code(400).send({ success: false, error: 'Invalid label ID' });
    const label = await app
      .db('whatsapp_labels')
      .where({ id: labelId, company_id: companyId })
      .first();
    if (!label) return reply.code(404).send({ success: false, error: 'Label not found' });
    await app.db.transaction(async (trx) => {
      await trx('whatsapp_conversation_labels')
        .where({ company_id: companyId, label_id: labelId })
        .delete();
      await trx('whatsapp_labels').where({ id: labelId, company_id: companyId }).delete();
      await recordWhatsAppAudit(req, 'whatsapp.label', 'delete', labelId, companyId, trx);
    });
    return { success: true, data: { id: labelId } };
  });

  app.put<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations/:id/labels',
    whatsappRateLimit(30),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
      const conversationId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      const labelIds = body?.label_ids;
      if (
        !conversationId ||
        !body ||
        Object.keys(body).length !== 1 ||
        !Array.isArray(labelIds) ||
        labelIds.length > 20 ||
        labelIds.some((value) => !Number.isSafeInteger(value) || Number(value) < 1) ||
        new Set(labelIds).size !== labelIds.length
      )
        return reply.code(400).send({ success: false, error: 'Invalid conversation labels' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      const labels = labelIds.length
        ? await app
            .db('whatsapp_labels')
            .select('id', 'name', 'color')
            .where({ company_id: companyId })
            .whereIn('id', labelIds as number[])
        : [];
      if (labels.length !== labelIds.length)
        return reply.code(404).send({ success: false, error: 'One or more labels were not found' });
      await app.db.transaction(async (trx) => {
        await trx('whatsapp_conversation_labels')
          .where({ company_id: companyId, conversation_id: conversationId })
          .delete();
        if (labels.length)
          await trx('whatsapp_conversation_labels').insert(
            labels.map((label) => ({
              company_id: companyId,
              conversation_id: conversationId,
              label_id: label.id,
            }))
          );
        await recordWhatsAppAudit(
          req,
          'whatsapp.conversation',
          'labels.update',
          conversationId,
          companyId,
          trx
        );
      });
      return { success: true, data: labels };
    }
  );

  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      search?: string;
      archived?: string;
      unread?: string;
      label_id?: string;
      queue?: string;
      team_id?: string;
      work_state?: string;
    };
  }>('/whatsapp/conversations', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const archived = req.query.archived === 'true';
    const unreadOnly = req.query.unread === 'true';
    const labelId = req.query.label_id === undefined ? undefined : id(req.query.label_id);
    const teamId = req.query.team_id === undefined ? undefined : id(req.query.team_id);
    const queue = req.query.queue ?? 'all';
    const workState = req.query.work_state ?? 'all';
    if (req.query.archived !== undefined && !['true', 'false'].includes(req.query.archived)) {
      return reply.code(400).send({ success: false, error: 'Archived must be true or false' });
    }
    if (req.query.unread !== undefined && !['true', 'false'].includes(req.query.unread)) {
      return reply.code(400).send({ success: false, error: 'Unread must be true or false' });
    }
    if (req.query.label_id !== undefined && !labelId) {
      return reply.code(400).send({ success: false, error: 'Invalid label ID' });
    }
    if (!['all', 'mine', 'unassigned'].includes(queue)) {
      return reply.code(400).send({ success: false, error: 'Invalid queue filter' });
    }
    if (req.query.team_id !== undefined && !teamId) {
      return reply.code(400).send({ success: false, error: 'Invalid team ID' });
    }
    if (!['all', 'open', 'closed'].includes(workState)) {
      return reply.code(400).send({ success: false, error: 'Invalid work state' });
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ success: false, error: 'Limit must be between 1 and 100' });
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
      return reply.code(400).send({ success: false, error: 'Offset must be between 0 and 10000' });
    }
    if (search.length > 100) {
      return reply
        .code(400)
        .send({ success: false, error: 'Search must be 100 characters or fewer' });
    }
    const account = await WhatsappAccount.query().findOne({ company_id: companyId });
    if (!account?.gateway_device_id) return { success: true, data: [] };
    const providerLimit = offset === 0 ? Math.max(100, limit) : limit;
    const upstream = await gowaRequest<{ data?: Array<Record<string, unknown>> }>(
      `/chats?limit=${providerLimit}&offset=${offset}&archived=${archived}`,
      { deviceId: account.gateway_device_id }
    );
    const chats = new Map((upstream.data ?? []).map((chat) => [chat.jid, chat]));
    if (search) {
      const matchingChats = await gowaRequest<{ data?: Array<Record<string, unknown>> }>(
        `/chats?limit=100&offset=0&archived=${archived}&search=${encodeURIComponent(search)}`,
        { deviceId: account.gateway_device_id }
      );
      for (const chat of matchingChats.data ?? []) chats.set(chat.jid, chat);
    }
    const primaryChats = [...(upstream.data ?? [])].slice(0, limit);
    const primaryJids = primaryChats
      .map((chat) => (typeof chat.jid === 'string' ? chat.jid : ''))
      .filter((jid) => /^[^\s@]{1,200}@(s\.whatsapp\.net|g\.us|lid)$/u.test(jid));
    const existingPreviewRows = primaryJids.length
      ? await app
          .db('whatsapp_conversations')
          .select('id', 'jid', 'last_message', 'last_message_at', 'last_message_sync_at')
          .where({ company_id: companyId })
          .whereIn('jid', primaryJids)
      : [];
    const existingPreviewByJid = new Map(existingPreviewRows.map((row) => [String(row.jid), row]));
    const conversationRows = [...chats.values()].flatMap((chat) => {
      const jid = typeof chat.jid === 'string' ? chat.jid : '';
      if (!/^[^\s@]{1,200}@(s\.whatsapp\.net|g\.us|lid)$/u.test(jid)) return [];
      const lastMessageAt = providerTimestamp(chat.last_message_time);
      return [
        {
          company_id: companyId,
          account_id: account.id,
          jid,
          name: typeof chat.name === 'string' && chat.name ? chat.name.slice(0, 255) : jid,
          is_group: jid.endsWith('@g.us'),
          is_archived: chat.archived === true,
          unread_count: 0,
          last_message_at: lastMessageAt,
        },
      ];
    });
    if (conversationRows.length) {
      await app
        .db('whatsapp_conversations')
        .insert(conversationRows)
        .onConflict(['company_id', 'jid'])
        .merge({
          name: app.db.raw('excluded.name'),
          is_group: app.db.raw('excluded.is_group'),
          is_archived: app.db.raw('excluded.is_archived'),
          last_message_at: app.db.raw(
            'CASE WHEN whatsapp_conversations.last_message_at IS NULL OR excluded.last_message_at > whatsapp_conversations.last_message_at THEN excluded.last_message_at ELSE whatsapp_conversations.last_message_at END'
          ),
          write_date: new Date().toISOString(),
        });
    }
    const chatsNeedingPreview = primaryChats.filter((chat) => {
      const jid = typeof chat.jid === 'string' ? chat.jid : '';
      if (!primaryJids.includes(jid)) return false;
      const providerTime = providerTimestamp(chat.last_message_time);
      if (!providerTime) return false;
      const existing = existingPreviewByJid.get(jid);
      const syncedTime = providerTimestamp(existing?.last_message_sync_at);
      return !syncedTime || Date.parse(providerTime) > Date.parse(syncedTime);
    });
    const conversationIdByJid = new Map(
      existingPreviewRows.map((row) => [String(row.jid), Number(row.id)])
    );
    const missingConversationJids = chatsNeedingPreview
      .map((chat) => String(chat.jid))
      .filter((jid) => !conversationIdByJid.has(jid));
    if (missingConversationJids.length) {
      const insertedRows = await app
        .db('whatsapp_conversations')
        .select('id', 'jid')
        .where({ company_id: companyId })
        .whereIn('jid', missingConversationJids);
      for (const row of insertedRows) conversationIdByJid.set(String(row.jid), Number(row.id));
    }
    let previewIndex = 0;
    const previewWorkers = Array.from(
      { length: Math.min(4, chatsNeedingPreview.length) },
      async () => {
        while (previewIndex < chatsNeedingPreview.length) {
          const chat = chatsNeedingPreview[previewIndex++]!;
          const jid = String(chat.jid);
          try {
            const conversationId = conversationIdByJid.get(jid);
            if (!conversationId) continue;
            const latest = await gowaRequest<{ data?: Array<Record<string, unknown>> }>(
              `/chat/${encodeURIComponent(jid)}/messages?limit=100&offset=0`,
              { deviceId: account.gateway_device_id! }
            );
            const latestMessage = (latest.data ?? []).reduce<{
              item: Record<string, unknown>;
              timestamp: string;
            } | null>((current, item) => {
              const timestamp = providerTimestamp(item.timestamp);
              return timestamp &&
                (!current || Date.parse(timestamp) > Date.parse(current.timestamp))
                ? { item, timestamp }
                : current;
            }, null);
            const providerTime = providerTimestamp(chat.last_message_time);
            if (!latestMessage) {
              if (providerTime) {
                await app
                  .db('whatsapp_conversations')
                  .where({ company_id: companyId, jid })
                  .update({
                    last_message_sync_at: providerTime,
                    write_date: new Date().toISOString(),
                  });
              }
              continue;
            }
            const recentMessages = new Map<string, Record<string, unknown>>();
            for (const item of latest.data ?? []) {
              if (typeof item.id !== 'string' || !item.id) continue;
              const timestamp = providerTimestamp(item.timestamp);
              if (!timestamp) continue;
              const fromMe = item.is_from_me === true;
              const typeInfo = classifyGoWaMessageType(
                item.media_type,
                item.view_once === true || item.is_view_once === true
              );
              const messageType = typeInfo.messageType;
              recentMessages.set(item.id, {
                company_id: companyId,
                account_id: account.id,
                conversation_id: conversationId,
                external_id: item.id.slice(0, 255),
                direction: fromMe ? 'outbound' : 'inbound',
                message_type: messageType,
                provider_type: typeInfo.providerType,
                content:
                  typeInfo.providerType === 'view_once'
                    ? 'View-once media'
                    : typeof item.content === 'string'
                      ? item.content.slice(0, 8000)
                      : '',
                status: fromMe ? 'sent' : 'received',
                media_mime_type:
                  !typeInfo.providerType && item.mime_type !== undefined
                    ? safeMime(item.mime_type)
                    : typeInfo.providerType
                      ? null
                      : mediaDefaultMime(messageType),
                media_file_name:
                  !typeInfo.providerType && typeof item.filename === 'string'
                    ? item.filename.slice(0, 255)
                    : !typeInfo.providerType && typeof item.file_name === 'string'
                      ? item.file_name.slice(0, 255)
                      : null,
                sender_display_name:
                  typeof item.sender_display_name === 'string'
                    ? item.sender_display_name.trim().slice(0, 255)
                    : typeof item.from_name === 'string'
                      ? item.from_name.trim().slice(0, 255)
                      : null,
                sender_jid:
                  typeof item.sender === 'string'
                    ? item.sender.slice(0, 255)
                    : typeof item.sender_jid === 'string'
                      ? item.sender_jid.slice(0, 255)
                      : null,
                create_date: timestamp,
              });
            }
            const recentMessageRows = [...recentMessages.values()];
            for (let index = 0; index < recentMessageRows.length; index += 25) {
              await app
                .db('whatsapp_messages')
                .insert(recentMessageRows.slice(index, index + 25))
                .onConflict(['company_id', 'external_id'])
                .merge(['content', 'status', 'provider_type', 'write_date']);
            }
            const latestTypeInfo = classifyGoWaMessageType(
              latestMessage.item.media_type,
              latestMessage.item.view_once === true || latestMessage.item.is_view_once === true
            );
            const latestWasDeleted =
              typeof latestMessage.item.id === 'string' &&
              Boolean(
                await app
                  .db('whatsapp_messages')
                  .select('id')
                  .where({
                    company_id: companyId,
                    external_id: latestMessage.item.id,
                    is_deleted: true,
                  })
                  .first()
              );
            const preview = latestWasDeleted
              ? 'This message was deleted'
              : latestTypeInfo.providerType === 'view_once'
                ? 'View-once media'
                : typeof latestMessage.item.content === 'string' && latestMessage.item.content
                  ? latestMessage.item.content.slice(0, 8_000)
                  : `[${latestTypeInfo.providerType ?? latestTypeInfo.messageType}]`;
            await app
              .db('whatsapp_conversations')
              .where({ company_id: companyId, jid })
              .where((builder) =>
                builder
                  .whereNull('last_message_at')
                  .orWhere('last_message_at', '<=', latestMessage.timestamp)
              )
              .update({
                last_message: preview,
                last_message_at: latestMessage.timestamp,
                write_date: new Date().toISOString(),
              });
            if (providerTime) {
              await app.db('whatsapp_conversations').where({ company_id: companyId, jid }).update({
                last_message_sync_at: providerTime,
                write_date: new Date().toISOString(),
              });
            }
          } catch (error) {
            req.log.warn(
              { error: whatsappLogErrorContext(error) },
              'WhatsApp conversation preview refresh failed'
            );
          }
        }
      }
    );
    await Promise.all(previewWorkers);
    const query = WhatsappConversation.query().where({
      company_id: companyId,
      is_archived: archived,
    });
    if (labelId) {
      const label = await app
        .db('whatsapp_labels')
        .where({ id: labelId, company_id: companyId })
        .first();
      if (!label) return reply.code(404).send({ success: false, error: 'Label not found' });
      query.whereIn(
        'id',
        app
          .db('whatsapp_conversation_labels')
          .select('conversation_id')
          .where({ company_id: companyId, label_id: labelId })
      );
    }
    if (queue === 'mine') query.where('assigned_user_id', req.auth!.userId);
    if (queue === 'unassigned') query.whereNull('assigned_user_id').whereNull('assigned_team_id');
    if (teamId) {
      const team = await app
        .db('organization_teams')
        .where({ id: teamId, company_id: companyId })
        .first();
      if (!team) return reply.code(404).send({ success: false, error: 'Team not found' });
      query.where('assigned_team_id', teamId);
    }
    if (workState !== 'all') query.where('work_state', workState);
    const readCursorTimestampSql =
      app.db.client.config.client === 'pg'
        ? 'read_cursor.last_read_at::timestamptz'
        : 'read_cursor.last_read_at';
    const unreadMessages = () =>
      app
        .db('whatsapp_messages as unread_message')
        .select(app.db.raw('1'))
        .whereRaw('unread_message.conversation_id = whatsapp_conversations.id')
        .whereRaw('unread_message.company_id = whatsapp_conversations.company_id')
        .where('unread_message.direction', 'inbound')
        .whereNotExists(
          app
            .db('whatsapp_conversation_reads as read_cursor')
            .select(app.db.raw('1'))
            .whereRaw('read_cursor.conversation_id = unread_message.conversation_id')
            .whereRaw('read_cursor.company_id = unread_message.company_id')
            .where('read_cursor.user_id', req.auth!.userId)
            .where((builder) =>
              builder
                .whereRaw(`unread_message.create_date < ${readCursorTimestampSql}`)
                .orWhereRaw(
                  `(unread_message.create_date = ${readCursorTimestampSql} AND unread_message.id <= read_cursor.last_read_message_id)`
                )
            )
        );
    if (unreadOnly) query.whereExists(unreadMessages());
    if (search) {
      const pattern = `%${search.toLocaleLowerCase()}%`;
      query.where((builder) =>
        builder
          .whereRaw('LOWER(name) LIKE ?', [pattern])
          .orWhereRaw('LOWER(jid) LIKE ?', [pattern])
          .orWhereExists(
            app
              .db('whatsapp_messages')
              .select(app.db.raw('1'))
              .whereRaw('whatsapp_messages.conversation_id = whatsapp_conversations.id')
              .whereRaw('LOWER(whatsapp_messages.content) LIKE ?', [pattern])
          )
      );
    }
    const conversations = await query
      .orderBy('is_pinned', 'desc')
      .orderBy('last_message_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset);
    const conversationIds = conversations.map((conversation) => conversation.id);
    const assignmentRows = conversationIds.length
      ? await app
          .db('whatsapp_conversations as conversation')
          .leftJoin('company_memberships as assigned_membership', function joinMember() {
            this.on('assigned_membership.user_id', '=', 'conversation.assigned_user_id').andOn(
              'assigned_membership.company_id',
              '=',
              'conversation.company_id'
            );
          })
          .leftJoin('users as assigned_agent', 'assigned_agent.id', 'assigned_membership.user_id')
          .leftJoin('organization_teams as assigned_team', function joinTeam() {
            this.on('assigned_team.id', '=', 'conversation.assigned_team_id').andOn(
              'assigned_team.company_id',
              '=',
              'conversation.company_id'
            );
          })
          .select(
            'conversation.id as conversation_id',
            'assigned_membership.user_id as assigned_user_id',
            'assigned_agent.login as assigned_user_name',
            'assigned_team.id as assigned_team_id',
            'assigned_team.name as assigned_team_name'
          )
          .where({ 'conversation.company_id': companyId })
          .whereIn('conversation.id', conversationIds)
      : [];
    const assignmentsByConversation = new Map(
      assignmentRows.map((row) => [Number(row.conversation_id), row])
    );
    const labelRows = conversationIds.length
      ? await app
          .db('whatsapp_conversation_labels as conversation_label')
          .join('whatsapp_labels as label', function joinLabel() {
            this.on('label.id', '=', 'conversation_label.label_id').andOn(
              'label.company_id',
              '=',
              'conversation_label.company_id'
            );
          })
          .select('conversation_label.conversation_id', 'label.id', 'label.name', 'label.color')
          .where({ 'conversation_label.company_id': companyId })
          .whereIn('conversation_label.conversation_id', conversationIds)
      : [];
    const labelsByConversation = new Map<
      number,
      Array<{ id: number; name: string; color: string }>
    >();
    for (const label of labelRows) {
      const current = labelsByConversation.get(Number(label.conversation_id)) ?? [];
      current.push({ id: Number(label.id), name: label.name, color: label.color });
      labelsByConversation.set(Number(label.conversation_id), current);
    }
    const unreadRows = conversationIds.length
      ? await app
          .db('whatsapp_messages as unread_message')
          .leftJoin('whatsapp_conversation_reads as read_cursor', function joinReadCursor() {
            this.on('read_cursor.company_id', '=', 'unread_message.company_id')
              .andOn('read_cursor.conversation_id', '=', 'unread_message.conversation_id')
              .andOn('read_cursor.user_id', '=', app.db.raw('?', [req.auth!.userId]));
          })
          .select('unread_message.conversation_id')
          .count({ unread_count: 'unread_message.id' })
          .where('unread_message.company_id', companyId)
          .whereIn('unread_message.conversation_id', conversationIds)
          .where('unread_message.direction', 'inbound')
          .where((builder) =>
            builder
              .whereNull('read_cursor.id')
              .orWhereRaw(`unread_message.create_date > ${readCursorTimestampSql}`)
              .orWhereRaw(
                `(unread_message.create_date = ${readCursorTimestampSql} AND unread_message.id > read_cursor.last_read_message_id)`
              )
          )
          .groupBy('unread_message.conversation_id')
      : [];
    const unreadCountByConversation = new Map(
      (unreadRows as Array<{ conversation_id: number; unread_count: number | string }>).map(
        (row) => [Number(row.conversation_id), Number(row.unread_count)]
      )
    );
    return {
      success: true,
      data: conversations.map((conversation) => ({
        ...conversation,
        assigned_user_name:
          assignmentsByConversation.get(conversation.id)?.assigned_user_name ?? null,
        assigned_team_name:
          assignmentsByConversation.get(conversation.id)?.assigned_team_name ?? null,
        unread_count: unreadCountByConversation.get(conversation.id) ?? 0,
        labels: labelsByConversation.get(conversation.id) ?? [],
      })),
    };
  });

  app.post<{ Body: unknown }>(
    '/whatsapp/contacts/check',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'create')) return;
      const body = isRecord(req.body) ? req.body : null;
      const rawPhone = typeof body?.phone === 'string' ? body.phone.trim() : '';
      const compactPhone = rawPhone.replace(/[\s().-]/gu, '');
      const phone = compactPhone.startsWith('+') ? compactPhone.slice(1) : compactPhone;
      const parsedPhone = /^\d+$/u.test(phone)
        ? parsePhoneNumberFromString(`+${phone}`)
        : undefined;
      if (
        !body ||
        Object.keys(body).some((key) => key !== 'phone') ||
        !/^[1-9]\d{7,14}$/u.test(phone) ||
        !parsedPhone?.isValid()
      )
        return reply.code(400).send({
          success: false,
          error: 'Enter a valid international phone number (8–15 digits)',
        });
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account || account.status !== 'connected' || !account.gateway_device_id)
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      try {
        const check = await gowaRequest<{ is_on_whatsapp?: unknown }>(
          `/user/check?phone=${encodeURIComponent(parsedPhone.number.slice(1))}`,
          { deviceId: account.gateway_device_id }
        );
        if (typeof check.is_on_whatsapp !== 'boolean')
          return reply
            .code(502)
            .send({ success: false, error: 'WhatsApp number could not be verified' });
        return reply.send({
          success: true,
          data: { phone: parsedPhone.number, is_on_whatsapp: check.is_on_whatsapp },
        });
      } catch (error) {
        req.log.warn({ error: whatsappLogErrorContext(error) }, 'WhatsApp number check failed');
        return reply
          .code(502)
          .send({ success: false, error: 'WhatsApp number could not be verified' });
      }
    }
  );

  app.post<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations/:id/archive',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
      const conversationId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      const archived = body?.archived;
      if (!conversationId || typeof archived !== 'boolean' || Object.keys(body ?? {}).length !== 1)
        return reply.code(400).send({ success: false, error: 'Invalid archive request' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account?.gateway_device_id)
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      try {
        await gowaRequest(`/chat/${encodeURIComponent(conversation.jid)}/archive`, {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ archived }),
        });
      } catch (error) {
        req.log.warn(
          { error: whatsappLogErrorContext(error) },
          'WhatsApp conversation archive request failed'
        );
        return reply
          .code(502)
          .send({ success: false, error: 'Could not update conversation archive' });
      }
      const updated = await app.db.transaction(async (trx) => {
        await WhatsappConversation.query(trx)
          .where({ id: conversationId, company_id: companyId })
          .patch({ is_archived: archived, write_date: new Date().toISOString() });
        await recordWhatsAppAudit(
          req,
          'whatsapp.conversation',
          archived ? 'archive' : 'unarchive',
          conversationId,
          companyId,
          trx
        );
        return WhatsappConversation.query(trx).findOne({
          id: conversationId,
          company_id: companyId,
        });
      });
      return { success: true, data: updated };
    }
  );

  app.post<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations/:id/pin',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
      const conversationId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      const pinned = body?.pinned;
      if (!conversationId || typeof pinned !== 'boolean' || Object.keys(body ?? {}).length !== 1)
        return reply.code(400).send({ success: false, error: 'Invalid pin request' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account?.gateway_device_id)
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      try {
        await gowaRequest(`/chat/${encodeURIComponent(conversation.jid)}/pin`, {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ pinned }),
        });
      } catch (error) {
        req.log.warn(
          { error: whatsappLogErrorContext(error) },
          'WhatsApp conversation pin request failed'
        );
        return reply.code(502).send({ success: false, error: 'Could not update conversation pin' });
      }
      const updated = await app.db.transaction(async (trx) => {
        await WhatsappConversation.query(trx)
          .where({ id: conversationId, company_id: companyId })
          .patch({ is_pinned: pinned, write_date: new Date().toISOString() });
        await recordWhatsAppAudit(
          req,
          'whatsapp.conversation',
          pinned ? 'pin' : 'unpin',
          conversationId,
          companyId,
          trx
        );
        return WhatsappConversation.query(trx).findOne({
          id: conversationId,
          company_id: companyId,
        });
      });
      return { success: true, data: updated };
    }
  );

  app.post<{ Params: Params; Body: unknown }>(
    '/whatsapp/groups',
    whatsappRateLimit(5),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'create')) return;
      const body = isRecord(req.body) ? req.body : null;
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      const rawParticipants = body?.participants;
      if (
        !body ||
        Object.keys(body).some((key) => !['title', 'participants'].includes(key)) ||
        !title ||
        title.length > 25 ||
        !Array.isArray(rawParticipants) ||
        rawParticipants.length < 1 ||
        rawParticipants.length > 100 ||
        rawParticipants.some((participant) => typeof participant !== 'string')
      )
        return reply.code(400).send({
          success: false,
          error: 'Enter a group name up to 25 characters and 1–100 participant phone numbers',
        });

      const participantNumbers: string[] = [];
      for (const rawParticipant of rawParticipants as string[]) {
        const compactPhone = rawParticipant.trim().replace(/[\s().-]/gu, '');
        const phone = compactPhone.startsWith('+') ? compactPhone.slice(1) : compactPhone;
        const parsed = /^\d+$/u.test(phone) ? parsePhoneNumberFromString(`+${phone}`) : undefined;
        if (!/^[1-9]\d{7,14}$/u.test(phone) || !parsed?.isValid())
          return reply
            .code(400)
            .send({ success: false, error: 'A participant phone number is invalid' });
        participantNumbers.push(parsed.number.slice(1));
      }
      if (new Set(participantNumbers).size !== participantNumbers.length)
        return reply
          .code(400)
          .send({ success: false, error: 'Participant phone numbers must be unique' });

      const idempotencyHeader = req.headers['idempotency-key'];
      const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader.trim() : '';
      if (!/^[\x21-\x7e]{16,128}$/u.test(idempotencyKey))
        return reply
          .code(400)
          .send({ success: false, error: 'A valid Idempotency-Key header is required' });
      const idempotencyHash = createHash('sha256').update(idempotencyKey).digest('hex');
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ title, participants: participantNumbers }))
        .digest('hex');
      const existing = await WhatsappGroupCreation.query().findOne({
        company_id: companyId,
        idempotency_key: idempotencyHash,
      });
      if (existing) {
        if (existing.request_hash !== requestHash)
          return reply
            .code(409)
            .send({ success: false, error: 'Idempotency-Key was used for a different request' });
        if (existing.group_jid && existing.status !== 'failed') {
          let conversation = await WhatsappConversation.query().findOne({
            company_id: companyId,
            jid: existing.group_jid,
            is_group: true,
          });
          if (!conversation && existing.status === 'unknown') {
            const account = await WhatsappAccount.query().findOne({ company_id: companyId });
            if (account) {
              conversation = await app.db.transaction(async (trx) => {
                const [recovered] = await trx('whatsapp_conversations')
                  .insert({
                    company_id: companyId,
                    account_id: account.id,
                    jid: existing.group_jid,
                    name: title,
                    is_group: true,
                    group_participant_count: participantNumbers.length + 1,
                    unread_count: 0,
                    write_date: new Date().toISOString(),
                  })
                  .onConflict(['company_id', 'jid'])
                  .merge({ name: title, is_group: true, write_date: new Date().toISOString() })
                  .returning('*');
                await WhatsappGroupCreation.query(trx).where({ id: existing.id }).patch({
                  status: 'completed',
                });
                await recordWhatsAppAudit(
                  req,
                  'whatsapp.conversation',
                  'group_create_reconciled',
                  Number(recovered.id),
                  companyId,
                  trx
                );
                return recovered;
              });
            }
          }
          if (conversation)
            return reply.send({ success: true, data: conversation, replayed: true });
        }
        return reply.code(409).send({
          success: false,
          error:
            existing.status === 'failed'
              ? 'This group creation failed; use a new idempotency key to retry'
              : 'Group creation is unresolved; check the inbox before retrying',
        });
      }

      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account || account.status !== 'connected' || !account.gateway_device_id)
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });

      let creationId: number;
      try {
        const creation = await WhatsappGroupCreation.query().insert({
          company_id: companyId,
          idempotency_key: idempotencyHash,
          request_hash: requestHash,
          status: 'started',
        });
        creationId = Number(creation.id);
      } catch (error) {
        const raced = await WhatsappGroupCreation.query().findOne({
          company_id: companyId,
          idempotency_key: idempotencyHash,
        });
        if (!raced) throw error;
        if (raced.request_hash !== requestHash)
          return reply
            .code(409)
            .send({ success: false, error: 'Idempotency-Key was used for a different request' });
        return reply.code(409).send({
          success: false,
          error: 'Group creation is unresolved; check the inbox before retrying',
        });
      }

      try {
        const result = await gowaRequest<{ group_id?: unknown }>('/group', {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ title, participants: participantNumbers }),
        });
        const groupJid = typeof result.group_id === 'string' ? result.group_id : '';
        if (!/^[^\s@]{1,200}@g\.us$/u.test(groupJid)) {
          await WhatsappGroupCreation.query()
            .where({ id: creationId })
            .patch({ status: 'unknown' });
          await recordWhatsAppAudit(
            req,
            'whatsapp.group.creation',
            'group_create_unknown',
            creationId,
            companyId
          );
          return reply
            .code(502)
            .send({ success: false, error: 'Group creation result could not be confirmed' });
        }
        await WhatsappGroupCreation.query().where({ id: creationId }).patch({
          status: 'unknown',
          group_jid: groupJid,
        });
        const now = new Date().toISOString();
        const conversation = await app.db.transaction(async (trx) => {
          const [created] = await trx('whatsapp_conversations')
            .insert({
              company_id: companyId,
              account_id: account.id,
              jid: groupJid,
              name: title,
              is_group: true,
              group_participant_count: participantNumbers.length + 1,
              unread_count: 0,
              write_date: now,
            })
            .onConflict(['company_id', 'jid'])
            .merge({ name: title, is_group: true, write_date: now })
            .returning('*');
          await WhatsappGroupCreation.query(trx).where({ id: creationId }).patch({
            status: 'completed',
            group_jid: groupJid,
          });
          await recordWhatsAppAudit(
            req,
            'whatsapp.conversation',
            'group_create',
            Number(created.id),
            companyId,
            trx
          );
          return created;
        });
        return reply.code(201).send({ success: true, data: conversation });
      } catch (error) {
        const definitelyRejected =
          error instanceof GowaError && error.statusCode >= 400 && error.statusCode < 500;
        await WhatsappGroupCreation.query()
          .where({ id: creationId })
          .patch({
            status: definitelyRejected ? 'failed' : 'unknown',
          });
        await recordWhatsAppAudit(
          req,
          'whatsapp.group.creation',
          definitelyRejected ? 'group_create_failed' : 'group_create_unknown',
          creationId,
          companyId
        );
        req.log.warn({ error: whatsappLogErrorContext(error) }, 'WhatsApp group creation failed');
        return reply.code(502).send({
          success: false,
          error: definitelyRejected
            ? 'WhatsApp rejected the group creation request'
            : 'Group creation could not be confirmed; check the inbox before retrying',
        });
      }
    }
  );

  app.post<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'create')) return;
      const body = isRecord(req.body) ? req.body : null;
      const phone = typeof body?.phone === 'string' ? body.phone.replace(/^\+/u, '') : '';
      if (
        !body ||
        !/^[1-9]\d{7,14}$/u.test(phone) ||
        Object.keys(body).some((key) => !['phone', 'name'].includes(key)) ||
        (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 255))
      )
        return reply
          .code(400)
          .send({ success: false, error: 'Enter a phone number with country code (8–15 digits)' });
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account || account.status !== 'connected')
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      const [conversation] = await app
        .db('whatsapp_conversations')
        .insert({
          company_id: companyId,
          account_id: account.id,
          jid: `${phone}@s.whatsapp.net`,
          name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `+${phone}`,
          is_group: false,
          unread_count: 0,
        })
        .onConflict(['company_id', 'jid'])
        .merge({ write_date: new Date().toISOString() })
        .returning('*');
      return reply.code(201).send({ success: true, data: conversation });
    }
  );

  app.get<{
    Params: Params;
    Querystring: { limit?: string; offset?: string };
  }>('/whatsapp/conversations/:id/notes', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const conversationId = id(req.params.id);
    if (!conversationId)
      return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
    const conversation = await WhatsappConversation.query().findOne({
      id: conversationId,
      company_id: companyId,
    });
    if (!conversation)
      return reply.code(404).send({ success: false, error: 'Conversation not found' });
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return reply.code(400).send({ success: false, error: 'Limit must be between 1 and 100' });
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5_000)
      return reply.code(400).send({ success: false, error: 'Offset must be between 0 and 5000' });
    const data = await app
      .db('whatsapp_internal_notes as note')
      .leftJoin('users as author', 'author.id', 'note.user_id')
      .select(
        'note.id',
        'note.conversation_id',
        'note.user_id',
        'note.body',
        'note.create_date',
        'author.login as author_name'
      )
      .where({ 'note.company_id': companyId, 'note.conversation_id': conversationId })
      .orderBy('note.create_date', 'desc')
      .orderBy('note.id', 'desc')
      .limit(limit)
      .offset(offset);
    return { success: true, data: data.reverse() };
  });

  app.post<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations/:id/notes',
    whatsappRateLimit(30),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
      const conversationId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      const noteBody = typeof body?.content === 'string' ? body.content.trim() : '';
      if (
        !conversationId ||
        !body ||
        Object.keys(body).some((key) => key !== 'content') ||
        noteBody.length < 1 ||
        noteBody.length > 4_000
      )
        return reply
          .code(400)
          .send({ success: false, error: 'Note must contain 1–4000 characters' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      const note = await app.db.transaction(async (trx) => {
        const [created] = await trx('whatsapp_internal_notes')
          .insert({
            company_id: companyId,
            conversation_id: conversationId,
            user_id: req.auth!.userId,
            body: noteBody,
          })
          .returning(['id', 'conversation_id', 'user_id', 'body', 'create_date']);
        await recordWhatsAppAudit(
          req,
          'whatsapp.internal_note',
          'create',
          Number(created.id),
          companyId,
          trx
        );
        const author = await trx('users').select('login').where({ id: req.auth!.userId }).first();
        return { ...created, author_name: author?.login ?? `User ${req.auth!.userId}` };
      });
      return reply.code(201).send({ success: true, data: note });
    }
  );

  app.get<{ Params: Params }>(
    '/whatsapp/conversations/:id/group',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      const conversationId = id(req.params.id);
      if (!conversationId)
        return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
      const [conversation] = await app
        .db('whatsapp_conversations')
        .where({ id: conversationId, company_id: companyId, is_group: true })
        .select(
          'id',
          'account_id',
          'jid',
          'name',
          'group_topic',
          'group_participant_count',
          'group_participants_json',
          'group_metadata_synced_at'
        );
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Group conversation not found' });
      const cleanProviderText = (value: string, max: number) =>
        value
          .replace(
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
            ''
          )
          .slice(0, max);
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account?.gateway_device_id)
        return reply.code(503).send({ success: false, error: 'WhatsApp account is unavailable' });

      const storedParticipants = (): Array<{
        jid: string;
        phone_number: string | null;
        display_name: string | null;
        is_admin: boolean;
        is_super_admin: boolean;
      }> => {
        if (typeof conversation.group_participants_json !== 'string') return [];
        try {
          const value: unknown = JSON.parse(conversation.group_participants_json);
          if (!Array.isArray(value)) return [];
          return value.slice(0, 2000).flatMap((item) => {
            if (
              !isRecord(item) ||
              typeof item.jid !== 'string' ||
              !/^[^\s@\p{Cc}\p{Cf}]{1,200}@(s\.whatsapp\.net|lid)$/u.test(item.jid)
            )
              return [];
            return [
              {
                jid: item.jid,
                phone_number:
                  typeof item.phone_number === 'string' &&
                  /^[^\s@\p{Cc}\p{Cf}]{1,200}@s\.whatsapp\.net$/u.test(item.phone_number)
                    ? item.phone_number
                    : null,
                display_name:
                  typeof item.display_name === 'string'
                    ? cleanProviderText(item.display_name.trim(), 255) || null
                    : null,
                is_admin: item.is_admin === true,
                is_super_admin: item.is_super_admin === true,
              },
            ];
          });
        } catch {
          return [];
        }
      };
      const fallback = () => ({
        name: conversation.name,
        topic: conversation.group_topic ?? null,
        participant_count:
          conversation.group_participant_count === null ||
          conversation.group_participant_count === undefined
            ? null
            : Number(conversation.group_participant_count),
        participants: storedParticipants(),
        synced_at: conversation.group_metadata_synced_at ?? null,
        stale: true,
      });

      try {
        const groupId = encodeURIComponent(String(conversation.jid));
        const [info, participantResponse] = await Promise.all([
          gowaRequest<Record<string, unknown>>(`/group/info?group_id=${groupId}`, {
            deviceId: account.gateway_device_id,
          }),
          gowaRequest<Record<string, unknown>>(`/group/participants?group_id=${groupId}`, {
            deviceId: account.gateway_device_id,
          }),
        ]);
        const infoResult = isRecord(info.results) ? info.results : info;
        const participantResult = isRecord(participantResponse.results)
          ? participantResponse.results
          : participantResponse;
        const rawParticipants = Array.isArray(participantResult.participants)
          ? participantResult.participants
          : [];
        const participants = rawParticipants.slice(0, 2000).flatMap((item) => {
          if (!isRecord(item)) return [];
          const jid =
            typeof item.jid === 'string'
              ? item.jid
              : typeof item.phone_number === 'string'
                ? item.phone_number
                : typeof item.JID === 'string'
                  ? item.JID
                  : '';
          if (!jid || !/^[^\s@\p{Cc}\p{Cf}]{1,200}@(s\.whatsapp\.net|lid)$/u.test(jid)) return [];
          const phone =
            typeof item.phone_number === 'string'
              ? item.phone_number
              : typeof item.PhoneNumber === 'string'
                ? item.PhoneNumber
                : null;
          const name =
            typeof item.display_name === 'string'
              ? item.display_name
              : typeof item.DisplayName === 'string'
                ? item.DisplayName
                : null;
          return [
            {
              jid,
              phone_number:
                phone && /^[^\s@\p{Cc}\p{Cf}]{1,200}@s\.whatsapp\.net$/u.test(phone) ? phone : null,
              display_name: name ? cleanProviderText(name.trim(), 255) || null : null,
              is_admin: item.is_admin === true || item.IsAdmin === true,
              is_super_admin: item.is_super_admin === true || item.IsSuperAdmin === true,
            },
          ];
        });
        const now = new Date().toISOString();
        const name =
          typeof infoResult.name === 'string'
            ? cleanProviderText(infoResult.name.trim(), 255)
            : typeof participantResult.name === 'string'
              ? cleanProviderText(participantResult.name.trim(), 255)
              : conversation.name;
        const topic =
          typeof infoResult.topic === 'string'
            ? cleanProviderText(infoResult.topic, 4000)
            : typeof infoResult.description === 'string'
              ? cleanProviderText(infoResult.description, 4000)
              : null;
        const reportedCount = Number(infoResult.participant_count);
        const count =
          Number.isSafeInteger(reportedCount) && reportedCount >= participants.length
            ? Math.min(reportedCount, 100_000)
            : participants.length;
        await app
          .db('whatsapp_conversations')
          .where({ id: conversationId, company_id: companyId, is_group: true })
          .update({
            name,
            group_topic: topic,
            group_participant_count: count,
            group_participants_json: JSON.stringify(participants),
            group_metadata_synced_at: now,
            write_date: now,
          });
        const freshByPhone = new Map(
          participants.flatMap((participant) => {
            const address = participant.phone_number ?? participant.jid;
            const match = address.match(/^([1-9]\d{7,14})@s\.whatsapp\.net$/u);
            return match ? [[match[1]!, participant] as const] : [];
          })
        );
        const pendingOperations = await WhatsappGroupOperation.query()
          .where({ company_id: companyId, conversation_id: conversationId })
          .whereIn('status', ['started', 'unknown']);
        for (const operation of pendingOperations) {
          let targets: unknown;
          try {
            targets = JSON.parse(operation.participants_json);
          } catch {
            continue;
          }
          if (
            !Array.isArray(targets) ||
            targets.length < 1 ||
            targets.some((phone) => typeof phone !== 'string' || !/^[1-9]\d{7,14}$/u.test(phone))
          )
            continue;
          const matched = targets.map((phone: string) => freshByPhone.get(phone));
          const allPresent = matched.every(Boolean);
          const nonePresent = matched.every((participant) => !participant);
          const allAdmins = allPresent && matched.every((participant) => participant?.is_admin);
          const allMembers = allPresent && matched.every((participant) => !participant?.is_admin);
          const achieved =
            (operation.action === 'add' && allPresent) ||
            (operation.action === 'remove' && nonePresent) ||
            (operation.action === 'promote' && allAdmins) ||
            (operation.action === 'demote' && allMembers);
          const notAchieved =
            (operation.action === 'add' && nonePresent) ||
            (operation.action === 'remove' && allPresent) ||
            (operation.action === 'promote' && allMembers) ||
            (operation.action === 'demote' && allAdmins);
          if (!achieved && !notAchieved) continue;
          await WhatsappGroupOperation.query()
            .where({ id: operation.id })
            .patch({
              status: achieved ? 'completed' : 'failed',
              result_json: JSON.stringify({ reconciled: true }),
            });
          await recordWhatsAppAudit(
            req,
            'whatsapp.conversation',
            `group_participants_${operation.action}_reconciled_${achieved ? 'completed' : 'failed'}`,
            conversationId,
            companyId
          );
        }
        return reply.send({
          success: true,
          data: {
            name,
            topic,
            participant_count: count,
            participants,
            synced_at: now,
            stale: false,
          },
        });
      } catch (error) {
        req.log.warn(
          { error: whatsappLogErrorContext(error) },
          'WhatsApp group metadata refresh failed'
        );
        if (
          conversation.group_metadata_synced_at ||
          conversation.group_participants_json ||
          conversation.group_topic
        )
          return reply.send({ success: true, data: fallback() });
        return reply.code(502).send({ success: false, error: 'Group details could not be loaded' });
      }
    }
  );

  app.post<{ Params: Params & { action: string }; Body: unknown }>(
    '/whatsapp/conversations/:id/group/participants/:action',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.conversation', 'write')) return;
      const conversationId = id(req.params.id);
      if (!conversationId)
        return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
      const groupActions = ['add', 'remove', 'promote', 'demote'] as const;
      if (!(groupActions as readonly string[]).includes(req.params.action))
        return reply.code(404).send({ success: false, error: 'Group action not found' });
      const action = req.params.action as (typeof groupActions)[number];
      const body = isRecord(req.body) ? req.body : null;
      const rawParticipants = body?.participants;
      if (
        !body ||
        Object.keys(body).some((key) => key !== 'participants') ||
        !Array.isArray(rawParticipants) ||
        rawParticipants.length < 1 ||
        rawParticipants.length > 100 ||
        rawParticipants.some((participant) => typeof participant !== 'string')
      )
        return reply.code(400).send({
          success: false,
          error: 'Provide 1–100 participant phone numbers',
        });

      const participants: string[] = [];
      for (const raw of rawParticipants as string[]) {
        const compactPhone = raw.trim().replace(/[\s().-]/gu, '');
        const phone = compactPhone.startsWith('+') ? compactPhone.slice(1) : compactPhone;
        const parsed = /^\d+$/u.test(phone) ? parsePhoneNumberFromString(`+${phone}`) : undefined;
        if (!/^[1-9]\d{7,14}$/u.test(phone) || !parsed?.isValid())
          return reply
            .code(400)
            .send({ success: false, error: 'A participant phone number is invalid' });
        participants.push(parsed.number.slice(1));
      }
      if (new Set(participants).size !== participants.length)
        return reply
          .code(400)
          .send({ success: false, error: 'Participant phone numbers must be unique' });

      const idempotencyHeader = req.headers['idempotency-key'];
      const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader.trim() : '';
      if (!/^[\x21-\x7e]{16,128}$/u.test(idempotencyKey))
        return reply
          .code(400)
          .send({ success: false, error: 'A valid Idempotency-Key header is required' });
      const idempotencyHash = createHash('sha256').update(idempotencyKey).digest('hex');
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ conversationId, action, participants }))
        .digest('hex');
      const existing = await WhatsappGroupOperation.query().findOne({
        company_id: companyId,
        idempotency_key: idempotencyHash,
      });
      if (existing) {
        if (existing.request_hash !== requestHash)
          return reply
            .code(409)
            .send({ success: false, error: 'Idempotency-Key was used for a different request' });
        if (existing.status === 'completed') {
          let results: unknown = [];
          try {
            results = JSON.parse(existing.result_json ?? '[]');
          } catch {
            results = [];
          }
          return reply.send({
            success: true,
            data: { status: 'completed', results },
            replayed: true,
          });
        }
        return reply.code(409).send({
          success: false,
          error:
            existing.status === 'failed'
              ? 'This group action failed; use a new request key after checking group details'
              : 'Group action result is unresolved; refresh group details before taking another action',
        });
      }

      const [conversation] = await app
        .db('whatsapp_conversations')
        .where({ id: conversationId, company_id: companyId, is_group: true })
        .select('id', 'account_id', 'jid');
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Group conversation not found' });
      const unresolvedOperations = await WhatsappGroupOperation.query()
        .where({ company_id: companyId, conversation_id: conversationId })
        .whereIn('status', ['started', 'unknown']);
      const requestedNumbers = new Set(participants);
      const overlapsUnresolved = unresolvedOperations.some((operation) => {
        try {
          const prior: unknown = JSON.parse(operation.participants_json);
          return Array.isArray(prior) && prior.some((phone) => requestedNumbers.has(String(phone)));
        } catch {
          return true;
        }
      });
      if (overlapsUnresolved)
        return reply.code(409).send({
          success: false,
          error: 'A previous group action is unresolved; refresh group details before retrying',
        });
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account || account.status !== 'connected' || !account.gateway_device_id)
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });

      let operationId: number;
      try {
        const operation = await WhatsappGroupOperation.query().insert({
          company_id: companyId,
          conversation_id: conversationId,
          idempotency_key: idempotencyHash,
          request_hash: requestHash,
          action,
          participants_json: JSON.stringify(participants),
          status: 'started',
        });
        operationId = Number(operation.id);
      } catch (error) {
        const raced = await WhatsappGroupOperation.query().findOne({
          company_id: companyId,
          idempotency_key: idempotencyHash,
        });
        if (!raced) throw error;
        if (raced.request_hash !== requestHash)
          return reply
            .code(409)
            .send({ success: false, error: 'Idempotency-Key was used for a different request' });
        return reply.code(409).send({
          success: false,
          error:
            'Group action result is unresolved; refresh group details before taking another action',
        });
      }

      const upstreamPath =
        action === 'add' ? '/group/participants' : `/group/participants/${action}`;
      try {
        const results = await gowaRequest<unknown>(upstreamPath, {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ group_id: conversation.jid, participants }),
        });
        const confirmed =
          Array.isArray(results) &&
          results.length === participants.length &&
          results.every((item) => isRecord(item) && item.status === 'success');
        if (!confirmed) {
          await WhatsappGroupOperation.query()
            .where({ id: operationId })
            .patch({ status: 'unknown' });
          await recordWhatsAppAudit(
            req,
            'whatsapp.conversation',
            `group_participants_${action}_unknown`,
            conversationId,
            companyId
          );
          return reply.code(502).send({
            success: false,
            error:
              'Group action result could not be confirmed; refresh group details before retrying',
          });
        }
        const safeResults = results.map((item) => ({
          participant: typeof item.participant === 'string' ? item.participant : null,
          status: 'success',
        }));
        await app.db.transaction(async (trx) => {
          await WhatsappGroupOperation.query(trx)
            .where({ id: operationId })
            .patch({
              status: 'completed',
              result_json: JSON.stringify(safeResults),
            });
          await trx('whatsapp_conversations')
            .where({ id: conversationId, company_id: companyId, is_group: true })
            .update({ group_metadata_synced_at: null, write_date: new Date().toISOString() });
          await recordWhatsAppAudit(
            req,
            'whatsapp.conversation',
            `group_participants_${action}`,
            conversationId,
            companyId,
            trx
          );
        });
        return reply.send({ success: true, data: { status: 'completed', results: safeResults } });
      } catch (error) {
        const definitelyRejected =
          error instanceof GowaError && error.statusCode >= 400 && error.statusCode < 500;
        await WhatsappGroupOperation.query()
          .where({ id: operationId })
          .patch({ status: definitelyRejected ? 'failed' : 'unknown' });
        await recordWhatsAppAudit(
          req,
          'whatsapp.conversation',
          `group_participants_${action}_${definitelyRejected ? 'failed' : 'unknown'}`,
          conversationId,
          companyId
        );
        req.log.warn({ error: whatsappLogErrorContext(error) }, 'WhatsApp group action failed');
        return reply.code(502).send({
          success: false,
          error: definitelyRejected
            ? 'WhatsApp rejected the group action'
            : 'Group action result is unknown; refresh group details before retrying',
        });
      }
    }
  );

  app.get<{ Params: Params }>(
    '/whatsapp/conversations/:id/contact',
    whatsappRateLimit(30),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      const conversationId = id(req.params.id);
      if (!conversationId)
        return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      if (conversation.is_group) {
        return reply.send({
          success: true,
          data: { name: conversation.name, phone_number: null, verified_name: null, status: null },
        });
      }
      const phoneMatch = String(conversation.jid).match(/^(\d{5,20})@s\.whatsapp\.net$/u);
      if (!phoneMatch) {
        return reply.send({
          success: true,
          data: { name: conversation.name, phone_number: null, verified_name: null, status: null },
        });
      }
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account?.gateway_device_id)
        return reply.code(503).send({ success: false, error: 'WhatsApp account is unavailable' });
      const [profileResult, avatarResult] = await Promise.allSettled([
        gowaRequest<Record<string, unknown>>(
          `/user/info?phone=${encodeURIComponent(conversation.jid)}`,
          { deviceId: account.gateway_device_id }
        ),
        gowaRequest<{ url?: unknown; id?: unknown }>(
          `/user/avatar?phone=${encodeURIComponent(conversation.jid)}&is_preview=true`,
          { deviceId: account.gateway_device_id }
        ),
      ]);
      const profile = profileResult.status === 'fulfilled' ? profileResult.value : {};
      const avatar = avatarResult.status === 'fulfilled' ? avatarResult.value : {};
      const profileSyncedAt =
        profileResult.status === 'fulfilled' ? new Date().toISOString() : null;
      const verifiedName =
        typeof profile.verified_name === 'string' ? profile.verified_name.slice(0, 255) : null;
      const contactStatus =
        typeof profile.status === 'string' ? profile.status.slice(0, 2000) : null;
      const pictureId = typeof avatar.id === 'string' ? avatar.id.slice(0, 255) : null;
      if (profileSyncedAt || pictureId) {
        const profileUpdate: Record<string, string> = {};
        if (verifiedName) profileUpdate.contact_verified_name = verifiedName;
        if (contactStatus) profileUpdate.contact_status = contactStatus;
        if (pictureId) profileUpdate.contact_picture_id = pictureId;
        if (profileSyncedAt) profileUpdate.contact_profile_synced_at = profileSyncedAt;
        if (Object.keys(profileUpdate).length > 0)
          await app
            .db('whatsapp_conversations')
            .where({ id: conversationId, company_id: companyId })
            .update(profileUpdate);
      }
      return reply.send({
        success: true,
        data: {
          name: conversation.name,
          phone_number: phoneMatch[1],
          verified_name: verifiedName ?? conversation.contact_verified_name ?? null,
          status: contactStatus ?? conversation.contact_status ?? null,
          picture_id: pictureId ?? conversation.contact_picture_id ?? null,
          avatar_available:
            trustedWhatsAppAvatarUrl(avatar.url) !== null ||
            Boolean(conversation.contact_avatar_key),
          synced_at: profileSyncedAt ?? conversation.contact_profile_synced_at ?? null,
        },
      });
    }
  );

  app.get<{ Params: Params }>(
    '/whatsapp/conversations/:id/contact/avatar',
    whatsappRateLimit(30),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      const conversationId = id(req.params.id);
      if (!conversationId)
        return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
      const conversation = await WhatsappConversation.query()
        .findOne({
          id: conversationId,
          company_id: companyId,
        })
        .select(
          'id',
          'company_id',
          'jid',
          'is_group',
          'contact_avatar_picture_id',
          'contact_avatar_key'
        );
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      const phoneMatch = String(conversation.jid).match(/^(\d{5,20})@s\.whatsapp\.net$/u);
      if (conversation.is_group || !phoneMatch)
        return reply.code(404).send({ success: false, error: 'Contact avatar is unavailable' });
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account?.gateway_device_id)
        return reply.code(503).send({ success: false, error: 'WhatsApp account is unavailable' });
      const [avatarCache] = await app
        .db('whatsapp_conversations')
        .where({ id: conversationId, company_id: companyId })
        .select('contact_avatar_picture_id', 'contact_avatar_key');
      const sendCachedAvatar = async () => {
        if (typeof avatarCache?.contact_avatar_key !== 'string') return null;
        const cached = await options.attachmentStorage.get(avatarCache.contact_avatar_key);
        const cachedMime = cached ? sniffMime(cached) : null;
        if (
          !cached ||
          !cachedMime ||
          !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(cachedMime)
        )
          return null;
        await recordWhatsAppAudit(
          req,
          'whatsapp.conversation',
          'contact_avatar_access',
          conversationId,
          companyId
        );
        reply
          .header('content-type', cachedMime)
          .header('content-length', String(cached.length))
          .header('content-disposition', 'inline')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox; base-uri 'none'")
          .header('cache-control', 'private, max-age=300')
          .header('vary', 'Authorization, X-Company-Id')
          .send(cached);
        return true;
      };
      try {
        const avatar = await gowaRequest<{ url?: unknown; id?: unknown }>(
          `/user/avatar?phone=${encodeURIComponent(conversation.jid)}&is_preview=true`,
          { deviceId: account.gateway_device_id }
        );
        const avatarUrl = trustedWhatsAppAvatarUrl(avatar.url);
        const pictureId = typeof avatar.id === 'string' ? avatar.id.slice(0, 255) : null;
        if (
          pictureId &&
          avatarCache?.contact_avatar_picture_id === pictureId &&
          typeof avatarCache.contact_avatar_key === 'string'
        ) {
          const cached = await sendCachedAvatar();
          if (cached) return cached;
        }
        if (typeof avatar.url === 'string' && avatar.url.length > 0 && !avatarUrl)
          return reply.code(404).send({ success: false, error: 'Contact avatar is unavailable' });
        if (!avatarUrl) {
          const cached = await sendCachedAvatar();
          if (cached) return cached;
          return reply.code(404).send({ success: false, error: 'Contact avatar is unavailable' });
        }
        const fetchAvatar = options.fetchContactAvatar ?? globalThis.fetch.bind(globalThis);
        const response = await fetchAvatar(avatarUrl, {
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return reply.code(response.status === 404 ? 404 : 502).send({
            success: false,
            error: 'Contact avatar could not be loaded',
          });
        }
        const bytes = await readBoundedAvatar(response);
        const mime = sniffMime(bytes);
        if (!mime || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime))
          return reply.code(502).send({ success: false, error: 'Contact avatar is invalid' });
        if (pictureId) {
          const newKey = randomUUID();
          await options.attachmentStorage.put(newKey, bytes);
          try {
            await app
              .db('whatsapp_conversations')
              .where({ id: conversationId, company_id: companyId })
              .update({
                contact_picture_id: pictureId,
                contact_avatar_picture_id: pictureId,
                contact_avatar_key: newKey,
              });
          } catch (error) {
            await options.attachmentStorage.delete(newKey).catch(() => undefined);
            throw error;
          }
          if (conversation.contact_avatar_key && conversation.contact_avatar_key !== newKey)
            await options.attachmentStorage
              .delete(conversation.contact_avatar_key)
              .catch((error: unknown) => {
                req.log.warn(
                  { error: whatsappLogErrorContext(error) },
                  'Stale WhatsApp contact avatar cleanup failed'
                );
              });
        }
        await recordWhatsAppAudit(
          req,
          'whatsapp.conversation',
          'contact_avatar_access',
          conversationId,
          companyId
        );
        return reply
          .header('content-type', mime)
          .header('content-length', String(bytes.length))
          .header('content-disposition', 'inline')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox; base-uri 'none'")
          .header('cache-control', 'private, max-age=300')
          .header('vary', 'Authorization, X-Company-Id')
          .send(bytes);
      } catch (error) {
        req.log.warn(
          { error: whatsappLogErrorContext(error) },
          'WhatsApp contact avatar fetch failed'
        );
        const cached = await sendCachedAvatar();
        if (cached) return cached;
        return reply
          .code(502)
          .send({ success: false, error: 'Contact avatar could not be loaded' });
      }
    }
  );

  app.get<{
    Params: Params;
    Querystring: { limit?: string; offset?: string };
  }>('/whatsapp/conversations/:id/messages', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const conversationId = id(req.params.id);
    if (!conversationId)
      return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
    const conversation = await WhatsappConversation.query().findOne({
      id: conversationId,
      company_id: companyId,
    });
    if (!conversation)
      return reply.code(404).send({ success: false, error: 'Conversation not found' });
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return reply.code(400).send({ success: false, error: 'Limit must be between 1 and 100' });
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5_000) {
      return reply.code(400).send({ success: false, error: 'Offset must be between 0 and 5000' });
    }
    const account = await WhatsappAccount.query().findOne({ company_id: companyId });
    if (!account?.gateway_device_id) return { success: true, data: [] };
    const latestCached = (await app
      .db('whatsapp_messages')
      .where({ conversation_id: conversationId, company_id: companyId })
      .max({ latest: 'create_date' })
      .first()) as { latest?: string | null } | undefined;
    const latestCachedAt = latestCached?.latest ? Date.parse(String(latestCached.latest)) : NaN;
    const incrementalStart =
      offset === 0 && Number.isFinite(latestCachedAt)
        ? `&start_time=${encodeURIComponent(new Date(latestCachedAt - 10 * 60_000).toISOString())}`
        : '';
    const providerLimit = offset === 0 ? Math.max(100, limit) : limit;
    const upstream = await gowaRequest<{ data?: Array<Record<string, unknown>> }>(
      `/chat/${encodeURIComponent(conversation.jid)}/messages?limit=${providerLimit}&offset=${offset}${incrementalStart}`,
      { deviceId: account.gateway_device_id }
    );
    for (const item of upstream.data ?? []) {
      if (typeof item.id !== 'string' || !item.id) continue;
      const tombstone = await app
        .db('whatsapp_messages')
        .select('id')
        .where({ company_id: companyId, external_id: item.id, is_deleted: true })
        .first();
      if (tombstone) continue;
      const fromMe = item.is_from_me === true;
      const typeInfo = classifyGoWaMessageType(
        item.media_type,
        item.view_once === true || item.is_view_once === true
      );
      const messageType = typeInfo.messageType;
      const timestamp = providerTimestamp(item.timestamp);
      if (!timestamp) continue;
      const content =
        typeInfo.providerType === 'view_once'
          ? 'View-once media'
          : typeof item.content === 'string'
            ? item.content.slice(0, 8000)
            : '';
      const externalId = item.id.slice(0, 255);
      const replyToExternalId = providerReplyId(item.context_metadata);
      if (fromMe) {
        await reconcileAmbiguousOutboundMessage({
          db: app.db,
          companyId,
          conversationId,
          externalId,
          content,
          messageType,
          timestamp,
        });
      }
      const reactions = Array.isArray(item.reactions)
        ? JSON.stringify(normalizedReactions(item.reactions))
        : null;
      const importedMessage = {
        company_id: companyId,
        account_id: account.id,
        conversation_id: conversationId,
        external_id: externalId,
        direction: fromMe ? 'outbound' : 'inbound',
        message_type: messageType,
        provider_type: typeInfo.providerType,
        content,
        status: fromMe ? 'sent' : 'received',
        media_mime_type:
          !typeInfo.providerType && item.mime_type !== undefined
            ? safeMime(item.mime_type)
            : typeInfo.providerType
              ? null
              : mediaDefaultMime(messageType),
        media_scan_status:
          !typeInfo.providerType && GOWA_MEDIA_TYPES.has(messageType)
            ? 'pending'
            : 'not_applicable',
        media_file_name:
          !typeInfo.providerType && typeof item.filename === 'string'
            ? item.filename.slice(0, 255)
            : !typeInfo.providerType && typeof item.file_name === 'string'
              ? item.file_name.slice(0, 255)
              : null,
        sender_display_name:
          typeof item.sender_display_name === 'string'
            ? item.sender_display_name.trim().slice(0, 255)
            : typeof item.from_name === 'string'
              ? item.from_name.trim().slice(0, 255)
              : null,
        sender_jid:
          typeof item.sender === 'string'
            ? item.sender.slice(0, 255)
            : typeof item.sender_jid === 'string'
              ? item.sender_jid.slice(0, 255)
              : null,
        reply_to_external_id: replyToExternalId,
        reactions,
        create_date: timestamp,
      };
      const importedMessagePatch = {
        content,
        provider_type: typeInfo.providerType,
        status: fromMe ? 'sent' : 'received',
        sender_display_name:
          typeof item.sender_display_name === 'string'
            ? item.sender_display_name.trim().slice(0, 255)
            : typeof item.from_name === 'string'
              ? item.from_name.trim().slice(0, 255)
              : null,
        reply_to_external_id: replyToExternalId,
        ...(Array.isArray(item.reactions) ? { reactions } : {}),
        write_date: new Date().toISOString(),
      };
      await app
        .db('whatsapp_messages')
        .insert(importedMessage)
        .onConflict(['company_id', 'external_id'])
        .merge(importedMessagePatch);
    }
    const messages = await WhatsappMessage.query()
      .select(
        'id',
        'direction',
        'content',
        'status',
        'retryable',
        'last_error',
        'message_type',
        'provider_type',
        'media_mime_type',
        'media_file_name',
        'media_scan_status',
        'sender_jid',
        'sender_display_name',
        'reply_to_message_id',
        'reply_to_external_id',
        'is_forwarded',
        'reactions',
        'is_edited',
        'is_deleted',
        'create_date'
      )
      .where({ conversation_id: conversationId, company_id: companyId })
      .orderBy('create_date', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset);
    for (const deletedMedia of await app
      .db('whatsapp_messages')
      .select('id', 'media_key', 'media_thumbnail_key')
      .where({ company_id: companyId, conversation_id: conversationId, is_deleted: true })
      .whereNotNull('media_key')) {
      try {
        if (typeof deletedMedia.media_key === 'string')
          await options.attachmentStorage.delete(deletedMedia.media_key);
        if (typeof deletedMedia.media_thumbnail_key === 'string')
          await options.attachmentStorage.delete(deletedMedia.media_thumbnail_key);
        await app
          .db('whatsapp_messages')
          .where({ id: deletedMedia.id, company_id: companyId, is_deleted: true })
          .update({
            media_key: null,
            media_thumbnail_key: null,
            write_date: new Date().toISOString(),
          });
      } catch (error) {
        req.log.warn(
          { error: whatsappLogErrorContext(error) },
          'WhatsApp deleted media cleanup retry failed'
        );
      }
    }
    const quotedInternalIds = messages
      .map((message) => Number(message.reply_to_message_id))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    const quotedExternalIds = messages
      .map((message) => message.reply_to_external_id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const quotedRows =
      quotedInternalIds.length || quotedExternalIds.length
        ? await app
            .db('whatsapp_messages')
            .select(
              'id',
              'external_id',
              'direction',
              'content',
              'message_type',
              'provider_type',
              'media_file_name'
            )
            .where({ company_id: companyId, conversation_id: conversationId })
            .andWhere((query) => {
              if (quotedInternalIds.length) query.whereIn('id', quotedInternalIds);
              if (quotedExternalIds.length) {
                if (quotedInternalIds.length) query.orWhereIn('external_id', quotedExternalIds);
                else query.whereIn('external_id', quotedExternalIds);
              }
            })
        : [];
    const quoteById = new Map(quotedRows.map((row) => [String(row.id), row]));
    const quoteByExternalId = new Map(quotedRows.map((row) => [String(row.external_id), row]));
    const readCursor = (await app
      .db('whatsapp_conversation_reads')
      .select('last_read_message_id', 'last_read_at')
      .where({ company_id: companyId, conversation_id: conversationId, user_id: req.auth!.userId })
      .first()) as
      { last_read_message_id?: number | string; last_read_at?: string | Date } | undefined;
    const lastReadMessageId = Number(readCursor?.last_read_message_id);
    const lastReadAt = Date.parse(String(readCursor?.last_read_at ?? ''));
    const latestProviderMessage = (upstream.data ?? []).reduce<Record<string, unknown> | null>(
      (latest, item) => {
        const timestamp = providerTimestamp(item.timestamp);
        const latestTimestamp = providerTimestamp(latest?.timestamp);
        return timestamp &&
          (!latestTimestamp || Date.parse(timestamp) > Date.parse(latestTimestamp))
          ? item
          : latest;
      },
      null
    );
    const latestTime = providerTimestamp(latestProviderMessage?.timestamp);
    const shouldUpdateLatest =
      latestTime !== null &&
      (!conversation.last_message_at ||
        !Number.isFinite(Date.parse(conversation.last_message_at)) ||
        Date.parse(latestTime) > Date.parse(conversation.last_message_at));
    const latestProviderId =
      typeof latestProviderMessage?.id === 'string' ? latestProviderMessage.id : null;
    const latestIsTombstoned = latestProviderId
      ? Boolean(
          await app
            .db('whatsapp_messages')
            .select('id')
            .where({ company_id: companyId, external_id: latestProviderId, is_deleted: true })
            .first()
        )
      : false;
    const latestTypeInfo = classifyGoWaMessageType(
      latestProviderMessage?.media_type,
      latestProviderMessage?.view_once === true || latestProviderMessage?.is_view_once === true
    );
    const latestContent = latestIsTombstoned
      ? 'This message was deleted'
      : latestProviderMessage
        ? latestTypeInfo.providerType === 'view_once'
          ? '[View-once media]'
          : typeof latestProviderMessage.content === 'string' && latestProviderMessage.content
            ? latestProviderMessage.content.slice(0, 2000)
            : `[${latestTypeInfo.providerType ?? String(latestProviderMessage.media_type ?? 'message')}]`
        : null;
    if (offset === 0) {
      await WhatsappConversation.query()
        .where({ id: conversationId, company_id: companyId })
        .patch({
          ...(shouldUpdateLatest && latestContent !== null ? { last_message: latestContent } : {}),
          ...(shouldUpdateLatest && latestTime !== null ? { last_message_at: latestTime } : {}),
          write_date: new Date().toISOString(),
        });
    }
    return {
      success: true,
      data: messages.map((message) => {
        const quoted =
          (message.reply_to_message_id != null
            ? quoteById.get(String(message.reply_to_message_id))
            : undefined) ??
          (message.reply_to_external_id
            ? quoteByExternalId.get(String(message.reply_to_external_id))
            : undefined);
        const messageAt = Date.parse(String(message.create_date));
        const afterReadCursor =
          !Number.isFinite(lastReadAt) ||
          messageAt > lastReadAt ||
          (messageAt === lastReadAt && Number(message.id) > lastReadMessageId);
        const {
          reply_to_external_id: _replyToExternalId,
          reactions: storedReactions,
          ...publicMessage
        } = message;
        return {
          ...publicMessage,
          reactions: normalizedReactions(storedReactions),
          is_last_read: Number.isFinite(lastReadAt) && Number(message.id) === lastReadMessageId,
          is_unread: message.direction === 'inbound' && afterReadCursor,
          reply_to: quoted
            ? {
                id: quoted.id,
                direction: quoted.direction,
                content: quoted.content,
                message_type: quoted.message_type,
                provider_type: quoted.provider_type,
                media_file_name: quoted.media_file_name,
              }
            : message.reply_to_message_id || message.reply_to_external_id
              ? { unavailable: true }
              : null,
        };
      }),
    };
  });

  app.post<{ Params: Params }>(
    '/whatsapp/messages/:id/reaction',
    whatsappRateLimit(20),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'create')) return;
      const messageId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      if (
        !messageId ||
        !body ||
        Object.keys(body).some((key) => key !== 'emoji') ||
        typeof body.emoji !== 'string' ||
        !WHATSAPP_REACTION_EMOJIS.includes(body.emoji as (typeof WHATSAPP_REACTION_EMOJIS)[number])
      ) {
        return reply.code(400).send({ success: false, error: 'Choose a supported reaction emoji' });
      }
      const message = await WhatsappMessage.query().findOne({
        id: messageId,
        company_id: companyId,
      });
      if (!message) return reply.code(404).send({ success: false, error: 'Message not found' });
      if (
        !message.external_id ||
        message.provider_type ||
        message.external_id.startsWith('pending:') ||
        message.external_id.startsWith('gowa-') ||
        !['received', 'sent', 'delivered', 'read'].includes(message.status)
      ) {
        return reply
          .code(409)
          .send({ success: false, error: 'Message is not available for reactions' });
      }
      const [conversation, account] = await Promise.all([
        WhatsappConversation.query().findOne({
          id: message.conversation_id,
          company_id: companyId,
        }),
        WhatsappAccount.query().findOne({ company_id: companyId }),
      ]);
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      if (!account?.gateway_device_id || account.status !== 'connected')
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      try {
        await gowaRequest(`/message/${encodeURIComponent(message.external_id)}/reaction`, {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ phone: conversation.jid, emoji: body.emoji }),
        });
      } catch (error) {
        req.log.error(
          { error: whatsappLogErrorContext(error) },
          'WhatsApp reaction request failed'
        );
        return reply.code(502).send({ success: false, error: 'Could not send reaction' });
      }
      const reactions = normalizedReactions(message.reactions);
      const ownReaction: WhatsAppReaction = {
        emoji: body.emoji,
        sender_jid: account.phone_number
          ? `${account.phone_number.replace(/\D/gu, '')}@s.whatsapp.net`
          : null,
        is_from_me: true,
        timestamp: new Date().toISOString(),
      };
      const ownReactionIndex = reactions.findIndex((reaction) => reaction.is_from_me);
      if (ownReactionIndex >= 0) reactions[ownReactionIndex] = ownReaction;
      else reactions.push(ownReaction);
      await WhatsappMessage.query()
        .where({ id: messageId, company_id: companyId })
        .patch({
          reactions: JSON.stringify(reactions),
          write_date: new Date().toISOString(),
        });
      await recordWhatsAppAudit(req, 'whatsapp.message', 'react', messageId, companyId);
      return reply.send({ success: true, data: { reactions } });
    }
  );

  app.post<{ Params: Params }>(
    '/whatsapp/messages/:id/edit',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'write')) return;
      const messageId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      const content = typeof body?.content === 'string' ? body.content.trim() : '';
      if (
        !messageId ||
        !body ||
        Object.keys(body).some((key) => key !== 'content') ||
        !content ||
        content.length > 8000
      )
        return reply.code(400).send({
          success: false,
          error: 'Message text is required and must be at most 8000 characters',
        });
      const message = await WhatsappMessage.query().findOne({
        id: messageId,
        company_id: companyId,
      });
      if (!message) return reply.code(404).send({ success: false, error: 'Message not found' });
      const messageAge = Date.now() - Date.parse(String(message.create_date));
      if (
        message.direction !== 'outbound' ||
        message.message_type !== 'text' ||
        message.provider_type ||
        message.is_deleted ||
        !message.external_id ||
        /^(pending:|gowa-)/u.test(message.external_id) ||
        !['sent', 'delivered', 'read'].includes(message.status) ||
        !Number.isFinite(messageAge) ||
        messageAge < 0 ||
        messageAge > 15 * 60_000
      )
        return reply
          .code(409)
          .send({ success: false, error: 'Only your recent sent text messages can be edited' });
      const [conversation, account] = await Promise.all([
        WhatsappConversation.query().findOne({
          id: message.conversation_id,
          company_id: companyId,
        }),
        WhatsappAccount.query().findOne({ company_id: companyId }),
      ]);
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      if (!account?.gateway_device_id || account.status !== 'connected')
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      try {
        await gowaRequest(`/message/${encodeURIComponent(message.external_id)}/update`, {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ phone: conversation.jid, message: content }),
        });
      } catch (error) {
        req.log.error({ error: whatsappLogErrorContext(error) }, 'WhatsApp message edit failed');
        return reply.code(502).send({ success: false, error: 'Could not edit message' });
      }
      await WhatsappMessage.query().where({ id: messageId, company_id: companyId }).patch({
        content,
        is_edited: true,
        write_date: new Date().toISOString(),
      });
      await app
        .db('whatsapp_conversations')
        .where({ id: conversation.id, company_id: companyId, last_message: message.content })
        .update({ last_message: content, write_date: new Date().toISOString() });
      await recordWhatsAppAudit(req, 'whatsapp.message', 'edit', messageId, companyId);
      return reply.send({ success: true, data: { id: messageId, content, is_edited: true } });
    }
  );

  app.post<{ Params: Params }>(
    '/whatsapp/messages/:id/revoke',
    whatsappRateLimit(5),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'write')) return;
      const messageId = id(req.params.id);
      if (!messageId) return reply.code(400).send({ success: false, error: 'Invalid message ID' });
      const message = await WhatsappMessage.query().findOne({
        id: messageId,
        company_id: companyId,
      });
      if (!message) return reply.code(404).send({ success: false, error: 'Message not found' });
      if (
        message.direction !== 'outbound' ||
        message.provider_type ||
        message.is_deleted ||
        !message.external_id ||
        /^(pending:|gowa-)/u.test(message.external_id) ||
        !['sent', 'delivered', 'read'].includes(message.status)
      )
        return reply
          .code(409)
          .send({ success: false, error: 'Only your sent messages can be deleted for everyone' });
      const [conversation, account] = await Promise.all([
        WhatsappConversation.query().findOne({
          id: message.conversation_id,
          company_id: companyId,
        }),
        WhatsappAccount.query().findOne({ company_id: companyId }),
      ]);
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      if (!account?.gateway_device_id || account.status !== 'connected')
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      try {
        await gowaRequest(`/message/${encodeURIComponent(message.external_id)}/revoke`, {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ phone: conversation.jid }),
        });
      } catch (error) {
        req.log.error({ error: whatsappLogErrorContext(error) }, 'WhatsApp message revoke failed');
        return reply
          .code(502)
          .send({ success: false, error: 'Could not delete message for everyone' });
      }
      await WhatsappMessage.query().where({ id: messageId, company_id: companyId }).patch({
        is_deleted: true,
        content: 'This message was deleted',
        media_mime_type: null,
        media_file_name: null,
        reactions: '[]',
        write_date: new Date().toISOString(),
      });
      if (message.media_key)
        await Promise.all(
          [message.media_key, message.media_thumbnail_key]
            .filter((key): key is string => Boolean(key))
            .map((key) => options.attachmentStorage.delete(key))
        )
          .then(async () => {
            await WhatsappMessage.query()
              .where({ id: messageId, company_id: companyId, is_deleted: true })
              .patch({
                media_key: null,
                media_thumbnail_key: null,
                write_date: new Date().toISOString(),
              });
          })
          .catch((error: unknown) => {
            req.log.warn(
              { error: whatsappLogErrorContext(error) },
              'WhatsApp revoked media cleanup failed'
            );
          });
      await app
        .db('whatsapp_conversations')
        .where({ id: conversation.id, company_id: companyId })
        .whereIn('last_message', [
          ...new Set(
            [message.content, message.media_file_name, `[${message.message_type}]`].filter(
              (value): value is string => Boolean(value)
            )
          ),
        ])
        .update({ last_message: 'This message was deleted', write_date: new Date().toISOString() });
      await recordWhatsAppAudit(req, 'whatsapp.message', 'revoke', messageId, companyId);
      return reply.send({ success: true, data: { id: messageId, is_deleted: true } });
    }
  );

  app.post<{ Params: Params }>(
    '/whatsapp/conversations/:id/read',
    whatsappRateLimit(30),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'create')) return;
      const conversationId = id(req.params.id);
      if (!conversationId)
        return reply.code(400).send({ success: false, error: 'Invalid conversation ID' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!account?.gateway_device_id)
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      const latestInbound = await WhatsappMessage.query()
        .findOne({ conversation_id: conversationId, company_id: companyId, direction: 'inbound' })
        .orderBy('create_date', 'desc')
        .orderBy('id', 'desc');
      if (!latestInbound) {
        return { success: true, data: { marked: false } };
      }
      const latestInboundAt = new Date(String(latestInbound.create_date)).toISOString();
      try {
        await gowaRequest(`/message/${encodeURIComponent(latestInbound.external_id)}/read`, {
          method: 'POST',
          deviceId: account.gateway_device_id,
          contentType: 'application/json',
          body: JSON.stringify({ phone: conversation.jid }),
        });
      } catch (error) {
        req.log.error(
          { error: whatsappLogErrorContext(error) },
          'WhatsApp mark-read request failed'
        );
        return reply
          .code(502)
          .send({ success: false, error: 'Could not mark conversation as read' });
      }
      await app.db.transaction(async (trx) => {
        await trx('whatsapp_conversation_reads')
          .insert({
            company_id: companyId,
            conversation_id: conversationId,
            user_id: req.auth!.userId,
            last_read_message_id: latestInbound.id,
            last_read_at: latestInboundAt,
          })
          .onConflict(['company_id', 'conversation_id', 'user_id'])
          .merge({
            last_read_message_id: trx.raw(
              'CASE WHEN excluded.last_read_at > whatsapp_conversation_reads.last_read_at OR (excluded.last_read_at = whatsapp_conversation_reads.last_read_at AND excluded.last_read_message_id > whatsapp_conversation_reads.last_read_message_id) THEN excluded.last_read_message_id ELSE whatsapp_conversation_reads.last_read_message_id END'
            ),
            last_read_at: trx.raw(
              'CASE WHEN excluded.last_read_at > whatsapp_conversation_reads.last_read_at OR (excluded.last_read_at = whatsapp_conversation_reads.last_read_at AND excluded.last_read_message_id > whatsapp_conversation_reads.last_read_message_id) THEN excluded.last_read_at ELSE whatsapp_conversation_reads.last_read_at END'
            ),
            write_date: new Date().toISOString(),
          });
        await recordWhatsAppAudit(
          req,
          'whatsapp.message',
          'mark_read',
          latestInbound.id,
          companyId,
          trx
        );
      });
      return { success: true, data: { marked: true, message_id: latestInbound.id } };
    }
  );

  app.post<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations/:id/uploads',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'create')) return;
      if (!supportsDirectUploads(options.attachmentStorage))
        return reply.code(409).send({ success: false, error: 'Direct uploads require S3 storage' });
      const conversationId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      if (
        !conversationId ||
        !body ||
        Object.keys(body).some(
          (key) => !['file_name', 'content_type', 'size_bytes'].includes(key)
        ) ||
        typeof body.file_name !== 'string' ||
        !safeFileName(body.file_name) ||
        typeof body.content_type !== 'string' ||
        body.content_type.length > 128 ||
        !Number.isSafeInteger(body.size_bytes) ||
        Number(body.size_bytes) < 1 ||
        Number(body.size_bytes) > MAX_ATTACHMENT_BYTES
      )
        return reply.code(400).send({ success: false, error: 'Invalid upload request' });
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation)
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      const storageKey = randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const contentType = safeMime(body.content_type);
      try {
        const upload = await options.attachmentStorage.createPresignedUpload(
          storageKey,
          contentType,
          Number(body.size_bytes),
          300
        );
        const ticket = await WhatsappUploadTicket.query().insertAndFetch({
          company_id: companyId,
          conversation_id: conversationId,
          user_id: req.auth!.userId,
          storage_key: storageKey,
          file_name: safeFileName(body.file_name)!,
          content_type: contentType,
          size_bytes: Number(body.size_bytes),
          expires_at: expiresAt,
          consumed_message_id: null,
        } as never);
        return reply.code(201).send({
          success: true,
          data: {
            upload_id: ticket.id,
            url: upload.url,
            method: upload.method,
            fields: upload.fields,
            expires_at: expiresAt,
            size_bytes: Number(body.size_bytes),
          },
        });
      } catch (error) {
        req.log.error({ error: whatsappLogErrorContext(error) }, 'WhatsApp upload ticket failed');
        return reply.code(503).send({ success: false, error: 'Could not prepare media upload' });
      }
    }
  );

  app.post<{ Params: Params; Body: unknown }>(
    '/whatsapp/conversations/:id/messages',
    { bodyLimit: MAX_ATTACHMENT_BYTES + 64 * 1024, ...whatsappRateLimit(20) },
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'create')) return;
      const conversationId = id(req.params.id);
      let upload: OutgoingUpload;
      try {
        if (!attachmentScanner) throw new MalwareScannerUnavailableError();
        upload = await parseOutgoingUpload(req, options.attachmentStorage, attachmentScanner);
      } catch (error) {
        if (error instanceof MediaScanInfectedError)
          return reply
            .code(422)
            .send({ success: false, error: 'Attachment blocked by malware scan' });
        if (error instanceof MalwareScannerUnavailableError)
          return reply.code(503).send({
            success: false,
            error: 'Attachment malware scanning is temporarily unavailable',
          });
        const status =
          isRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : 400;
        return reply.code(status).send({
          success: false,
          error:
            status >= 500
              ? 'Media storage is unavailable. Try again.'
              : error instanceof Error
                ? error.message
                : 'Invalid media upload',
        });
      }
      let directUploadTicketId: number | null = null;
      let directUploadSourceKey: string | null = null;
      let directUploadBytes: Buffer | null = null;
      const uploadTicketId = upload.fields.upload_ticket_id
        ? Number(upload.fields.upload_ticket_id)
        : null;
      if (uploadTicketId !== null) {
        const ticket = await WhatsappUploadTicket.query().findOne({
          id: uploadTicketId,
          company_id: companyId,
          conversation_id: conversationId,
          user_id: req.auth!.userId,
        });
        if (!ticket)
          return reply.code(404).send({ success: false, error: 'Upload ticket not found' });
        const expired = new Date(String(ticket.expires_at)).getTime() <= Date.now();
        if (expired && !ticket.consumed_message_id) {
          await options.attachmentStorage.delete(ticket.storage_key).catch(() => undefined);
          await WhatsappUploadTicket.query().deleteById(ticket.id);
          return reply.code(410).send({ success: false, error: 'Upload ticket expired' });
        }
        if (!supportsDirectUploads(options.attachmentStorage))
          return reply
            .code(409)
            .send({ success: false, error: 'Direct uploads require S3 storage' });
        try {
          const metadata = await options.attachmentStorage.head(ticket.storage_key);
          if (
            !metadata ||
            metadata.sizeBytes !== ticket.size_bytes ||
            metadata.sizeBytes < 1 ||
            metadata.sizeBytes > MAX_ATTACHMENT_BYTES ||
            metadata.contentType !== ticket.content_type
          ) {
            await options.attachmentStorage.delete(ticket.storage_key).catch(() => undefined);
            await WhatsappUploadTicket.query().deleteById(ticket.id);
            return reply
              .code(422)
              .send({ success: false, error: 'Uploaded media did not match its ticket' });
          }
          const bytes = await readStoredAttachmentBounded(
            options.attachmentStorage,
            ticket.storage_key,
            MAX_ATTACHMENT_BYTES
          );
          if (!bytes || bytes.byteLength !== ticket.size_bytes) {
            await options.attachmentStorage.delete(ticket.storage_key).catch(() => undefined);
            await WhatsappUploadTicket.query().deleteById(ticket.id);
            return reply.code(422).send({ success: false, error: 'Uploaded media is incomplete' });
          }
          const detectedMime = sniffMime(bytes.subarray(0, 64 * 1024));
          if (!mimeMatchesSignature(ticket.content_type, detectedMime)) {
            await options.attachmentStorage.delete(ticket.storage_key).catch(() => undefined);
            await WhatsappUploadTicket.query().deleteById(ticket.id);
            return reply
              .code(422)
              .send({ success: false, error: 'Media type does not match its contents' });
          }
          const scanResult = await attachmentScanner!.scan(Readable.from([bytes]));
          if (scanResult.status === 'infected') {
            await options.attachmentStorage.delete(ticket.storage_key).catch(() => undefined);
            await WhatsappUploadTicket.query().deleteById(ticket.id);
            return reply
              .code(422)
              .send({ success: false, error: 'Attachment blocked by malware scan' });
          }
          upload = {
            fields: Object.fromEntries(
              Object.entries(upload.fields).filter(([field]) => field !== 'upload_ticket_id')
            ),
            mediaKey: ticket.storage_key,
            mediaMime:
              ticket.content_type === 'application/octet-stream' && detectedMime
                ? detectedMime
                : ticket.content_type,
            mediaFileName: ticket.file_name,
            mediaDigest: createHash('sha256').update(bytes).digest('hex'),
            mediaSizeBytes: ticket.size_bytes,
          };
          directUploadTicketId = ticket.id;
          directUploadSourceKey = ticket.storage_key;
          directUploadBytes = bytes;
        } catch (error) {
          if (error instanceof MediaTooLargeError) {
            await options.attachmentStorage.delete(ticket.storage_key).catch(() => undefined);
            await WhatsappUploadTicket.query().deleteById(ticket.id);
            return reply
              .code(413)
              .send({ success: false, error: 'Media exceeds the 10 MiB limit' });
          }
          if (error instanceof MalwareScannerUnavailableError)
            return reply.code(503).send({
              success: false,
              error: 'Attachment malware scanning is temporarily unavailable',
            });
          req.log.error(
            { error: whatsappLogErrorContext(error) },
            'WhatsApp direct upload check failed'
          );
          return reply.code(503).send({ success: false, error: 'Could not verify uploaded media' });
        }
      }
      const body = {
        ...upload.fields,
        content: upload.fields.content ?? '',
        ...(upload.fields.reply_to_message_id
          ? { reply_to_message_id: Number(upload.fields.reply_to_message_id) }
          : {}),
      };
      if (
        !conversationId ||
        typeof body.content !== 'string' ||
        body.content.length > 8000 ||
        (body.reply_to_message_id !== undefined &&
          (!Number.isSafeInteger(Number(body.reply_to_message_id)) ||
            Number(body.reply_to_message_id) < 1))
      ) {
        if (upload.mediaKey && !directUploadTicketId)
          await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
        return reply.code(400).send({ success: false, error: 'Invalid message payload' });
      }
      const idempotencyKey = req.headers['idempotency-key'];
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey)
      ) {
        if (upload.mediaKey && !directUploadTicketId)
          await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
        return reply
          .code(400)
          .send({ success: false, error: 'A valid Idempotency-Key is required' });
      }
      const conversation = await WhatsappConversation.query().findOne({
        id: conversationId,
        company_id: companyId,
      });
      if (!conversation) {
        if (upload.mediaKey && !directUploadTicketId)
          await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
        return reply.code(404).send({ success: false, error: 'Conversation not found' });
      }
      let quotedMessage: { id: number; external_id: string } | undefined;
      if (body.reply_to_message_id !== undefined) {
        quotedMessage = await WhatsappMessage.query().findOne({
          id: Number(body.reply_to_message_id),
          company_id: companyId,
          conversation_id: conversationId,
        });
        if (!quotedMessage) {
          if (upload.mediaKey && !directUploadTicketId)
            await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
          return reply.code(404).send({ success: false, error: 'Quoted message not found' });
        }
        if (!quotedMessage.external_id || quotedMessage.external_id.startsWith('pending:')) {
          if (upload.mediaKey && !directUploadTicketId)
            await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
          return reply.code(409).send({
            success: false,
            error: 'Quoted message is not available on WhatsApp yet',
          });
        }
      }
      const account = await WhatsappAccount.query().findOne({ company_id: companyId });
      if (!body.content.trim() && !upload.mediaKey) {
        return reply
          .code(400)
          .send({ success: false, error: 'Message must contain text or media' });
      }
      const mediaMime = upload.mediaMime;
      const fileName = upload.mediaFileName;
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            conversation_id: conversationId,
            content: body.content,
            reply_to_message_id: quotedMessage?.id ?? null,
            reply_to_external_id: quotedMessage?.external_id ?? null,
            media_mime_type: mediaMime,
            media_file_name: fileName,
          })
        )
        .update(upload.mediaDigest)
        .digest('hex');
      const existing = await WhatsappMessage.query().findOne({
        company_id: companyId,
        idempotency_key: idempotencyKey,
      });
      if (existing) {
        if (upload.mediaKey && !directUploadTicketId)
          await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
        if (directUploadTicketId && existing.media_key !== upload.mediaKey) {
          await options.attachmentStorage.delete(upload.mediaKey!).catch(() => undefined);
          await WhatsappUploadTicket.query().deleteById(directUploadTicketId);
        }
        if (existing.request_hash !== requestHash)
          return reply
            .code(409)
            .send({ success: false, error: 'Idempotency key was used for another message' });
        return reply.code(202).send({ success: true, data: existing });
      }
      if (!account || !account.gateway_device_id || account.status !== 'connected') {
        if (upload.mediaKey && !directUploadTicketId)
          await options.attachmentStorage.delete(upload.mediaKey).catch(() => undefined);
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      }
      let mediaKey = upload.mediaKey;
      try {
        if (directUploadTicketId && directUploadSourceKey && mediaKey) {
          const finalMediaKey = randomUUID();
          if (!directUploadBytes)
            throw new MediaStorageError('Uploaded media is no longer available');
          await options.attachmentStorage.put(finalMediaKey, directUploadBytes);
          mediaKey = finalMediaKey;
        }
        const message = await app.db.transaction(async (trx) => {
          const inserted = await WhatsappMessage.query(trx).insertAndFetch({
            company_id: companyId,
            account_id: account.id,
            conversation_id: conversationId,
            external_id: `pending:${idempotencyKey}`.slice(0, 255),
            idempotency_key: idempotencyKey,
            request_hash: requestHash,
            direction: 'outbound',
            message_type: mediaKey ? mediaType(mediaMime) : 'text',
            content: body.content,
            status: 'queued',
            attempt_count: 0,
            retryable: false,
            media_key: mediaKey,
            media_thumbnail_key: null,
            media_mime_type: mediaKey ? mediaMime : null,
            media_size_bytes: upload.mediaSizeBytes,
            media_file_name: fileName,
            media_scan_status: mediaKey ? 'clean' : 'not_applicable',
            reply_to_message_id: quotedMessage?.id ?? null,
            reply_to_external_id: quotedMessage?.external_id ?? null,
          } as never);
          await OutboxEvent.query(trx).insert({
            event_type: WHATSAPP_SEND_EVENT,
            aggregate_model: 'whatsapp.message',
            aggregate_id: inserted.id,
            company_id: companyId,
            payload: JSON.stringify({ message_id: inserted.id }),
            status: 'pending',
            attempts: 0,
            max_attempts: 4,
            available_at: new Date().toISOString(),
          });
          await WhatsappConversation.query(trx)
            .where({ id: conversationId, company_id: companyId })
            .patch({
              last_message: (body.content as string) || (fileName ?? '[media]'),
              last_message_at: new Date().toISOString(),
            });
          await recordWhatsAppAudit(
            req,
            'whatsapp.message',
            'send_queued',
            inserted.id,
            companyId,
            trx
          );
          if (directUploadTicketId) {
            const consumed = await trx('whatsapp_upload_tickets')
              .where({
                id: directUploadTicketId,
                company_id: companyId,
                conversation_id: conversationId,
                user_id: req.auth!.userId,
              })
              .whereNull('consumed_message_id')
              .update({ consumed_message_id: inserted.id, write_date: new Date().toISOString() });
            if (consumed !== 1) throw new UploadTicketConsumedError();
          }
          return inserted;
        });
        if (upload.mediaSizeBytes !== null)
          recordWhatsAppMediaTransfer('outbound', upload.mediaSizeBytes);
        return reply.code(202).send({ success: true, data: message });
      } catch (error) {
        req.log.error({ error: whatsappLogErrorContext(error) }, 'WhatsApp message queue failed');
        const raced = await WhatsappMessage.query().findOne({
          company_id: companyId,
          idempotency_key: idempotencyKey,
        });
        if (mediaKey && (directUploadTicketId ? mediaKey !== upload.mediaKey : true))
          await options.attachmentStorage.delete(mediaKey).catch(() => {});
        if (raced) {
          if (raced.request_hash === requestHash)
            return reply.code(202).send({ success: true, data: raced });
          return reply
            .code(409)
            .send({ success: false, error: 'Idempotency key was used for another message' });
        }
        if (error instanceof UploadTicketConsumedError)
          return reply.code(409).send({ success: false, error: 'Upload ticket was already used' });
        return reply.code(mediaKey ? 503 : 500).send({
          success: false,
          error: mediaKey
            ? 'Media storage or queue is unavailable. Try again.'
            : 'Message could not be queued. Try again.',
        });
      }
    }
  );

  app.post<{ Params: Params }>(
    '/whatsapp/messages/:id/forward',
    whatsappRateLimit(20),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'create')) return;
      const sourceId = id(req.params.id);
      const body = isRecord(req.body) ? req.body : null;
      if (
        !sourceId ||
        !body ||
        Object.keys(body).some((key) => key !== 'conversation_id') ||
        !Number.isSafeInteger(body.conversation_id) ||
        Number(body.conversation_id) < 1
      )
        return reply.code(400).send({ success: false, error: 'Invalid forward request' });
      const idempotencyKey = req.headers['idempotency-key'];
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey)
      )
        return reply
          .code(400)
          .send({ success: false, error: 'A valid Idempotency-Key is required' });
      const [source, destination, account] = await Promise.all([
        WhatsappMessage.query().findOne({ id: sourceId, company_id: companyId }),
        WhatsappConversation.query().findOne({
          id: Number(body.conversation_id),
          company_id: companyId,
        }),
        WhatsappAccount.query().findOne({ company_id: companyId }),
      ]);
      if (!source)
        return reply.code(404).send({ success: false, error: 'Source message not found' });
      if (source.provider_type)
        return reply
          .code(409)
          .send({ success: false, error: 'This message type cannot be forwarded yet' });
      if (!destination)
        return reply
          .code(404)
          .send({ success: false, error: 'Destination conversation not found' });
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            source_message_id: source.id,
            destination_conversation_id: destination.id,
          })
        )
        .digest('hex');
      const existing = await WhatsappMessage.query().findOne({
        company_id: companyId,
        idempotency_key: idempotencyKey,
      });
      if (existing) {
        if (existing.request_hash !== requestHash)
          return reply
            .code(409)
            .send({ success: false, error: 'Idempotency key was used for another message' });
        return reply.code(202).send({ success: true, data: existing });
      }
      if (
        !source.external_id ||
        source.external_id.startsWith('pending:') ||
        source.external_id.startsWith('gowa-')
      )
        return reply
          .code(409)
          .send({ success: false, error: 'Source message is not available to forward' });
      if (!['received', 'sent', 'delivered', 'read'].includes(source.status))
        return reply
          .code(409)
          .send({ success: false, error: 'Source message is not available to forward' });
      if (!account?.gateway_device_id || account.status !== 'connected')
        return reply.code(409).send({ success: false, error: 'WhatsApp account is not connected' });
      try {
        const forwarded = await app.db.transaction(async (trx) => {
          const inserted = await WhatsappMessage.query(trx).insertAndFetch({
            company_id: companyId,
            account_id: account.id,
            conversation_id: destination.id,
            external_id: `pending:${idempotencyKey}`.slice(0, 255),
            idempotency_key: idempotencyKey,
            request_hash: requestHash,
            direction: 'outbound',
            message_type: source.message_type,
            content: source.content,
            status: 'queued',
            attempt_count: 0,
            retryable: false,
            media_mime_type: source.media_mime_type,
            media_file_name: source.media_file_name,
            is_forwarded: true,
            forward_from_external_id: source.external_id,
          } as never);
          await OutboxEvent.query(trx).insert({
            event_type: WHATSAPP_SEND_EVENT,
            aggregate_model: 'whatsapp.message',
            aggregate_id: inserted.id,
            company_id: companyId,
            payload: JSON.stringify({ message_id: inserted.id }),
            status: 'pending',
            attempts: 0,
            max_attempts: 4,
            available_at: new Date().toISOString(),
          });
          await WhatsappConversation.query(trx)
            .where({ id: destination.id, company_id: companyId })
            .patch({
              last_message: source.content || source.media_file_name || `[${source.message_type}]`,
              last_message_at: new Date().toISOString(),
            });
          await recordWhatsAppAudit(
            req,
            'whatsapp.message',
            'forward_queued',
            inserted.id,
            companyId,
            trx
          );
          return inserted;
        });
        return reply.code(202).send({ success: true, data: forwarded });
      } catch (error) {
        req.log.error({ error: whatsappLogErrorContext(error) }, 'WhatsApp forward queue failed');
        const raced = await WhatsappMessage.query().findOne({
          company_id: companyId,
          idempotency_key: idempotencyKey,
        });
        if (raced?.request_hash === requestHash)
          return reply.code(202).send({ success: true, data: raced });
        if (raced)
          return reply
            .code(409)
            .send({ success: false, error: 'Idempotency key was used for another message' });
        return reply
          .code(503)
          .send({ success: false, error: 'Message could not be queued. Try again.' });
      }
    }
  );

  app.post<{ Params: Params }>(
    '/whatsapp/messages/:id/retry',
    whatsappRateLimit(10),
    async (req, reply) => {
      const companyId = requireCompany(req, reply);
      if (!companyId) return;
      if (!requireWhatsAppAction(req, reply, 'whatsapp.message', 'create')) return;
      const messageId = id(req.params.id);
      if (!messageId) return reply.code(400).send({ success: false, error: 'Invalid message ID' });
      const current = await WhatsappMessage.query().findOne({
        id: messageId,
        company_id: companyId,
        direction: 'outbound',
      });
      if (!current) return reply.code(404).send({ success: false, error: 'Message not found' });
      if (current.status === 'queued' || current.status === 'sending')
        return reply.code(202).send({ success: true, data: current });
      if (current.status !== 'failed' || !current.retryable)
        return reply.code(409).send({
          success: false,
          error:
            current.status === 'unknown'
              ? 'Delivery is uncertain. Verify the WhatsApp chat before trying again.'
              : 'This message cannot be retried.',
        });
      const message = await app.db.transaction(async (trx) => {
        const updated = await WhatsappMessage.query(trx)
          .where({ id: messageId, company_id: companyId, status: 'failed', retryable: true })
          .patch({ status: 'queued', retryable: false, last_error: null });
        if (updated !== 1) return null;
        await OutboxEvent.query(trx).insert({
          event_type: WHATSAPP_SEND_EVENT,
          aggregate_model: 'whatsapp.message',
          aggregate_id: messageId,
          company_id: companyId,
          payload: JSON.stringify({ message_id: messageId }),
          status: 'pending',
          attempts: 0,
          max_attempts: 4,
          available_at: new Date().toISOString(),
        });
        await recordWhatsAppAudit(
          req,
          'whatsapp.message',
          'retry_queued',
          messageId,
          companyId,
          trx
        );
        return WhatsappMessage.query(trx).findOne({ id: messageId, company_id: companyId });
      });
      if (!message) {
        const latest = await WhatsappMessage.query().findOne({
          id: messageId,
          company_id: companyId,
        });
        if (latest?.status === 'queued' || latest?.status === 'sending')
          return reply.code(202).send({ success: true, data: latest });
        return reply.code(409).send({ success: false, error: 'Message is no longer retryable' });
      }
      return reply.code(202).send({ success: true, data: message });
    }
  );

  app.get<{ Params: Params }>('/whatsapp/media/:id/thumbnail', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const messageId = id(req.params.id);
    if (!messageId) return reply.code(400).send({ success: false, error: 'Invalid message ID' });
    let message = await WhatsappMessage.query().findOne({ id: messageId, company_id: companyId });
    if (
      !message ||
      message.provider_type ||
      message.is_deleted ||
      !['image', 'video'].includes(message.message_type)
    )
      return reply.code(404).send({ success: false, error: 'Media preview not found' });
    if (message.media_scan_status === 'infected')
      return reply.code(410).send({ success: false, error: 'Attachment blocked by malware scan' });

    if (message.media_thumbnail_key) {
      try {
        const cached = await options.attachmentStorage.get(message.media_thumbnail_key);
        if (cached?.length) {
          const cachedReply = reply
            .header('Cache-Control', 'private, max-age=3600')
            .header('Vary', 'Authorization, X-Company-Id')
            .header('X-Original-Content-Type', safeMime(message.media_mime_type))
            .header('X-Content-Type-Options', 'nosniff')
            .header('Content-Security-Policy', "default-src 'none'; sandbox; base-uri 'none'");
          if (message.media_size_bytes !== null && message.media_size_bytes !== undefined)
            cachedReply.header('X-Original-Content-Length', String(message.media_size_bytes));
          return cachedReply
            .type(message.message_type === 'image' ? 'image/webp' : 'image/jpeg')
            .send(cached);
        }
        await WhatsappMessage.query()
          .where({ id: message.id, company_id: companyId })
          .patch({ media_thumbnail_key: null });
        message.media_thumbnail_key = null;
      } catch (error) {
        req.log.warn(
          { error: whatsappLogErrorContext(error) },
          'WhatsApp thumbnail cache lookup failed'
        );
      }
    }

    const original = await app.inject({
      method: 'GET',
      url: `/whatsapp/media/${messageId}`,
      headers: {
        authorization: req.headers.authorization,
        'x-company-id': String(companyId),
      },
    });
    if (original.statusCode !== 200)
      return reply
        .code(original.statusCode)
        .type(original.headers['content-type'] ?? 'application/json')
        .send(original.rawPayload);

    const originalMime = original.headers['content-type']?.split(';', 1)[0]?.toLowerCase() ?? '';
    if (!originalMime.startsWith('image/') && !originalMime.startsWith('video/'))
      return reply.code(415).send({ success: false, error: 'This media type cannot be previewed' });

    let thumbnail: MediaThumbnail;
    try {
      thumbnail = originalMime.startsWith('video/')
        ? await (options.createVideoPoster ?? createVideoPoster)(original.rawPayload)
        : await createImageThumbnail(original.rawPayload);
    } catch (error) {
      req.log.warn(
        { error: whatsappLogErrorContext(error) },
        'WhatsApp thumbnail generation failed'
      );
      return reply.code(415).send({ success: false, error: 'Media preview is unavailable' });
    }

    message =
      (await WhatsappMessage.query().findOne({ id: messageId, company_id: companyId })) ?? message;
    if (message.media_scan_status !== 'clean' || !message.media_key)
      return reply.code(503).send({ success: false, error: 'Media is not ready for preview' });
    await WhatsappMessage.query()
      .where({ id: messageId, company_id: companyId })
      .patch({ media_size_bytes: original.rawPayload.length });
    message.media_size_bytes = original.rawPayload.length;
    const thumbnailKey = randomUUID();
    try {
      await options.attachmentStorage.put(thumbnailKey, thumbnail.bytes);
      const updated = await WhatsappMessage.query()
        .where({ id: messageId, company_id: companyId, media_key: message.media_key })
        .patch({ media_thumbnail_key: thumbnailKey });
      if (!updated) {
        await options.attachmentStorage.delete(thumbnailKey).catch(() => undefined);
        return reply.code(404).send({ success: false, error: 'Media preview not found' });
      }
    } catch (error) {
      await options.attachmentStorage.delete(thumbnailKey).catch(() => undefined);
      req.log.warn(
        { error: whatsappLogErrorContext(error) },
        'WhatsApp thumbnail cache write failed'
      );
    }

    return reply
      .header('Cache-Control', 'private, max-age=3600')
      .header('Vary', 'Authorization, X-Company-Id')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox; base-uri 'none'")
      .header('X-Original-Content-Type', originalMime)
      .header('X-Original-Content-Length', String(original.rawPayload.length))
      .type(thumbnail.contentType)
      .send(thumbnail.bytes);
  });

  app.get<{ Params: Params }>('/whatsapp/media/:id', async (req, reply) => {
    const companyId = requireCompany(req, reply);
    if (!companyId) return;
    const messageId = id(req.params.id);
    if (!messageId) return reply.code(400).send({ success: false, error: 'Invalid message ID' });
    const message = await WhatsappMessage.query().findOne({ id: messageId, company_id: companyId });
    if (
      !message ||
      message.provider_type ||
      !GOWA_MEDIA_TYPES.has(message.message_type) ||
      message.is_deleted
    )
      return reply.code(404).send({ success: false, error: 'Media not found' });
    if (message.media_scan_status === 'infected')
      return reply.code(410).send({ success: false, error: 'Attachment blocked by malware scan' });
    if (!attachmentScanner)
      return reply
        .code(503)
        .send({ success: false, error: 'Attachment malware scanning is temporarily unavailable' });

    if (message.media_key && message.media_scan_status !== 'clean') {
      try {
        const scanResult = await scanStoredAttachment(
          options.attachmentStorage,
          message.media_key,
          attachmentScanner
        );
        if (scanResult.status === 'infected') {
          await options.attachmentStorage.delete(message.media_key).catch((error: unknown) => {
            req.log.warn(
              { error: whatsappLogErrorContext(error) },
              'WhatsApp quarantined attachment cleanup failed'
            );
          });
          if (message.media_thumbnail_key)
            await options.attachmentStorage
              .delete(message.media_thumbnail_key)
              .catch(() => undefined);
          await WhatsappMessage.query().where({ id: message.id, company_id: companyId }).patch({
            media_key: null,
            media_thumbnail_key: null,
            media_mime_type: null,
            media_scan_status: 'infected',
          });
          message.media_key = null;
          message.media_mime_type = null;
          message.media_scan_status = 'infected';
          return reply
            .code(410)
            .send({ success: false, error: 'Attachment blocked by malware scan' });
        }
        await WhatsappMessage.query()
          .where({ id: message.id, company_id: companyId })
          .patch({ media_scan_status: 'clean' });
        message.media_scan_status = 'clean';
      } catch (error) {
        req.log.error({ error: whatsappLogErrorContext(error) }, 'WhatsApp malware scan failed');
        return reply.code(503).send({
          success: false,
          error: 'Attachment malware scanning is temporarily unavailable',
        });
      }
    }
    let content: Buffer | null = null;
    let mediaStream: Readable | null = null;
    let verifiedMime: string | null = null;
    let verifiedSize: number | null = null;
    let downloadedFromGateway = false;
    try {
      if (message.media_key && options.attachmentStorage.getStream) {
        const cachedStream = await options.attachmentStorage.getStream(message.media_key);
        if (cachedStream) {
          const inspected = await peekReadable(cachedStream);
          if (!inspected.prefix.length)
            return reply.code(404).send({ success: false, error: 'Media not found' });
          verifiedMime = sniffMime(inspected.prefix) ?? 'application/octet-stream';
          mediaStream = limitReadable(inspected.stream, MAX_ATTACHMENT_BYTES);
        }
      }
      if (!mediaStream && message.media_key)
        content = await options.attachmentStorage.get(message.media_key);
      if (content) verifiedSize = content.length;
    } catch (error) {
      req.log.error(
        { error: whatsappLogErrorContext(error) },
        'WhatsApp attachment storage read failed'
      );
      return reply
        .code(503)
        .send({ success: false, error: 'Media storage is temporarily unavailable' });
    }
    if (!content && !mediaStream) {
      const conversation = await WhatsappConversation.query().findOne({
        id: message.conversation_id,
        company_id: companyId,
      });
      const account = await WhatsappAccount.query().findOne({
        id: message.account_id,
        company_id: companyId,
      });
      if (!conversation || !account?.gateway_device_id)
        return reply.code(404).send({ success: false, error: 'Media not found' });
      const metadata = await gowaRequest<{
        file_url?: string;
        file_path?: string;
        filename?: string;
      }>(
        `/message/${encodeURIComponent(message.external_id)}/download?phone=${encodeURIComponent(conversation.jid)}`,
        { deviceId: account.gateway_device_id }
      );
      const mediaPath = metadata.file_url ?? metadata.file_path;
      if (!mediaPath) return reply.code(404).send({ success: false, error: 'Media not found' });
      const downloaded = await gowaBinary(gowaOriginPath(mediaPath), account.gateway_device_id);
      if (options.attachmentStorage.putStream && options.attachmentStorage.getStream) {
        const mediaKey = randomUUID();
        try {
          const streamed = await streamResponseToStorage(
            downloaded,
            options.attachmentStorage,
            mediaKey
          );
          verifiedMime = streamed.mime;
          verifiedSize = streamed.size;
          const scanResult = await scanStoredAttachment(
            options.attachmentStorage,
            mediaKey,
            attachmentScanner
          );
          if (scanResult.status === 'infected') {
            await options.attachmentStorage.delete(mediaKey).catch(() => undefined);
            await WhatsappMessage.query()
              .where({ id: message.id, company_id: companyId })
              .patch({ media_scan_status: 'infected' });
            message.media_scan_status = 'infected';
            return reply
              .code(410)
              .send({ success: false, error: 'Attachment blocked by malware scan' });
          }
        } catch (error) {
          await options.attachmentStorage.delete(mediaKey).catch(() => undefined);
          if (error instanceof MalwareScannerUnavailableError) {
            req.log.error(
              { error: whatsappLogErrorContext(error) },
              'WhatsApp malware scan failed'
            );
            return reply.code(503).send({
              success: false,
              error: 'Attachment malware scanning is temporarily unavailable',
            });
          }
          if (error instanceof MediaTooLargeError) {
            return reply
              .code(413)
              .send({ success: false, error: 'Media exceeds the 10 MiB limit' });
          }
          if (error instanceof MediaIncompleteError) {
            return reply
              .code(502)
              .send({ success: false, error: 'WhatsApp gateway returned incomplete media' });
          }
          if (error instanceof MediaEmptyError) {
            return reply.code(404).send({ success: false, error: 'Media not found' });
          }
          throw error;
        }
        const storedStream = await options.attachmentStorage.getStream(mediaKey);
        if (!storedStream) {
          await options.attachmentStorage.delete(mediaKey).catch(() => undefined);
          return reply
            .code(503)
            .send({ success: false, error: 'Media storage is temporarily unavailable' });
        }
        mediaStream = limitReadable(storedStream, MAX_ATTACHMENT_BYTES);
        await WhatsappMessage.query()
          .where({ id: message.id, company_id: companyId })
          .patch({
            media_key: mediaKey,
            media_thumbnail_key: null,
            media_mime_type: verifiedMime,
            media_size_bytes: verifiedSize,
            media_scan_status: 'clean',
            media_file_name: safeFileName(metadata.filename) ?? message.media_file_name,
          });
        message.media_key = mediaKey;
        message.media_mime_type = verifiedMime;
        message.media_file_name = safeFileName(metadata.filename) ?? message.media_file_name;
        downloadedFromGateway = true;
      } else {
        try {
          content = await readLimitedMedia(downloaded);
        } catch (error) {
          if (error instanceof MediaTooLargeError) {
            return reply
              .code(413)
              .send({ success: false, error: 'Media exceeds the 10 MiB limit' });
          }
          if (error instanceof MediaIncompleteError) {
            return reply
              .code(502)
              .send({ success: false, error: 'WhatsApp gateway returned incomplete media' });
          }
          throw error;
        }
        if (!content.length)
          return reply.code(404).send({ success: false, error: 'Media not found' });
        verifiedMime = sniffMime(content) ?? 'application/octet-stream';
        verifiedSize = content.length;
        let scanResult;
        try {
          scanResult = await attachmentScanner.scan(Readable.from([content]));
        } catch (error) {
          req.log.error({ error: whatsappLogErrorContext(error) }, 'WhatsApp malware scan failed');
          return reply.code(503).send({
            success: false,
            error: 'Attachment malware scanning is temporarily unavailable',
          });
        }
        if (scanResult.status === 'infected') {
          await WhatsappMessage.query()
            .where({ id: message.id, company_id: companyId })
            .patch({ media_scan_status: 'infected' });
          message.media_scan_status = 'infected';
          return reply
            .code(410)
            .send({ success: false, error: 'Attachment blocked by malware scan' });
        }
        const mediaKey = randomUUID();
        await options.attachmentStorage.put(mediaKey, content);
        await WhatsappMessage.query()
          .where({ id: message.id, company_id: companyId })
          .patch({
            media_key: mediaKey,
            media_thumbnail_key: null,
            media_mime_type: verifiedMime,
            media_size_bytes: verifiedSize,
            media_scan_status: 'clean',
            media_file_name: safeFileName(metadata.filename) ?? message.media_file_name,
          });
        message.media_key = mediaKey;
        message.media_mime_type = verifiedMime;
        message.media_file_name = safeFileName(metadata.filename) ?? message.media_file_name;
        downloadedFromGateway = true;
      }
    }
    if (downloadedFromGateway && verifiedSize !== null)
      recordWhatsAppMediaTransfer('inbound', verifiedSize);
    verifiedMime ??= content ? (sniffMime(content) ?? 'application/octet-stream') : null;
    if (!content && !mediaStream)
      return reply.code(404).send({ success: false, error: 'Media not found' });
    if (message.media_mime_type !== verifiedMime) {
      await WhatsappMessage.query()
        .where({ id: message.id, company_id: companyId })
        .patch({ media_mime_type: verifiedMime });
      message.media_mime_type = verifiedMime;
    }
    if (verifiedSize !== null && message.media_size_bytes !== verifiedSize) {
      await WhatsappMessage.query()
        .where({ id: message.id, company_id: companyId })
        .patch({ media_size_bytes: verifiedSize });
      message.media_size_bytes = verifiedSize;
    }
    await recordWhatsAppAudit(req, 'whatsapp.message', 'media_access', message.id, companyId);
    const mime = safeMime(message.media_mime_type);
    const disposition =
      mime.startsWith('image/') ||
      mime.startsWith('audio/') ||
      mime.startsWith('video/') ||
      mime === 'application/pdf'
        ? 'inline'
        : 'attachment';
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'"
      )
      .header(
        'content-disposition',
        `${disposition}; filename="${safeFileName(message.media_file_name) ?? 'attachment'}"`
      )
      .type(mime)
      .send(mediaStream ?? content);
  });
};
