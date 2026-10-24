/** Operations a role may perform on a model through the generic REST / JSON-RPC API. */
export type Operation = 'read' | 'create' | 'write' | 'unlink' | 'action';

/** Never reachable through the generic API, whatever the role (tokens, sessions, ...). */
const INTERNAL_PREFIXES = ['auth.', 'base.job', 'base.cron', 'base.outbox_event', 'workflow.'];

/** Sensitive knowledge tables are reachable only through their dedicated scoped API routes. */
const NON_GENERIC_MODELS = new Set([
  'knowledge.privacy_revocation',
  'knowledge.privacy_projection',
  'knowledge.witness_testimony',
  'knowledge.witness_correction',
  'knowledge.witness_interpretation',
  'knowledge.story_version',
  'knowledge.story_page_version',
  'knowledge.research_suggestion_version',
]);

/** Only administrative roles may touch these; ordinary users use dedicated endpoints. */
const ADMIN_ONLY_MODELS = new Set([
  'base.user',
  'base.audit_log',
  'base.access_group',
  'base.group_membership',
  'base.model_access',
  'base.company_membership',
  'base.partner_bank',
]);

const ADMIN_ROLES = new Set(['system', 'superadmin']);

/**
 * Central authorization rule. Default deny: unknown roles and unknown operations get nothing.
 *
 * - `system`: full access except internal models.
 * - `superadmin`: administers user accounts, but cannot grant or alter the system role.
 * - `user`: read-only on non-administrative models.
 */
export interface GroupModelGrant {
  model_name: string;
  read: boolean;
  create: boolean;
  write: boolean;
  unlink: boolean;
}

export function canAccess(
  role: string | undefined,
  modelName: string,
  op: Operation,
  groupGrants: readonly GroupModelGrant[] = []
): boolean {
  if (INTERNAL_PREFIXES.some((prefix) => modelName.startsWith(prefix))) return false;
  if (NON_GENERIC_MODELS.has(modelName)) return false;
  // WhatsApp mutations must pass the dedicated company-scoped queue/control routes.
  if (modelName.startsWith('whatsapp.') && op !== 'read') return false;
  if (modelName === 'base.audit_log') return ADMIN_ROLES.has(role ?? '') && op === 'read';
  if (role !== undefined && ADMIN_ROLES.has(role)) return true;
  if (role === 'user') {
    if (ADMIN_ONLY_MODELS.has(modelName)) return false;
    if (op === 'read') return true;
    const grantOperation = op === 'action' ? 'write' : op;
    return groupGrants.some((grant) => grant.model_name === modelName && grant[grantOperation]);
  }
  return false;
}

/** Only the system actor may create, promote, modify, or remove system accounts. */
export function canManageBaseUser(
  actorRole: string | undefined,
  operation: Operation,
  currentRole?: string,
  requestedRole?: string
): boolean {
  if (actorRole === 'system') return true;
  if (actorRole !== 'superadmin') return false;
  if (operation === 'read') return true;
  return currentRole !== 'system' && requestedRole !== 'system';
}

/** Maps an HTTP request on `/api/:model...` to the operation it performs. */
export function operationFor(method: string, routeUrl: string): Operation {
  if (routeUrl.endsWith('/action/:method')) return 'action';
  switch (method) {
    case 'GET':
    case 'HEAD':
      return 'read';
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'write';
    case 'DELETE':
      return 'unlink';
    default:
      return 'action';
  }
}

/** Maps a JSON-RPC `execute_kw` method to the operation it performs, if it is exposed. */
export function rpcOperation(method: string): Operation | null {
  switch (method) {
    case 'search':
    case 'search_read':
      return 'read';
    case 'create':
      return 'create';
    case 'write':
      return 'write';
    case 'unlink':
      return 'unlink';
    default:
      return null;
  }
}
