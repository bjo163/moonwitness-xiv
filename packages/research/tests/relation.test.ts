import { describe, expect, it } from 'vitest';
import {
  queryReviewedResearchAdjacency,
  validateResearchGraph,
  validateResearchRelation,
  type ResearchGraphInput,
  type ResearchGraphNode,
  type ResearchRelation,
} from '../src/relation.js';
import {
  recordIdentityDecision,
  type IdentityReconciliationCandidate,
} from '../src/identity-reconciliation.js';

const reviewedAt = '2026-10-16T02:00:00Z';

function node(
  id: string,
  kind: ResearchGraphNode['kind'],
  overrides: Partial<ResearchGraphNode> = {}
): ResearchGraphNode {
  return { id, kind, visibility: 'PUBLIC_APPROVED', ...overrides };
}

function relation(overrides: Partial<ResearchRelation> = {}): ResearchRelation {
  return {
    id: 'mw:relation:alpha-related-beta',
    kind: 'ResearchRelation',
    schema_version: 1,
    lifecycle: 'active',
    created_at: '2026-10-16T01:00:00Z',
    updated_at: '2026-10-16T02:00:00Z',
    origin_ref: 'mw:source:synthetic-fixture',
    content_revision: 1,
    visibility: 'PUBLIC_APPROVED',
    predicate: 'related_to',
    subject_id: 'mw:entity:alpha',
    object_id: 'mw:entity:beta',
    scope: { kind: 'work', reference_id: 'mw:work:fixture-scope' },
    supporting_evidence_ids: ['mw:evidence:relation-support'],
    counterevidence_ids: [],
    alternative_relation_ids: [],
    epistemic_status: 'supported',
    review_status: 'accepted',
    review_decision_id: 'mw:review-decision:relation-accepted',
    reviewer_id: 'mw:agent:reviewer',
    reviewed_at: reviewedAt,
    reviewed_revision: 1,
    ...overrides,
  };
}

function graph(relations: ResearchRelation[] = [relation()]): ResearchGraphInput {
  return {
    nodes: [
      node('mw:entity:alpha', 'Entity', { identity_class: 'Entity' }),
      node('mw:entity:beta', 'Entity', { identity_class: 'Entity' }),
      node('mw:work:fixture-scope', 'Work'),
      node('mw:evidence:relation-support', 'Evidence'),
      node('mw:agent:reviewer', 'Agent'),
      node('mw:review-decision:relation-accepted', 'ReviewDecision'),
      node('mw:identity-decision:alpha-beta-accepted', 'ReviewDecision'),
    ],
    relations,
  };
}

