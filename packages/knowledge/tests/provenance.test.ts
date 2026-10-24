import { describe, expect, it } from 'vitest';
import { validateKnowledgeProvenanceGraph } from '../src/index.js';
import type { KnowledgeProvenanceGraph } from '../src/provenance.js';

const actorId = 'mw:agent:synthetic-reviewer';
const sourceId = 'mw:artifact:synthetic-source';
const inputId = 'mw:content:synthetic-input';
const outputId = 'mw:assertion:synthetic-output';
const activityId = 'mw:provenance-activity:synthetic-derivation';
const method = { method_id: 'mw:method:synthetic-extraction', method_version: '1.0.0' };

const validGraph: KnowledgeProvenanceGraph = {
  records: [
    { id: actorId, kind: 'Agent' },
    { id: sourceId, kind: 'Artifact' },
    { id: inputId, kind: 'Content' },
    {
      id: outputId,
      kind: 'Assertion',
      derivation: {
        activity_id: activityId,
        input_ids: [inputId],
        ...method,
      },
    },
  ],
  activities: [
    {
      id: activityId,
      actor_id: actorId,
      source_ids: [sourceId],
      used_ids: [inputId, sourceId],
      generated_ids: [outputId],
      started_at: '2026-10-15T10:00:00Z',
      ended_at: '2026-10-15T10:00:01Z',
      ...method,
    },
  ],
};

function cloneGraph(): KnowledgeProvenanceGraph {
  return JSON.parse(JSON.stringify(validGraph)) as KnowledgeProvenanceGraph;
}

describe('PROV-inspired activity and evidence contracts', () => {
  it('accepts a fully resolved derivation with actor, source, method, and time', () => {
    expect(validateKnowledgeProvenanceGraph(validGraph)).toEqual({ valid: true, issues: [] });
  });

  it('rejects dangling actors, sources, inputs, outputs, and activity references', () => {
    const dangling: KnowledgeProvenanceGraph = {
      records: [
        {
          id: outputId,
          kind: 'Assertion',
          derivation: {
            activity_id: 'mw:provenance-activity:missing',
            input_ids: ['mw:content:missing'],
            ...method,
          },
        },
      ],
      activities: [
        {
          ...validGraph.activities[0],
          actor_id: 'mw:agent:missing',
          source_ids: ['mw:artifact:missing'],
          used_ids: ['mw:content:missing', 'mw:artifact:missing'],
          generated_ids: ['mw:assertion:missing'],
        },
      ],
    };
    const result = validateKnowledgeProvenanceGraph(dangling);
    expect(result).toMatchObject({ valid: false });
    if (result.valid) throw new Error('expected unresolved references');
    expect(result.issues.filter((issue) => issue.keyword === 'unresolvedReference')).toHaveLength(
      6
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: '/records/0/derivation/activity_id',
        keyword: 'unresolvedReference',
      })
    );
  });

  it('requires every activity output to carry matching derivation metadata', () => {
    const missing = cloneGraph();
    delete missing.records[3].derivation;
    expect(validateKnowledgeProvenanceGraph(missing)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: 'missingDerivation' })]),
    });
  });

  it('rejects a record whose derivation method or version differs from its activity', () => {
    const mismatch = cloneGraph();
    mismatch.records[3].derivation!.method_version = '2.0.0';
    expect(validateKnowledgeProvenanceGraph(mismatch)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: 'methodMismatch' })]),
    });
  });

  it('rejects malformed actor kind, reversed timestamps, and source IDs not marked as used', () => {
    const invalid = cloneGraph();
    invalid.activities[0].actor_id = 'mw:entity:synthetic-actor';
    invalid.activities[0].ended_at = '2026-10-15T09:59:59Z';
    invalid.activities[0].used_ids = [inputId];
    const result = validateKnowledgeProvenanceGraph(invalid);
    expect(result).toMatchObject({ valid: false });
    if (result.valid) throw new Error('expected contract diagnostics');
    expect(result.issues.map((issue) => issue.keyword)).toEqual(
      expect.arrayContaining(['recordKind', 'timeOrder', 'notUsed'])
    );
  });

  it('checks the resolved record kinds for actors and source artifacts', () => {
    const invalid = cloneGraph();
    invalid.records[0].kind = 'Entity';
    invalid.records[1].kind = 'Content';
    const result = validateKnowledgeProvenanceGraph(invalid);
    expect(result).toMatchObject({ valid: false });
    if (result.valid) throw new Error('expected record kind mismatches');
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/activities/0/actor_id', keyword: 'recordKind' }),
        expect.objectContaining({ path: '/activities/0/source_ids/0', keyword: 'recordKind' }),
        expect.objectContaining({ path: '/records/0/kind', keyword: 'recordKind' }),
        expect.objectContaining({ path: '/records/1/kind', keyword: 'recordKind' }),
      ])
    );
  });

  it('rejects duplicate IDs and cyclic derivation lineage', () => {
    const cyclic: KnowledgeProvenanceGraph = {
      records: [
        { id: actorId, kind: 'Agent' },
        {
          id: 'mw:content:cycle-a',
          kind: 'Content',
          derivation: { activity_id: activityId, input_ids: ['mw:content:cycle-b'], ...method },
        },
        {
          id: 'mw:content:cycle-b',
          kind: 'Content',
          derivation: { activity_id: activityId, input_ids: ['mw:content:cycle-a'], ...method },
        },
      ],
      activities: [
        {
          id: activityId,
          actor_id: actorId,
          source_ids: [],
          used_ids: ['mw:content:cycle-a', 'mw:content:cycle-b'],
          generated_ids: ['mw:content:cycle-a', 'mw:content:cycle-b'],
          started_at: '2026-10-15T10:00:00Z',
          ended_at: '2026-10-15T10:00:01Z',
          ...method,
        },
      ],
    };
    cyclic.records.push({ id: actorId, kind: 'Agent' });
    const result = validateKnowledgeProvenanceGraph(cyclic);
    expect(result).toMatchObject({ valid: false });
    if (result.valid) throw new Error('expected duplicate ID and derivation cycle');
    expect(result.issues.map((issue) => issue.keyword)).toEqual(
      expect.arrayContaining(['duplicateId', 'derivationCycle'])
    );
  });

  it('returns semantic diagnostics in stable order', () => {
    const invalid = cloneGraph();
    invalid.activities[0].source_ids = ['mw:artifact:z-missing', 'mw:artifact:a-missing'];
    invalid.activities[0].used_ids = [inputId];
    const first = validateKnowledgeProvenanceGraph(invalid);
    expect(validateKnowledgeProvenanceGraph(invalid)).toEqual(first);
  });
});
