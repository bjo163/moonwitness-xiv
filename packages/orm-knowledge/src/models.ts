import { defineModel, fields, type BaseModel } from '@moonwitness/orm';
import { Company, User } from '@moonwitness/orm-base';
import type { StaticHookArguments } from 'objection';

function testimonyModel(): typeof BaseModel {
  return WitnessTestimony;
}

/** The originally received account, kept distinct from every later correction. */
export const WitnessTestimony = defineModel('knowledge.witness_testimony', {
  table: 'knowledge_witness_testimonies',
  order: 'id asc',
  fields: {
    external_key: fields.string({ required: true, unique: true }),
    original_text: fields.text({ required: true }),
    source_label: fields.string({ required: true }),
    source_locator: fields.string({ required: true }),
    source_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    received_time_text: fields.string({ required: true }),
    received_time_precision: fields.enum(['instant', 'day', 'month', 'year', 'unknown'], {
      required: true,
      default: 'unknown',
    }),
    uncertainty_note: fields.text(),
    visibility: fields.enum(['RESTRICTED', 'INTERNAL', 'PUBLIC'], {
      required: true,
      default: 'RESTRICTED',
    }),
    /** Legacy or unclassified records stay outside the scoped API until explicitly marked. */
    synthetic: fields.boolean({ required: true, default: false }),
    company: fields.belongsTo(Company),
    created_by: fields.belongsTo(User, { required: true }),
  },
});

/** Corrections are separate append-only assertions; they never replace original_text. */
export const WitnessCorrection = defineModel('knowledge.witness_correction', {
  table: 'knowledge_witness_corrections',
  order: 'testimony_id asc, sequence asc',
  unique: [['testimony', 'sequence']],
  fields: {
    testimony: fields.belongsTo(testimonyModel, { required: true }),
    sequence: fields.integer({ required: true }),
    correction_text: fields.text({ required: true }),
    reason: fields.text({ required: true }),
    source_label: fields.string({ required: true }),
    source_locator: fields.string({ required: true }),
    source_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    asserted_time_text: fields.string({ required: true }),
    asserted_time_precision: fields.enum(['instant', 'day', 'month', 'year', 'unknown'], {
      required: true,
      default: 'unknown',
    }),
    synthetic: fields.boolean({ required: true, default: false }),
    uncertainty_note: fields.text(),
    recorded_by: fields.belongsTo(User, { required: true }),
  },
});

/** Interpretations cite source records explicitly and never replace testimony text. */
export const WitnessInterpretation = defineModel('knowledge.witness_interpretation', {
  table: 'knowledge_witness_interpretations',
  order: 'testimony_id asc, id asc',
  fields: {
    testimony: fields.belongsTo(testimonyModel, { required: true }),
    assertion_ref: fields.string({ required: true }),
    evidence_ref: fields.string({ required: true }),
    interpretation_text: fields.text({ required: true }),
    method_label: fields.string({ required: true }),
    method_version: fields.string({ required: true }),
    epistemic_status: fields.enum(['hypothesis', 'supported', 'contested', 'rejected'], {
      required: true,
      default: 'hypothesis',
    }),
    visibility: fields.enum(['RESTRICTED', 'INTERNAL', 'PUBLIC'], {
      required: true,
      default: 'RESTRICTED',
    }),
    synthetic: fields.boolean({ required: true, default: false }),
    recorded_by: fields.belongsTo(User, { required: true }),
  },
});

/** One immutable, content-addressed canonical research graph release. */
export const ResearchGraphRelease = defineModel('knowledge.research_graph_release', {
  table: 'knowledge_research_graph_releases',
  order: 'id asc',
  fields: {
    release_digest: fields.string({ required: true, unique: true, pattern: '^[a-f0-9]{64}$' }),
    manifest_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    manifest_json: fields.text({ required: true, hidden: true }),
    record_count: fields.integer({ required: true }),
    schema_version: fields.string({ required: true }),
    previous_release_digest: fields.string({ pattern: '^[a-f0-9]{64}$' }),
  },
});

