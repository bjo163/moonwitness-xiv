import { defineAddon, ref, seed, type Addon } from '@moonwitness/orm';
import { AccessGroup, GroupMembership, ModelAccess } from '@moonwitness/orm-base';
import {
  ResearchActiveRelease,
  ResearchActorIdentity,
  ResearchGraphRecord,
  ResearchGraphRelease,
  ResearchReviewEvent,
  ConceptProfileVersion,
  ConceptProfileReviewDecision,
  TextualAlignmentCandidateVersion,
  TextualAlignmentCandidateReviewDecision,
  ResearchSuggestionVersion,
  ResearchSuggestionReviewDecision,
  StoryVersion,
  StoryPageVersion,
  StoryEpisodeVersion,
  WitnessCorrection,
  WitnessInterpretation,
  WitnessTestimony,
} from './models.js';
import {
  ResearchPrivacyProjection,
  ResearchPrivacyRevocation,
} from './privacy-revocation.model.js';
import { views } from './views.js';

const syntheticDigest = 'a'.repeat(64);
const syntheticPrivacyProjectionJson =
  '{"excerpt":"Synthetic privacy projection only; no witness data."}';

const installAppendOnlyGuards: NonNullable<Addon['setup']> = async (trx) => {
  const tables = [
    'knowledge_story_versions',
    'knowledge_story_page_versions',
    'knowledge_story_episode_versions',
    'knowledge_witness_testimonies',
    'knowledge_witness_corrections',
    'knowledge_witness_interpretations',
    'knowledge_research_graph_releases',
    'knowledge_research_graph_records',
    'knowledge_research_review_events',
    'knowledge_concept_profile_versions',
    'knowledge_concept_profile_review_decisions',
    'knowledge_textual_alignment_candidate_versions',
    'knowledge_textual_alignment_candidate_review_decisions',
    'knowledge_research_suggestion_versions',
    'knowledge_research_suggestion_review_decisions',
    'knowledge_research_actor_identities',
    'knowledge_privacy_revocations',
  ] as const;
  const client = String(trx.client.config.client);

  if (client === 'pg') {
    await trx.raw(`
      CREATE OR REPLACE FUNCTION moonwitness_reject_knowledge_witness_mutation()
      RETURNS trigger AS $$
      BEGIN
      IF TG_TABLE_NAME = 'knowledge_concept_profile_versions' THEN
        RAISE EXCEPTION 'Knowledge concept profiles are append-only';
      END IF;
      IF TG_TABLE_NAME = 'knowledge_concept_profile_review_decisions' THEN
        RAISE EXCEPTION 'Concept profile review decisions are append-only';
      END IF;
      IF TG_TABLE_NAME = 'knowledge_textual_alignment_candidate_versions' THEN
        RAISE EXCEPTION 'Knowledge textual alignment candidates are append-only';
      END IF;
      IF TG_TABLE_NAME = 'knowledge_textual_alignment_candidate_review_decisions' THEN
        RAISE EXCEPTION 'Textual alignment candidate review decisions are append-only';
      END IF;
      IF TG_TABLE_NAME = 'knowledge_research_suggestion_versions' THEN
        RAISE EXCEPTION 'Knowledge research suggestions are append-only';
      END IF;
      IF TG_TABLE_NAME = 'knowledge_research_suggestion_review_decisions' THEN
        RAISE EXCEPTION 'Research suggestion review decisions are append-only';
      END IF;
      IF TG_TABLE_NAME IN ('knowledge_story_versions', 'knowledge_story_page_versions') THEN
        RAISE EXCEPTION 'Knowledge story versions and pages are append-only';
      END IF;
      IF TG_TABLE_NAME = 'knowledge_story_episode_versions' THEN
        RAISE EXCEPTION 'Knowledge story episodes are append-only';
      END IF;
      RAISE EXCEPTION 'Knowledge witness records are append-only';
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of tables) {
      const trigger = `${table}_append_only`;
      await trx.raw('DROP TRIGGER IF EXISTS ?? ON ??', [trigger, table]);
      await trx.raw(
        'CREATE TRIGGER ?? BEFORE UPDATE OR DELETE ON ?? FOR EACH ROW EXECUTE FUNCTION moonwitness_reject_knowledge_witness_mutation()',
        [trigger, table]
      );
    }
    return;
  }

  if (client === 'better-sqlite3' || client === 'sqlite3') {
    for (const table of tables) {
      const errorMessage =
        table === 'knowledge_concept_profile_versions'
          ? 'Knowledge concept profiles are append-only'
          : table === 'knowledge_concept_profile_review_decisions'
            ? 'Concept profile review decisions are append-only'
            : table === 'knowledge_textual_alignment_candidate_versions'
              ? 'Knowledge textual alignment candidates are append-only'
              : table === 'knowledge_textual_alignment_candidate_review_decisions'
                ? 'Textual alignment candidate review decisions are append-only'
                : table === 'knowledge_research_suggestion_versions'
                  ? 'Knowledge research suggestions are append-only'
                  : table === 'knowledge_research_suggestion_review_decisions'
                    ? 'Research suggestion review decisions are append-only'
                    : table === 'knowledge_story_versions' ||
                        table === 'knowledge_story_page_versions'
                      ? 'Knowledge story versions and pages are append-only'
                      : table === 'knowledge_story_episode_versions'
                        ? 'Knowledge story episodes are append-only'
                        : 'Knowledge witness records are append-only';
      await trx.raw(
        `CREATE TRIGGER IF NOT EXISTS ${table}_reject_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${errorMessage}'); END`
      );
      await trx.raw(
        `CREATE TRIGGER IF NOT EXISTS ${table}_reject_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${errorMessage}'); END`
      );
    }
  }
};

