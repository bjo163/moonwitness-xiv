import { defineModel, fields } from '@moonwitness/orm';
import { Company, User } from '@moonwitness/orm-base';

/** Sanitized, append-only record that a scoped synthetic subject was withdrawn. */
export const ResearchPrivacyRevocation = defineModel('knowledge.privacy_revocation', {
  table: 'knowledge_privacy_revocations',
  order: 'company_id asc, id asc',
  unique: [['company', 'idempotency_key']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    actor: fields.belongsTo(User, { required: true }),
    subject_ref_sha256: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    consent_decision_ref_sha256: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    idempotency_key: fields.string({ required: true, hidden: true }),
    event_digest: fields.string({ required: true, unique: true, pattern: '^[a-f0-9]{64}$' }),
    decided_at: fields.string({ required: true }),
  },
});

/** One restricted derived search projection, erased from active use on withdrawal. */
export const ResearchPrivacyProjection = defineModel('knowledge.privacy_projection', {
  table: 'knowledge_privacy_projections',
  order: 'company_id asc, projection_key asc',
  unique: [['company', 'projection_key']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    projection_key: fields.string({ required: true }),
    subject_ref_sha256: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    projection_json: fields.text({ required: true, hidden: true }),
    projection_digest: fields.string({ pattern: '^[a-f0-9]{64}$' }),
    synthetic: fields.boolean({ required: true, default: false }),
    visibility: fields.enum(['RESTRICTED', 'INTERNAL'], { required: true, default: 'RESTRICTED' }),
    state: fields.enum(['active', 'revoked'], { required: true, default: 'active' }),
    revoked_at: fields.string(),
  },
});