/** Immutable JSON record bytes belonging to one graph release. */
export const ResearchGraphRecord = defineModel('knowledge.research_graph_record', {
  table: 'knowledge_research_graph_records',
  order: 'release_id asc, record_key asc',
  unique: [['release', 'record_key']],
  fields: {
    release: fields.belongsTo(ResearchGraphRelease, { required: true }),
    record_key: fields.string({ required: true }),
    record_kind: fields.enum(
      ['node', 'source', 'expression', 'assertion', 'evidence', 'relation'],
      {
        required: true,
      }
    ),
    visibility: fields.enum(['PUBLIC', 'INTERNAL', 'RESTRICTED'], { required: true }),
    content_json: fields.text({ required: true, hidden: true }),
    content_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
  },
});

/** Mutable pointer to the currently selected immutable release. */
export const ResearchActiveRelease = defineModel('knowledge.research_active_release', {
  table: 'knowledge_research_active_releases',
  order: 'corpus_key asc',
  unique: [['corpus_key']],
  fields: {
    corpus_key: fields.string({ required: true }),
    release: fields.belongsTo(ResearchGraphRelease, { required: true }),
    activated_at: fields.string({ required: true }),
  },
});

/** Append-only decision projection bound to a workflow event and graph revision. */
export const ResearchReviewEvent = defineModel('knowledge.research_review_event', {
  table: 'knowledge_research_review_events',
  order: 'workflow_instance_id asc, workflow_event_sequence asc',
  unique: [['workflow_instance_id', 'workflow_event_sequence'], ['idempotency_key']],
  fields: {
    event_id: fields.string({ required: true, unique: true }),
    workflow_instance_id: fields.integer({ required: true }),
    workflow_event_sequence: fields.integer({ required: true }),
    subject_id: fields.string({ required: true }),
    subject_revision: fields.integer({ required: true }),
    research_release_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    idempotency_key: fields.string({ required: true, hidden: true }),
    event_json: fields.text({ required: true, hidden: true }),
    event_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
  },
});

/** Immutable, tenant-scoped INTERNAL concept profile version. */
export const ConceptProfileVersion = defineModel('knowledge.concept_profile_version', {
  table: 'knowledge_concept_profile_versions',
  order: 'company_id asc, profile_id asc, version asc',
  unique: [['company', 'profile_id', 'version']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    profile_id: fields.string({
      required: true,
      pattern: '^mw:concept-profile:[a-z0-9][a-z0-9._-]{0,179}$',
    }),
    concept_id: fields.string({
      required: true,
      pattern: '^mw:concept:[a-z0-9][a-z0-9._-]{0,179}$',
    }),
    version: fields.integer({ required: true }),
    visibility: fields.enum(['INTERNAL'], { required: true, default: 'INTERNAL' }),
    profile_json: fields.text({ required: true, hidden: true }),
    profile_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    recorded_by: fields.belongsTo(User, { required: true }),
  },
});

/**
 * Append-only, tenant-scoped review decision for one exact stored concept profile version, bound to
 * the canonical digest of the document that decision authorizes. Concept profile interpretations are
 * tenant state, so their review history lives here and never in the canon-only graph release events.
 */
export const ConceptProfileReviewDecision = defineModel(
  'knowledge.concept_profile_review_decision',
  {
    table: 'knowledge_concept_profile_review_decisions',
    order: 'company_id asc, profile_id asc, id asc',
    unique: [['company', 'profile_digest', 'reviewer']],
    fields: {
      company: fields.belongsTo(Company, { required: true }),
      profile_id: fields.string({
        required: true,
        pattern: '^mw:concept-profile:[a-z0-9][a-z0-9._-]{0,179}$',
      }),
      profile_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
      reviewed_version: fields.integer({ required: true }),
      reviewed_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
      outcome: fields.enum(['accepted', 'rejected'], { required: true }),
      reviewer: fields.belongsTo(User, { required: true }),
      decided_at: fields.string({ required: true }),
      rationale: fields.text({ required: true, hidden: true }),
    },
  }
);

