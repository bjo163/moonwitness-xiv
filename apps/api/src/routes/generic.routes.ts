import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { databaseErrorCode } from '../database/errors.js';
import type { AttachmentStorage } from '@moonwitness/orm-storage';
import {
  BaseModel,
  Registry,
  applyDomain,
  describeFields,
  validateDomain,
  resolveViews,
  getModelMenuInfo,
  columnName,
  type Field,
  type FieldMap,
  type Domain,
} from '@moonwitness/orm';
import { assignDefaultCompanyMembership, assignDefaultUserGroup } from '@moonwitness/orm-base';
import { isValidOrganizationMutation } from '@moonwitness/orm-organization';
import {
  asJsonObject,
  isRecord as isObject,
  isJsonValue,
  MAX_ATTACHMENT_BYTES,
  type JsonObject,
  type JsonValue,
} from '@moonwitness/types';
import type { Transaction } from 'objection';
import { canAccess, canManageBaseUser, operationFor, rpcOperation } from '../auth/policy.js';
import { getRecordRuleDomain } from '../auth/rules.js';
import type {
  ActionRequestBody,
  DeleteQueryParams,
  GroupCountQueryParams,
  ModelActionParam,
  ModelIdParam,
  ModelListResponse,
  ModelParam,
  SearchQueryParams,
} from '@moonwitness/types';
import {
  queryGraphIsBounded,
  relationExpression,
  rpcSearchReadIsBounded,
  userGraphAllowed,
} from './generic-query-graph.js';
import { auditSnapshot } from './generic-audit.js';

type RpcEnvelope = {
  jsonrpc?: unknown;
  method?: unknown;
  params?: unknown;
  id?: unknown;
};

const SERVER_MANAGED_FIELDS = new Set([
  'id',
  'create_date',
  'write_date',
  'create_uid',
  'write_uid',
]);

function hasServerManagedFields(value: JsonObject): boolean {
  return Object.keys(value).some((key) => SERVER_MANAGED_FIELDS.has(key));
}

function errorMessage(error: unknown, fallback: string): string {
  if (databaseErrorCode(error)) return fallback;
  return error instanceof Error ? error.message : fallback;
}

function parseInteger(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined || value === '') return fallback;
  if (!/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Resolves a model bound to the request's Environment so audit fields use the caller. */
function resolveModel(req: FastifyRequest, name: string) {
  return Registry.has(name) ? req.env.get(name) : null;
}

function parseModelDomain(raw: string | undefined, Model: typeof BaseModel): Domain | null {
  if (!raw) return [];
  try {
    return validateDomain(
      JSON.parse(raw) as unknown,
      new Set(Object.keys(Model.jsonSchema.properties ?? {}))
    );
  } catch {
    return null;
  }
}

function requireId(value: string, reply: FastifyReply): number | null {
  const id = parseInteger(value);
  if (id === undefined || id < 1) {
    reply.status(400).send({ success: false, error: 'Invalid ID parameter' });
    return null;
  }
  return id;
}

function modelNotFound(name: string) {
  return {
    success: false,
    error: `Model '${name}' not found. Available models: ${Registry.getNames().join(', ')}`,
  };
}

function recordNotFound(name: string, id: number) {
  return { success: false, error: `Record #${id} of model '${name}' not found` };
}

function property(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function roleOf(value: unknown): string | undefined {
  const role = property(value, 'role');
  return typeof role === 'string' ? role : undefined;
}

function resolveFieldTarget(field: Field): typeof BaseModel | undefined {
  const target = field.target;
  if (!target) return undefined;
  if (typeof target === 'function' && !('modelName' in target)) return target();
  return target as typeof BaseModel;
}

function hasPolymorphicResourceFields(fields: FieldMap): boolean {
  return 'resource_model' in fields && 'resource_id' in fields;
}

async function findReference(
  targetModel: string,
  targetId: number,
  activeUsersOnly = false,
  trx?: Transaction
): Promise<string | null> {
  for (const [modelName, RegisteredModel] of Registry.getAll()) {
    const fields = RegisteredModel.fields ?? {};
    const references = Object.entries(fields).flatMap(([fieldName, field]) => {
      if (field.kind !== 'belongsTo') return [];
      const target = resolveFieldTarget(field);
      return target?.modelName === targetModel ? [columnName(fieldName, field)] : [];
    });
    for (const column of references) {
      let query = RegisteredModel.query(trx).where(column, targetId);
      if (activeUsersOnly && modelName === 'base.user') query = query.where('active', true);
      if (await query.first()) return modelName;
    }

    if (hasPolymorphicResourceFields(fields)) {
      const reference = await RegisteredModel.query(trx)
        .where({ resource_model: targetModel, resource_id: targetId })
        .first();
      if (reference) return modelName;
    }
  }
  return null;
}

async function hasActivePartner(
  modelName: string,
  values: JsonObject,
  current?: BaseModel,
  trx?: Transaction
) {
  if (modelName !== 'base.user') return true;
  const active = values.active ?? current?.active ?? true;
  if (active !== true) return true;
  const rawId = values.partner_id ?? property(current, 'partner_id');
  if (typeof rawId !== 'number') return true;
  const Partner = Registry.get('base.partner');
  const partner = await Partner.query(trx).findById(rawId);
  return partner !== undefined && partner.active !== false;
}

async function hasCompanyAccess(
  req: FastifyRequest,
  modelName: string,
  values: JsonObject,
  current?: BaseModel,
  trx?: Transaction
): Promise<boolean> {
  const companyId = req.auth?.companyId;
  const modelFields = Registry.get(modelName).fields ?? {};
  const targetCompany = Object.hasOwn(values, 'company_id')
    ? values.company_id
    : property(current, 'company_id');
  const canAssignCompanyMembership =
    modelName === 'base.company_membership' &&
    (req.auth?.role === 'system' || req.auth?.role === 'superadmin');
  if ('company' in modelFields || 'company_id' in modelFields) {
    const currentCompany = property(current, 'company_id');
    if (typeof currentCompany === 'number' && targetCompany === null) return false;
    if (
      targetCompany !== undefined &&
      targetCompany !== null &&
      targetCompany !== companyId &&
      !canAssignCompanyMembership
    )
      return false;
    if (targetCompany === undefined && companyId !== undefined && modelFields.company?.required)
      return false;
  }
  for (const [fieldName, field] of Object.entries(modelFields)) {
    if (field.kind !== 'belongsTo') continue;
    const relationId = Object.hasOwn(values, `${fieldName}_id`)
      ? values[`${fieldName}_id`]
      : Object.hasOwn(values, fieldName)
        ? values[fieldName]
        : property(current, `${fieldName}_id`);
    if (typeof relationId !== 'number' || !Number.isSafeInteger(relationId)) continue;
    const targetModel = resolveFieldTarget(field);
    if (!targetModel) continue;
    const target = await req.env.get(targetModel.modelName).query(trx).findById(relationId);
    if (!target) return false;
    const targetFields = targetModel.fields ?? {};
    if ('company' in targetFields || 'company_id' in targetFields) {
      const relatedCompany = property(target, 'company_id');
      if (relatedCompany !== undefined && relatedCompany !== null && relatedCompany !== companyId)
        return false;
    }
  }
  return isValidOrganizationMutation(modelName, values, current?.toJSON(), trx);
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ success: false, error: 'Forbidden' });
}

