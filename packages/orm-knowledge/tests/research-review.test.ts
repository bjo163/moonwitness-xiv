import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { readQuranPassage } from '@moonwitness/corpus';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import {
  expireDueWorkflows,
  manifest as workflowManifest,
  startWorkflow,
} from '@moonwitness/orm-workflow';
import {
  activateResearchGraphRelease,
  createResearchGraphRelease,
  manifest as knowledgeManifest,
  readActiveResearchGraphRelease,
  readResearchReviewHistory,
  ResearchGraphRecord,
  resolveConceptProfileEvidence,
  storeConceptProfiles,
  transitionResearchReview,
} from '../src/index.js';

const corpusRootDirectory = path.resolve(process.cwd(), '../..');
const corpusKey = 'research';
const assertionId = 'mw:assertion:review-test-001';
const evidenceId = 'mw:evidence:review-test-quran-001';
const quranSourceId = 'mw:source:tanzil-quran-text';
const quranEditionId = 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2';
const reviewScopeId = 'mw:concept:review-test-scope';
const relationId = 'mw:relation:review-test-001';
const leftEntityId = 'mw:entity:review-fixture-left';
const rightEntityId = 'mw:entity:review-fixture-right';
const reviewWorkflowConfig = {
  startState: 'submitted',
  startRoles: ['system', 'superadmin'],
  timeoutMinutes: 1440,
  resourceModels: [ResearchGraphRecord.modelName, 'base.partner'],
  transitions: [
    {
      action: 'approve',
      from: 'submitted',
      to: 'approved',
      roles: ['user', 'superadmin'],
      requireDifferentActor: true,
    },
    {
      action: 'reject',
      from: 'submitted',
      to: 'rejected',
      roles: ['user', 'superadmin'],
      requireDifferentActor: true,
    },
  ],
};

let db: Knex;
let releaseDigest: string;
let activeRecordId: number;
let activeRelationRecordId: number;
let systemId: number;
let superadminId: number;
let companyId: number;

