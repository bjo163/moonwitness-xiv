import { CronExpressionParser } from 'cron-parser';
import type { Transaction } from 'objection';
import { Environment } from '@moonwitness/orm';
import { Company, CompanyMembership, User } from '@moonwitness/orm-base';
import { Cron, Job, JobRun, OutboxEvent } from './models.js';

interface RegisteredHandler {
  version: number;
  parse(payload: unknown): unknown;
  run(payload: unknown, context: JobContext): Promise<unknown>;
}

export interface JobHandler<TPayload> {
  name: string;
  version: number;
  parse(payload: unknown): TPayload;
  run(payload: TPayload, context: JobContext): Promise<unknown>;
}

export interface EnqueueOptions {
  companyId?: number;
  requestedBy?: number;
  idempotencyKey?: string;
  availableAt?: Date;
  priority?: number;
  maxAttempts?: number;
}

export interface JobContext {
  jobId: number;
  attempt: number;
  idempotencyKey: string;
  companyId?: number;
  requestedBy?: number;
  env: Environment;
  signal: AbortSignal;
}

export class PermanentJobError extends Error {
  constructor(
    message: string,
    readonly code = 'PERMANENT_JOB_ERROR'
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super('The job lease was lost before the worker could commit its result');
    this.name = 'LeaseLostError';
  }
}

class JobCancelledError extends Error {
  constructor() {
    super('The job was cancelled by an operator');
    this.name = 'JobCancelledError';
  }
}

const handlers = new Map<string, RegisteredHandler>();
export interface OutboxContext {
  eventId: number;
  eventType: string;
  companyId?: number;
  requestedBy?: number;
  env: Environment;
  signal: AbortSignal;
}

const outboxConsumers = new Map<
  string,
  (payload: unknown, eventId: number, context: OutboxContext) => Promise<void>
>();

function supportsSkipLocked(model: typeof Job | typeof Cron | typeof OutboxEvent): boolean {
  const client = String(model.knex().client.config.client);
  return client.includes('pg') || client.includes('postgres') || client.includes('mysql');
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function registerJobHandler<TPayload>(handler: JobHandler<TPayload>): () => void {
  if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(handler.name)) {
    throw new Error(`Invalid job handler name: ${handler.name}`);
  }
  if (!Number.isInteger(handler.version) || handler.version < 1) {
    throw new Error(`Invalid job handler version: ${handler.name}`);
  }
  if (handlers.has(handler.name))
    throw new Error(`Job handler already registered: ${handler.name}`);
  handlers.set(handler.name, {
    version: handler.version,
    parse: handler.parse,
    run: (payload, context) => handler.run(handler.parse(payload), context),
  });
  return () => handlers.delete(handler.name);
}

export function registerOutboxConsumer(
  eventType: string,
  consume: (payload: unknown, eventId: number, context: OutboxContext) => Promise<void>
): () => void {
  if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(eventType))
    throw new Error(`Invalid outbox event type: ${eventType}`);
  if (outboxConsumers.has(eventType))
    throw new Error(`Outbox consumer already registered: ${eventType}`);
  outboxConsumers.set(eventType, consume);
  return () => outboxConsumers.delete(eventType);
}

export async function enqueueJob<TPayload>(
  handlerName: string,
  payload: TPayload,
  options: EnqueueOptions = {}
): Promise<number> {
  const handler = handlers.get(handlerName);
  if (!handler) throw new Error(`Unknown job handler: ${handlerName}`);
  const validated = handler.parse(payload);
  const serialized = JSON.stringify(validated);
  if (serialized === undefined) throw new Error('Job payload must be JSON serializable');
  if (options.idempotencyKey) {
    const existing = await Job.query().findOne({ idempotency_key: options.idempotencyKey });
    if (existing) return existing.id;
  }
  try {
    const job = await Job.query().insertAndFetch({
      handler: handlerName,
      handler_version: handler.version,
      payload: serialized,
      company_id: options.companyId,
      requested_by_id: options.requestedBy,
      idempotency_key: options.idempotencyKey,
      available_at: (options.availableAt ?? new Date()).toISOString(),
      priority: options.priority ?? 0,
      max_attempts: options.maxAttempts ?? 5,
    });
    return job.id;
  } catch (error) {
    if (options.idempotencyKey) {
      const raced = await Job.query().findOne({ idempotency_key: options.idempotencyKey });
      if (raced) return raced.id;
    }
    throw error;
  }
}

