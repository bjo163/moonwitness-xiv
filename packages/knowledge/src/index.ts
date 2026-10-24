export {
  resolveKnowledgeIdentity,
  validateCanonicalKnowledgeId,
  type CanonicalIdValidation,
  type CanonicalKnowledgeId,
  type KnowledgeAlias,
  type KnowledgeIdentityReference,
  type KnowledgeIdentityResolution,
} from './identity.js';
export * from './types.js';
export * from './json-schema.js';
export * from './validate.js';
export * from './provenance.js';
export * from './source-artifact.js';
export {
  canonicalizeJson,
  hashCanonicalJson,
  parseCanonicalJson,
  createKnowledgeSnapshot,
  type KnowledgeSnapshotInput,
} from './canonical-json.js';
export * from './schema-version.js';
