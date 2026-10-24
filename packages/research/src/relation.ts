import {
  createJsonSchemaValidator,
  type JsonSchemaContract,
  type KnowledgeValidationIssue,
  type KnowledgeValidationResult,
} from '@moonwitness/knowledge';
import relationSchema from '../../../ontology/core/research-relation.schema.json' with { type: 'json' };
import {
  summarizeIdentityDecisions,
  validateIdentityCandidate,
  validateIdentityDecision,
  type IdentityReconciliationCandidate,
  type IdentityReconciliationDecision,
} from './identity-reconciliation.js';

export type ResearchRelationPredicate =
  | 'edition_of'
  | 'witness_of'
  | 'member_of_canon'
  | 'derived_from'
  | 'related_to'
  | 'textually_parallels'
  | 'possibly_corresponds_to'
  | 'explicit_identity_equivalence';
export type ResearchEpistemicStatus =
  | 'unreviewed'
  | 'supported'
  | 'partially_supported'
  | 'disputed'
  | 'insufficient_evidence'
  | 'withdrawn';
export type ResearchReviewStatus =
  'unreviewed' | 'pending' | 'accepted' | 'rejected' | 'disputed' | 'withdrawn';
export type ResearchVisibility =
  'PUBLIC_APPROVED' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | 'CHILD_SENSITIVE';
export type ResearchGraphNodeKind =
  | 'Entity'
  | 'Agent'
  | 'Work'
  | 'Expression'
  | 'Edition'
  | 'Artifact'
  | 'Passage'
  | 'Content'
  | 'Term'
  | 'Concept'
  | 'Assertion'
  | 'Evidence'
  | 'ProvenanceActivity'
  | 'Assessment'
  | 'ReviewDecision'
  | 'DatasetRelease'
  | 'ImportRun'
  | 'ExternalAlias';

export interface ResearchGraphNode {
  id: string;
  kind: ResearchGraphNodeKind;
  visibility: ResearchVisibility;
  identity_class?:
    | 'RevelationIdentity'
    | 'TextualWitness'
    | 'Canon'
    | 'Entity'
    | 'AgentIdentity'
    | 'TermIdentity'
    | 'ConceptIdentity';
}

export interface ResearchRelation {
  id: `mw:relation:${string}`;
  kind: 'ResearchRelation';
  schema_version: 1;
  lifecycle: 'candidate' | 'active' | 'superseded' | 'withdrawn';
  created_at: string;
  updated_at: string;
  origin_ref: string;
  content_revision: number;
  visibility: ResearchVisibility;
  predicate: ResearchRelationPredicate;
  subject_id: string;
  object_id: string;
  scope: {
    kind: 'passage' | 'speaker' | 'document' | 'work' | 'community' | 'time' | 'research_context';
    reference_id: string;
  };
  supporting_evidence_ids: string[];
  counterevidence_ids: string[];
  alternative_relation_ids: string[];
  epistemic_status: ResearchEpistemicStatus;
  review_status: ResearchReviewStatus;
  review_decision_id?: string;
  reviewer_id?: string;
  reviewed_at?: string;
  reviewed_revision?: number;
  identity_decision_id?: string;
}

export interface ResearchGraphInput {
  nodes: readonly ResearchGraphNode[];
  relations: readonly ResearchRelation[];
  identity_candidates?: readonly IdentityReconciliationCandidate[];
  identity_decisions?: readonly IdentityReconciliationDecision[];
}

export interface ResearchAdjacencyOptions {
  direction?: 'outgoing' | 'incoming' | 'both';
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  canRead?: (record: ResearchGraphNode | ResearchRelation) => boolean;
}

export interface ResearchAdjacencyEdge {
  relation: ReviewedResearchRelationProjection;
  depth: number;
}

export type ReviewedResearchRelationProjection = Pick<
  ResearchRelation,
  | 'id'
  | 'kind'
  | 'schema_version'
  | 'content_revision'
  | 'predicate'
  | 'subject_id'
  | 'object_id'
  | 'scope'
  | 'supporting_evidence_ids'
  | 'counterevidence_ids'
  | 'alternative_relation_ids'
  | 'epistemic_status'
  | 'review_status'