/** Immutable tenant-scoped INTERNAL citation-only textual alignment candidate version. */
export const TextualAlignmentCandidateVersion = defineModel(
  'knowledge.textual_alignment_candidate_version',
  {
    table: 'knowledge_textual_alignment_candidate_versions',
    order: 'company_id asc, candidate_id asc, version asc',
    unique: [['company', 'candidate_id', 'version']],
    fields: {
      company: fields.belongsTo(Company, { required: true }),
      candidate_id: fields.string({
        required: true,
        pattern: '^mw:textual-alignment-candidate:[a-z0-9][a-z0-9._-]{0,159}$',
      }),
      version: fields.integer({ required: true }),
      visibility: fields.enum(['INTERNAL'], { required: true, default: 'INTERNAL' }),
      candidate_json: fields.text({ required: true, hidden: true }),
      candidate_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
      recorded_by: fields.belongsTo(User, { required: true }),
    },
  }
);

/** Immutable, tenant-scoped INTERNAL local-AI suggestion snapshot. */
export const ResearchSuggestionVersion = defineModel('knowledge.research_suggestion_version', {
  table: 'knowledge_research_suggestion_versions',
  order: 'company_id asc, suggestion_id asc, version asc',
  unique: [['company', 'suggestion_id', 'version']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    suggestion_id: fields.string({
      required: true,
      pattern: '^mw:suggestion:[a-z0-9][a-z0-9._-]{0,179}$',
    }),
    version: fields.integer({ required: true }),
    visibility: fields.enum(['INTERNAL'], { required: true, default: 'INTERNAL' }),
    status: fields.enum(['unreviewed'], { required: true, default: 'unreviewed' }),
    suggestion_json: fields.text({ required: true, hidden: true }),
    suggestion_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    recorded_by: fields.belongsTo(User, { required: true }),
  },
});

/**
 * Immutable, tenant-scoped human review of one exact stored local-AI suggestion version. An accepted
 * outcome admits the model output for the tenant's own follow-up work; it grants no canonical write and
 * leaves the reviewed suggestion version `INTERNAL` and `unreviewed`.
 */
export const ResearchSuggestionReviewDecision = defineModel(
  'knowledge.research_suggestion_review_decision',
  {
    table: 'knowledge_research_suggestion_review_decisions',
    order: 'company_id asc, suggestion_id asc, id asc',
    unique: [['company', 'suggestion_digest', 'reviewer']],
    fields: {
      company: fields.belongsTo(Company, { required: true }),
      suggestion_id: fields.string({
        required: true,
        pattern: '^mw:suggestion:[a-z0-9][a-z0-9._-]{0,179}$',
      }),
      suggestion_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
      reviewed_version: fields.integer({ required: true }),
      outcome: fields.enum(['accepted', 'rejected'], { required: true }),
      reviewer: fields.belongsTo(User, { required: true }),
      decided_at: fields.string({ required: true }),
      rationale: fields.text({ required: true, hidden: true }),
    },
  }
);

/**
 * Immutable, tenant-scoped review of one exact textual alignment candidate version. An accepted
 * outcome admits the pairing as a parallel to carry; it cannot widen the candidate's own
 * interpretation boundary, which lives inside the reviewed bytes this row binds.
 */
export const TextualAlignmentCandidateReviewDecision = defineModel(
  'knowledge.textual_alignment_candidate_review_decision',
  {
    table: 'knowledge_textual_alignment_candidate_review_decisions',
    order: 'company_id asc, candidate_id asc, id asc',
    unique: [['company', 'candidate_digest', 'reviewer']],
    fields: {
      company: fields.belongsTo(Company, { required: true }),
      candidate_id: fields.string({
        required: true,
        pattern: '^mw:textual-alignment-candidate:[a-z0-9][a-z0-9._-]{0,159}$',
      }),
      candidate_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
      reviewed_version: fields.integer({ required: true }),
      outcome: fields.enum(['accepted', 'rejected'], { required: true }),
      reviewer: fields.belongsTo(User, { required: true }),
      decided_at: fields.string({ required: true }),
      rationale: fields.text({ required: true, hidden: true }),
    },
  }
);

