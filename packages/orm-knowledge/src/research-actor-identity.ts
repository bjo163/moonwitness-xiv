import type { Knex } from 'knex';

const canonicalUserIdPattern = /^mw:user:[a-z0-9][a-z0-9._-]{0,179}$/u;

export interface AuthenticatedIdentityProvisioner {
  /** Populated by trusted server authentication middleware. */
  readonly userId: number;
  readonly role: 'user' | 'superadmin';
}

export interface ProvisionResearchActorIdentityInput {
  readonly authenticatedProvisioner: AuthenticatedIdentityProvisioner;
  /** Explicit active row in base.users; never inferred from a login or SQL identifier. */
  readonly targetUserId: number;
  /** Explicit stable identity in the approved ontology namespace. */
  readonly canonicalUserId: string;
  readonly reason: string;
  readonly requestId: string;
}

export type ResearchActorIdentityProvisioningErrorCode =
  'INVALID_INPUT' | 'FORBIDDEN' | 'TARGET_NOT_FOUND' | 'CONFLICT';

export class ResearchActorIdentityProvisioningError extends Error {
  constructor(
    readonly code: ResearchActorIdentityProvisioningErrorCode,
    message: string
  ) {
    super(`Research actor identity provisioning: ${message}`);
    this.name = 'ResearchActorIdentityProvisioningError';
  }
}

function fail(code: ResearchActorIdentityProvisioningErrorCode, message: string): never {
  throw new ResearchActorIdentityProvisioningError(code, message);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Provision one explicit user-to-canonical-identity mapping and its audit event.
 * The caller owns the transaction boundary; this function rejects non-transaction handles.
 */
export async function provisionResearchActorIdentity(
  trx: Knex.Transaction,
  input: ProvisionResearchActorIdentityInput
): Promise<{ id: number; userId: number; canonicalUserId: string; requestId: string }> {
  if (!trx || typeof trx.commit !== 'function' || typeof trx.rollback !== 'function') {
    return fail('INVALID_INPUT', 'an active database transaction is required');
  }
  if (
    !input ||
    !Number.isSafeInteger(input.authenticatedProvisioner?.userId) ||
    input.authenticatedProvisioner.userId <= 0 ||
    !Number.isSafeInteger(input.targetUserId) ||
    input.targetUserId <= 0 ||
    !nonemptyString(input.canonicalUserId) ||
    !canonicalUserIdPattern.test(input.canonicalUserId) ||
    !nonemptyString(input.reason) ||
    input.reason.trim().length > 500 ||
    !nonemptyString(input.requestId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(input.requestId)
  ) {
    return fail(
      'INVALID_INPUT',
      'all explicit identity fields, reason, and request ID are required'
    );
  }

  // Verify the asserted context against the database. Caller-provided role alone is insufficient.
  const provisioner = await trx('users as user')
    .join('partners as partner', 'partner.id', 'user.partner_id')
    .where({
      'user.id': input.authenticatedProvisioner.userId,
      'user.active': true,
      'partner.active': true,
    })
    .forUpdate()
    .first('user.id as id', 'user.role');
  if (
    !provisioner ||
    provisioner.role !== 'superadmin' ||
    input.authenticatedProvisioner.role !== 'superadmin'
  ) {
    return fail('FORBIDDEN', 'an authenticated active superadmin is required');
  }

  const target = await trx('users as user')
    .join('partners as partner', 'partner.id', 'user.partner_id')
    .where({ 'user.id': input.targetUserId, 'user.active': true, 'partner.active': true })
    .forUpdate()
    .first('user.id as id');
  if (!target)
    return fail('TARGET_NOT_FOUND', 'the explicit target user does not exist or is inactive');

  // Serialize conflicting writes, then fail closed on every uniqueness collision.
  const byRequest = await trx('knowledge_research_actor_identities')
    .where({ request_id: input.requestId })
    .first('id', 'user_id', 'canonical_user_id', 'provisioned_by_id', 'reason');
  if (byRequest) {
    if (
      Number(byRequest.user_id) === input.targetUserId &&
      byRequest.canonical_user_id === input.canonicalUserId &&
      Number(byRequest.provisioned_by_id) === provisioner.id &&
      byRequest.reason === input.reason.trim()
    ) {
      return {
        id: Number(byRequest.id),
        userId: input.targetUserId,
        canonicalUserId: input.canonicalUserId,
        requestId: input.requestId,
      };
    }
    return fail(
      'CONFLICT',
      'the request ID is already provisioned for a different identity mapping'
    );
  }

  const byUser = await trx('knowledge_research_actor_identities')
    .where({ user_id: input.targetUserId })
    .first('id', 'canonical_user_id');
  const byCanonical = await trx('knowledge_research_actor_identities')
    .where({ canonical_user_id: input.canonicalUserId })
    .first('id', 'user_id');
  if (byUser || byCanonical) {
    return fail('CONFLICT', 'a user or canonical identity is already provisioned');
  }

  const [inserted] = await trx('knowledge_research_actor_identities')
    .insert({
      user_id: input.targetUserId,
      canonical_user_id: input.canonicalUserId,
      request_id: input.requestId,
      provisioned_by_id: provisioner.id,
      reason: input.reason.trim(),
    })
    .returning(['id']);
  const id = Number(typeof inserted === 'object' ? inserted.id : inserted);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return fail('INVALID_INPUT', 'mapping insert returned no valid ID');
  }

  const changes = JSON.stringify({
    target_user_id: input.targetUserId,
    canonical_user_id: input.canonicalUserId,
    request_id: input.requestId,
    reason: input.reason.trim(),
  });
  await trx('audit_logs').insert({
    model: 'knowledge.research_actor_identity',
    record_id: id,
    operation: 'provision',
    actor_id: provisioner.id,
    changes,
  });

  return {
    id,
    userId: input.targetUserId,
    canonicalUserId: input.canonicalUserId,
    requestId: input.requestId,
  };
}