beforeEach(async () => {
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: {
      afterCreate(
        connection: { pragma(sql: string): unknown },
        done: (error: Error | null, connection: unknown) => void
      ) {
        connection.pragma('foreign_keys = ON');
        done(null, connection);
      },
    },
  });
  await installAddons(db, [
    baseManifest,
    jobsManifest,
    notificationManifest,
    workflowManifest,
    knowledgeManifest,
  ]);
  systemId = Number((await db('users').where({ login: 'system' }).first('id'))?.id);
  superadminId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
  companyId = Number((await db('companies').first('id'))?.id);
  await db('company_memberships')
    .insert({ user_id: superadminId, company_id: companyId, is_default: true })
    .onConflict(['user_id', 'company_id'])
    .ignore();
  await db('knowledge_research_actor_identities').insert([
    { user_id: systemId, canonical_user_id: 'mw:user:synthetic-requester' },
    { user_id: superadminId, canonical_user_id: 'mw:user:synthetic-reviewer' },
  ]);
  const quran = await readQuranPassage({
    rootDirectory: corpusRootDirectory,
    editionId: quranEditionId,
    locator: 'Q7:46',
    use: 'read_analyze',
  });
  const input = {
    corpusKey,
    schemaVersion: 'research-graph/v1',
    records: [
      {
        key: quranSourceId,
        kind: 'source' as const,
        visibility: 'PUBLIC' as const,
        content: { id: quranSourceId, kind: 'Artifact', visibility: 'PUBLIC_APPROVED' },
      },
      {
        key: quranEditionId,
        kind: 'expression' as const,
        visibility: 'PUBLIC' as const,
        content: { id: quranEditionId, kind: 'Edition', visibility: 'PUBLIC_APPROVED' },
      },
      {
        key: reviewScopeId,
        kind: 'node' as const,
        visibility: 'INTERNAL' as const,
        content: {
          id: reviewScopeId,
          kind: 'Concept',
          identity_class: 'ConceptIdentity',
          visibility: 'INTERNAL',
        },
      },
      {
        key: leftEntityId,
        kind: 'node' as const,
        visibility: 'INTERNAL' as const,
        content: {
          id: leftEntityId,
          kind: 'Entity',
          identity_class: 'Entity',
          visibility: 'INTERNAL',
        },
      },
      {
        key: rightEntityId,
        kind: 'node' as const,
        visibility: 'INTERNAL' as const,
        content: {
          id: rightEntityId,
          kind: 'Entity',
          identity_class: 'Entity',
          visibility: 'INTERNAL',
        },
      },
      {
        key: assertionId,
        kind: 'assertion' as const,
        visibility: 'PUBLIC' as const,
        content: {
          id: assertionId,
          kind: 'Assertion',
          schema_version: 1,
          lifecycle: 'candidate',
          created_at: '2026-10-16T00:00:00.000Z',
          updated_at: '2026-10-16T00:00:00.000Z',
          origin_ref: 'fixture://research/review/001',
          visibility: 'PUBLIC_APPROVED',
          content_revision: 1,
          claim: 'Synthetic review contract fixture.',
          polarity: 'positive',
          scope: { kind: 'research_context', reference_id: reviewScopeId },
          context: { mode: 'analysis', reference_id: reviewScopeId },
          epistemic_status: 'hypothesized',
          review_status: 'pending',
        },
      },
      {
        key: evidenceId,
        kind: 'evidence' as const,
        visibility: 'INTERNAL' as const,
        content: {
          id: evidenceId,
          kind: 'Evidence',
          visibility: 'INTERNAL',
          assertion_id: assertionId,
          direction: 'supporting',
          selector: {
            source_id: quranSourceId,
            edition_id: quranEditionId,
            locator: 'Q7:46',
            content_sha256: quran.sha256,
          },
        },
      },
      {
        key: relationId,
        kind: 'relation' as const,
        visibility: 'INTERNAL' as const,
        content: {
          id: relationId,
          kind: 'ResearchRelation',
          schema_version: 1,
          lifecycle: 'candidate',
          created_at: '2026-10-16T00:00:00.000Z',
          updated_at: '2026-10-16T00:00:00.000Z',
          origin_ref: 'fixture://research/review/relation-001',
          content_revision: 1,
          visibility: 'INTERNAL',
          predicate: 'related_to',
          subject_id: leftEntityId,
          object_id: rightEntityId,
          scope: { kind: 'research_context', reference_id: reviewScopeId },
          supporting_evidence_ids: [evidenceId],
          counterevidence_ids: [],
          alternative_relation_ids: [],
          epistemic_status: 'unreviewed',
          review_status: 'pending',
        },
      },
    ],
  };
  const release = await db.transaction((trx) => createResearchGraphRelease(trx, input));
  releaseDigest = release.releaseDigest;
  await db.transaction((trx) =>
    activateResearchGraphRelease(trx, {
      corpusKey,
      releaseDigest,
      expectedCurrentReleaseDigest: null,
      activatedAt: '2026-10-16T00:00:01.000Z',
    })
  );
  activeRecordId = Number(
    (
      await db('knowledge_research_graph_records')
        .where({
          release_id: (await db('knowledge_research_active_releases').first('release_id'))
            .release_id,
        })
        .where({ record_key: assertionId })
        .first('id')
    )?.id
  );
  activeRelationRecordId = Number(
    (
      await db('knowledge_research_graph_records')
        .where({
          release_id: (await db('knowledge_research_active_releases').first('release_id'))
            .release_id,
        })
        .where({ record_key: relationId })
        .first('id')
    )?.id
  );
  await db('workflow_definitions').insert({
    code: 'research.review',
    version: 1,
    name: 'Synthetic research review',
    config: JSON.stringify(reviewWorkflowConfig),
    enabled: true,
  });
});