/** Immutable, tenant-scoped INTERNAL snapshot of a story and its ordered pages. */
export const StoryVersion = defineModel('knowledge.story_version', {
  table: 'knowledge_story_versions',
  order: 'company_id asc, story_id asc, version asc',
  unique: [['company', 'story_id', 'version']],
  fields: {
    company: fields.belongsTo(Company, { required: true }),
    story_id: fields.string({
      required: true,
      pattern: '^mw:story:[a-z0-9][a-z0-9._-]{0,179}$',
    }),
    version: fields.integer({ required: true }),
    visibility: fields.enum(['INTERNAL'], { required: true, default: 'INTERNAL' }),
    title: fields.string({ required: true }),
    story_json: fields.text({ required: true, hidden: true }),
    story_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    page_count: fields.integer({ required: true }),
    previous_story_digest: fields.string({ pattern: '^[a-f0-9]{64}$' }),
    recorded_by: fields.belongsTo(User, { required: true }),
  },
});

/** Ordered page content and its optional single immutable artifact reference. */
export const StoryPageVersion = defineModel('knowledge.story_page_version', {
  table: 'knowledge_story_page_versions',
  order: 'story_version_id asc, page_order asc',
  unique: [
    ['story_version', 'page_id'],
    ['story_version', 'page_order'],
  ],
  fields: {
    story_version: fields.belongsTo(StoryVersion, { required: true }),
    page_id: fields.string({
      required: true,
      pattern: '^mw:story-page:[a-z0-9][a-z0-9._-]{0,179}$',
    }),
    page_order: fields.integer({ required: true }),
    original_text: fields.text({ required: true, hidden: true }),
    original_text_digest: fields.string({ required: true, pattern: '^[a-f0-9]{64}$' }),
    media_ref_json: fields.text({ hidden: true }),
  },
});

/** Explicit, stable ontology identities for database users; IDs are never inferred from SQL rows. */
export const ResearchActorIdentity = defineModel('knowledge.research_actor_identity', {
  table: 'knowledge_research_actor_identities',
  order: 'id asc',
  unique: [['user']],
  fields: {
    user: fields.belongsTo(User, { required: true, unique: true }),
    canonical_user_id: fields.string({
      required: true,
      unique: true,
      pattern: '^mw:user:[a-z0-9][a-z0-9._-]{0,179}$',
    }),
    /** Present for mappings provisioned through the governed service. */
    request_id: fields.string({ unique: true }),
    provisioned_by: fields.belongsTo(User),
    reason: fields.text(),
  },
});

const rejectImmutableMutation = (): never => {
  throw new Error('Witness source records and corrections cannot be updated or deleted');
};

for (const model of [
  WitnessTestimony,
  WitnessCorrection,
  WitnessInterpretation,
  ResearchGraphRelease,
  ResearchGraphRecord,
  ResearchReviewEvent,
  ConceptProfileVersion,
  TextualAlignmentCandidateVersion,
  ResearchSuggestionVersion,
  ResearchActorIdentity,
  StoryVersion,
  StoryPageVersion,
]) {
  model.beforeUpdate = (_args: StaticHookArguments<InstanceType<typeof model>>): never =>
    rejectImmutableMutation();
  model.beforeDelete = (_args: StaticHookArguments<InstanceType<typeof model>>): never =>
    rejectImmutableMutation();
  model.prototype.$beforeUpdate = rejectImmutableMutation;
  model.prototype.$beforeDelete = rejectImmutableMutation;
}

WitnessTestimony.relationMappings = {
  ...WitnessTestimony.relationMappings,
  corrections: {
    relation: WitnessTestimony.HasManyRelation,
    modelClass: WitnessCorrection,
    join: {
      from: 'knowledge_witness_testimonies.id',
      to: 'knowledge_witness_corrections.testimony_id',
    },
  },
};

WitnessCorrection.relationMappings = {
  ...WitnessCorrection.relationMappings,
  testimony_record: {
    relation: WitnessCorrection.BelongsToOneRelation,
    modelClass: WitnessTestimony,
    join: {
      from: 'knowledge_witness_corrections.testimony_id',
      to: 'knowledge_witness_testimonies.id',
    },
  },
};

WitnessInterpretation.relationMappings = {
  ...WitnessInterpretation.relationMappings,
  testimony_record: {
    relation: WitnessInterpretation.BelongsToOneRelation,
    modelClass: WitnessTestimony,
    join: {
      from: 'knowledge_witness_interpretations.testimony_id',
      to: 'knowledge_witness_testimonies.id',
    },
  },
};