describe('reviewed research relation graph', () => {
  it('validates typed, versioned, scoped and evidence-linked relations', () => {
    const value = relation({
      counterevidence_ids: ['mw:evidence:relation-counter'],
      alternative_relation_ids: ['mw:relation:alternative'],
    });
    expect(validateResearchRelation(value)).toMatchObject({ valid: true });
    expect(validateResearchRelation({ ...value, subject_id: value.object_id })).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ keyword: 'distinct_endpoints' })],
    });
    expect(validateResearchRelation({ ...value, schema_version: 2 })).toMatchObject({
      valid: false,
    });
    expect(
      validateResearchRelation({
        ...value,
        supporting_evidence_ids: ['mw:evidence:relation-counter'],
      })
    ).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ keyword: 'disjoint_evidence_direction' })],
    });
  });

  it('queries only active accepted edges and exposes version, scope and evidential direction', () => {
    const accepted = relation({ counterevidence_ids: ['mw:evidence:relation-counter'] });
    const pending = relation({
      id: 'mw:relation:pending',
      lifecycle: 'candidate',
      review_status: 'pending',
    });
    const value = graph([accepted, pending]);
    value.nodes = [...value.nodes, node('mw:evidence:relation-counter', 'Evidence')];
    expect(validateResearchGraph(value)).toEqual({ valid: true, issues: [] });

    const result = queryReviewedResearchAdjacency(value, 'mw:entity:alpha', {
      direction: 'outgoing',
    });
    expect(result).toMatchObject({ status: 'found', root_id: 'mw:entity:alpha', truncated: false });
    if (result.status !== 'found') throw new Error('expected a visible root node');
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.relation).toMatchObject({
      schema_version: 1,
      predicate: 'related_to',
      scope: { kind: 'work', reference_id: 'mw:work:fixture-scope' },
      supporting_evidence_ids: ['mw:evidence:relation-support'],
      counterevidence_ids: ['mw:evidence:relation-counter'],
      review_status: 'accepted',
    });
    expect(result.edges[0]?.relation).not.toHaveProperty('reviewer_id');
    expect(result.edges[0]?.relation).not.toHaveProperty('review_decision_id');
    expect(result.edges[0]?.relation).not.toHaveProperty('origin_ref');
  });

  it('supports reverse adjacency and hides private roots/edges without existence detail', () => {
    const value = graph([
      relation({ visibility: 'INTERNAL' }),
      relation({
        id: 'mw:relation:beta-related-gamma',
        subject_id: 'mw:entity:beta',
        object_id: 'mw:entity:gamma',
      }),
    ]);
    value.nodes = [...value.nodes, node('mw:entity:gamma', 'Entity', { identity_class: 'Entity' })];
    expect(validateResearchGraph(value)).toEqual({ valid: true, issues: [] });
    const reverse = queryReviewedResearchAdjacency(value, 'mw:entity:gamma', {
      direction: 'incoming',
    });
    expect(reverse).toMatchObject({ status: 'found' });
    if (reverse.status === 'found')
      expect(reverse.nodes.map(({ id }) => id)).toContain('mw:entity:beta');
    expect(queryReviewedResearchAdjacency(value, 'mw:entity:missing')).toEqual({
      status: 'not_found',
    });
    expect(queryReviewedResearchAdjacency(value, 'mw:entity:alpha')).toMatchObject({
      status: 'found',
      edges: [],
    });

    const privateNodeGraph = graph();
    privateNodeGraph.nodes = privateNodeGraph.nodes.map((entry) =>
      entry.id === 'mw:entity:alpha' ? { ...entry, visibility: 'CHILD_SENSITIVE' } : entry
    );
    expect(queryReviewedResearchAdjacency(privateNodeGraph, 'mw:entity:alpha')).toEqual({
      status: 'not_found',
    });
  });

  it('applies access policy to supporting evidence and caps traversal output', () => {
    const value = graph([
      relation({ visibility: 'RESTRICTED' }),
      relation({
        id: 'mw:relation:alpha-related-gamma',
        object_id: 'mw:entity:gamma',
        visibility: 'RESTRICTED',
      }),
    ]);
    value.nodes = value.nodes.map((entry) =>
      entry.id === 'mw:evidence:relation-support' ? { ...entry, visibility: 'RESTRICTED' } : entry
    );
    value.nodes = [...value.nodes, node('mw:entity:gamma', 'Entity')];
    expect(validateResearchGraph(value)).toEqual({ valid: true, issues: [] });
    expect(queryReviewedResearchAdjacency(value, 'mw:entity:alpha')).toMatchObject({
      status: 'found',
      edges: [],
    });
    const reviewerView = queryReviewedResearchAdjacency(value, 'mw:entity:alpha', {
      canRead: () => true,
    });
    expect(reviewerView).toMatchObject({ status: 'found' });
    if (reviewerView.status === 'found') expect(reviewerView.edges).toHaveLength(2);

    const limitedGraph = graph([
      relation(),
      relation({ id: 'mw:relation:alpha-related-gamma', object_id: 'mw:entity:gamma' }),
    ]);
    limitedGraph.nodes = [...limitedGraph.nodes, node('mw:entity:gamma', 'Entity')];
    expect(validateResearchGraph(value)).toEqual({ valid: true, issues: [] });
    const limited = queryReviewedResearchAdjacency(limitedGraph, 'mw:entity:alpha', {
      maxEdges: 1,
    });
    expect(limited).toMatchObject({ status: 'found', truncated: true });
  });

  it('rejects wrong endpoint types and dangling evidence, scope, or alternatives', () => {
    const wrongTypes = graph([relation({ predicate: 'edition_of' })]);
    expect(validateResearchGraph(wrongTypes)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ keyword: 'endpoint_types' })],
    });
    const missingEvidence = graph([relation({ supporting_evidence_ids: ['mw:evidence:missing'] })]);
    expect(validateResearchGraph(missingEvidence)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ keyword: 'evidence_exists' })],
    });
    const missingScope = graph([
      relation({ scope: { kind: 'work', reference_id: 'mw:work:missing' } }),
    ]);
    expect(validateResearchGraph(missingScope)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ keyword: 'scope_exists' })],
    });
    const missingAlternative = graph([
      relation({ alternative_relation_ids: ['mw:relation:missing'] }),
    ]);
    expect(validateResearchGraph(missingAlternative)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ keyword: 'alternative_exists' })],
    });
    const mismatchedIdentityClass = graph();
    mismatchedIdentityClass.nodes = mismatchedIdentityClass.nodes.map((entry) =>
      entry.id === 'mw:work:fixture-scope' ? { ...entry, identity_class: 'Canon' as const } : entry
    );
    expect(validateResearchGraph(mismatchedIdentityClass)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: 'node_shape' })]),
    });
    const overlyPublicRelation = graph();
    overlyPublicRelation.nodes = overlyPublicRelation.nodes.map((entry) =>
      entry.id === 'mw:evidence:relation-support' ? { ...entry, visibility: 'CONFIDENTIAL' } : entry
    );
    expect(validateResearchGraph(overlyPublicRelation)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ keyword: 'visibility_monotonicity' })],
    });
  });

  it('omits an edge when its alternative relation is not readable', () => {
    const primary = relation({ alternative_relation_ids: ['mw:relation:private-alternative'] });
    const alternative = relation({
      id: 'mw:relation:private-alternative',
      subject_id: 'mw:entity:beta',
      object_id: 'mw:entity:alpha',
    });
    const value = graph([primary, alternative]);
    expect(validateResearchGraph(value)).toEqual({ valid: true, issues: [] });
    const result = queryReviewedResearchAdjacency(value, 'mw:entity:alpha', {
      canRead: (record) => record.id !== 'mw:relation:private-alternative',
    });
    expect(result).toMatchObject({ status: 'found', edges: [] });
  });

  it('requires an accepted, uncontested K3-003 human decision for identity equivalence', () => {
    const candidate: IdentityReconciliationCandidate = {
      id: 'mw:identity-candidate:alpha-beta',
      kind: 'IdentityReconciliationCandidate',
      status: 'candidate',
      left_identity_id: 'mw:entity:alpha',
      right_identity_id: 'mw:entity:beta',
      alias_observations: [],
      conflicts: [],
      created_at: '2026-10-16T01:00:00Z',
    };
    const decision = recordIdentityDecision(candidate, {
      id: 'mw:identity-decision:alpha-beta-accepted',
      kind: 'IdentityReconciliationDecision',
      outcome: 'accepted',
      evidence_refs: ['mw:evidence:identity-review'],
      reviewer_id: 'mw:agent:reviewer',
      reviewed_at: reviewedAt,
      preserved_conflict_ids: [],
    });
    const edge = relation({
      predicate: 'explicit_identity_equivalence',
      review_decision_id: decision.id,
      identity_decision_id: decision.id,
    });
    const value = graph([edge]);
    value.nodes = [...value.nodes, node('mw:evidence:identity-review', 'Evidence')];
    value.identity_candidates = [candidate];
    value.identity_decisions = [decision];
    expect(validateResearchGraph(value)).toEqual({ valid: true, issues: [] });

    const rejected = {
      ...decision,
      outcome: 'rejected' as const,
      id: 'mw:identity-decision:alpha-beta-rejected',
    };
    const conflictGraph = graph([edge]);
    conflictGraph.nodes = [...conflictGraph.nodes, node('mw:evidence:identity-review', 'Evidence')];
    conflictGraph.identity_candidates = [candidate];
    conflictGraph.identity_decisions = [decision, rejected];
    expect(validateResearchGraph(conflictGraph)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ keyword: 'uncontested_identity_decision' }),
      ]),
    });
    expect(() => queryReviewedResearchAdjacency(conflictGraph, 'mw:entity:alpha')).toThrow(
      'Research graph is invalid'
    );
  });

  it('rejects directed derivation cycles but permits cycles in contestable relation types', () => {
    const first = relation({ predicate: 'derived_from' });
    const second = relation({
      id: 'mw:relation:beta-derived-gamma',
      predicate: 'derived_from',
      subject_id: 'mw:entity:beta',
      object_id: 'mw:entity:gamma',
    });
    const third = relation({
      id: 'mw:relation:gamma-derived-alpha',
      predicate: 'derived_from',
      subject_id: 'mw:entity:gamma',
      object_id: 'mw:entity:alpha',
    });
    const value = graph([first, second, third]);
    value.nodes = [...value.nodes, node('mw:entity:gamma', 'Entity')];
    expect(validateResearchGraph(value)).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ keyword: 'acyclic_derived_from' })],
    });
    expect(
      validateResearchGraph({
        ...value,
        relations: [
          first,
          { ...second, predicate: 'related_to' },
          { ...third, predicate: 'related_to' },
        ],
      })
    ).toMatchObject({ valid: true });
  });
});