function relationConflict(reply: FastifyReply, modelName: string, reference: string) {
  return reply.code(409).send({
    success: false,
    error: `Cannot archive or delete '${modelName}'; it is still referenced by '${reference}'`,
  });
}

async function recordAudit(
  req: FastifyRequest,
  modelName: string,
  operation: string,
  recordId: number,
  before: unknown,
  after: unknown,
  trx?: Transaction
): Promise<void> {
  if (modelName === 'base.audit_log') return;
  const Model = resolveModel(req, modelName);
  if (!Model) return;
  const previous = auditSnapshot(Model, before);
  const current = auditSnapshot(Model, after);
  const changes: JsonObject = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) {
      changes[key] = { before: previous[key] ?? null, after: current[key] ?? null };
    }
  }
  const auditModel = req.env.get('base.audit_log');
  const activeTrx = trx ?? req.env.trx;
  await (activeTrx ? auditModel.query(activeTrx) : auditModel.query()).insert({
    model: modelName,
    record_id: recordId,
    operation,
    actor_id: req.auth?.userId ?? null,
    changes: JSON.stringify(changes),
  } as Partial<BaseModel>);
}

async function recordOutbox(
  req: FastifyRequest,
  modelName: string,
  operation: string,
  recordId: number,
  snapshot: JsonObject,
  trx?: Transaction
): Promise<void> {
  const outbox = req.env.get('base.outbox_event');
  const activeTrx = trx ?? req.env.trx;
  await (activeTrx ? outbox.query(activeTrx) : outbox.query()).insert({
    event_type: `record.${operation}`,
    aggregate_model: modelName,
    aggregate_id: recordId,
    company_id: typeof snapshot.company_id === 'number' ? snapshot.company_id : req.auth?.companyId,
    actor_id: req.auth?.userId ?? null,
    payload: JSON.stringify({ model: modelName, id: recordId, operation, record: snapshot }),
    available_at: new Date().toISOString(),
  } as Partial<BaseModel>);
}

async function inRequestTransaction<T>(
  req: FastifyRequest,
  callback: (trx: Transaction) => Promise<T>
): Promise<T> {
  const originalEnv = req.env;
  return req.server.db.transaction(async (trx) => {
    const transactionalEnv = originalEnv.withTransaction(trx);
    req.env = transactionalEnv;
    try {
      return await callback(trx);
    } finally {
      req.env = originalEnv;
    }
  });
}

async function scopedRecord(
  req: FastifyRequest,
  model: typeof BaseModel,
  modelName: string,
  id: number,
  activeTest = true,
  transaction?: Transaction
): Promise<BaseModel | null> {
  const scope = await userReadScope(req, modelName);
  const query = applyDomain(model.query(transaction), [...scope, ['id', '=', id]]);
  const record = await query.forUpdate().first();
  if (!record || (activeTest && record.active === false)) return null;
  return record as BaseModel;
}

async function hasValidResourceReference(
  req: FastifyRequest,
  modelName: string,
  values: JsonObject,
  current?: BaseModel,
  trx?: Transaction
): Promise<boolean> {
  const Model = Registry.get(modelName);
  if (!hasPolymorphicResourceFields(Model.fields ?? {})) return true;
  const resourceModel = Object.hasOwn(values, 'resource_model')
    ? values.resource_model
    : property(current, 'resource_model');
  const resourceId = Object.hasOwn(values, 'resource_id')
    ? values.resource_id
    : property(current, 'resource_id');
  if (resourceModel === undefined && resourceId === undefined) return true;
  if (
    typeof resourceModel !== 'string' ||
    !Registry.has(resourceModel) ||
    !canAccess(req.auth?.role, resourceModel, 'read', req.auth?.groupPermissions) ||
    typeof resourceId !== 'number' ||
    !Number.isSafeInteger(resourceId) ||
    resourceId < 1
  )
    return false;
  const Resource = Registry.get(resourceModel);
  return Boolean(await scopedRecord(req, Resource, resourceModel, resourceId, true, trx));
}

const PROTECTED_ACCESS_MODELS = new Set([
  'base.user',
  'base.audit_log',
  'base.access_group',
  'base.group_membership',
  'base.model_access',
  'base.company_membership',
  'base.job',
  'base.job_run',
  'base.cron',
  'base.outbox_event',
]);

function hasValidAccessRule(modelName: string, values: JsonObject, current?: BaseModel): boolean {
  if (modelName !== 'base.model_access') return true;
  const target = Object.hasOwn(values, 'model_name')
    ? values.model_name
    : property(current, 'model_name');
  return (
    typeof target === 'string' &&
    Registry.has(target) &&
    !PROTECTED_ACCESS_MODELS.has(target) &&
    !target.startsWith('auth.')
  );
}

async function userReadScope(req: FastifyRequest, modelName: string): Promise<Domain> {
  return getRecordRuleDomain(req, modelName);
}

async function rpcUserMutationAllowed(
  actorRole: string | undefined,
  model: typeof BaseModel,
  operation: 'create' | 'write' | 'unlink',
  args: JsonValue[]
): Promise<boolean> {
  if (actorRole === 'system') return true;
  if (operation === 'create') {
    const records = Array.isArray(args[0]) ? args[0] : [args[0]];
    for (const item of records) {
      const record = asJsonObject(item);
      if (
        !record ||
        !canManageBaseUser(actorRole, operation, undefined, roleOf(record)) ||
        !(await hasActivePartner(model.modelName, record))
      )
        return false;
    }
    return true;
  }
  const ids =
    typeof args[0] === 'number'
      ? [args[0]]
      : Array.isArray(args[0])
        ? args[0].filter((id): id is number => typeof id === 'number')
        : [];
  const records = await model
    .query()
    .whereIn('id', ids)
    .select('id', 'role', 'partner_id', 'active');
  const values = operation === 'write' ? asJsonObject(args[1]) : null;
  if (
    !records.every((record) =>
      canManageBaseUser(actorRole, operation, roleOf(record), roleOf(values))
    )
  )
    return false;
  if (operation === 'write' && values) {
    for (const record of records) {
      if (!(await hasActivePartner(model.modelName, values, record))) return false;
    }
  }
  return true;
}