>;

export type ResearchAdjacencyResult =
  | { status: 'not_found' }
  | {
      status: 'found';
      root_id: string;
      nodes: ResearchGraphNode[];
      edges: ResearchAdjacencyEdge[];
      truncated: boolean;
    };

const canonicalIdPattern =
  /^mw:[a-z]+(?:-[a-z]+)*:[a-z0-9][a-z0-9._-]{0,179}(?::[a-z0-9][a-z0-9._-]{0,179})*$/u;
const visibilityOrder: Record<ResearchVisibility, number> = {
  PUBLIC_APPROVED: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  CHILD_SENSITIVE: 4,
};

function visibilityRank(visibility: ResearchVisibility): number {
  return visibilityOrder[visibility];
}
const validateRelationSchema = createJsonSchemaValidator(
  relationSchema as unknown as JsonSchemaContract,
  'does not match the versioned research relation contract'
);

function issue(path: string, keyword: string, message: string): KnowledgeValidationResult {
  return { valid: false, issues: [{ path, keyword, message }] };
}

function passed(): KnowledgeValidationResult {
  return { valid: true, issues: [] };
}

function mergeIssues(issues: KnowledgeValidationIssue[]): KnowledgeValidationResult {
  return issues.length === 0 ? passed() : { valid: false, issues };
}

function asRelation(value: unknown): ResearchRelation {
  return value as ResearchRelation;
}

/** Validate shape and invariants local to one versioned relation record. */
export function validateResearchRelation(value: unknown): KnowledgeValidationResult {
  const schemaResult = validateRelationSchema(value);
  if (!schemaResult.valid) return schemaResult;
  const relation = asRelation(value);
  if (relation.subject_id === relation.object_id) {
    return issue('/object_id', 'distinct_endpoints', 'relation endpoints must be different');
  }
  if (relation.lifecycle === 'active' && relation.review_status !== 'accepted') {
    return issue('/review_status', 'active_review', 'active relations must have accepted review');
  }
  if (relation.review_status === 'accepted') {
    if (relation.reviewed_revision !== relation.content_revision) {
      return issue(
        '/reviewed_revision',
        'current_revision',
        'accepted review must match current revision'
      );
    }
    if (relation.epistemic_status === 'withdrawn') {
      return issue(
        '/epistemic_status',
        'withdrawn_review',
        'withdrawn relations cannot be accepted'
      );
    }
    if (relation.review_decision_id === undefined || relation.reviewer_id === undefined) {
      return issue(
        '/review_decision_id',
        'review_provenance',
        'accepted relations require review provenance'
      );
    }
  }
  const evidenceOverlap = relation.supporting_evidence_ids.find((id) =>
    relation.counterevidence_ids.includes(id)
  );
  if (evidenceOverlap) {
    return issue(
      '/counterevidence_ids',
      'disjoint_evidence_direction',
      'one evidence record cannot support and counter this relation at once'
    );
  }
  if (relation.alternative_relation_ids.includes(relation.id)) {
    return issue(
      '/alternative_relation_ids',
      'not_self',
      'a relation cannot be its own alternative'
    );
  }
  return passed();
}