interface JobRecord {
  id: number;
  handler: string;
  handler_version: number;
  payload: string;
  company_id?: number | null;
  requested_by_id?: number | null;
  idempotency_key?: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  fencing_token: number;
  cancel_requested: boolean;
}

interface RunRecord {
  id: number;
}

interface Claim {
  job: JobRecord;
  run: RunRecord;
  workerId: string;
}

function sanitizeError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : 'Unknown job failure';
  const code = error instanceof PermanentJobError ? error.code : 'JOB_FAILED';
  return {
    code: code.slice(0, 100),
    message: message
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/(password|secret|token|credential)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
      .slice(0, 2000),
  };
}

async function claimNext(workerId: string, leaseSeconds: number): Promise<Claim | null> {
  return Job.transaction(async (trx) => {
    const now = new Date();
    let candidateQuery = Job.query(trx)
      .where((query) =>
        query
          .where((queued) =>
            queued.where('status', 'queued').where('available_at', '<=', now.toISOString())
          )
          .orWhere((expired) =>
            expired.where('status', 'running').where('lease_until', '<', now.toISOString())
          )
      )
      .orderBy('priority', 'desc')
      .orderBy('available_at', 'asc')
      .orderBy('id', 'asc')
      .forUpdate();
    if (supportsSkipLocked(Job)) candidateQuery = candidateQuery.skipLocked();
    const job = (await candidateQuery.first()) as
      (InstanceType<typeof Job> & JobRecord) | undefined;
    if (!job) return null;

    if (job.status === 'running' && job.cancel_requested) {
      await Job.query(trx).findById(job.id).patch({
        status: 'cancelled',
        cancel_requested: false,
        lease_owner: null,
        lease_until: null,
      });
      await JobRun.query(trx)
        .where({ job_id: job.id, attempt: job.attempts, status: 'running' })
        .patch({
          status: 'cancelled',
          finished_at: now.toISOString(),
          error_code: 'JOB_CANCELLED',
          error_message: 'Cancellation completed after the previous worker lease expired',
        });
      return null;
    }

    if (job.attempts >= job.max_attempts) {
      await Job.query(trx).findById(job.id).patch({
        status: 'dead',
        lease_owner: null,
        lease_until: null,
      });
      await JobRun.query(trx)
        .where({ job_id: job.id, attempt: job.attempts, status: 'running' })
        .patch({
          status: 'dead',
          finished_at: now.toISOString(),
          error_code: 'LEASE_EXPIRED',
          error_message: 'Worker lease expired after the maximum number of attempts',
        });
      return null;
    }

    if (job.status === 'running') {
      await JobRun.query(trx)
        .where({ job_id: job.id, attempt: job.attempts, status: 'running' })
        .patch({
          status: 'retrying',
          finished_at: now.toISOString(),
          error_code: 'LEASE_EXPIRED',
          error_message: 'Worker lease expired; the job was reclaimed',
        });
    }

    const attempt = job.attempts + 1;
    const fencingToken = job.fencing_token + 1;
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    await Job.query(trx).findById(job.id).patch({
      status: 'running',
      attempts: attempt,
      lease_owner: workerId,
      lease_until: leaseUntil,
      fencing_token: fencingToken,
    });
    const run = (await JobRun.query(trx).insertAndFetch({
      job_id: job.id,
      attempt,
      worker_id: workerId,
      status: 'running',
      started_at: now.toISOString(),
    })) as InstanceType<typeof JobRun> & RunRecord;
    return {
      job: { ...job, attempts: attempt, fencing_token: fencingToken, cancel_requested: false },
      run,
      workerId,
    };
  });
}