export const manifest = defineAddon({
  name: 'knowledge',
  version: '1.10.0',
  depends: ['base'],
  models: [
    WitnessTestimony,
    WitnessCorrection,
    WitnessInterpretation,
    ResearchGraphRelease,
    ResearchGraphRecord,
    ResearchActiveRelease,
    ResearchReviewEvent,
    ConceptProfileVersion,
    ConceptProfileReviewDecision,
    TextualAlignmentCandidateVersion,
    TextualAlignmentCandidateReviewDecision,
    ResearchSuggestionVersion,
    ResearchSuggestionReviewDecision,
    StoryVersion,
    StoryPageVersion,
    StoryEpisodeVersion,
    ResearchActorIdentity,
    ResearchPrivacyRevocation,
    ResearchPrivacyProjection,
  ],
  setup: installAppendOnlyGuards,
  data: [
    seed(AccessGroup, 'knowledge.group_privacy_steward', {
      code: 'knowledge_privacy_steward',
      name: 'Knowledge Privacy Steward',
      description: 'Explicitly grants access to synthetic privacy lifecycle controls.',
    }),
    seed(GroupMembership, 'knowledge.membership_privacy_steward_superadmin', {
      user: ref('base.user_superadmin'),
      group: ref('knowledge.group_privacy_steward'),
    }),
    seed(AccessGroup, 'knowledge.group_witness_steward', {
      code: 'knowledge_witness_steward',
      name: 'Knowledge Witness Steward',
      description: 'Least-privilege access to owner-scoped synthetic witness examples.',
    }),
    seed(GroupMembership, 'knowledge.membership_witness_steward_superadmin', {
      user: ref('base.user_superadmin'),
      group: ref('knowledge.group_witness_steward'),
    }),
    seed(ResearchPrivacyProjection, 'knowledge.synthetic_privacy_projection_001', {
      company: ref('base.company_default'),
      projection_key: 'synthetic-search-001',
      subject_ref_sha256: '357a432635adf14e8fcde203cfc900cb0ad8e43d9768a59a9052a4f52aca7623',
      projection_json: syntheticPrivacyProjectionJson,
      projection_digest: '3a71c3c81696759d8ccef0975ee7a5316ceeec035ed4d15dc959259b3082a011',
      synthetic: true,
      visibility: 'RESTRICTED',
      state: 'active',
    }),
    seed(WitnessTestimony, 'knowledge.synthetic_witness_001', {
      external_key: 'synthetic-witness-001',
      original_text: 'Synthetic example: the meeting began sometime in spring.',
      source_label: 'Synthetic training fixture',
      source_locator: 'fixture://witness/001',
      source_digest: syntheticDigest,
      received_time_text: 'spring',
      received_time_precision: 'unknown',
      uncertainty_note: 'The source says spring but gives no year or exact date.',
      synthetic: true,
      created_by: ref('base.user_system'),
    }),
    seed(WitnessCorrection, 'knowledge.synthetic_witness_001_correction_001', {
      testimony: ref('knowledge.synthetic_witness_001'),
      sequence: 1,
      correction_text: 'Synthetic correction: the meeting began after noon.',
      reason: 'A second synthetic fixture clarifies the time of day.',
      source_label: 'Synthetic correction fixture',
      source_locator: 'fixture://witness/001/correction/001',
      source_digest: 'b'.repeat(64),
      asserted_time_text: '2026-01-01T12:00:00Z',
      asserted_time_precision: 'instant',
      synthetic: true,
      recorded_by: ref('base.user_system'),
    }),
    seed(WitnessInterpretation, 'knowledge.synthetic_witness_001_interpretation_001', {
      testimony: ref('knowledge.synthetic_witness_001'),
      assertion_ref: 'assertion://synthetic/meeting-after-noon',
      evidence_ref: 'evidence://synthetic/witness-001/correction-001',
      interpretation_text: 'Synthetic hypothesis: the meeting likely began after noon.',
      method_label: 'Synthetic source comparison',
      method_version: '1',
      epistemic_status: 'hypothesis',
      synthetic: true,
      recorded_by: ref('base.user_system'),
    }),
    seed(WitnessTestimony, 'knowledge.synthetic_witness_scoped_001', {
      external_key: 'synthetic-witness-scoped-001',
      original_text: 'Synthetic owner-scoped example: a lamp was near the doorway.',
      source_label: 'Synthetic access fixture',
      source_locator: 'fixture://witness/scoped/001',
      source_digest: 'd'.repeat(64),
      received_time_text: '2026',
      received_time_precision: 'year',
      uncertainty_note: 'Synthetic fixture with intentionally coarse date precision.',
      visibility: 'RESTRICTED',
      synthetic: true,
      company: ref('base.company_default'),
      created_by: ref('base.user_superadmin'),
    }),
    seed(WitnessCorrection, 'knowledge.synthetic_witness_scoped_001_correction_001', {
      testimony: ref('knowledge.synthetic_witness_scoped_001'),
      sequence: 1,
      correction_text: 'Synthetic correction: the lamp was beside the side entrance.',
      reason: 'A second synthetic fixture provides an alternative location.',
      source_label: 'Synthetic correction access fixture',
      source_locator: 'fixture://witness/scoped/001/correction/001',
      source_digest: 'e'.repeat(64),
      asserted_time_text: '2026',
      asserted_time_precision: 'year',
      synthetic: true,
      recorded_by: ref('base.user_superadmin'),
    }),
    seed(WitnessInterpretation, 'knowledge.synthetic_witness_scoped_001_interpretation_001', {
      testimony: ref('knowledge.synthetic_witness_scoped_001'),
      assertion_ref: 'assertion://synthetic/witness-scoped-001',
      evidence_ref: 'evidence://synthetic/witness-scoped-001/correction-001',
      interpretation_text: 'Synthetic hypothesis: the lamp marked a secondary entrance.',
      method_label: 'Synthetic fixture comparison',
      method_version: '1',
      epistemic_status: 'hypothesis',
      visibility: 'RESTRICTED',
      synthetic: true,
      recorded_by: ref('base.user_superadmin'),
    }),
    seed(ModelAccess, 'knowledge.access_user_testimony_read', {
      group: ref('base.group_user'),
      model_name: WitnessTestimony.modelName,
      read: false,
      create: false,
      write: false,
      unlink: false,
    }),
    seed(ModelAccess, 'knowledge.access_user_correction_read', {
      group: ref('base.group_user'),
      model_name: WitnessCorrection.modelName,
      read: false,
      create: false,
      write: false,
      unlink: false,
    }),
    seed(ModelAccess, 'knowledge.access_user_interpretation_read', {
      group: ref('base.group_user'),
      model_name: WitnessInterpretation.modelName,
      read: false,
      create: false,
      write: false,
      unlink: false,
    }),
    ...(
      [
        ResearchGraphRelease,
        ResearchGraphRecord,
        ResearchActiveRelease,
        ResearchReviewEvent,
        ConceptProfileVersion,
        TextualAlignmentCandidateVersion,
        StoryVersion,
        StoryPageVersion,
        StoryEpisodeVersion,
        ResearchActorIdentity,
        ResearchPrivacyRevocation,
        ResearchPrivacyProjection,
        ResearchSuggestionVersion,
      ] as const
    ).map((model) =>
      seed(ModelAccess, `knowledge.access_user_${model.modelName.replaceAll('.', '_')}_read`, {
        group: ref('base.group_user'),
        model_name: model.modelName,
        read: false,
        create: false,
        write: false,
        unlink: false,
      })
    ),
  ],
  views,
  menus: [
    {
      model: WitnessTestimony.modelName,
      label: 'Witness Testimony',
      group: 'Knowledge',
      sequence: 80,
      developmentOnly: true,
    },
    {
      model: WitnessCorrection.modelName,
      label: 'Witness Corrections',
      group: 'Knowledge',
      sequence: 81,
      developmentOnly: true,
    },
    {
      model: WitnessInterpretation.modelName,
      label: 'Witness Interpretations',
      group: 'Knowledge',
      sequence: 82,
      developmentOnly: true,
    },
  ],
});