async function executeRpc(
  model: typeof BaseModel,
  method: string,
  args: JsonValue[],
  kwargs: Record<string, JsonValue>,
  readScope: Domain,
  req: FastifyRequest,
  trx?: Transaction
): Promise<JsonValue> {
  const [first, second] = args;
  const domain = [...(Array.isArray(first) ? (first as Domain) : []), ...readScope];
  switch (method) {
    case 'search_read': {
      const relationGraph = typeof kwargs.with === 'string' ? kwargs.with : undefined;
      return (await model.search_read(domain, {
        ...(kwargs as Parameters<typeof model.search_read>[1]),
        ...(relationGraph ? { withGraphFetched: relationGraph } : {}),
      })) as JsonValue;
    }
    case 'search':
      return (await model.search(domain, kwargs as Parameters<typeof model.search>[1])).map(
        (record) => record.id
      );
    case 'create': {
      const values = first;
      if (values === undefined || !(Array.isArray(values) || asJsonObject(values)))
        throw new Error('create expects an object or array of objects');
      const inputs = (Array.isArray(values) ? values : [values]).map(asJsonObject);
      if (
        inputs.some((record) => record === null) ||
        !(
          await Promise.all(
            inputs.map((record) =>
              record
                ? Promise.all([
                    hasCompanyAccess(req, model.modelName, record, undefined, trx),
                    hasValidResourceReference(req, model.modelName, record, undefined, trx),
                  ]).then((results) => results.every(Boolean))
                : false
            )
          )
        ).every(Boolean)
      )
        throw new Error('Invalid related record reference');
      if (
        model.modelName === 'base.model_access' &&
        inputs.some((record) => !record || !hasValidAccessRule(model.modelName, record))
      )
        throw new Error('Access rules cannot target protected or uninstalled models');
      const created = await model.create(values as JsonObject | JsonObject[], { transaction: trx });
      const records = Array.isArray(created) ? created : [created];
      if (model.modelName === 'base.user') {
        for (const record of records) {
          if (roleOf(record) === 'user') await assignDefaultUserGroup(record.id, trx);
          await assignDefaultCompanyMembership(record.id, trx);
        }
      }
      for (const record of records) {
        await recordAudit(req, model.modelName, 'create', record.id, null, record);
        await recordOutbox(
          req,
          model.modelName,
          'created',
          record.id,
          auditSnapshot(model, record)
        );
      }
      return Array.isArray(created) ? created.map((record) => record.id) : created.id;
    }
    case 'write': {
      const ids =
        typeof first === 'number'
          ? first
          : Array.isArray(first)
            ? first.filter((id): id is number => typeof id === 'number')
            : [];
      const values = asJsonObject(second);
      if (values === null) throw new Error('write expects IDs and an object of values');
      const idList = Array.isArray(ids) ? ids : [ids];
      const visible = await model.search([...readScope, ['id', 'in', idList]], {
        limit: idList.length,
        transaction: trx,
      });
      if (visible.length !== idList.length) throw new Error('Record not found');
      const before = await model.query(trx).whereIn('id', idList);
      for (const record of before) {
        if (!(await hasCompanyAccess(req, model.modelName, values, record, trx)))
          throw new Error('Company access denied');
        if (!hasValidAccessRule(model.modelName, values, record)) {
          throw new Error('Access rules cannot target protected or uninstalled models');
        }
      }
      if (values.active === false) {
        for (const record of before) {
          const reference = await findReference(
            model.modelName,
            record.id,
            model.modelName === 'base.partner',
            trx
          );
          if (reference) throw new Error(`Record is still used by '${reference}'`);
        }
      }
      for (const record of before) {
        if (!(await hasValidResourceReference(req, model.modelName, values, record, trx))) {
          throw new Error('Invalid related record reference');
        }
      }
      const written = await model.write(ids, values, { transaction: trx });
      const after = await model.query(trx).whereIn('id', idList);
      const afterById = new Map(after.map((record) => [record.id, record]));
      for (const record of before) {
        const updated = afterById.get(record.id);
        if (updated) {
          await recordAudit(req, model.modelName, 'write', record.id, record, updated);
          await recordOutbox(
            req,
            model.modelName,
            'updated',
            record.id,
            auditSnapshot(model, updated)
          );
        }
      }
      return written;
    }
    case 'unlink': {
      const ids =
        typeof first === 'number'
          ? first
          : Array.isArray(first)
            ? first.filter((id): id is number => typeof id === 'number')
            : [];
      const idList = Array.isArray(ids) ? ids : [ids];
      const visible = await model.search([...readScope, ['id', 'in', idList]], {
        limit: idList.length,
        transaction: trx,
      });
      if (visible.length !== idList.length) throw new Error('Record not found');
      const before = await model.query(trx).whereIn('id', idList);
      for (const record of before) {
        const reference = await findReference(
          model.modelName,
          record.id,
          model.modelName === 'base.partner',
          trx
        );
        if (reference) throw new Error(`Record is still used by '${reference}'`);
      }
      const unlinked = await model.unlink(ids, false, { transaction: trx });
      const after = await model.query(trx).whereIn('id', idList);
      const afterById = new Map(after.map((record) => [record.id, record]));
      for (const record of before)
        await recordAudit(
          req,
          model.modelName,
          'archive',
          record.id,
          record,
          afterById.get(record.id) ?? null
        );
      for (const record of before)
        await recordOutbox(
          req,
          model.modelName,
          'archived',
          record.id,
          auditSnapshot(model, afterById.get(record.id) ?? record)
        );
      return unlinked;
    }
    default:
      throw new Error(`Method '${method}' is not exposed`);
  }
}

interface GenericRoutesOptions {
  attachmentStorage: AttachmentStorage;
}

const ATTACHMENT_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/json',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'text/csv',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function safeAttachmentName(value: string | undefined): string | null {
  if (
    !value ||
    value.length > 255 ||
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return null;
  const name = value.normalize('NFC').trim();
  if (!name || name === '.' || name === '..' || name.includes('..')) return null;
  return name;
}

