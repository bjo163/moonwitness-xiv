export const knowledgeRecordKinds = [
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
  'Relation',
  'Assessment',
  'ReviewDecision',
  'DatasetRelease',
  'ImportRun',
  'ExternalAlias',
] as const;

export type KnowledgeRecordKind = (typeof knowledgeRecordKinds)[number];

/** Classification values implement the accepted K0-005 vocabulary only. */
export const knowledgeVisibilityValues = [
  'PUBLIC_APPROVED',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'CHILD_SENSITIVE',
] as const;

export type KnowledgeVisibility = (typeof knowledgeVisibilityValues)[number];
export type KnowledgeLifecycle = 'draft' | 'candidate' | 'active' | 'superseded' | 'withdrawn';

/** Per-record derivation link; graph-level resolution is performed separately. */
export interface KnowledgeDerivation {
  activity_id: string;
  input_ids: string[];
  method_id: string;
  method_version: string;
}

/**
 * Shared structural envelope only. The JSON Schema is authoritative for value
 * bounds and runtime validity; call `validateKnowledgeRecord` before treating
 * an untrusted value as a valid record. Derivation references are resolved by
 * `validateKnowledgeProvenanceGraph`; this shape does not imply source rights.
 */
export interface KnowledgeRecordBase {
  id: string;
  kind: KnowledgeRecordKind;
  schema_version: number;
  lifecycle: KnowledgeLifecycle;
  created_at: string;
  updated_at: string;
  origin_ref: string;
  visibility: KnowledgeVisibility;
  content_revision: number;
  derivation?: KnowledgeDerivation;
}

export type KnowledgeRecord = {
  [Kind in KnowledgeRecordKind]: KnowledgeRecordBase & { kind: Kind };
}[KnowledgeRecordKind];

export interface KnowledgeValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export type KnowledgeValidationResult =
  { valid: true; issues: [] } | { valid: false; issues: KnowledgeValidationIssue[] };