function endpointTypeIssue(
  relation: ResearchRelation,
  subject: ResearchGraphNode,
  object: ResearchGraphNode
): KnowledgeValidationIssue | undefined {
  switch (relation.predicate) {
    case 'edition_of':
      if (
        subject.kind !== 'Edition' ||
        object.kind !== 'Expression' ||
        object.identity_class !== 'TextualWitness'
      ) {
        return {
          path: '/predicate',
          keyword: 'endpoint_types',
          message: 'edition_of requires an Edition subject and TextualWitness Expression object',
        };
      }
      break;
    case 'witness_of':
      if (
        subject.kind !== 'Expression' ||
        subject.identity_class !== 'TextualWitness' ||
        object.kind !== 'Work' ||
        object.identity_class !== 'RevelationIdentity'
      ) {
        return {
          path: '/predicate',
          keyword: 'endpoint_types',
          message: 'witness_of requires a TextualWitness Expression and RevelationIdentity Work',
        };
      }
      break;
    case 'member_of_canon':
      if (
        subject.kind !== 'Expression' ||
        subject.identity_class !== 'TextualWitness' ||
        object.kind !== 'Concept' ||
        object.identity_class !== 'Canon'
      ) {
        return {
          path: '/predicate',
          keyword: 'endpoint_types',
          message: 'member_of_canon requires a TextualWitness Expression and Canon Concept',
        };
      }
      break;
    case 'explicit_identity_equivalence':
      if (
        subject.identity_class === undefined ||
        object.identity_class === undefined ||
        subject.kind !== object.kind ||
        subject.identity_class !== object.identity_class
      ) {
        return {
          path: '/predicate',
          keyword: 'identity_class_match',
          message: 'explicit identity equivalence requires matching, typed identity classes',
        };
      }
      break;
    case 'derived_from':
    case 'related_to':
    case 'textually_parallels':
    case 'possibly_corresponds_to':
      break;
  }
  return undefined;
}

function validIdentityClassForKind(node: ResearchGraphNode): boolean {
  const allowed: Partial<
    Record<ResearchGraphNodeKind, readonly NonNullable<ResearchGraphNode['identity_class']>[]>
  > = {
    Work: ['RevelationIdentity'],
    Expression: ['TextualWitness'],
    Concept: ['Canon', 'ConceptIdentity'],
    Entity: ['Entity', 'AgentIdentity'],
    Agent: ['AgentIdentity'],
    Term: ['TermIdentity'],
  };
  return (
    node.identity_class === undefined || allowed[node.kind]?.includes(node.identity_class) === true
  );
}

function validateIdentityRelation(
  relation: ResearchRelation,
  candidates: ReadonlyMap<string, IdentityReconciliationCandidate>,
  decisions: readonly IdentityReconciliationDecision[]
): KnowledgeValidationIssue[] {
  if (relation.predicate !== 'explicit_identity_equivalence') return [];
  const decision = decisions.find((candidate) => candidate.id === relation.identity_decision_id);
  if (!decision || decision.outcome !== 'accepted') {
    return [
      {
        path: '/identity_decision_id',
        keyword: 'accepted_identity_decision',
        message: 'identity equivalence requires an accepted K3-003 decision',
      },
    ];
  }
  if (!validateIdentityDecision(decision).valid) {
    return [
      {
        path: '/identity_decision_id',
        keyword: 'valid_identity_decision',
        message: 'identity relation decision is invalid',
      },
    ];
  }
  const candidate = candidates.get(decision.candidate_id);
  if (!candidate) {
    return [
      {
        path: '/identity_decision_id',
        keyword: 'candidate_exists',
        message: 'identity decision candidate is missing',
      },
    ];
  }
  const matches =
    (candidate.left_identity_id === relation.subject_id &&
      candidate.right_identity_id === relation.object_id) ||
    (candidate.left_identity_id === relation.object_id &&
      candidate.right_identity_id === relation.subject_id);
  if (!matches) {
    return [
      {
        path: '/identity_decision_id',
        keyword: 'decision_endpoints',
        message: 'identity decision does not review these relation endpoints',
      },
    ];
  }
  const candidateDecisions = decisions.filter((item) => item.candidate_id === candidate.id);
  if (candidateDecisions.some((item) => !validateIdentityDecision(item).valid)) {
    return [
      {
        path: '/identity_decision_id',
        keyword: 'valid_identity_decisions',
        message: 'identity relation candidate contains an invalid decision',
      },
    ];
  }
  const summary = summarizeIdentityDecisions(candidate.id, candidateDecisions);
  if (summary.status !== 'accepted_decision') {
    return [
      {
        path: '/identity_decision_id',
        keyword: 'uncontested_identity_decision',
        message: 'conflicting or unresolved identity decisions cannot create an equivalence edge',
      },
    ];
  }
  if (
    relation.review_decision_id !== decision.id ||
    relation.reviewer_id !== decision.reviewer_id ||
    relation.reviewed_at !== decision.reviewed_at
  ) {
    return [
      {
        path: '/review_decision_id',
        keyword: 'decision_provenance',
        message: 'identity relation review fields must match its accepted decision',
      },
    ];
  }
  return [];
}

