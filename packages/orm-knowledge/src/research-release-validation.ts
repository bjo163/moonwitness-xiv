import {
  validateResearchAssertion,
  validateResearchEvidenceReference,
  validateResearchGraph,
  validateResearchRelation,
  type ResearchEvidenceReference,
  type ResearchGraphNode,
  type ResearchRelation,
  type ResearchVisibility,
} from '@moonwitness/research';
import { WorkflowError } from '@moonwitness/orm-workflow';
import type { StoredResearchGraphRecord } from './research-release.js';

export const visibilityOrder: Record<ResearchVisibility, number> = {
  PUBLIC_APPROVED: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  CHILD_SENSITIVE: 4,
};

function fail(code: ConstructorParameters<typeof WorkflowError>[0], message: string): never {
  throw new WorkflowError(code, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getVisibility(value: unknown): ResearchVisibility {
  if (
    value === 'PUBLIC_APPROVED' ||
    value === 'INTERNAL' ||
    value === 'CONFIDENTIAL' ||
    value === 'RESTRICTED' ||
    value === 'CHILD_SENSITIVE'
  ) {
    return value;
  }
  return fail('INVALID_EVENT_PAYLOAD', 'Research record visibility is invalid');
}

function maxVisibility(left: ResearchVisibility, right: ResearchVisibility): ResearchVisibility {
  return visibilityOrder[left] >= visibilityOrder[right] ? left : right;
}

/** Generic PUBLIC storage is deliberately only an INTERNAL floor, never publication approval. */
function storageVisibilityFloor(
  value: StoredResearchGraphRecord['visibility']
): ResearchVisibility {
  return value === 'RESTRICTED' ? 'RESTRICTED' : 'INTERNAL';
}

export function reviewVisibility(
  record: StoredResearchGraphRecord,
  content: Record<string, unknown>
) {
  return maxVisibility(
    storageVisibilityFloor(record.visibility),
    getVisibility(content.visibility)
  );
}

export function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (!isObject(value)) return fail('INVALID_EVENT_PAYLOAD', message);
  return value;
}

export function canonicalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^mw:[a-z]+(?:-[a-z]+)*:[a-z0-9][a-z0-9._-]{0,179}(?::[a-z0-9][a-z0-9._-]{0,179})*$/u.test(
      value
    )
  );
}

export function evidenceReference(record: StoredResearchGraphRecord): ResearchEvidenceReference {
  const content = assertObject(record.content, 'Research evidence record is invalid');
  const candidate = {
    id: content.id,
    assertion_id: content.assertion_id,
    direction: content.direction,
    selector: content.selector,
  };
  const validation = validateResearchEvidenceReference(candidate);
  if (
    record.kind !== 'evidence' ||
    content.kind !== 'Evidence' ||
    content.id !== record.key ||
    !validation.valid
  ) {
    return fail('INVALID_EVENT_PAYLOAD', 'Research evidence record failed its schema check');
  }
  return candidate as ResearchEvidenceReference;
}

/** Validate a graph release independently of the review workflow implementation. */
export function validateResearchRelease(records: readonly StoredResearchGraphRecord[]) {
  const nodes: ResearchGraphNode[] = [];
  const relations: ResearchRelation[] = [];
  const evidence = new Map<string, ResearchEvidenceReference>();
  const contentById = new Map<string, Record<string, unknown>>();

  for (const record of records) {
    const content = assertObject(record.content, 'Research graph record content is invalid');
    if (content.id !== record.key || !canonicalId(record.key)) {
      fail('INVALID_EVENT_PAYLOAD', 'Research graph record key does not match its canonical id');
    }
    const visibility = reviewVisibility(record, content);
    const projected = { ...content, visibility };
    if (record.kind === 'relation') {
      if (content.kind !== 'ResearchRelation' || !validateResearchRelation(projected).valid) {
        fail('INVALID_EVENT_PAYLOAD', 'Research relation failed its schema check');
      }
      relations.push(projected as unknown as ResearchRelation);
      contentById.set(record.key, projected);
    } else {
      if (record.kind === 'assertion') {
        if (content.kind !== 'Assertion' || !validateResearchAssertion(projected).valid) {
          fail('INVALID_EVENT_PAYLOAD', 'Research assertion failed its schema check');
        }
      } else if (record.kind === 'evidence') {
        evidence.set(record.key, evidenceReference(record));
        if (content.kind !== 'Evidence')
          fail('INVALID_EVENT_PAYLOAD', 'Research evidence kind is invalid');
      } else if (
        (record.kind === 'source' && content.kind !== 'Artifact') ||
        (record.kind === 'expression' &&
          !['Expression', 'Edition', 'Passage', 'Content'].includes(String(content.kind))) ||
        !['node', 'source', 'expression', 'assertion', 'evidence'].includes(record.kind)
      ) {
        fail('INVALID_EVENT_PAYLOAD', 'Research graph node kind does not match its record kind');
      }
      const node = {
        id: String(content.id),
        kind: content.kind,
        visibility,
        ...(content.identity_class === undefined ? {} : { identity_class: content.identity_class }),
      };
      nodes.push(node as ResearchGraphNode);
      contentById.set(record.key, projected);
    }
  }

  const graphValidation = validateResearchGraph({ nodes, relations });
  if (!graphValidation.valid) {
    fail('INVALID_EVENT_PAYLOAD', 'Active research release failed full graph validation');
  }
  const graphNodeIds = new Set(nodes.map((node) => node.id));
  for (const reference of evidence.values()) {
    if (
      !graphNodeIds.has(reference.selector.source_id) ||
      !graphNodeIds.has(reference.selector.edition_id) ||
      ('expression_id' in reference.selector && !graphNodeIds.has(reference.selector.expression_id))
    ) {
      fail(
        'INVALID_EVENT_PAYLOAD',
        'Evidence source and edition identities must exist in the active graph'
      );
    }
  }
  return { nodes, relations, evidence, contentById };
}