async function commitJobResult(
  claim: Claim,
  status: 'succeeded' | 'queued' | 'dead' | 'cancelled',
  details: { errorCode?: string; errorMessage?: string; result?: string; availableAt?: string }
): Promise<void> {
  const trx = await Job.startTransaction();
  try {
    const update = Job.query(trx)
      .where({
        id: claim.job.id,
        fencing_token: claim.job.fencing_token,
        lease_owner: claim.workerId,
      })
      .where({ status: 'running' });
    if (status === 'succeeded') update.where({ cancel_requested: false });
    let finalStatus = status;
    const patch = await update.patch({
      status,
      available_at: details.availableAt,
      lease_owner: null,
      lease_until: null,
      cancel_requested: status === 'cancelled' ? false : claim.job.cancel_requested,
    });
    let finalDetails = details;
    if (patch !== 1 && status === 'succeeded') {
      const cancellation = await Job.query(trx)
        .where({
          id: claim.job.id,
          fencing_token: claim.job.fencing_token,
          lease_owner: claim.workerId,
          status: 'running',
          cancel_requested: true,
        })
        .patch({
          status: 'cancelled',
          lease_owner: null,
          lease_until: null,
          cancel_requested: false,
        });
      if (cancellation === 1) {
        finalStatus = 'cancelled';
        finalDetails = {
          errorCode: 'JOB_CANCELLED',
          errorMessage: 'Job cancellation was requested before its result was committed',
        };
      } else {
        throw new LeaseLostError();
      }
    } else if (patch !== 1) {
      throw new LeaseLostError();
    }
    const runStatus =
      finalStatus === 'queued' ? 'retrying' : finalStatus === 'dead' ? 'dead' : finalStatus;
    await JobRun.query(trx).findById(claim.run.id).patch({
      status: runStatus,
      finished_at: new Date().toISOString(),
      error_code: finalDetails.errorCode,
      error_message: finalDetails.errorMessage,
      result: finalDetails.result,
    });
    await trx.commit();
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export interface WorkerOptions {
  workerId: string;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  retryBaseSeconds?: number;
  retryMaxSeconds?: number;
}

export async function runOneJob(options: WorkerOptions): Promise<boolean> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  if (!options.workerId || options.workerId.length > 255)
    throw new Error('workerId must contain 1 to 255 characters');
  if (!Number.isFinite(leaseSeconds) || leaseSeconds < 3)
    throw new Error('leaseSeconds must be at least 3');
  const claim = await claimNext(options.workerId, leaseSeconds);
  if (!claim) return false;
  const handler = handlers.get(claim.job.handler);
  if (!handler || handler.version !== claim.job.handler_version) {
    const error = new PermanentJobError(
      `Handler '${claim.job.handler}' version ${claim.job.handler_version} is unavailable`,
      'HANDLER_UNAVAILABLE'
    );
    const safe = sanitizeError(error);
    await commitJobResult(claim, 'dead', { errorCode: safe.code, errorMessage: safe.message });
    return true;
  }

  const controller = new AbortController();
  const heartbeatEvery = Math.max(
    1000,
    (options.heartbeatSeconds ?? Math.max(1, Math.floor(leaseSeconds / 3))) * 1000
  );
  const heartbeat = setInterval(() => {
    void (async () => {
      const current = await Job.query()
        .where({
          id: claim.job.id,
          lease_owner: claim.workerId,
          fencing_token: claim.job.fencing_token,
        })
        .where({ status: 'running' })
        .first();
      if (!current) {
        controller.abort(new LeaseLostError());
        return;
      }
      if (current.cancel_requested) {
        controller.abort(new JobCancelledError());
        return;
      }
      const updated = await Job.query()
        .where({
          id: claim.job.id,
          lease_owner: claim.workerId,
          fencing_token: claim.job.fencing_token,
        })
        .where({ status: 'running' })
        .patch({ lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString() });
      if (updated !== 1) controller.abort(new LeaseLostError());
    })().catch(() => controller.abort(new LeaseLostError()));
  }, heartbeatEvery);
  heartbeat.unref?.();

  try {
    const context = await createJobContext(claim.job, controller.signal);
    const payload: unknown = JSON.parse(claim.job.payload);
    const result = await handler.run(payload, context);
    if (controller.signal.aborted) throw controller.signal.reason;
    const encodedResult = result === undefined ? undefined : JSON.stringify(result);
    await commitJobResult(claim, 'succeeded', { result: encodedResult });
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    const safe = sanitizeError(error);
    const cancelled =
      error instanceof JobCancelledError || controller.signal.aborted || claim.job.cancel_requested;
    const retryable = !(error instanceof PermanentJobError);
    const shouldRetry = !cancelled && retryable && claim.job.attempts < claim.job.max_attempts;
    const base = options.retryBaseSeconds ?? 2;
    const ceiling = options.retryMaxSeconds ?? 3600;
    const delaySeconds = Math.min(ceiling, base * 2 ** Math.max(0, claim.job.attempts - 1));
    const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    await commitJobResult(claim, cancelled ? 'cancelled' : shouldRetry ? 'queued' : 'dead', {
      errorCode: safe.code,
      errorMessage: safe.message,
      availableAt: shouldRetry ? availableAt : undefined,
    });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

async function createJobContext(job: JobRecord, signal: AbortSignal): Promise<JobContext> {
  let companyId = job.company_id ?? undefined;
  const requestedBy = job.requested_by_id ?? undefined;
  let actorRole: string | undefined;
  if (requestedBy !== undefined) {
    const user = await User.query().where({ id: requestedBy, active: true }).first();
    if (!user)
      throw new PermanentJobError('Job actor is inactive or unavailable', 'ACTOR_UNAVAILABLE');
    actorRole = user.role;
    const memberships = await CompanyMembership.query()
      .where({ user_id: requestedBy, active: true })
      .orderBy('is_default', 'desc')
      .orderBy('company_id', 'asc');
    if (memberships.length === 0)
      throw new PermanentJobError(
        'Job actor has no active company membership',
        'COMPANY_ACCESS_REVOKED'
      );
    if (companyId === undefined) companyId = memberships[0]?.company_id;
    if (companyId !== undefined) {
      const membership = memberships.find(({ company_id }) => company_id === companyId);
      if (!membership)
        throw new PermanentJobError(
          'Job actor no longer has company access',
          'COMPANY_ACCESS_REVOKED'
        );
    }
  }
  if (companyId !== undefined) {
    const company = await Company.query().where({ id: companyId, active: true }).first();
    if (!company)
      throw new PermanentJobError('Job company is inactive or unavailable', 'COMPANY_UNAVAILABLE');
  }
  return {
    jobId: job.id,
    attempt: job.attempts,
    idempotencyKey: job.idempotency_key ?? `job:${job.id}`,
    companyId,
    requestedBy,
    env: new Environment({ userId: requestedBy, role: actorRole, companyId }),
    signal,
  };
}

export async function runWorkerLoop(
  options: WorkerOptions,
  signal: AbortSignal,
  idleDelayMs = 1000
): Promise<void> {
  while (!signal.aborted) {
    const processed = await runOneJob(options);
    if (!processed) await waitFor(idleDelayMs, signal);
  }
}

export interface SchedulerOptions {
  now?: Date;
  limit?: number;
}

/**
 * A stored cron whose payload can never produce a job, as distinct from a transient storage failure: the
 * registered handler rejects it, or it is not JSON. Only this class disarms a cron.
 */
class CronPayloadRejection extends Error {
  constructor(cron: { code: string; handler: string }) {
    super(`Cron "${cron.code}" payload was rejected by handler "${cron.handler}"`);
    this.name = 'CronPayloadRejection';
  }
}

export async function enqueueDueCrons(options: SchedulerOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const due = await Cron.query()
    .where({ enabled: true, active: true })
    .where('next_run_at', '<=', now.toISOString())
    .orderBy('next_run_at', 'asc')
    .limit(limit);
  let enqueued = 0;
  for (const cron of due) {
    try {
      await Cron.transaction(async (trx) => {
        let lockQuery = Cron.query(trx).findById(cron.id).forUpdate();
        if (supportsSkipLocked(Cron)) lockQuery = lockQuery.skipLocked();
        const locked = await lockQuery;
        if (!locked || !locked.enabled || locked.next_run_at > now.toISOString()) return;
        const occurrences: Date[] = [];
        const iterator = CronExpressionParser.parse(locked.cron_expression, {
          currentDate: new Date(new Date(locked.next_run_at).getTime() - 1000),
          tz: locked.timezone,
        });
        for (let index = 0; index < 10_000; index += 1) {
          const occurrence = iterator.next().toDate();
          if (occurrence > now) break;
          occurrences.push(occurrence);
        }
        if (occurrences.length === 0) return;
        const policy = locked.misfire_policy;
        const selected =
          policy === 'skip'
            ? []
            : policy === 'coalesce'
              ? [occurrences[0]]
              : occurrences.slice(0, Math.max(1, locked.max_catch_up));
        const currentlyRunning = await Job.query(trx)
          .where({ cron_id: locked.id, status: 'running' })
          .first();
        const queued = await Job.query(trx).where({ cron_id: locked.id, status: 'queued' });
        if (locked.concurrency_policy === 'forbid' && (currentlyRunning || queued.length > 0)) {
          selected.length = 0;
        } else if (locked.concurrency_policy === 'replace') {
          if (currentlyRunning) {
            await Job.query(trx).findById(currentlyRunning.id).patch({ cancel_requested: true });
          }
          for (const pending of queued) {
            await Job.query(trx).findById(pending.id).patch({ status: 'cancelled' });
          }
        }
        const selectedKeys = new Set(selected.map((date) => date.toISOString()));
        for (const occurrence of occurrences) {
          if (!selectedKeys.has(occurrence.toISOString())) continue;
          const scheduleKey = `cron:${locked.id}:${occurrence.toISOString()}`;
          const existing = await Job.query(trx).findOne({ schedule_key: scheduleKey });
          if (existing) continue;
          const registered = handlers.get(locked.handler);
          if (!registered || registered.version !== locked.handler_version) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(locked.payload);
          } catch {
            throw new CronPayloadRejection(locked);
          }
          try {
            registered.parse(payload);
          } catch {
            throw new CronPayloadRejection(locked);
          }
          await Job.query(trx).insert({
            handler: locked.handler,
            handler_version: locked.handler_version,
            payload: locked.payload,
            company_id: locked.company_id,
            requested_by_id: locked.requested_by_id,
            cron_id: locked.id,
            schedule_key: scheduleKey,
            available_at: now.toISOString(),
            max_attempts: 5,
          });
          enqueued += 1;
        }
        const nextExpression = CronExpressionParser.parse(locked.cron_expression, {
          currentDate: now,
          tz: locked.timezone,
        });
        await Cron.query(trx).findById(locked.id).patch({
          next_run_at: nextExpression.next().toDate().toISOString(),
        });
      });
    } catch (error) {
      if (!(error instanceof CronPayloadRejection)) throw error;
      await Cron.query().findById(cron.id).patch({ enabled: false });
      console.error(
        `${error.message}. Disarmed so one broken row cannot stall the queue or exit the scheduler; ` +
          'correct its payload and re-enable it to resume.'
      );
    }
  }
  return enqueued;
}

export async function runSchedulerLoop(
  signal: AbortSignal,
  pollIntervalMs = 15_000
): Promise<void> {
  while (!signal.aborted) {
    await enqueueDueCrons();
    if (signal.aborted) break;
    await waitFor(pollIntervalMs, signal);
  }
}

interface OutboxClaim {
  id: number;
  event_type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  fencing_token: number;
  company_id?: number | null;
  actor_id?: number | null;
}

export async function dispatchOneOutboxEvent(
  workerId: string,
  leaseSeconds = 60
): Promise<boolean> {
  if (!workerId || workerId.length > 255)
    throw new Error('workerId must contain 1 to 255 characters');
  if (!Number.isFinite(leaseSeconds) || leaseSeconds < 3)
    throw new Error('leaseSeconds must be at least 3');
  const claim = await OutboxEvent.transaction(async (trx) => {
    const now = new Date();
    let query = OutboxEvent.query(trx)
      .where((builder) =>
        builder
          .where((pending) =>
            pending.where('status', 'pending').where('available_at', '<=', now.toISOString())
          )
          .orWhere((expired) =>
            expired.where('status', 'processing').where('lease_until', '<', now.toISOString())
          )
      )
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .forUpdate();
    if (supportsSkipLocked(OutboxEvent)) query = query.skipLocked();
    const event = (await query.first()) as
      (InstanceType<typeof OutboxEvent> & OutboxClaim) | undefined;
    if (!event) return null;
    if (event.status === 'processing' && event.attempts >= event.max_attempts) {
      await OutboxEvent.query(trx).findById(event.id).patch({
        status: 'dead',
        lease_owner: null,
        lease_until: null,
        last_error: 'LEASE_EXPIRED: maximum delivery attempts reached',
      });
      return null;
    }
    const attempt = event.attempts + 1;
    const fencingToken = event.fencing_token + 1;
    await OutboxEvent.query(trx)
      .findById(event.id)
      .patch({
        status: 'processing',
        attempts: attempt,
        lease_owner: workerId,
        lease_until: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
        fencing_token: fencingToken,
      });
    return { ...event, attempts: attempt, fencing_token: fencingToken };
  });
  if (!claim) return false;
  const consumer = outboxConsumers.get(claim.event_type);
  if (!consumer) {
    await OutboxEvent.query()
      .where({
        id: claim.id,
        fencing_token: claim.fencing_token,
        lease_owner: workerId,
        status: 'processing',
      })
      .patch({
        status: 'pending',
        available_at: new Date(Date.now() + 60_000).toISOString(),
        lease_owner: null,
        lease_until: null,
        last_error: `OUTBOX_CONSUMER_UNAVAILABLE: no consumer registered for ${claim.event_type}`,
      });
    return true;
  }
  const controller = new AbortController();
  const heartbeat = setInterval(
    () => {
      void (async () => {
        const current = await OutboxEvent.query()
          .where({ id: claim.id, lease_owner: workerId, fencing_token: claim.fencing_token })
          .where({ status: 'processing' })
          .first();
        if (!current) {
          controller.abort(new LeaseLostError());
          return;
        }
        const updated = await OutboxEvent.query()
          .where({ id: claim.id, lease_owner: workerId, fencing_token: claim.fencing_token })
          .where({ status: 'processing' })
          .patch({ lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString() });
        if (updated !== 1) controller.abort(new LeaseLostError());
      })().catch(() => controller.abort(new LeaseLostError()));
    },
    Math.max(1000, Math.floor((leaseSeconds * 1000) / 3))
  );
  heartbeat.unref?.();
  try {
    const payload: unknown = JSON.parse(claim.payload);
    const companyId = claim.company_id ?? undefined;
    const requestedBy = claim.actor_id ?? undefined;
    if (
      companyId !== undefined &&
      !(await Company.query().where({ id: companyId, active: true }).first())
    )
      throw new PermanentJobError(
        'Outbox company is inactive or unavailable',
        'COMPANY_UNAVAILABLE'
      );
    if (requestedBy !== undefined) {
      if (!(await User.query().where({ id: requestedBy, active: true }).first()))
        throw new PermanentJobError('Outbox actor is inactive or unavailable', 'ACTOR_UNAVAILABLE');
      if (
        companyId !== undefined &&
        !(await CompanyMembership.query()
          .where({ user_id: requestedBy, company_id: companyId, active: true })
          .first())
      )
        throw new PermanentJobError(
          'Outbox actor no longer has company access',
          'COMPANY_ACCESS_REVOKED'
        );
    }
    await consumer(payload, claim.id, {
      eventId: claim.id,
      eventType: claim.event_type,
      companyId,
      requestedBy,
      env: new Environment({ userId: requestedBy, companyId }),
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    const updated = await OutboxEvent.query()
      .where({
        id: claim.id,
        fencing_token: claim.fencing_token,
        lease_owner: workerId,
        status: 'processing',
      })
      .patch({
        status: 'published',
        published_at: new Date().toISOString(),
        lease_owner: null,
        lease_until: null,
        last_error: null,
      });
    if (updated !== 1) throw new LeaseLostError();
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    const safe = sanitizeError(error);
    const dead = error instanceof PermanentJobError || claim.attempts >= claim.max_attempts;
    await OutboxEvent.query()
      .where({
        id: claim.id,
        fencing_token: claim.fencing_token,
        lease_owner: workerId,
        status: 'processing',
      })
      .patch({
        status: dead ? 'dead' : 'pending',
        available_at: new Date(
          Date.now() + Math.min(3600, 2 ** claim.attempts) * 1000
        ).toISOString(),
        lease_owner: null,
        lease_until: null,
        last_error: `${safe.code}: ${safe.message}`,
      });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export async function runOutboxLoop(
  workerId: string,
  signal: AbortSignal,
  idleDelayMs = 1000
): Promise<void> {
  while (!signal.aborted) {
    const processed = await dispatchOneOutboxEvent(workerId);
    if (!processed) await waitFor(idleDelayMs, signal);
  }
}

export async function cancelJob(jobId: number, transaction?: Transaction): Promise<boolean> {
  const job = await Job.query(transaction).findById(jobId);
  if (!job) return false;
  if (job.status === 'running') {
    const requested = await Job.query(transaction)
      .where({ id: jobId, status: 'running' })
      .patch({ cancel_requested: true });
    return requested === 1;
  }
  if (job.status !== 'queued') return false;
  const cancelled = await Job.query(transaction)
    .where({ id: jobId, status: 'queued' })
    .patch({ status: 'cancelled' });
  return cancelled === 1;
}