function hasDerivedFromCycle(relations: readonly ResearchRelation[]): boolean {
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const relation of relations) {
    if (
      relation.predicate !== 'derived_from' ||
      relation.lifecycle !== 'active' ||
      relation.review_status !== 'accepted'
    )
      continue;
    const targets = adjacency.get(relation.subject_id) ?? [];
    targets.push(relation.object_id);
    adjacency.set(relation.subject_id, targets);
    indegree.set(relation.subject_id, indegree.get(relation.subject_id) ?? 0);
    indegree.set(relation.object_id, (indegree.get(relation.object_id) ?? 0) + 1);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let visitedCount = 0;
  while (ready.length > 0) {
    const current = ready.pop()!;
    visitedCount += 1;
    for (const target of adjacency.get(current) ?? []) {
      const count = indegree.get(target)! - 1;
      indegree.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  return visitedCount !== indegree.size;
}

/** Validate endpoints, evidence, scope, reviewed identity decisions, and acyclic provenance. */
export function validateResearchGraph(value: ResearchGraphInput): KnowledgeValidationResult {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.relations)) {
    return issue('/', 'graph_shape', 'graph requires node and relation arrays');
  }
  if (value.nodes.length > 10_000 || value.relations.length > 50_000) {
    return issue('/', 'graph_size', 'graph exceeds validation limits');
  }
  const issues: KnowledgeValidationIssue[] = [];
  const nodes = new Map<string, ResearchGraphNode>();
  const relationIds = new Set<string>();
  const allowedKinds = new Set<ResearchGraphNodeKind>([
    'Entity',
    'Agent',
    'Work',
    'Expression',
    'Edition',
    'Artifact',
    'Passage',
    'Content',
    'Term',
    'Concept',
    'Assertion',
    'Evidence',
    'ProvenanceActivity',
    'Assessment',
    'ReviewDecision',
    'DatasetRelease',
    'ImportRun',
    'ExternalAlias',
  ]);
  const allowedVisibilities = new Set<ResearchVisibility>([
    'PUBLIC_APPROVED',
    'INTERNAL',
    'CONFIDENTIAL',
    'RESTRICTED',
    'CHILD_SENSITIVE',
  ]);
  const relationIdSet = new Set<string>(
    value.relations
      .map((relation) => relation?.id)
      .filter((id): id is string => typeof id === 'string')
  );
  const relationMap = new Map(value.relations.map((relation) => [relation?.id, relation]));
  for (const [index, node] of value.nodes.entries()) {
    if (
      !node ||
      typeof node.id !== 'string' ||
      !canonicalIdPattern.test(node.id) ||
      !allowedKinds.has(node.kind) ||
      !allowedVisibilities.has(node.visibility) ||
      (node.identity_class !== undefined &&
        ![
          'RevelationIdentity',
          'TextualWitness',
          'Canon',
          'Entity',
          'AgentIdentity',
          'TermIdentity',
          'ConceptIdentity',
        ].includes(node.identity_class)) ||
      !validIdentityClassForKind(node)
    ) {
      issues.push({
        path: `/nodes/${index}`,
        keyword: 'node_shape',
        message: 'graph node is invalid',
      });
      continue;
    }
    if (nodes.has(node.id)) {
      issues.push({
        path: `/nodes/${index}/id`,
        keyword: 'unique_node',
        message: 'node IDs must be unique',
      });
      continue;
    }
    nodes.set(node.id, node);
  }
  const candidates = new Map<string, IdentityReconciliationCandidate>();
  for (const [index, candidate] of (value.identity_candidates ?? []).entries()) {
    const validation = validateIdentityCandidate(candidate);
    if (!validation.valid) {
      issues.push({
        path: `/identity_candidates/${index}`,
        keyword: 'identity_candidate',
        message: 'identity candidate is invalid',
      });
    } else if (candidates.has(candidate.id)) {
      issues.push({
        path: `/identity_candidates/${index}/id`,
        keyword: 'unique_candidate',
        message: 'identity candidate IDs must be unique',
      });
    } else {
      candidates.set(candidate.id, candidate);
    }
  }
  const decisions = value.identity_decisions ?? [];
  const decisionIds = new Set<string>();
  for (const [index, decision] of decisions.entries()) {
    if (
      !validateIdentityDecision(decision).valid ||
      decisionIds.has(decision.id) ||
      nodes.get(decision.id)?.kind !== 'ReviewDecision' ||
      !nodes.has(decision.reviewer_id)
    ) {
      issues.push({
        path: `/identity_decisions/${index}`,
        keyword: 'identity_decision',
        message: 'identity decision is invalid',
      });
    } else {
      decisionIds.add(decision.id);
      if (!candidates.has(decision.candidate_id)) {
        issues.push({
          path: `/identity_decisions/${index}/candidate_id`,
          keyword: 'candidate_exists',
          message: 'identity decision candidate must exist in the graph input',
        });
      }
      for (const evidenceId of decision.evidence_refs) {
        if (nodes.get(evidenceId)?.kind !== 'Evidence') {
          issues.push({
            path: `/identity_decisions/${index}/evidence_refs`,
            keyword: 'evidence_exists',
            message: 'identity decision evidence must resolve to graph evidence records',
          });
          break;
        }
      }
    }
  }

  for (const [index, relation] of value.relations.entries()) {
    const validation = validateResearchRelation(relation);
    if (!validation.valid) {
      issues.push(
        ...validation.issues.map((entry) => ({
          ...entry,
          path: `/relations/${index}${entry.path}`,
        }))
      );
      continue;
    }
    if (relationIds.has(relation.id) || nodes.has(relation.id)) {
      issues.push({
        path: `/relations/${index}/id`,
        keyword: 'unique_record',
        message: 'relation IDs must not collide with graph records',
      });
      continue;
    }
    relationIds.add(relation.id);
    const subject = nodes.get(relation.subject_id);
    const object = nodes.get(relation.object_id);
    if (!subject || !object) {
      issues.push({
        path: `/relations/${index}`,
        keyword: 'endpoints_exist',
        message: 'relation endpoints must be present in the graph input',
      });
      continue;
    }
    const typeIssue = endpointTypeIssue(relation, subject, object);
    if (typeIssue) issues.push({ ...typeIssue, path: `/relations/${index}${typeIssue.path}` });
    const scope = nodes.get(relation.scope.reference_id);
    if (!scope) {
      issues.push({
        path: `/relations/${index}/scope/reference_id`,
        keyword: 'scope_exists',
        message: 'relation scope must reference a graph record',
      });
    }
    const referencedNodes = [
      ...relation.supporting_evidence_ids,
      ...relation.counterevidence_ids,
      relation.scope.reference_id,
    ]
      .map((id) => nodes.get(id))
      .filter((node): node is ResearchGraphNode => node !== undefined);
    for (const reference of referencedNodes) {
      if (visibilityRank(relation.visibility) < visibilityRank(reference.visibility)) {
        issues.push({
          path: `/relations/${index}/visibility`,
          keyword: 'visibility_monotonicity',
          message: 'relation visibility must be at least as restrictive as every referenced node',
        });
        break;
      }
    }
    if (relation.review_status === 'accepted') {
      const reviewRecord = nodes.get(relation.review_decision_id!);
      const reviewer = nodes.get(relation.reviewer_id!);
      if (reviewRecord?.kind !== 'ReviewDecision') {
        issues.push({
          path: `/relations/${index}/review_decision_id`,
          keyword: 'review_decision_exists',
          message: 'accepted relation review decision must resolve to a review record',
        });
      }
      if (!reviewer || !['Agent', 'Entity'].includes(reviewer.kind)) {
        issues.push({
          path: `/relations/${index}/reviewer_id`,
          keyword: 'reviewer_exists',
          message: 'accepted relation reviewer must resolve to an agent record',
        });
      }
      for (const [referenceId, reference] of [
        [relation.review_decision_id!, reviewRecord],
        [relation.reviewer_id!, reviewer],
      ] as const) {
        if (
          reference &&
          visibilityRank(reference.visibility) > visibilityRank(relation.visibility)
        ) {
          issues.push({
            path: `/relations/${index}`,
            keyword: 'visibility_monotonicity',
            message: `relation visibility must be at least as restrictive as referenced review record ${referenceId}`,
          });
        }
      }
      if (relation.predicate === 'explicit_identity_equivalence') {
        const identityDecision = decisions.find(
          (decision) => decision.id === relation.identity_decision_id
        );
        for (const evidenceId of identityDecision?.evidence_refs ?? []) {
          const identityEvidence = nodes.get(evidenceId);
          if (
            identityEvidence &&
            visibilityRank(identityEvidence.visibility) > visibilityRank(relation.visibility)
          ) {
            issues.push({
              path: `/relations/${index}/visibility`,
              keyword: 'visibility_monotonicity',
              message:
                'identity relation visibility must be at least as restrictive as its decision evidence',
            });
            break;
          }
        }
      }
    }
    for (const evidenceId of [
      ...relation.supporting_evidence_ids,
      ...relation.counterevidence_ids,
    ]) {
      if (nodes.get(evidenceId)?.kind !== 'Evidence') {
        issues.push({
          path: `/relations/${index}/supporting_evidence_ids`,
          keyword: 'evidence_exists',
          message: 'support and counterevidence references must resolve to evidence records',
        });
        break;
      }
    }
    for (const alternativeId of relation.alternative_relation_ids) {
      const alternative = relationMap.get(alternativeId);
      if (!relationIdSet.has(alternativeId)) {
        issues.push({
          path: `/relations/${index}/alternative_relation_ids`,
          keyword: 'alternative_exists',
          message: 'alternative relation reference must resolve within the graph input',
        });
        break;
      }
      if (
        alternative &&
        visibilityRank(relation.visibility) < visibilityRank(alternative.visibility)
      ) {
        issues.push({
          path: `/relations/${index}/visibility`,
          keyword: 'visibility_monotonicity',
          message:
            'relation visibility must be at least as restrictive as every alternative relation',
        });
        break;
      }
    }
    issues.push(
      ...validateIdentityRelation(relation, candidates, decisions).map((entry) => ({
        ...entry,
        path: `/relations/${index}${entry.path}`,
      }))
    );
  }
  if (hasDerivedFromCycle(value.relations)) {
    issues.push({
      path: '/relations',
      keyword: 'acyclic_derived_from',
      message: 'accepted derived_from relations must not contain a cycle',
    });
  }
  return mergeIssues(issues);
}