function encodedAttachmentName(name: string): string {
  return encodeURIComponent(name).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export const genericRoutes: FastifyPluginAsync<GenericRoutesOptions> = async (fastify, options) => {
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  );

  // Single authorization point for every /api/:model route; handlers stay policy-free.
  fastify.addHook('preHandler', async (req, reply) => {
    const model = (req.params as { model?: string } | undefined)?.model;
    if (!model) return;
    const operation = operationFor(req.method, req.routeOptions.url ?? '');
    if (!canAccess(req.auth?.role, model, operation, req.auth?.groupPermissions)) {
      return reply.code(403).send({ success: false, error: 'Forbidden' });
    }
    if (model === 'base.attachment' && operation === 'create') {
      return reply.code(400).send({ success: false, error: 'Use the attachment upload endpoint' });
    }
    if (
      model === 'base.attachment' &&
      operation === 'write' &&
      req.routeOptions.url !== '/api/:model/:id/action/:method'
    ) {
      return reply.code(400).send({ success: false, error: 'Attachment metadata is immutable' });
    }
  });

  fastify.post<{
    Querystring: { resource_model?: string; resource_id?: string; name?: string };
    Body: Buffer;
  }>(
    '/api/base.attachment/upload',
    {
      bodyLimit: MAX_ATTACHMENT_BYTES,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (!canAccess(req.auth?.role, 'base.attachment', 'create', req.auth?.groupPermissions))
        return forbidden(reply);
      const { resource_model: resourceModel, resource_id: rawResourceId } = req.query;
      const resourceId = parseInteger(rawResourceId);
      const name = safeAttachmentName(req.query.name);
      const mimeHeader = req.headers['x-file-mime'];
      const rawMime = (Array.isArray(mimeHeader) ? mimeHeader[0] : mimeHeader)
        ?.trim()
        .toLowerCase();
      const mimetype = rawMime && ATTACHMENT_MIME_TYPES.has(rawMime) ? rawMime : null;
      if (
        !resourceModel ||
        !Registry.has(resourceModel) ||
        resourceId === undefined ||
        resourceId < 1 ||
        !name ||
        !mimetype
      ) {
        return reply.code(400).send({ success: false, error: 'Invalid attachment metadata' });
      }
      if (!canAccess(req.auth?.role, resourceModel, 'read', req.auth?.groupPermissions)) {
        return reply.code(404).send({ success: false, error: 'Record not found' });
      }
      const resource = await scopedRecord(
        req,
        resolveModel(req, resourceModel) ?? BaseModel,
        resourceModel,
        resourceId
      );
      if (!resource) return reply.code(404).send({ success: false, error: 'Record not found' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        return reply.code(400).send({ success: false, error: 'Attachment must not be empty' });
      if (req.body.length > MAX_ATTACHMENT_BYTES)
        return reply.code(413).send({ success: false, error: 'Attachment exceeds 10 MiB limit' });

      const key = randomUUID();
      const checksum = createHash('sha256').update(req.body).digest('hex');
      let persisted = false;
      try {
        await options.attachmentStorage.put(key, req.body);
        persisted = true;
        const record = await inRequestTransaction(req, async (trx) => {
          const AttachmentModel = req.env.get('base.attachment');
          const created = await AttachmentModel.create(
            {
              name,
              resource_model: resourceModel,
              resource_id: resourceId,
              mimetype,
              size_bytes: req.body.length,
              storage_key: key,
              checksum,
            } as JsonObject,
            { transaction: trx }
          );
          const createdRecord = Array.isArray(created) ? created[0] : created;
          if (!createdRecord) throw new Error('Attachment metadata was not created');
          await recordAudit(
            req,
            'base.attachment',
            'create',
            createdRecord.id,
            null,
            createdRecord,
            trx
          );
          await recordOutbox(
            req,
            'base.attachment',
            'created',
            createdRecord.id,
            auditSnapshot(AttachmentModel, createdRecord),
            trx
          );
          return createdRecord;
        });
        return reply.code(201).send({ success: true, data: record });
      } catch (error) {
        if (persisted) {
          await options.attachmentStorage.delete(key).catch((cleanupError) => {
            req.log.error(
              { err: cleanupError, storageKey: key },
              'Failed to compensate attachment upload'
            );
          });
        } else {
          req.log.error({ err: error }, 'Attachment storage upload failed');
          return reply
            .code(503)
            .send({ success: false, error: 'Attachment storage is temporarily unavailable' });
        }
        throw error;
      }
    }
  );

  fastify.get<{ Params: ModelIdParam }>('/api/base.attachment/:id/download', async (req, reply) => {
    if (!canAccess(req.auth?.role, 'base.attachment', 'read', req.auth?.groupPermissions))
      return forbidden(reply);
    const id = requireId(req.params.id, reply);
    if (id === null) return;
    const Model = req.env.get('base.attachment');
    const attachment = await scopedRecord(req, Model, 'base.attachment', id);
    if (!attachment) return reply.code(404).send({ success: false, error: 'Attachment not found' });
    const resourceModel = property(attachment, 'resource_model');
    const resourceId = property(attachment, 'resource_id');
    if (
      typeof resourceModel !== 'string' ||
      !Registry.has(resourceModel) ||
      typeof resourceId !== 'number' ||
      !Number.isSafeInteger(resourceId) ||
      resourceId < 1
    ) {
      return reply.code(404).send({ success: false, error: 'Attachment not found' });
    }
    if (!canAccess(req.auth?.role, resourceModel, 'read', req.auth?.groupPermissions)) {
      return reply.code(404).send({ success: false, error: 'Attachment not found' });
    }
    const resource = await scopedRecord(
      req,
      resolveModel(req, resourceModel) ?? BaseModel,
      resourceModel,
      resourceId
    );
    if (!resource) return reply.code(404).send({ success: false, error: 'Attachment not found' });
    const key = property(attachment, 'storage_key');
    const name = property(attachment, 'name');
    const mimetype = property(attachment, 'mimetype');
    if (typeof key !== 'string' || typeof name !== 'string' || typeof mimetype !== 'string')
      return reply.code(404).send({ success: false, error: 'Attachment content not found' });
    try {
      const content = await options.attachmentStorage.get(key);
      if (!content)
        return reply.code(404).send({ success: false, error: 'Attachment content not found' });
      reply
        .header('Content-Type', mimetype)
        .header('Content-Length', content.length)
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodedAttachmentName(name)}`
        )
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store');
      return reply.send(content);
    } catch (error) {
      req.log.error({ err: error }, 'Attachment storage download failed');
      return reply
        .code(503)
        .send({ success: false, error: 'Attachment storage is temporarily unavailable' });
    }
  });

  fastify.get<{ Reply: ModelListResponse }>('/api/models', async (req) => ({
    success: true,
    models: Registry.getNames()
      .filter((name) => canAccess(req.auth?.role, name, 'read', req.auth?.groupPermissions))
      .map((name) => ({
        model: name,
        table: Registry.get(name).tableName,
        menu: getModelMenuInfo(name),
      })),
  }));

  /** What the caller may do on a model; drives which buttons a UI shows. */
  const permissionsFor = (req: FastifyRequest, model: string) => ({
    read: canAccess(req.auth?.role, model, 'read', req.auth?.groupPermissions),
    create: canAccess(req.auth?.role, model, 'create', req.auth?.groupPermissions),
    write: canAccess(req.auth?.role, model, 'write', req.auth?.groupPermissions),
    unlink: canAccess(req.auth?.role, model, 'unlink', req.auth?.groupPermissions),
  });

  /** Field metadata with readonly forced on when the caller cannot write. */
  const fieldsFor = (req: FastifyRequest, model: string) => {
    const writable = canAccess(req.auth?.role, model, 'write', req.auth?.groupPermissions);
    return describeFields(Registry.get(model))
      .filter((field) => model !== 'base.attachment' || field.name !== 'storage_key')
      .map((field) => (writable ? field : { ...field, readonly: true }));
  };

  fastify.get<{ Params: ModelParam }>('/api/:model/fields', async (req, reply) => {
    if (!Registry.has(req.params.model))
      return reply.status(404).send(modelNotFound(req.params.model));
    return {
      success: true,
      model: req.params.model,
      permissions: permissionsFor(req, req.params.model),
      fields: fieldsFor(req, req.params.model),
    };
  });

  fastify.get<{ Params: ModelParam }>('/api/:model/views', async (req, reply) => {
    if (!Registry.has(req.params.model))
      return reply.status(404).send(modelNotFound(req.params.model));
    const views = resolveViews(Registry.get(req.params.model));
    return {
      success: true,
      ...views,
      permissions: permissionsFor(req, req.params.model),
      fields: fieldsFor(req, req.params.model),
    };
  });

  fastify.get<{ Params: ModelParam; Querystring: GroupCountQueryParams }>(
    '/api/:model/group-count',
    async (req, reply) => {
      const Model = resolveModel(req, req.params.model);
      if (!Model) return reply.status(404).send(modelNotFound(req.params.model));
      const domain = parseModelDomain(req.query.domain, Model);
      if (!domain) {
        return reply
          .code(400)
          .send({ success: false, error: 'Invalid domain; expected a JSON domain array' });
      }
      if (!req.query.group_by || req.query.group_by.length > 512) {
        return reply.code(400).send({ success: false, error: 'group_by is required' });
      }
      const groupBy = req.query.group_by.split(',').map((field) => field.trim());
      const limit = parseInteger(req.query.limit, 100);
      const offset = parseInteger(req.query.offset, 0);
      if (limit === undefined || limit < 1 || limit > 500) {
        return reply.code(400).send({ success: false, error: 'limit must be 1–500' });
      }
      if (offset === undefined || offset < 0 || offset > 10_000) {
        return reply.code(400).send({ success: false, error: 'offset must be 0–10000' });
      }
      try {
        const scope = await userReadScope(req, req.params.model);
        const page = await Model.search_group_count([...domain, ...scope], groupBy, {
          limit,
          offset,
        });
        return { success: true, model: req.params.model, groupBy, ...page };
      } catch (error) {
        const validationError = isObject(error) && error.statusCode === 400;
        return reply.code(validationError ? 400 : 500).send({
          success: false,
          error: validationError
            ? errorMessage(error, 'Invalid grouped-count request')
            : errorMessage(error, 'Unable to group records'),
        });
      }
    }
  );

  fastify.get<{ Params: ModelParam; Querystring: SearchQueryParams }>(
    '/api/:model',
    async (req, reply) => {
      const Model = resolveModel(req, req.params.model);
      if (!Model) return reply.status(404).send(modelNotFound(req.params.model));

      const domain = parseModelDomain(req.query.domain, Model);
      if (!domain) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid domain; expected a JSON domain array' });
      }

      const limit = parseInteger(req.query.limit, 80);
      const offset = parseInteger(req.query.offset, 0);
      const cursor = parseInteger(req.query.cursor);
      const cursorMode = req.query.cursor !== undefined;
      if (
        limit === undefined ||
        limit < 1 ||
        limit > 500 ||
        offset === undefined ||
        offset < 0 ||
        (cursorMode && (cursor === undefined || cursor < 0 || offset > 0))
      ) {
        return reply.status(400).send({
          success: false,
          error:
            'limit must be 1–500; offset and cursor must be non-negative and cannot be combined',
        });
      }
      if (cursorMode && req.query.order && req.query.order.trim().toLowerCase() !== 'id asc') {
        return reply.code(400).send({
          success: false,
          error: 'cursor pagination requires ascending id order',
        });
      }
      const fields = req.query.fields
        ?.split(',')
        .map((field) => field.trim())
        .filter(Boolean);
      if (fields && fields.length > 100) {
        return reply
          .code(400)
          .send({ success: false, error: 'At most 100 fields may be selected' });
      }
      if ((req.query.with?.length ?? 0) > 512 || (req.query.order?.length ?? 0) > 512) {
        return reply.code(400).send({ success: false, error: 'Query expression is too long' });
      }
      if (!queryGraphIsBounded(req.query.with)) {
        return reply
          .code(400)
          .send({ success: false, error: 'Relation graph exceeds maximum depth' });
      }
      const options = {
        fields,
        limit: cursorMode && limit > 0 ? limit + 1 : limit,
        offset: cursorMode ? undefined : offset,
        order: cursorMode ? 'id asc' : req.query.order,
        withGraphFetched: relationExpression(req.query.with),
      };
      const scope = await userReadScope(req, req.params.model);
      if (!userGraphAllowed(req.auth?.role, req.params.model, req.query.with))
        return reply.code(403).send({ success: false, error: 'Forbidden relation graph' });
      const cursorDomain = cursorMode ? ([['id', '>', cursor]] as Domain) : [];
      const [pageRecords, total] = await Promise.all([
        Model.search_read([...domain, ...scope, ...cursorDomain], options),
        req.query.count === 'true'
          ? Model.search_count([...domain, ...scope])
          : Promise.resolve(undefined),
      ]);
      const hasMore = cursorMode && limit > 0 && pageRecords.length > limit;
      const records = hasMore ? pageRecords.slice(0, limit) : pageRecords;
      return {
        success: true,
        model: req.params.model,
        count: records.length,
        total,
        nextCursor: hasMore ? records.at(-1)?.id : undefined,
        data: records,
      };
    }
  );

  fastify.get<{ Params: ModelIdParam; Querystring: { with?: string } }>(
    '/api/:model/:id',
    async (req, reply) => {
      const Model = resolveModel(req, req.params.model);
      if (!Model) return reply.status(404).send(modelNotFound(req.params.model));
      const id = requireId(req.params.id, reply);
      if (id === null) return;
      if (!queryGraphIsBounded(req.query.with))
        return reply
          .code(400)
          .send({ success: false, error: 'Relation graph exceeds maximum depth' });
      if (!userGraphAllowed(req.auth?.role, req.params.model, req.query.with))
        return reply.code(403).send({ success: false, error: 'Forbidden relation graph' });
      const scope = await userReadScope(req, req.params.model);
      if (req.auth?.role === 'user' || scope.length > 0) {
        const [record] = await Model.search_read([...scope, ['id', '=', id]], {
          limit: 1,
          withGraphFetched: relationExpression(req.query.with),
        });
        if (!record) return reply.status(404).send(recordNotFound(req.params.model, id));
        return { success: true, model: req.params.model, data: record };
      }
      const record = await Model.browse(id, {
        withGraphFetched: relationExpression(req.query.with),
      });
      if (!record) return reply.status(404).send(recordNotFound(req.params.model, id));
      return { success: true, model: req.params.model, data: record };
    }
  );

  fastify.post<{ Params: ModelParam; Body: unknown }>('/api/:model', async (req, reply) => {
    const Model = resolveModel(req, req.params.model);
    if (!Model) return reply.status(404).send(modelNotFound(req.params.model));
    const body = req.body;
    const values = Array.isArray(body) ? body.map(asJsonObject) : [asJsonObject(body)];
    if (values.some((value) => value === null))
      return reply
        .status(400)
        .send({ success: false, error: 'Request body must be a JSON object or array of objects' });
    const inputRecords = values as JsonObject[];
    if (inputRecords.some(hasServerManagedFields))
      return reply
        .status(400)
        .send({ success: false, error: 'Identity and audit fields are managed by the server' });
    if (
      req.params.model === 'base.user' &&
      !inputRecords.every((value) =>
        canManageBaseUser(req.auth?.role, 'create', undefined, roleOf(value))
      )
    )
      return forbidden(reply);
    for (const value of inputRecords) {
      if (!(await hasCompanyAccess(req, req.params.model, value))) {
        return reply.code(403).send({ success: false, error: 'Company access denied' });
      }
      if (!hasValidAccessRule(req.params.model, value)) {
        return reply.code(400).send({
          success: false,
          error: 'Access rules cannot target protected or uninstalled models',
        });
      }
      if (!(await hasValidResourceReference(req, req.params.model, value))) {
        return reply.code(400).send({
          success: false,
          error: 'A valid installed model record is required for resource_model and resource_id',
        });
      }
    }
    for (const value of inputRecords) {
      if (!(await hasActivePartner(req.params.model, value)))
        return reply
          .code(409)
          .send({ success: false, error: 'An active user requires an active partner' });
    }
    const created = await inRequestTransaction(req, async (trx) => {
      for (const value of inputRecords) {
        if (!(await hasCompanyAccess(req, req.params.model, value, undefined, trx)))
          throw Object.assign(new Error('Company access denied'), { statusCode: 403 });
        if (!(await hasValidResourceReference(req, req.params.model, value, undefined, trx)))
          throw Object.assign(new Error('A valid installed model record is required'), {
            statusCode: 400,
          });
        if (!(await hasActivePartner(req.params.model, value, undefined, trx)))
          throw Object.assign(new Error('An active user requires an active partner'), {
            statusCode: 409,
          });
      }
      const result = await Model.create(
        Array.isArray(body) ? (values as JsonObject[]) : (values[0] as JsonObject),
        { transaction: trx }
      );
      for (const record of Array.isArray(result) ? result : [result]) {
        if (req.params.model === 'base.user') {
          if (roleOf(record) === 'user') await assignDefaultUserGroup(record.id, trx);
          await assignDefaultCompanyMembership(record.id, trx);
        }
        const snapshot = auditSnapshot(Model, record);
        await recordAudit(req, req.params.model, 'create', record.id, null, record, trx);
        await recordOutbox(req, req.params.model, 'created', record.id, snapshot, trx);
      }
      return result;
    });
    return reply.status(201).send({ success: true, model: req.params.model, data: created });
  });

  const updateHandler = async (
    req: FastifyRequest<{ Params: ModelIdParam; Body: unknown }>,
    reply: FastifyReply
  ) => {
    const Model = resolveModel(req, req.params.model);
    if (!Model) return reply.status(404).send(modelNotFound(req.params.model));
    const id = requireId(req.params.id, reply);
    if (id === null) return;
    const record = await scopedRecord(req, Model, req.params.model, id);
    if (!record) return reply.status(404).send(recordNotFound(req.params.model, id));
    const values = asJsonObject(req.body);
    if (values === null)
      return reply
        .status(400)
        .send({ success: false, error: 'Request body must be a JSON object' });
    if (hasServerManagedFields(values))
      return reply
        .status(400)
        .send({ success: false, error: 'Identity and audit fields are managed by the server' });
    if (!(await hasCompanyAccess(req, req.params.model, values, record)))
      return reply.code(403).send({ success: false, error: 'Company access denied' });
    if (!(await hasValidResourceReference(req, req.params.model, values, record))) {
      return reply.code(400).send({
        success: false,
        error: 'A valid installed model record is required for resource_model and resource_id',
      });
    }
    if (!hasValidAccessRule(req.params.model, values, record)) {
      return reply.code(400).send({
        success: false,
        error: 'Access rules cannot target protected or uninstalled models',
      });
    }
    if (
      req.params.model === 'base.user' &&
      !canManageBaseUser(req.auth?.role, 'write', roleOf(record), roleOf(values))
    )
      return forbidden(reply);
    if (!(await hasActivePartner(req.params.model, values, record)))
      return reply
        .code(409)
        .send({ success: false, error: 'An active user requires an active partner' });
    if (values.active === false) {
      const reference = await findReference(
        req.params.model,
        id,
        req.params.model === 'base.partner'
      );
      if (reference) return relationConflict(reply, req.params.model, reference);
    }
    const updated = await inRequestTransaction(req, async (trx) => {
      const locked = await scopedRecord(req, Model, req.params.model, id, true, trx);
      if (!locked) return null;
      if (!(await hasCompanyAccess(req, req.params.model, values, locked, trx))) return null;
      if (!(await hasValidResourceReference(req, req.params.model, values, locked, trx)))
        throw Object.assign(new Error('A valid installed model record is required'), {
          statusCode: 400,
        });
      if (!(await hasActivePartner(req.params.model, values, locked, trx)))
        throw Object.assign(new Error('An active user requires an active partner'), {
          statusCode: 409,
        });
      if (values.active === false) {
        const reference = await findReference(
          req.params.model,
          id,
          req.params.model === 'base.partner',
          trx
        );
        if (reference)
          throw Object.assign(new Error(`Cannot archive: still referenced by '${reference}'`), {
            statusCode: 409,
          });
      }
      const before = locked.toJSON();
      await Model.write(id, values, { transaction: trx });
      const next = (await Model.browse(id, { transaction: trx })) as BaseModel | null;
      if (!next) return null;
      const snapshot = auditSnapshot(Model, next);
      await recordAudit(req, req.params.model, 'write', id, before, next, trx);
      await recordOutbox(req, req.params.model, 'updated', id, snapshot, trx);
      return next;
    });
    if (!updated) return reply.status(404).send(recordNotFound(req.params.model, id));
    return { success: true, model: req.params.model, data: updated };
  };
  fastify.put<{ Params: ModelIdParam; Body: unknown }>('/api/:model/:id', updateHandler);
  fastify.patch<{ Params: ModelIdParam; Body: unknown }>('/api/:model/:id', updateHandler);

  fastify.delete<{ Params: ModelIdParam; Querystring: DeleteQueryParams }>(
    '/api/:model/:id',
    async (req, reply) => {
      const Model = resolveModel(req, req.params.model);
      if (!Model) return reply.status(404).send(modelNotFound(req.params.model));
      const id = requireId(req.params.id, reply);
      if (id === null) return;
      const record = await scopedRecord(req, Model, req.params.model, id);
      if (!record) return reply.status(404).send(recordNotFound(req.params.model, id));
      if (
        req.params.model === 'base.user' &&
        !canManageBaseUser(req.auth?.role, 'unlink', roleOf(record))
      )
        return forbidden(reply);
      const hardDelete = req.query.hard === 'true';
      const deletion = await inRequestTransaction(req, async (trx) => {
        const transactionalModel = resolveModel(req, req.params.model);
        if (!transactionalModel) return { missing: true as const };
        const locked = await scopedRecord(
          req,
          transactionalModel,
          req.params.model,
          id,
          false,
          trx
        );
        if (!locked) return { missing: true as const };
        if (
          req.params.model === 'base.user' &&
          !canManageBaseUser(req.auth?.role, 'unlink', roleOf(locked))
        )
          return { forbidden: true as const };
        const before = locked.toJSON();
        const reference = await findReference(
          req.params.model,
          id,
          !hardDelete && req.params.model === 'base.partner',
          trx
        );
        if (reference) return { reference };
        await locked.remove(hardDelete, { transaction: trx });
        await recordAudit(
          req,
          req.params.model,
          hardDelete ? 'delete' : 'archive',
          id,
          before,
          hardDelete ? null : locked,
          trx
        );
        await recordOutbox(
          req,
          req.params.model,
          hardDelete ? 'deleted' : 'archived',
          id,
          auditSnapshot(transactionalModel, hardDelete ? before : locked),
          trx
        );
        const storageKey =
          hardDelete && req.params.model === 'base.attachment'
            ? property(locked, 'storage_key')
            : undefined;
        return { deleted: true as const, storageKey };
      });
      if ('missing' in deletion)
        return reply.status(404).send(recordNotFound(req.params.model, id));
      if ('forbidden' in deletion) return forbidden(reply);
      if ('reference' in deletion && typeof deletion.reference === 'string')
        return relationConflict(reply, req.params.model, deletion.reference);
      if (typeof deletion.storageKey === 'string') {
        await options.attachmentStorage.delete(deletion.storageKey).catch((error) => {
          req.log.error(
            { err: error, storageKey: deletion.storageKey },
            'Attachment object cleanup failed'
          );
        });
      }
      return {
        success: true,
        model: req.params.model,
        message: hardDelete
          ? `Record #${id} permanently deleted`
          : `Record #${id} archived (active: false)`,
      };
    }
  );

  fastify.post<{ Params: ModelActionParam; Body: ActionRequestBody }>(
    '/api/:model/:id/action/:method',
    async (req, reply) => {
      const Model = resolveModel(req, req.params.model);
      if (!Model) return reply.status(404).send(modelNotFound(req.params.model));
      const id = requireId(req.params.id, reply);
      if (id === null) return;
      const record = await scopedRecord(
        req,
        Model,
        req.params.model,
        id,
        req.params.method !== 'action_unarchive'
      );
      if (!record) return reply.status(404).send(recordNotFound(req.params.model, id));
      if (
        req.params.model === 'base.user' &&
        !canManageBaseUser(req.auth?.role, 'action', roleOf(record))
      )
        return forbidden(reply);
      if (!Model.exposedActions.includes(req.params.method)) {
        return reply
          .status(400)
          .send({ success: false, error: `Action '${req.params.method}' is not exposed` });
      }
      if (!req.params.method.startsWith('action_')) {
        return reply
          .status(400)
          .send({ success: false, error: `Action '${req.params.method}' is invalid` });
      }
      const actionResult = await inRequestTransaction(req, async (trx) => {
        const transactionalModel = resolveModel(req, req.params.model);
        if (!transactionalModel) return { missing: true as const };
        const locked = await scopedRecord(
          req,
          transactionalModel,
          req.params.model,
          id,
          req.params.method !== 'action_unarchive',
          trx
        );
        if (!locked) return { missing: true as const };
        if (
          req.params.model === 'base.user' &&
          !canManageBaseUser(req.auth?.role, 'action', roleOf(locked))
        )
          return { forbidden: true as const };
        if (req.params.method === 'action_archive') {
          const reference = await findReference(
            req.params.model,
            id,
            req.params.model === 'base.partner',
            trx
          );
          if (reference) return { reference };
        }
        if (
          req.params.model === 'base.user' &&
          req.params.method === 'action_unarchive' &&
          !(await hasActivePartner('base.user', { active: true }, locked, trx))
        )
          return { inactivePartner: true as const };
        const before = locked.toJSON();
        const action = locked[req.params.method as keyof BaseModel];
        if (typeof action !== 'function') return { invalid: true as const };
        const result: unknown = await Reflect.apply(action, locked, []);
        const snapshot = auditSnapshot(transactionalModel, locked);
        await recordAudit(req, req.params.model, req.params.method, id, before, locked, trx);
        await recordOutbox(req, req.params.model, req.params.method, id, snapshot, trx);
        return { record: locked, result };
      });
      if ('missing' in actionResult)
        return reply.status(404).send(recordNotFound(req.params.model, id));
      if ('forbidden' in actionResult) return forbidden(reply);
      if ('reference' in actionResult && typeof actionResult.reference === 'string')
        return relationConflict(reply, req.params.model, actionResult.reference);
      if ('inactivePartner' in actionResult)
        return reply
          .code(409)
          .send({ success: false, error: 'An active user requires an active partner' });
      if ('invalid' in actionResult)
        return reply
          .status(400)
          .send({ success: false, error: `Action '${req.params.method}' is invalid` });
      const jsonResult = isJsonValue(actionResult.result)
        ? actionResult.result
        : (actionResult.record.toJSON() as JsonValue);
      return {
        success: true,
        model: req.params.model,
        id,
        method: req.params.method,
        result: jsonResult,
      };
    }
  );

  fastify.post<{ Body: unknown }>('/jsonrpc', async (req, reply) => {
    const body: unknown = req.body;
    const envelope: RpcEnvelope = isObject(body) ? body : {};
    const id =
      typeof envelope.id === 'string' || typeof envelope.id === 'number' || envelope.id === null
        ? envelope.id
        : null;
    const params = isObject(envelope.params) ? envelope.params : {};
    const rpcError = (code: number, message: string) => ({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
    if (
      envelope.method !== 'call' ||
      params.service !== 'object' ||
      params.method !== 'execute_kw' ||
      !Array.isArray(params.args)
    ) {
      return reply.status(400).send(rpcError(-32600, 'Invalid JSON-RPC Request'));
    }
    const [modelName, method, rawArgs, rawKwargs] = params.args;
    if (typeof modelName !== 'string' || typeof method !== 'string')
      return reply.status(400).send(rpcError(-32602, 'Invalid execute_kw arguments'));
    const Model = resolveModel(req, modelName);
    if (!Model) return reply.send(rpcError(-32000, `Model '${modelName}' not found`));
    const required = rpcOperation(method);
    if (
      modelName === 'base.attachment' &&
      (required === 'create' || required === 'write' || required === 'unlink')
    ) {
      return reply.send(rpcError(-32003, 'Use the attachment content endpoints'));
    }
    if (required && !canAccess(req.auth?.role, modelName, required, req.auth?.groupPermissions)) {
      return reply.status(403).send(rpcError(-32003, 'Forbidden'));
    }
    const args = Array.isArray(rawArgs) && rawArgs.every(isJsonValue) ? rawArgs : [];
    const kwargs = asJsonObject(rawKwargs) ?? {};
    const rpcMutationValues =
      required === 'create'
        ? (Array.isArray(args[0]) ? args[0] : [args[0]]).map(asJsonObject)
        : required === 'write'
          ? [asJsonObject(args[1])]
          : [];
    if (rpcMutationValues.some((value) => value !== null && hasServerManagedFields(value)))
      return reply.send(rpcError(-32602, 'Identity and audit fields are managed by the server'));
    if (required === 'read' && (method === 'search_read' || method === 'search')) {
      try {
        validateDomain(args[0] ?? [], new Set(Object.keys(Model.jsonSchema.properties ?? {})));
      } catch {
        return reply.send(rpcError(-32602, 'Invalid search domain'));
      }
    }
    const requestedGraph = typeof kwargs.with === 'string' ? kwargs.with : undefined;
    if (required === 'read' && !queryGraphIsBounded(requestedGraph))
      return reply.send(rpcError(-32602, 'Relation graph exceeds maximum depth'));
    const scope =
      required === 'read' || required === 'write' || required === 'unlink'
        ? await userReadScope(req, modelName)
        : [];
    if (required === 'read' && method === 'search_read' && !rpcSearchReadIsBounded(kwargs))
      return reply.send(rpcError(-32602, 'Search query exceeds configured limits'));
    if (required === 'read' && !userGraphAllowed(req.auth?.role, modelName, requestedGraph))
      return reply.status(403).send(rpcError(-32003, 'Forbidden relation graph'));
    if (
      modelName === 'base.user' &&
      (required === 'create' || required === 'write' || required === 'unlink') &&
      !(await rpcUserMutationAllowed(req.auth?.role, Model, required, args))
    )
      return reply.status(403).send(rpcError(-32003, 'Forbidden'));
    if (required === 'create' && modelName === 'base.model_access') {
      const values = asJsonObject(args[0]);
      if (!values || !hasValidAccessRule(modelName, values))
        return reply.send(
          rpcError(-32602, 'Access rules cannot target protected or uninstalled models')
        );
    }
    if (required === 'unlink') {
      const rawIds = args[0];
      const ids =
        typeof rawIds === 'number'
          ? [rawIds]
          : Array.isArray(rawIds)
            ? rawIds.filter((value): value is number => typeof value === 'number')
            : [];
      for (const id of ids) {
        const reference = await findReference(modelName, id, modelName === 'base.partner');
        if (reference)
          return reply.status(409).send(rpcError(-32009, `Record is still used by '${reference}'`));
      }
    }
    if (required === 'write' && kwargs.active === false) {
      const rawIds = args[0];
      const ids =
        typeof rawIds === 'number'
          ? [rawIds]
          : Array.isArray(rawIds)
            ? rawIds.filter((value): value is number => typeof value === 'number')
            : [];
      for (const id of ids) {
        const reference = await findReference(modelName, id, modelName === 'base.partner');
        if (reference)
          return reply.status(409).send(rpcError(-32009, `Record is still used by '${reference}'`));
      }
    }
    try {
      const executionKwargs = requestedGraph
        ? { ...kwargs, with: relationExpression(requestedGraph) ?? requestedGraph }
        : kwargs;
      const execute = (trx?: Transaction) =>
        executeRpc(Model, method, args, executionKwargs, scope, req, trx);
      const result =
        required === 'read'
          ? await execute()
          : await inRequestTransaction(req, (trx) => execute(trx));
      return {
        jsonrpc: '2.0',
        id,
        result,
      };
    } catch (error) {
      return reply.send(rpcError(-32601, errorMessage(error, 'Execution error')));
    }
  });
};