afterEach(async () => db.destroy());

async function startReviewWorkflow(
  resourceModel = ResearchGraphRecord.modelName,
  resourceId = activeRecordId,
  idempotencyKey = `research-review-start-${resourceId}-001`
) {
  return startWorkflow(db, {
    code: 'research.review',
    companyId,
    actorId: systemId,
    role: 'system',
    resourceModel,
    resourceId,
    idempotencyKey,
    now: new Date('2026-10-16T00:01:00.000Z'),
  });
}

function reviewInput(
  instanceId: number,
  overrides: Partial<Parameters<typeof transitionResearchReview>[1]> = {}
) {
  return {
    instanceId,
    authenticatedReviewer: { userId: superadminId, companyId, role: 'superadmin' as const },
    action: 'approve' as const,
    expectedWorkflowRevision: 0,
    subjectId: assertionId,
    expectedSubjectRevision: 1,
    evidenceIds: [evidenceId],
    idempotencyKey: `research-review-action-${instanceId}-001`,
    corpusRootDirectory,
    now: new Date('2026-10-16T00:02:00.000Z'),
    ...overrides,
  };
}

describe('transactional research review service', () => {
  it('resolves accepted concept evidence against the current company review and source snapshot', async () => {
    const started = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(started.id));

    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: { userId: superadminId, companyId, role: 'superadmin' },
        corpusRootDirectory,
      })
    ).resolves.toMatchObject({
      canonicalEvidence: { id: evidenceId, assertion_id: assertionId },
      reviewStatus: 'accepted',
      access: 'readable',
    });
  });

  it('does not let an accepted Assertion review approve a concept profile interpretation', async () => {
    const started = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(started.id));
    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: { userId: superadminId, companyId, role: 'superadmin' },
        corpusRootDirectory,
      })
    ).resolves.toMatchObject({
      canonicalEvidence: { id: evidenceId, assertion_id: assertionId },
      reviewStatus: 'accepted',
      access: 'readable',
    });

    const acceptedProfile = {
      format: 'moonwitness-concept-profiles/v1',
      profiles: [
        {
          id: 'mw:concept-profile:accepted-with-assertion-review-only',
          concept_id: 'mw:concept:synthetic-review-scope',
          tradition: 'Synthetic test tradition',
          interpretive_scope: 'Synthetic profile review binding boundary.',
          epistemic_status: 'provisional',
          uncertainty: { level: 'high', note: 'Synthetic fixture only.' },
          interpretations: [
            {
              claim_type: 'human_interpretation',
              text: 'Synthetic accepted interpretation.',
              status: 'accepted',
              evidence_ids: [evidenceId],
            },
          ],
        },
      ],
    };
    await expect(
      storeConceptProfiles(db, {
        authenticatedActor: { userId: superadminId, companyId, role: 'superadmin' },
        corpusRootDirectory,
        document: acceptedProfile,
      })
    ).rejects.toThrow(/exact profile-digest review binding/u);
    expect(await db('knowledge_concept_profile_versions')).toHaveLength(0);
  });

  it('keeps canonical evidence unreviewed before a matching independent decision exists', async () => {
    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: { userId: superadminId, companyId, role: 'superadmin' },
        corpusRootDirectory,
      })
    ).resolves.toMatchObject({ reviewStatus: 'unreviewed', access: 'readable' });
  });

  it('does not carry review acceptance forward to a different assertion revision', async () => {
    const started = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(started.id));
    const current = await db.transaction((trx) => readActiveResearchGraphRelease(trx, corpusKey));
    expect(current).not.toBeNull();
    const next = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        corpusKey,
        schemaVersion: 'research-graph/v1',
        previousReleaseDigest: current!.releaseDigest,
        records: current!.records.map((record) =>
          record.key === assertionId
            ? {
                ...record,
                content: {
                  ...(record.content as Record<string, unknown>),
                  content_revision: 2,
                },
              }
            : record
        ),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey,
        releaseDigest: next.releaseDigest,
        expectedCurrentReleaseDigest: current!.releaseDigest,
        activatedAt: '2026-10-16T00:03:00.000Z',
      })
    );

    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: { userId: superadminId, companyId, role: 'superadmin' },
        corpusRootDirectory,
      })
    ).resolves.toMatchObject({ reviewStatus: 'unreviewed', access: 'readable' });
  });

  it('does not use another company’s accepted review as this company’s consensus', async () => {
    const first = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(first.id));
    const otherCompanyId = Number(
      await db('companies').insert({
        name: 'Separate research review tenant',
        timezone: 'UTC',
        active: true,
      })
    );
    await db('company_memberships').insert({
      user_id: superadminId,
      company_id: otherCompanyId,
      is_default: false,
    });
    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: {
          userId: superadminId,
          companyId: otherCompanyId,
          role: 'superadmin',
        },
        corpusRootDirectory,
      })
    ).resolves.toMatchObject({ reviewStatus: 'unreviewed', access: 'readable' });
    await expect(
      readResearchReviewHistory(db, { subjectId: assertionId, companyId: otherCompanyId })
    ).resolves.toMatchObject({ events: [], truncated: false });
  });

  it('retains acceptance for the same assertion revision after an unrelated graph release', async () => {
    const started = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(started.id));
    const current = await db.transaction((trx) => readActiveResearchGraphRelease(trx, corpusKey));
    expect(current).not.toBeNull();
    const next = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        corpusKey,
        schemaVersion: 'research-graph/v1',
        previousReleaseDigest: current!.releaseDigest,
        records: current!.records.map((record) => {
          if (record.key !== relationId) return record;
          const content = record.content as Record<string, unknown>;
          return {
            ...record,
            content: {
              ...content,
              updated_at: '2026-10-16T00:04:00.000Z',
              content_revision: 2,
            },
          };
        }),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey,
        releaseDigest: next.releaseDigest,
        expectedCurrentReleaseDigest: current!.releaseDigest,
        activatedAt: '2026-10-16T00:04:01.000Z',
      })
    );

    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: { userId: superadminId, companyId, role: 'superadmin' },
        corpusRootDirectory,
      })
    ).resolves.toMatchObject({ reviewStatus: 'accepted', access: 'readable' });
  });

  it('fails closed on conflicting decisions in the authenticated company history', async () => {
    const first = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(first.id));
    const second = await startReviewWorkflow(
      ResearchGraphRecord.modelName,
      activeRecordId,
      'research-review-start-conflict-001'
    );
    await transitionResearchReview(
      db,
      reviewInput(second.id, {
        action: 'reject',
        idempotencyKey: `research-review-reject-${second.id}-001`,
      })
    );

    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: { userId: superadminId, companyId, role: 'superadmin' },
        corpusRootDirectory,
      })
    ).resolves.toMatchObject({ reviewStatus: 'conflicting', access: 'readable' });
  });

  it('rechecks active company membership when resolving concept evidence', async () => {
    await db('company_memberships')
      .where({ user_id: superadminId, company_id: companyId })
      .update({ active: false });

    await expect(
      resolveConceptProfileEvidence(db, evidenceId, {
        authenticatedReader: { userId: superadminId, companyId, role: 'superadmin' },
        corpusRootDirectory,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rechecks active company membership inside the decision transaction', async () => {
    const started = await startReviewWorkflow();
    await db('company_memberships')
      .where({ user_id: superadminId, company_id: companyId })
      .update({ active: false });

    await expect(transitionResearchReview(db, reviewInput(started.id))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await db('workflow_instances').where({ id: started.id }).first('revision')
    ).toMatchObject({ revision: 0 });
    expect(await db('workflow_events').where({ instance_id: started.id })).toHaveLength(1);
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('rejects confidential subjects before changing workflow or decision history', async () => {
    const current = await db.transaction((trx) => readActiveResearchGraphRelease(trx, corpusKey));
    expect(current).not.toBeNull();
    const next = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        corpusKey,
        schemaVersion: 'research-graph/v1',
        previousReleaseDigest: current!.releaseDigest,
        records: current!.records.map((record) =>
          record.key === assertionId
            ? {
                ...record,
                visibility: 'RESTRICTED',
                content: {
                  ...(record.content as Record<string, unknown>),
                  visibility: 'RESTRICTED',
                },
              }
            : record
        ),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey,
        releaseDigest: next.releaseDigest,
        expectedCurrentReleaseDigest: current!.releaseDigest,
        activatedAt: '2026-10-16T00:00:02.000Z',
      })
    );
    activeRecordId = Number(
      (
        await db('knowledge_research_graph_records')
          .where({
            release_id: (await db('knowledge_research_active_releases').first('release_id'))
              .release_id,
            record_key: assertionId,
          })
          .first('id')
      )?.id
    );
    const started = await startReviewWorkflow();
    await expect(transitionResearchReview(db, reviewInput(started.id))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await db('workflow_instances').where({ id: started.id }).first('revision')
    ).toMatchObject({ revision: 0 });
    expect(await db('workflow_events')).toHaveLength(1);
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('rejects confidential evidence without committing a workflow or decision event', async () => {
    const current = await db.transaction((trx) => readActiveResearchGraphRelease(trx, corpusKey));
    expect(current).not.toBeNull();
    const next = await db.transaction((trx) =>
      createResearchGraphRelease(trx, {
        corpusKey,
        schemaVersion: 'research-graph/v1',
        previousReleaseDigest: current!.releaseDigest,
        records: current!.records.map((record) =>
          record.key === evidenceId || record.key === relationId
            ? {
                ...record,
                visibility: 'RESTRICTED',
                content: {
                  ...(record.content as Record<string, unknown>),
                  visibility: 'RESTRICTED',
                },
              }
            : record
        ),
      })
    );
    await db.transaction((trx) =>
      activateResearchGraphRelease(trx, {
        corpusKey,
        releaseDigest: next.releaseDigest,
        expectedCurrentReleaseDigest: current!.releaseDigest,
        activatedAt: '2026-10-16T00:00:02.000Z',
      })
    );
    activeRecordId = Number(
      (
        await db('knowledge_research_graph_records')
          .where({
            release_id: (await db('knowledge_research_active_releases').first('release_id'))
              .release_id,
            record_key: assertionId,
          })
          .first('id')
      )?.id
    );
    const started = await startReviewWorkflow();
    await expect(transitionResearchReview(db, reviewInput(started.id))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await db('workflow_instances').where({ id: started.id }).first('revision')
    ).toMatchObject({ revision: 0 });
    expect(await db('workflow_events')).toHaveLength(1);
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('binds the decision to the active graph release and commits it with the workflow event', async () => {
    const started = await startReviewWorkflow();
    const completed = await transitionResearchReview(db, reviewInput(started.id));
    const stored = await db('knowledge_research_review_events').first();
    const event = JSON.parse(String(stored.event_json)) as Record<string, unknown>;
    expect(completed).toMatchObject({ status: 'completed', currentState: 'approved', revision: 1 });
    expect(event).toMatchObject({
      subject_id: assertionId,
      subject_revision: 1,
      research_release_digest: releaseDigest,
      workflow_instance_id: started.id,
      workflow_event_sequence: 1,
      reviewer_id: 'mw:user:synthetic-reviewer',
      requester_id: 'mw:user:synthetic-requester',
      visibility: 'INTERNAL',
    });
    expect(
      await db('workflow_events').where({ instance_id: started.id, sequence: 1 })
    ).toHaveLength(1);
    expect(await db('knowledge_research_review_events')).toHaveLength(1);
    await expect(
      readResearchReviewHistory(db, { subjectId: assertionId, companyId })
    ).resolves.toMatchObject({
      events: [{ workflow_instance_id: started.id, research_release_digest: releaseDigest }],
      truncated: false,
    });
    await expect(
      readResearchReviewHistory(db, { subjectId: assertionId, companyId: companyId + 1 })
    ).resolves.toMatchObject({ events: [], truncated: false, nextCursor: null });
  });

  it('replays exact intent without a second event and conflicts on changed evidence', async () => {
    const started = await startReviewWorkflow();
    const input = reviewInput(started.id);
    await transitionResearchReview(db, input);
    await expect(transitionResearchReview(db, input)).resolves.toMatchObject({ revision: 1 });
    await expect(
      transitionResearchReview(db, { ...input, evidenceIds: ['mw:evidence:other'] })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await db('knowledge_research_review_events')).toHaveLength(1);
  });

  it.each([
    'altered',
    'missing',
    'noncanonical',
    'mismatched-event',
    'missing-projection',
  ] as const)(
    'fails closed across replay, history, and evidence resolution after %s workflow corruption',
    async (corruption) => {
      const started = await startReviewWorkflow();
      const input = reviewInput(started.id);
      await transitionResearchReview(db, input);
      await db.raw('DROP TRIGGER workflow_events_reject_update');
      await db.raw('DROP TRIGGER knowledge_research_review_events_reject_delete');
      if (corruption === 'missing-projection') {
        await db('knowledge_research_review_events')
          .where({ workflow_instance_id: started.id })
          .delete();
      } else {
        const stored = await db('workflow_events')
          .where({ instance_id: started.id, sequence: 1 })
          .first('payload');
        const envelope = JSON.parse(String(stored?.payload)) as Record<string, unknown>;
        let payload: string | null;
        if (corruption === 'missing') payload = null;
        else if (corruption === 'noncanonical') payload = JSON.stringify(envelope, null, 2);
        else if (corruption === 'mismatched-event') {
          const event = envelope.event as Record<string, unknown>;
          payload = JSON.stringify({ ...envelope, event: { ...event, outcome: 'rejected' } });
        } else payload = JSON.stringify({ ...envelope, unexpected: true });
        await db('workflow_events')
          .where({ instance_id: started.id, sequence: 1 })
          .update({ payload });
      }
      await expect(transitionResearchReview(db, input)).rejects.toMatchObject({
        code: expect.stringMatching(/INVALID_EVENT_PAYLOAD|IDEMPOTENCY_CONFLICT/),
      });
      await expect(
        readResearchReviewHistory(db, { subjectId: assertionId, companyId })
      ).rejects.toMatchObject({
        code: 'INVALID_EVENT_PAYLOAD',
      });
      await expect(
        resolveConceptProfileEvidence(db, evidenceId, {
          authenticatedReader: { userId: superadminId, companyId, role: 'superadmin' },
          corpusRootDirectory,
        })
      ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    }
  );

  it('allows the ordinary timeout event without a research decision projection', async () => {
    const started = await startReviewWorkflow();
    await db('workflow_instances')
      .where({ id: started.id })
      .update({ due_at: '2026-10-16T00:00:00.000Z' });
    await expect(expireDueWorkflows(db, new Date('2026-10-17T00:00:00.000Z'))).resolves.toBe(1);
    await expect(
      readResearchReviewHistory(db, { subjectId: assertionId, companyId })
    ).resolves.toMatchObject({
      events: [],
      truncated: false,
    });
  });

  it('keeps a multi-approval intermediate vote as event:null without a decision projection', async () => {
    const definition = await db('workflow_definitions').where({ code: 'research.review' }).first();
    const config = JSON.parse(String(definition?.config)) as {
      transitions: Array<Record<string, unknown>>;
    };
    config.transitions = config.transitions.map((transition) =>
      transition.action === 'approve' ? { ...transition, requiredApprovals: 2 } : transition
    );
    await db('workflow_definitions')
      .where({ code: 'research.review' })
      .update({ config: JSON.stringify(config) });
    const started = await startReviewWorkflow();
    await expect(transitionResearchReview(db, reviewInput(started.id))).resolves.toMatchObject({
      currentState: 'submitted',
      revision: 1,
      status: 'active',
    });
    const stored = await db('workflow_events')
      .where({ instance_id: started.id, sequence: 1 })
      .first('payload');
    expect(JSON.parse(String(stored?.payload))).toMatchObject({
      event: null,
      workflowPreparedPayload: 1,
    });
    expect(
      await db('knowledge_research_review_events').where({ workflow_instance_id: started.id })
    ).toHaveLength(0);
    await expect(
      readResearchReviewHistory(db, { subjectId: assertionId, companyId })
    ).resolves.toMatchObject({ events: [] });
  });

  it('binds a relation decision to its active revision and directly linked evidence', async () => {
    const started = await startReviewWorkflow(
      ResearchGraphRecord.modelName,
      activeRelationRecordId
    );
    const completed = await transitionResearchReview(
      db,
      reviewInput(started.id, { subjectId: relationId })
    );
    const stored = await db('knowledge_research_review_events').first();
    expect(completed).toMatchObject({ status: 'completed', currentState: 'approved', revision: 1 });
    expect(JSON.parse(String(stored.event_json))).toMatchObject({
      subject_id: relationId,
      research_release_digest: releaseDigest,
      outcome: 'accepted',
    });
  });

  it('rejects a resource outside the active graph before committing a review', async () => {
    const started = await startReviewWorkflow('base.partner', 1);
    await expect(transitionResearchReview(db, reviewInput(started.id))).rejects.toMatchObject({
      code: 'INVALID_EVENT_PAYLOAD',
    });
    expect(
      await db('workflow_instances').where({ id: started.id }).first('revision')
    ).toMatchObject({
      revision: 0,
    });
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('rejects evidence that is not present and associated in the active graph', async () => {
    const started = await startReviewWorkflow();
    await expect(
      transitionResearchReview(
        db,
        reviewInput(started.id, {
          evidenceIds: ['mw:evidence:not-in-active-release'],
          idempotencyKey: 'research-review-unbound-evidence-01',
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    expect(
      await db('workflow_instances').where({ id: started.id }).first('revision')
    ).toMatchObject({
      revision: 0,
    });
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('rejects a stale research subject revision without committing workflow state', async () => {
    const started = await startReviewWorkflow();
    await expect(
      transitionResearchReview(db, reviewInput(started.id, { expectedSubjectRevision: 2 }))
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(
      await db('workflow_instances').where({ id: started.id }).first('revision')
    ).toMatchObject({
      revision: 0,
    });
    expect(
      await db('workflow_events').where({ instance_id: started.id, sequence: 1 })
    ).toHaveLength(0);
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('rejects an authenticated role that does not match the persisted database user', async () => {
    const started = await startReviewWorkflow();
    await expect(
      transitionResearchReview(
        db,
        reviewInput(started.id, {
          authenticatedReviewer: { userId: superadminId, companyId, role: 'user' },
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await db('workflow_instances').where({ id: started.id }).first('revision')
    ).toMatchObject({
      revision: 0,
    });
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('rolls back approvals, workflow state, and workflow event if decision persistence fails', async () => {
    const started = await startReviewWorkflow();
    await db.raw(`
      CREATE TRIGGER fail_research_review_event
      BEFORE INSERT ON knowledge_research_review_events
      BEGIN SELECT RAISE(ABORT, 'injected review persistence failure'); END
    `);
    await expect(transitionResearchReview(db, reviewInput(started.id))).rejects.toThrow(
      'injected review persistence failure'
    );
    expect(
      await db('workflow_instances').where({ id: started.id }).first('revision', 'status')
    ).toMatchObject({
      revision: 0,
      status: 'active',
    });
    expect(await db('workflow_approvals').where({ instance_id: started.id })).toHaveLength(0);
    expect(
      await db('workflow_events').where({ instance_id: started.id, sequence: 1 })
    ).toHaveLength(0);
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('enforces workflow self-review rejection before writing a research decision', async () => {
    const started = await startWorkflow(db, {
      code: 'research.review',
      companyId,
      actorId: superadminId,
      role: 'superadmin',
      resourceModel: ResearchGraphRecord.modelName,
      resourceId: activeRecordId,
      idempotencyKey: 'research-review-self-start-001',
      now: new Date('2026-10-16T00:01:00.000Z'),
    });
    await expect(transitionResearchReview(db, reviewInput(started.id))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db('knowledge_research_review_events')).toHaveLength(0);
  });

  it('protects review history from raw SQL edits', async () => {
    const started = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(started.id));
    const row = await db('knowledge_research_review_events').first('id');
    await expect(
      db('knowledge_research_review_events').where({ id: row.id }).update({ event_json: '{}' })
    ).rejects.toThrow('append-only');
    await expect(
      db('knowledge_research_review_events').where({ id: row.id }).delete()
    ).rejects.toThrow('append-only');
  });

  it('fails closed when a privileged database edit corrupts prior review bytes', async () => {
    const first = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(first.id));
    const second = await startWorkflow(db, {
      code: 'research.review',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: ResearchGraphRecord.modelName,
      resourceId: activeRecordId,
      idempotencyKey: 'research-review-corruption-followup-01',
      now: new Date('2026-10-16T00:03:00.000Z'),
    });
    await db.raw('DROP TRIGGER knowledge_research_review_events_reject_update');
    await db('knowledge_research_review_events').where({ workflow_instance_id: first.id }).update({
      event_json: '{}',
    });
    await expect(
      readResearchReviewHistory(db, { subjectId: assertionId, companyId })
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    await expect(
      transitionResearchReview(
        db,
        reviewInput(second.id, { idempotencyKey: 'research-review-after-corruption-01' })
      )
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    expect(await db('workflow_instances').where({ id: second.id }).first('revision')).toMatchObject(
      {
        revision: 0,
      }
    );
  });

  it('rejects review history whose indexed tenant binding disagrees with the event payload', async () => {
    const first = await startReviewWorkflow();
    await transitionResearchReview(db, reviewInput(first.id));
    const otherCompanyId = Number(
      await db('companies').insert({
        name: 'Research review isolation company',
        timezone: 'UTC',
        active: true,
      })
    );
    const otherCompanyWorkflow = await startWorkflow(db, {
      code: 'research.review',
      companyId: otherCompanyId,
      actorId: systemId,
      role: 'system',
      resourceModel: ResearchGraphRecord.modelName,
      resourceId: activeRecordId,
      idempotencyKey: 'research-review-other-company-01',
      now: new Date('2026-10-16T00:03:00.000Z'),
    });
    const followup = await startWorkflow(db, {
      code: 'research.review',
      companyId,
      actorId: systemId,
      role: 'system',
      resourceModel: ResearchGraphRecord.modelName,
      resourceId: activeRecordId,
      idempotencyKey: 'research-review-binding-followup-01',
      now: new Date('2026-10-16T00:03:01.000Z'),
    });

    await db.raw('DROP TRIGGER knowledge_research_review_events_reject_update');
    await db('knowledge_research_review_events')
      .where({ workflow_instance_id: first.id })
      .update({ workflow_instance_id: otherCompanyWorkflow.id });

    await expect(
      readResearchReviewHistory(db, { subjectId: assertionId, companyId: otherCompanyId })
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    await expect(
      transitionResearchReview(
        db,
        reviewInput(followup.id, { idempotencyKey: 'research-review-binding-decision-01' })
      )
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    expect(
      await db('workflow_instances').where({ id: followup.id }).first('revision')
    ).toMatchObject({ revision: 0 });
  });
});