function validateQueryLimits(options: ResearchAdjacencyOptions) {
  const { maxDepth = 1, maxNodes = 100, maxEdges = 200 } = options;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 5) {
    throw new TypeError('maxDepth must be an integer between 1 and 5');
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 200) {
    throw new TypeError('maxNodes must be an integer between 1 and 200');
  }
  if (!Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 500) {
    throw new TypeError('maxEdges must be an integer between 1 and 500');
  }
}

/**
 * Return a deterministic, bounded adjacency traversal. Access is checked against
 * endpoints, scope and all evidence before an edge can participate in traversal.
 * The default policy exposes PUBLIC_APPROVED records only.
 */
export function queryReviewedResearchAdjacency(
  graph: ResearchGraphInput,
  rootId: string,
  options: ResearchAdjacencyOptions = {}
): ResearchAdjacencyResult {
  const validation = validateResearchGraph(graph);
  if (!validation.valid) throw new TypeError('Research graph is invalid');
  validateQueryLimits(options);
  const direction = options.direction ?? 'both';
  const canRead = options.canRead ?? ((record) => record.visibility === 'PUBLIC_APPROVED');
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const readableNodes = new Set(graph.nodes.filter(canRead).map((node) => node.id));
  if (!readableNodes.has(rootId)) return { status: 'not_found' };

  const readableRelations = graph.relations.filter((relation) => {
    if (
      relation.lifecycle !== 'active' ||
      relation.review_status !== 'accepted' ||
      !canRead(relation) ||
      !readableNodes.has(relation.subject_id) ||
      !readableNodes.has(relation.object_id) ||
      !readableNodes.has(relation.scope.reference_id) ||
      (relation.reviewer_id !== undefined && !readableNodes.has(relation.reviewer_id)) ||
      (relation.review_decision_id !== undefined && !readableNodes.has(relation.review_decision_id))
    )
      return false;
    return (
      [...relation.supporting_evidence_ids, ...relation.counterevidence_ids].every((id) =>
        readableNodes.has(id)
      ) &&
      (relation.identity_decision_id === undefined ||
        (graph.identity_decisions ?? [])
          .find((decision) => decision.id === relation.identity_decision_id)
          ?.evidence_refs.every((id) => readableNodes.has(id)) === true)
    );
  });
  const readableRelationIds = new Set<string>(readableRelations.map((relation) => relation.id));
  const eligible = readableRelations.filter((relation) =>
    relation.alternative_relation_ids.every((id) => readableRelationIds.has(id))
  );
  const visibleRelationIds = new Set<string>(eligible.map((relation) => relation.id));
  const adjacency = new Map<string, ResearchRelation[]>();
  for (const relation of eligible) {
    const outgoing = adjacency.get(relation.subject_id) ?? [];
    outgoing.push(relation);
    adjacency.set(relation.subject_id, outgoing);
    const incoming = adjacency.get(relation.object_id) ?? [];
    incoming.push(relation);
    adjacency.set(relation.object_id, incoming);
  }
  for (const relations of adjacency.values()) {
    relations.sort((left, right) => left.id.localeCompare(right.id));
  }

  const maxDepth = options.maxDepth ?? 1;
  const maxNodes = options.maxNodes ?? 100;
  const maxEdges = options.maxEdges ?? 200;
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const visited = new Set([rootId]);
  const nodes = new Map<string, ResearchGraphNode>([[rootId, nodeMap.get(rootId)!]]);
  const edges = new Map<string, ResearchAdjacencyEdge>();
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const candidates = (adjacency.get(current.id) ?? []).filter((relation) => {
      const outgoing = relation.subject_id === current.id;
      const incoming = relation.object_id === current.id;
      return (
        (direction === 'both' && (outgoing || incoming)) ||
        (direction === 'outgoing' && outgoing) ||
        (direction === 'incoming' && incoming)
      );
    });
    for (const relation of candidates) {
      const neighborId =
        relation.subject_id === current.id ? relation.object_id : relation.subject_id;
      if (!visited.has(neighborId) && visited.size >= maxNodes) {
        truncated = true;
        continue;
      }
      if (!edges.has(relation.id) && edges.size >= maxEdges) {
        truncated = true;
        continue;
      }
      const visibleRelation: ReviewedResearchRelationProjection = {
        id: relation.id,
        kind: relation.kind,
        schema_version: relation.schema_version,
        content_revision: relation.content_revision,
        predicate: relation.predicate,
        subject_id: relation.subject_id,
        object_id: relation.object_id,
        scope: relation.scope,
        supporting_evidence_ids: relation.supporting_evidence_ids
          .slice()
          .sort((left, right) => left.localeCompare(right)),
        counterevidence_ids: relation.counterevidence_ids
          .slice()
          .sort((left, right) => left.localeCompare(right)),
        alternative_relation_ids: relation.alternative_relation_ids
          .filter((id) => id.startsWith('mw:relation:'))
          .filter((id) => visibleRelationIds.has(id))
          .sort((left, right) => left.localeCompare(right)),
        epistemic_status: relation.epistemic_status,
        review_status: relation.review_status,
      };
      if (!edges.has(relation.id)) {
        edges.set(relation.id, { relation: visibleRelation, depth: current.depth + 1 });
      }
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        nodes.set(neighborId, nodeMap.get(neighborId)!);
        queue.push({ id: neighborId, depth: current.depth + 1 });
      }
    }
  }
  return {
    status: 'found',
    root_id: rootId,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) =>
      left.relation.id.localeCompare(right.relation.id)
    ),
    truncated,
  };
}

export const researchRelationSchema = relationSchema;
