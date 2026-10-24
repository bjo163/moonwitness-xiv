import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import provenanceGraphSchema from '../schemas/provenance-graph.schema.json' with { type: 'json' };
import { validateCanonicalKnowledgeId } from './identity.js';
import { knowledgeRecordKinds } from './types.js';
import type {
  KnowledgeDerivation,
  KnowledgeRecordKind,
  KnowledgeValidationIssue,
  KnowledgeValidationResult,
} from './types.js';

export interface KnowledgeProvenanceRecord {
  id: string;
  kind: KnowledgeRecordKind;
  derivation?: KnowledgeDerivation;
}

/**
 * A PROV-inspired activity. `used_ids` identifies inputs, including source
 * artifacts; `source_ids` calls out source artifacts for downstream review.
 */
export interface KnowledgeProvenanceActivity {
  id: string;
  actor_id: string;
  source_ids: string[];
  used_ids: string[];
  generated_ids: string[];
  started_at: string;
  ended_at: string;
  method_id: string;
  method_version: string;
}

export interface KnowledgeProvenanceGraph {
  /**
   * Scoped record index for this graph, not complete record envelopes. Each
   * full envelope must pass `validateKnowledgeRecord` separately. A record is
   * derived in this graph when listed by an activity's `generated_ids`.
   */
  records: KnowledgeProvenanceRecord[];
  activities: KnowledgeProvenanceActivity[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
formatsModule.default.default(ajv, { mode: 'full' });
const validateShape = ajv.compile<KnowledgeProvenanceGraph>(provenanceGraphSchema);

function pointerForIssue(
  instancePath: string,
  keyword: string,
  params: Record<string, unknown>
): string {
  if (keyword === 'required' && typeof params.missingProperty === 'string') {
    return `${instancePath}/${params.missingProperty.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  if (keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    return `${instancePath}/${params.additionalProperty.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  return instancePath || '/';
}

function canonicalIdIssue(id: string, path: string): KnowledgeValidationIssue | undefined {
  const result = validateCanonicalKnowledgeId(id);
  if (result.valid) return undefined;
  return {
    path,
    keyword: 'canonicalId',
    message: result.issue ?? 'must be a canonical knowledge ID',
  };
}

/** Validate structure and resolve every actor, source, input, output, and activity reference. */
export function validateKnowledgeProvenanceGraph(value: unknown): KnowledgeValidationResult {
  if (!validateShape(value)) {
    const issues: KnowledgeValidationIssue[] = (validateShape.errors ?? []).map((error) => ({
      path: pointerForIssue(error.instancePath, error.keyword, error.params),
      keyword: error.keyword,
      message: error.message ?? 'does not match the provenance graph contract',
    }));
    return { valid: false, issues };
  }

  const graph = value;
  const issues: KnowledgeValidationIssue[] = [];
  const recordIndex = new Map<string, number>();
  const recordKindById = new Map<string, KnowledgeRecordKind>();
  const activityIndex = new Map<string, number>();
  const allIds = new Set<string>();

  graph.records.forEach((record, index) => {
    const recordIdResult = validateCanonicalKnowledgeId(record.id);
    if (!recordIdResult.valid) {
      issues.push(canonicalIdIssue(record.id, `/records/${index}/id`)!);
    } else if (recordIdResult.kind !== record.kind) {
      issues.push({
        path: `/records/${index}/kind`,
        keyword: 'recordKind',
        message: `record kind ${record.kind} does not match its canonical ID kind ${recordIdResult.kind}`,
      });
    }
    if (allIds.has(record.id)) {
      issues.push({
        path: `/records/${index}/id`,
        keyword: 'duplicateId',
        message: `duplicate provenance graph ID: ${record.id}`,
      });
    } else {
      allIds.add(record.id);
    }
    if (!(knowledgeRecordKinds as readonly string[]).includes(record.kind)) {
      issues.push({
        path: `/records/${index}/kind`,
        keyword: 'recordKind',
        message: 'record kind is not part of the knowledge kernel',
      });
    }
    recordIndex.set(record.id, index);
    recordKindById.set(record.id, record.kind);
  });

  graph.activities.forEach((activity, index) => {
    const idPath = `/activities/${index}/id`;
    const idResult = validateCanonicalKnowledgeId(activity.id);
    if (!idResult.valid) issues.push(canonicalIdIssue(activity.id, idPath)!);
    else if (idResult.kind !== 'ProvenanceActivity') {
      issues.push({
        path: idPath,
        keyword: 'recordKind',
        message: 'activity ID must use the ProvenanceActivity kind',
      });
    }
    if (allIds.has(activity.id)) {
      issues.push({
        path: idPath,
        keyword: 'duplicateId',
        message: `duplicate provenance graph ID: ${activity.id}`,
      });
    } else {
      allIds.add(activity.id);
    }
    activityIndex.set(activity.id, index);

    const actorPath = `/activities/${index}/actor_id`;
    const actorResult = validateCanonicalKnowledgeId(activity.actor_id);
    if (!actorResult.valid) issues.push(canonicalIdIssue(activity.actor_id, actorPath)!);
    else if (actorResult.kind !== 'Agent') {
      issues.push({
        path: actorPath,
        keyword: 'recordKind',
        message: 'actor ID must use the Agent kind',
      });
    }
    if (!recordIndex.has(activity.actor_id)) {
      issues.push({
        path: actorPath,
        keyword: 'unresolvedReference',
        message: `actor record does not resolve: ${activity.actor_id}`,
      });
    } else if (recordKindById.get(activity.actor_id) !== 'Agent') {
      issues.push({
        path: actorPath,
        keyword: 'recordKind',
        message: 'resolved actor record must have kind Agent',
      });
    }

    if (Date.parse(activity.started_at) > Date.parse(activity.ended_at)) {
      issues.push({
        path: `/activities/${index}/ended_at`,
        keyword: 'timeOrder',
        message: 'activity end must not precede its start',
      });
    }

    activity.source_ids.forEach((id, sourceIndex) => {
      const path = `/activities/${index}/source_ids/${sourceIndex}`;
      const issue = canonicalIdIssue(id, path);
      if (issue) issues.push(issue);
      if (!recordIndex.has(id))
        issues.push({
          path,
          keyword: 'unresolvedReference',
          message: `source record does not resolve: ${id}`,
        });
      else if (recordKindById.get(id) !== 'Artifact') {
        issues.push({
          path,
          keyword: 'recordKind',
          message: 'resolved source record must have kind Artifact',
        });
      }
      if (!activity.used_ids.includes(id))
        issues.push({
          path,
          keyword: 'notUsed',
          message: 'source IDs must also appear in used_ids',
        });
    });

    activity.used_ids.forEach((id, inputIndex) => {
      const path = `/activities/${index}/used_ids/${inputIndex}`;
      const issue = canonicalIdIssue(id, path);
      if (issue) issues.push(issue);
      if (!recordIndex.has(id))
        issues.push({
          path,
          keyword: 'unresolvedReference',
          message: `input record does not resolve: ${id}`,
        });
    });

    activity.generated_ids.forEach((id, outputIndex) => {
      const path = `/activities/${index}/generated_ids/${outputIndex}`;
      const issue = canonicalIdIssue(id, path);
      if (issue) issues.push(issue);
      if (!recordIndex.has(id))
        issues.push({
          path,
          keyword: 'unresolvedReference',
          message: `generated record does not resolve: ${id}`,
        });
    });
  });

  graph.records.forEach((record, index) => {
    const derivation = record.derivation;
    if (!derivation) return;
    const activityPath = `/records/${index}/derivation/activity_id`;
    const idIssue = canonicalIdIssue(derivation.activity_id, activityPath);
    if (idIssue) issues.push(idIssue);
    const activityPosition = activityIndex.get(derivation.activity_id);
    if (activityPosition === undefined) {
      issues.push({
        path: activityPath,
        keyword: 'unresolvedReference',
        message: `provenance activity does not resolve: ${derivation.activity_id}`,
      });
      return;
    }

    const activity = graph.activities[activityPosition];
    if (!activity.generated_ids.includes(record.id)) {
      issues.push({
        path: activityPath,
        keyword: 'generationMismatch',
        message: 'activity does not list this record as generated',
      });
    }
    for (const inputId of derivation.input_ids) {
      if (!activity.used_ids.includes(inputId)) {
        issues.push({
          path: `/records/${index}/derivation/input_ids`,
          keyword: 'usageMismatch',
          message: `activity does not list derivation input as used: ${inputId}`,
        });
      }
    }
    if (
      activity.method_id !== derivation.method_id ||
      activity.method_version !== derivation.method_version
    ) {
      issues.push({
        path: `/records/${index}/derivation`,
        keyword: 'methodMismatch',
        message: 'record derivation method and version must match its activity',
      });
    }
  });

  graph.activities.forEach((activity, activityIndexValue) => {
    activity.generated_ids.forEach((id, outputIndex) => {
      const recordPosition = recordIndex.get(id);
      if (recordPosition === undefined) return;
      const record = graph.records[recordPosition];
      if (!record.derivation) {
        issues.push({
          path: `/records/${recordPosition}/derivation`,
          keyword: 'missingDerivation',
          message: `generated record must carry derivation metadata for ${activity.id}`,
        });
      } else if (record.derivation.activity_id !== activity.id) {
        issues.push({
          path: `/activities/${activityIndexValue}/generated_ids/${outputIndex}`,
          keyword: 'generationMismatch',
          message: `record points to a different activity: ${record.derivation.activity_id}`,
        });
      }
    });
  });

  const inputsByOutput = new Map<string, string[]>();
  graph.records.forEach((record) => {
    if (record.derivation) inputsByOutput.set(record.id, record.derivation.input_ids);
  });
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycleMembers = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) {
      const cycleStart = stack.indexOf(id);
      for (const member of stack.slice(cycleStart)) cycleMembers.add(member);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const input of inputsByOutput.get(id) ?? []) {
      visit(input);
    }
    stack.pop();
    active.delete(id);
  };
  for (const id of inputsByOutput.keys()) visit(id);
  for (const id of [...cycleMembers].sort()) {
    const index = recordIndex.get(id);
    if (index !== undefined)
      issues.push({
        path: `/records/${index}/derivation/input_ids`,
        keyword: 'derivationCycle',
        message: `derivation graph contains a cycle through ${id}`,
      });
  }

  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  issues.sort(
    (left, right) =>
      compare(left.path, right.path) ||
      compare(left.keyword, right.keyword) ||
      compare(left.message, right.message)
  );
  return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues };
}
