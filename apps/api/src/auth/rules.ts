import type { Domain } from '@moonwitness/orm';
import type { FastifyRequest } from 'fastify';

export interface SecurityContext {
  userId: number;
  role: string;
  partnerId?: number;
  companyId?: number;
  request: FastifyRequest;
}

export type RecordRuleHandler = (context: SecurityContext) => Domain | Promise<Domain>;

const ruleRegistry = new Map<string, RecordRuleHandler[]>();

/** Register a dynamic record rule for a model. Multiple rules for the same model are combined (ANDed). */
export function registerRecordRule(model: string, handler: RecordRuleHandler): void {
  const existing = ruleRegistry.get(model) ?? [];
  ruleRegistry.set(model, [...existing, handler]);
}

/** Clear custom registered rules (useful for test isolation). */
export function clearRecordRules(): void {
  ruleRegistry.clear();
}

/** Reference models universally readable by all authenticated users */
const PUBLIC_MODELS = new Set(['base.country', 'base.currency', 'base.language', 'base.tag']);

/**
 * Resolves the record rule domain for the current user and model.
 * Superadmin and system actors bypass row-level filtering.
 */
export async function getRecordRuleDomain(req: FastifyRequest, modelName: string): Promise<Domain> {
  const auth = req.auth;
  if (!auth) {
    return [];
  }

  // WhatsApp credentials and conversations always belong to the selected company,
  // including when accessed through the generic model API by an administrator.
  if (modelName.startsWith('whatsapp.')) return [['company_id', '=', auth.companyId ?? -1]];

  if (auth.role === 'system' || auth.role === 'superadmin') return [];

  const context: SecurityContext = {
    userId: auth.userId,
    role: auth.role,
    partnerId: auth.partnerId,
    companyId: auth.companyId,
    request: req,
  };

  // Company scope is additive, so extension rules cannot accidentally remove tenant isolation.
  const Model = req.env.get(modelName);
  const fields = Model.fields;
  const companyDomain: Domain =
    fields && ('company' in fields || 'company_id' in fields)
      ? context.companyId !== undefined
        ? [['company_id', '=', context.companyId]]
        : [['company_id', '=', -1]]
      : [];

  if (PUBLIC_MODELS.has(modelName)) return [];

  // Check custom rules and append the immutable company boundary.
  const customRules = ruleRegistry.get(modelName);
  if (customRules && customRules.length > 0) {
    const domains: Domain = [...companyDomain];
    for (const rule of customRules) {
      const part = await rule(context);
      domains.push(...part);
    }
    return domains;
  }

  if (modelName === 'notification.notification') {
    return [...companyDomain, ['recipient_id', '=', context.userId]];
  }

  if (modelName === 'notification.preference') {
    return [...companyDomain, ['user_id', '=', context.userId]];
  }

  // 2. Default core security scopes
  if (modelName === 'base.partner') {
    return [
      ...companyDomain,
      context.partnerId !== undefined ? ['id', '=', context.partnerId] : ['id', '=', -1],
    ];
  }

  if (modelName === 'base.partner_address' || modelName === 'base.partner_category_link') {
    return context.partnerId !== undefined
      ? [['partner_id', '=', context.partnerId]]
      : [['partner_id', '=', -1]];
  }

  if (modelName === 'base.company') {
    return context.companyId !== undefined ? [['id', '=', context.companyId]] : [['id', '=', -1]];
  }

  if (companyDomain.length > 0) return companyDomain;

  // Default ownership rule for any auditable model
  return [['create_uid', '=', context.userId]];
}
