import { knowledgeRecordKinds, type KnowledgeRecordKind } from './types.js';

const idTokenPattern = '[a-z0-9]+(?:[._-][a-z0-9]+)*';
const namespacePattern = new RegExp(`^${idTokenPattern}(?![\\s\\S])`, 'u');
const canonicalIdPattern = new RegExp(
  `^mw:([a-z]+(?:-[a-z]+)*):(${idTokenPattern}(?::${idTokenPattern})*)(?![\\s\\S])`,
  'u'
);

export type CanonicalKnowledgeId = string & { readonly __brand: 'CanonicalKnowledgeId' };

export interface CanonicalIdValidation {
  valid: boolean;
  value?: CanonicalKnowledgeId;
  kind?: KnowledgeRecordKind;
  issue?: string;
}

export interface KnowledgeAlias {
  namespace: string;
  value: string;
  targetId: string;
}

export type KnowledgeIdentityReference =
  { canonicalId: string } | { alias: { namespace: string; value: string } };

export type KnowledgeIdentityResolution =
  | { status: 'resolved'; canonicalId: CanonicalKnowledgeId; via: 'canonical' | 'alias' }
  | { status: 'not-found' }
  | { status: 'conflict'; canonicalIds: CanonicalKnowledgeId[] }
  | { status: 'canonical-id-collision'; canonicalId: CanonicalKnowledgeId }
  | { status: 'invalid'; issue: string }
  | { status: 'dangling-alias'; canonicalId: CanonicalKnowledgeId };

function canonicalKindToken(kind: KnowledgeRecordKind): string {
  return kind.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase();
}

const kindByToken = new Map(
  knowledgeRecordKinds.map((kind) => [canonicalKindToken(kind), kind] as const)
);

export function validateCanonicalKnowledgeId(value: unknown): CanonicalIdValidation {
  if (typeof value !== 'string') return { valid: false, issue: 'ID must be a string.' };
  if (value.length > 500) return { valid: false, issue: 'ID exceeds 500 characters.' };

  const match = canonicalIdPattern.exec(value);
  if (!match) {
    return {
      valid: false,
      issue: 'ID must use mw:<lowercase-kind>:<canonical-token> syntax.',
    };
  }

  const kind = kindByToken.get(match[1]);
  if (!kind) return { valid: false, issue: `Unknown canonical kind token: ${match[1]}.` };

  return { valid: true, value: value as CanonicalKnowledgeId, kind };
}

function validateAlias(alias: unknown): string | undefined {
  if (typeof alias !== 'object' || alias === null) return 'Alias entry must be an object.';
  const candidate = alias as { namespace?: unknown; value?: unknown; targetId?: unknown };
  if (
    typeof candidate.namespace !== 'string' ||
    typeof candidate.value !== 'string' ||
    typeof candidate.targetId !== 'string'
  ) {
    return 'Alias namespace, value, and target ID must be strings.';
  }
  if (!namespacePattern.test(candidate.namespace))
    return 'Alias namespace must be a lowercase canonical token.';
  if (
    candidate.value.length === 0 ||
    candidate.value.length > 500 ||
    candidate.value.includes('\0')
  ) {
    return 'Alias value must contain 1 to 500 characters and no NUL.';
  }
  if (!validateCanonicalKnowledgeId(candidate.targetId).valid) {
    return `Alias target is not a valid canonical ID: ${candidate.targetId}.`;
  }
  return undefined;
}

function aliasKey(namespace: string, value: string): string {
  return `${namespace}\0${value}`;
}

/** Resolve only exact canonical IDs or explicit source namespace/value aliases. */
export function resolveKnowledgeIdentity(
  reference: KnowledgeIdentityReference,
  canonicalIds: readonly string[],
  aliases: readonly KnowledgeAlias[]
): KnowledgeIdentityResolution {
  if (typeof reference !== 'object' || reference === null) {
    return { status: 'invalid', issue: 'Identity reference must be an object.' };
  }
  if (!Array.isArray(canonicalIds) || !Array.isArray(aliases)) {
    return { status: 'invalid', issue: 'Canonical IDs and aliases must be arrays.' };
  }

  const canonicalIdSet = new Set<CanonicalKnowledgeId>();
  const duplicateIds = new Set<CanonicalKnowledgeId>();
  for (const id of canonicalIds) {
    const validation = validateCanonicalKnowledgeId(id);
    if (!validation.valid || !validation.value) {
      return { status: 'invalid', issue: `Canonical registry contains an invalid ID: ${id}.` };
    }
    if (canonicalIdSet.has(validation.value)) duplicateIds.add(validation.value);
    canonicalIdSet.add(validation.value);
  }
  const [duplicateId] = [...duplicateIds].sort();
  if (duplicateId) return { status: 'canonical-id-collision', canonicalId: duplicateId };

  if ('canonicalId' in reference) {
    if (typeof reference.canonicalId !== 'string') {
      return { status: 'invalid', issue: 'Canonical ID reference must be a string.' };
    }
    const validation = validateCanonicalKnowledgeId(reference.canonicalId);
    if (!validation.valid || !validation.value) {
      return { status: 'invalid', issue: validation.issue ?? 'Canonical ID is invalid.' };
    }
    return canonicalIdSet.has(validation.value)
      ? { status: 'resolved', canonicalId: validation.value, via: 'canonical' }
      : { status: 'not-found' };
  }

  if (!('alias' in reference) || typeof reference.alias !== 'object' || reference.alias === null) {
    return { status: 'invalid', issue: 'Identity reference must contain a canonical ID or alias.' };
  }
  if (typeof reference.alias.namespace !== 'string' || typeof reference.alias.value !== 'string') {
    return { status: 'invalid', issue: 'Alias namespace and value must be strings.' };
  }
  if (!namespacePattern.test(reference.alias.namespace)) {
    return { status: 'invalid', issue: 'Alias namespace must be a lowercase canonical token.' };
  }
  if (
    reference.alias.value.length === 0 ||
    reference.alias.value.length > 500 ||
    reference.alias.value.includes('\0')
  ) {
    return { status: 'invalid', issue: 'Alias value must contain 1 to 500 characters and no NUL.' };
  }

  const requestedKey = aliasKey(reference.alias.namespace, reference.alias.value);
  const targets = new Set<CanonicalKnowledgeId>();
  for (const alias of aliases) {
    const issue = validateAlias(alias);
    if (issue)
      return { status: 'invalid', issue: `Alias registry contains an invalid entry: ${issue}` };
    if (aliasKey(alias.namespace, alias.value) !== requestedKey) continue;
    const targetId = validateCanonicalKnowledgeId(alias.targetId).value;
    if (targetId) targets.add(targetId);
  }

  if (targets.size === 0) return { status: 'not-found' };
  const orderedTargets = [...targets].sort();
  if (orderedTargets.length > 1) return { status: 'conflict', canonicalIds: orderedTargets };

  const [canonicalId] = orderedTargets;
  if (!canonicalIdSet.has(canonicalId)) return { status: 'dangling-alias', canonicalId };
  return { status: 'resolved', canonicalId, via: 'alias' };
}
