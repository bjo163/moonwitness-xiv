import {
  resolveResearchEvidenceReference,
  validateResearchEvidenceReference,
  type ResearchEvidenceReference,
  type ResolvedEvidenceReference,
  type ResolvablePassage,
} from './evidence.js';
import {
  validateResearchGraph,
  type ResearchGraphInput,
  type ResearchRelation,
  type ResearchVisibility,
} from './relation.js';

export interface ExplainedRelation {
  id: ResearchRelation['id'];
  kind: ResearchRelation['kind'];
  schema_version: ResearchRelation['schema_version'];
  content_revision: ResearchRelation['content_revision'];
  predicate: ResearchRelation['predicate'];
  subject_id: ResearchRelation['subject_id'];
  object_id: ResearchRelation['object_id'];
  scope: ResearchRelation['scope'];
  epistemic_status: ResearchRelation['epistemic_status'];
  review_status: ResearchRelation['review_status'];
  supporting_evidence: ResolvedEvidenceReference[];
  counterevidence: ResolvedEvidenceReference[];
  alternatives: Array<{
    relation: Omit<ExplainedRelation, 'supporting_evidence' | 'counterevidence' | 'alternatives'>;
    supporting_evidence: ResolvedEvidenceReference[];
    counterevidence: ResolvedEvidenceReference[];
  }>;
  interpretation_boundary: 'linked_evidence_only';
}

export type ResearchExplanationResult =
  | { status: 'explained'; explanation: ExplainedRelation }
  | { status: 'not_found' }
  | { status: 'evidence_unavailable' };

export interface ResearchExplanationOptions {
  evidenceReferences: readonly ResearchEvidenceReference[];
  evidenceVisibility: ReadonlyMap<string, ResearchVisibility>;
  lookupPassage: (editionId: string, locator: string) => Promise<ResolvablePassage | null>;
  canRead?: (record: ResearchRelation | { id: string; visibility: ResearchVisibility }) => boolean;
}

type RelationSummary = Omit<
  ExplainedRelation,
  'supporting_evidence' | 'counterevidence' | 'alternatives'
>;
const visibilityOrder: Record<ResearchVisibility, number> = {
  PUBLIC_APPROVED: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  CHILD_SENSITIVE: 4,
};

function summarizeRelation(relation: ResearchRelation): RelationSummary {
  return {
    id: relation.id,
    kind: relation.kind,
    schema_version: relation.schema_version,
    content_revision: relation.content_revision,
    predicate: relation.predicate,
    subject_id: relation.subject_id,
    object_id: relation.object_id,
    scope: relation.scope,
    epistemic_status: relation.epistemic_status,
    review_status: relation.review_status,
    interpretation_boundary: 'linked_evidence_only',
  };
}

function snapshotJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Resolve an explanation strictly from relation records and exact K3-002 local evidence selectors. */
export async function explainResearchRelation(
  graph: ResearchGraphInput,
  relationId: string,
  options: ResearchExplanationOptions
): Promise<ResearchExplanationResult> {
  let graphSnapshot: ResearchGraphInput;
  let evidenceReferences: readonly ResearchEvidenceReference[];
  let evidenceVisibility: Map<string, ResearchVisibility>;
  let lookupPassage: ResearchExplanationOptions['lookupPassage'];
  let readPolicy: ResearchExplanationOptions['canRead'];
  try {
    lookupPassage = options.lookupPassage;
    readPolicy = options.canRead;
    graphSnapshot = snapshotJson(graph);
    evidenceReferences = snapshotJson(options.evidenceReferences);
    evidenceVisibility = new Map(options.evidenceVisibility);
  } catch {
    return { status: 'not_found' };
  }
  if (
    !validateResearchGraph(graphSnapshot).valid ||
    !Array.isArray(evidenceReferences) ||
    typeof lookupPassage !== 'function' ||
    (readPolicy !== undefined && typeof readPolicy !== 'function')
  ) {
    return { status: 'not_found' };
  }
  if (evidenceReferences.some((reference) => !validateResearchEvidenceReference(reference).valid)) {
    return { status: 'evidence_unavailable' };
  }

  const relation = graphSnapshot.relations.find((candidate) => candidate.id === relationId);
  if (!relation) return { status: 'not_found' };
  const canRead = readPolicy ?? ((record) => record.visibility === 'PUBLIC_APPROVED');
  const alternatives = new Map<string, ResearchRelation>(
    graphSnapshot.relations.map((candidate) => [candidate.id, candidate])
  );
  const nodes = new Map(graphSnapshot.nodes.map((node) => [node.id, node]));
  const relationReadable = (candidate: ResearchRelation) =>
    canRead(snapshotJson(candidate)) &&
    [candidate.subject_id, candidate.object_id, candidate.scope.reference_id].every((id) => {
      const visibility = nodes.get(id)?.visibility;
      return (
        visibility !== undefined &&
        visibilityOrder[candidate.visibility] >= visibilityOrder[visibility] &&
        canRead({ id, visibility })
      );
    });
  if (!relationReadable(relation)) return { status: 'not_found' };
  const selectedAlternatives: ResearchRelation[] = [];
  for (const alternativeId of relation.alternative_relation_ids) {
    const alternative = alternatives.get(alternativeId);
    if (
      !alternative ||
      !relationReadable(alternative) ||
      visibilityOrder[relation.visibility] < visibilityOrder[alternative.visibility]
    ) {
      return { status: 'not_found' };
    }
    selectedAlternatives.push(alternative);
  }

  const requiredEvidenceIds = new Set([
    ...relation.supporting_evidence_ids,
    ...relation.counterevidence_ids,
    ...selectedAlternatives.flatMap((alternative) => [
      ...alternative.supporting_evidence_ids,
      ...alternative.counterevidence_ids,
    ]),
  ]);
  if (requiredEvidenceIds.size === 0) return { status: 'evidence_unavailable' };
  const evidenceById = new Map<string, ResearchEvidenceReference>(
    evidenceReferences.map((reference) => [reference.id, reference])
  );
  if (evidenceById.size !== evidenceReferences.length) {
    return { status: 'evidence_unavailable' };
  }
  const referencesToResolve: ResearchEvidenceReference[] = [];
  for (const evidenceId of requiredEvidenceIds) {
    const reference = evidenceById.get(evidenceId);
    const assertion = reference ? nodes.get(reference.assertion_id) : undefined;
    const evidenceNode = nodes.get(evidenceId);
    const visibility = evidenceVisibility.get(evidenceId);
    if (
      !reference ||
      evidenceNode?.kind !== 'Evidence' ||
      assertion?.kind !== 'Assertion' ||
      !canRead(snapshotJson(assertion)) ||
      visibility === undefined ||
      visibility !== evidenceNode.visibility ||
      !canRead(snapshotJson(evidenceNode)) ||
      [relation, ...selectedAlternatives].some(
        (candidate) =>
          (candidate.supporting_evidence_ids.includes(evidenceId) ||
            candidate.counterevidence_ids.includes(evidenceId)) &&
          (visibilityOrder[candidate.visibility] < visibilityOrder[visibility] ||
            visibilityOrder[candidate.visibility] < visibilityOrder[assertion.visibility])
      )
    ) {
      return { status: 'not_found' };
    }
    referencesToResolve.push(reference);
  }

  const resolved = new Map<string, ResolvedEvidenceReference>();
  for (const reference of referencesToResolve) {
    try {
      resolved.set(
        reference.id,
        await resolveResearchEvidenceReference(reference, async (editionId, locator) => {
          const passage = await lookupPassage(editionId, locator);
          return passage === null ? null : snapshotJson(passage);
        })
      );
    } catch {
      return { status: 'evidence_unavailable' };
    }
  }

  const toEvidence = (ids: readonly string[], direction: 'supporting' | 'counterevidence') => {
    const entries: ResolvedEvidenceReference[] = [];
    for (const id of [...ids].sort((left, right) => left.localeCompare(right))) {
      const evidence = resolved.get(id);
      if (!evidence || evidence.direction !== direction) return undefined;
      entries.push(evidence);
    }
    return entries;
  };
  const supporting = toEvidence(relation.supporting_evidence_ids, 'supporting');
  const counterevidence = toEvidence(relation.counterevidence_ids, 'counterevidence');
  if (!supporting || !counterevidence) return { status: 'evidence_unavailable' };

  const explainedAlternatives: ExplainedRelation['alternatives'] = [];
  for (const alternative of selectedAlternatives) {
    const alternativeSupporting = toEvidence(alternative.supporting_evidence_ids, 'supporting');
    const alternativeCounterevidence = toEvidence(
      alternative.counterevidence_ids,
      'counterevidence'
    );
    if (!alternativeSupporting || !alternativeCounterevidence) {
      return { status: 'evidence_unavailable' };
    }
    explainedAlternatives.push({
      relation: summarizeRelation(alternative),
      supporting_evidence: alternativeSupporting,
      counterevidence: alternativeCounterevidence,
    });
  }

  return {
    status: 'explained',
    explanation: {
      ...summarizeRelation(relation),
      supporting_evidence: supporting,
      counterevidence,
      alternatives: explainedAlternatives,
    },
  };
}
