import { describe, expect, it } from 'vitest';
import {
  appendResearchReviewEvent,
  summarizeResearchReviewHistory,
  validateResearchReviewEvent,
  type AppendResearchReviewInput,
  type ResearchAssertion,
  type ResearchReviewEvent,
} from '../src/index.js';

const subject: ResearchAssertion = {
  id: 'mw:assertion:review-subject-001',
  kind: 'Assertion',
  schema_version: 1,
  lifecycle: 'candidate',
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
  origin_ref: 'synthetic:test:review-subject',
  visibility: 'INTERNAL',
  content_revision: 2,
  claim: 'Synthetic claim under review.',
  polarity: 'positive',
  scope: { kind: 'passage', reference_id: 'mw:passage:sample-verse' },
  context: { mode: 'analysis', reference_id: 'mw:passage:sample-verse' },
  epistemic_status: 'hypothesized',
  review_status: 'pending',
};

function input(overrides: Partial<AppendResearchReviewInput> = {}): AppendResearchReviewInput {
  return {
    authenticatedActorId: 'mw:user:reviewer-01',
    authenticatedRole: 'user',
    requesterId: 'mw:user:author-01',
    expectedSubjectRevision: 2,
    researchReleaseDigest: 'a'.repeat(64),
    workflowInstanceId: 41,
    workflowEventSequence: 1,
    workflowRevision: 1,
    outcome: 'accepted',
    evidenceIds: ['mw:evidence:review-source'],
    evidenceVisibility: new Map([['mw:evidence:review-source', 'INTERNAL']]),
    idempotencyKey: 'research-review-action-0001',
    now: new Date('2026-10-16T02:00:00Z'),
    ...overrides,
  };
}

function event(outcome: 'accepted' | 'rejected', sequence: number): ResearchReviewEvent {
  const result = appendResearchReviewEvent(
    subject,
    [],
    input({
      outcome,
      workflowInstanceId: sequence + 40,
      workflowEventSequence: sequence,
      idempotencyKey: `research-review-action-${String(sequence).padStart(4, '0')}`,
    })
  );
  if (result.status !== 'appended') throw new Error('expected review event to append');
  return result.event;
}

describe('research review event flow', () => {
  it('binds an append-only decision to exact subject and committed workflow revisions', () => {
    const result = appendResearchReviewEvent(subject, [], input());
    expect(result).toMatchObject({
      status: 'appended',
      event: {
        subject_id: subject.id,
        subject_revision: 2,
        workflow_instance_id: 41,
        workflow_event_sequence: 1,
        workflow_revision: 1,
        outcome: 'accepted',
        reviewer_id: 'mw:user:reviewer-01',
        visibility: 'INTERNAL',
      },
    });
  });

  it('rejects stale revisions, self-review, missing evidence, and unauthorized roles', () => {
    for (const invalidInput of [
      input({ expectedSubjectRevision: 1 }),
      input({ requesterId: 'mw:user:reviewer-01' }),
      input({ evidenceVisibility: new Map() }),
      input({ authenticatedRole: 'system' as never }),
    ]) {
      expect(appendResearchReviewEvent(subject, [], invalidInput).status).toBe('invalid');
    }
  });

  it('replays exact idempotent decisions but rejects key reuse or duplicate workflow actions', () => {
    const first = appendResearchReviewEvent(subject, [], input());
    if (first.status !== 'appended') throw new Error('expected first event to append');
    expect(appendResearchReviewEvent(subject, first.history, input())).toMatchObject({
      status: 'replayed',
      event: { id: first.event.id },
    });
    expect(
      appendResearchReviewEvent(subject, first.history, input({ outcome: 'rejected' }))
    ).toMatchObject({
      status: 'invalid',
      issues: [expect.objectContaining({ code: 'idempotency_conflict' })],
    });
    expect(
      appendResearchReviewEvent(
        subject,
        first.history,
        input({ idempotencyKey: 'different-action-key-0002' })
      )
    ).toMatchObject({
      status: 'invalid',
      issues: [expect.objectContaining({ code: 'duplicate_workflow_event' })],
    });
  });

  it('replays a committed decision after the subject advances to a newer revision', () => {
    const first = appendResearchReviewEvent(subject, [], input());
    if (first.status !== 'appended') throw new Error('expected first event to append');
    expect(
      appendResearchReviewEvent({ ...subject, content_revision: 3 }, first.history, input())
    ).toMatchObject({ status: 'replayed', event: { subject_revision: 2 } });
  });

  it('retains contradictory decisions and summarizes them per subject revision', () => {
    const history = [event('accepted', 1), event('rejected', 2)];
    expect(summarizeResearchReviewHistory(subject.id, 2, history)).toMatchObject({
      status: 'conflicting',
      events: history,
    });
    expect(summarizeResearchReviewHistory(subject.id, 1, history)).toEqual({
      status: 'unreviewed',
      events: [],
    });
  });

  it('raises event visibility to the most restrictive referenced evidence', () => {
    const result = appendResearchReviewEvent(
      subject,
      [],
      input({
        evidenceVisibility: new Map([['mw:evidence:review-source', 'CHILD_SENSITIVE']]),
      })
    );
    expect(result).toMatchObject({ status: 'appended', event: { visibility: 'CHILD_SENSITIVE' } });
  });

  it('validates event shape and permits a new revision while retaining prior decisions', () => {
    const first = event('accepted', 1);
    expect(validateResearchReviewEvent(first)).toEqual({ valid: true, issues: [] });
    expect(validateResearchReviewEvent({ ...first, subject_revision: 0 })).toMatchObject({
      valid: false,
    });
    const revisedSubject = { ...subject, content_revision: 3 };
    const next = appendResearchReviewEvent(
      revisedSubject,
      [first],
      input({
        expectedSubjectRevision: 3,
        workflowInstanceId: 43,
        workflowEventSequence: 1,
        workflowRevision: 1,
        idempotencyKey: 'research-review-action-0003',
      })
    );
    expect(next).toMatchObject({ status: 'appended' });
    if (next.status === 'appended') {
      expect(next.history).toHaveLength(2);
      expect(summarizeResearchReviewHistory(subject.id, 3, next.history)).toMatchObject({
        status: 'accepted',
        events: [next.event],
      });
    }
  });
});
