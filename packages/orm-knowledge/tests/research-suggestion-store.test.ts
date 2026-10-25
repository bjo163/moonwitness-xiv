import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { isAttestedResearchSuggestionReviewDecision } from '@moonwitness/research';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import {
  manifest,
  listResearchSuggestionVersions,
  readResearchSuggestionVersion,
  recordResearchSuggestionReviewDecision,
  resolveResearchSuggestionReviewDecision,
  storeResearchSuggestions,
} from '../src/index.js';
import { canonicalResearchJson } from '../src/research-release.js';

let db: Knex;
let userId: number;
let companyId: number;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function suggestion(text = 'Synthetic extractive passage.') {
  const sourceText = text;
  return {
    id: 'mw:suggestion:synthetic-summary',
    kind: 'summary',
    status: 'unreviewed',
    visibility: 'INTERNAL',
    text,
    citations: [
      {
        evidence_id: 'mw:evidence:synthetic-evidence',
        assertion_id: 'mw:assertion:synthetic-assertion',
        selector: {
          source_id: 'mw:source:synthetic-source',
          edition_id: 'mw:edition:synthetic-edition',
          locator: text.includes('revised') ? 'synthetic:revision' : 'synthetic:1',
          content_sha256: sha256(sourceText),
          range: { unit: 'unicode_scalar', start: 0, end: Array.from(sourceText).length },
          selected_span_sha256: sha256(sourceText),
        },
      },
    ],
  };
}

function envelope(item = suggestion()) {
  return { format: 'mw-local-ai-suggestion-envelope/v1', suggestions: [item] };
}

const resolver = {
  async resolvePassage(selector: ReturnType<typeof suggestion>['citations'][number]['selector']) {
    const text =
      selector.locator === 'synthetic:revision'
        ? 'Synthetic revised extractive passage.'
        : 'Synthetic extractive passage.';
    return {
      source_id: selector.source_id,
      edition_id: selector.edition_id,
      locator: selector.locator,
      content_sha256: selector.content_sha256,
      text,
      readable: true,
    };
  },
  async resolveAssertion() {
    return { active: true, readable: true };
  },
  async resolveEvidence(evidenceId: string) {
    return {
      assertion_id: 'mw:assertion:synthetic-assertion',
      active: evidenceId === 'mw:evidence:synthetic-evidence',
      readable: true,
    };
  },
};

function resolverForTransaction(trx: Knex.Transaction) {
  return {
    async resolvePassage(selector: ReturnType<typeof suggestion>['citations'][number]['selector']) {
      const row = await trx('test_research_passage_access')
        .where({
          source_id: selector.source_id,
          edition_id: selector.edition_id,
          locator: selector.locator,
        })
        .first('content_sha256', 'text', 'readable');
      return row
        ? {
            source_id: selector.source_id,
            edition_id: selector.edition_id,
            locator: selector.locator,
            content_sha256: String(row.content_sha256),
            text: String(row.text),
            readable: Boolean(row.readable),
          }
        : null;
    },
    async resolveAssertion(assertionId: string) {
      const row = await trx('test_research_assertion_access')
        .where({ assertion_id: assertionId })
        .first('active', 'readable');
      return row ? { active: Boolean(row.active), readable: Boolean(row.readable) } : null;
    },
    async resolveEvidence(evidenceId: string) {
      const row = await trx('test_research_evidence_access')
        .where({ evidence_id: evidenceId })
        .first('assertion_id', 'active', 'readable');
      return row
        ? {
            assertion_id: String(row.assertion_id),
            active: Boolean(row.active),
            readable: Boolean(row.readable),
          }
        : null;
    },
  };
}

const actor = () => ({ userId, companyId, role: 'superadmin' as const });

async function addReviewer(login = 'suggestion-reviewer'): Promise<number> {
  await db('partners').insert({
    name: `Synthetic ${login}`,
    company_id: companyId,
    is_company: false,
  });
  const partnerId = Number(
    (
      await db('partners')
        .where({ name: `Synthetic ${login}` })
        .first('id')
    )?.id
  );
  await db('users').insert({ login, partner_id: partnerId, role: 'user' });
  const reviewerId = Number((await db('users').where({ login }).first('id'))?.id);
  await db('company_memberships').insert({
    user_id: reviewerId,
    company_id: companyId,
    is_default: false,
  });
  return reviewerId;
}

function review(
  reviewerId: number,
  suggestionId: string,
  overrides: Partial<{
    outcome: 'accepted' | 'rejected';
    rationale: string;
    reviewedVersion: number;
    reviewerCompanyId: number;
    reviewerRole: 'user' | 'superadmin';
  }> = {}
) {
  return {
    authenticatedReviewer: {
      userId: reviewerId,
      companyId: overrides.reviewerCompanyId ?? companyId,
      role: overrides.reviewerRole ?? ('user' as const),
    },
    suggestionId,
    ...(overrides.reviewedVersion === undefined
      ? {}
      : { reviewedVersion: overrides.reviewedVersion }),
    outcome: overrides.outcome ?? ('accepted' as const),
    rationale:
      overrides.rationale ?? 'Checked the extractive passage and the citation-only boundary.',
  };
}

function reader(reviewerId: number, reviewerCompanyId = companyId) {
  return {
    authenticatedReader: {
      userId: reviewerId,
      companyId: reviewerCompanyId,
      role: 'user' as const,
    },
  };
}

describe('suggestion-digest review decisions', () => {
  it('binds an accepted decision to a stored version the reviewer did not store', async () => {
    const [stored] = await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    const suggestionId = stored!.suggestionId;
    await expect(
      recordResearchSuggestionReviewDecision(
        db,
        review(userId, suggestionId, { reviewerRole: 'superadmin' })
      )
    ).rejects.toThrow(/someone other than the actor who stored it/u);
    expect(await db('knowledge_research_suggestion_review_decisions')).toHaveLength(0);

    const reviewerId = await addReviewer();
    const decision = await recordResearchSuggestionReviewDecision(
      db,
      review(reviewerId, suggestionId)
    );
    expect(decision).toMatchObject({
      kind: 'ResearchSuggestionReviewDecision',
      suggestion_id: suggestionId,
      suggestion_digest: stored!.digest,
      reviewed_version: 1,
      outcome: 'accepted',
      reviewer_id: String(reviewerId),
    });
    expect(
      isAttestedResearchSuggestionReviewDecision(decision, {
        company_id: String(companyId),
        reviewer_id: String(reviewerId),
      })
    ).toBe(true);
    await expect(
      resolveResearchSuggestionReviewDecision(db, {
        ...reader(reviewerId),
        suggestionId,
        suggestionDigest: stored!.digest,
      })
    ).resolves.toMatchObject({ id: decision.id });
    await expect(
      resolveResearchSuggestionReviewDecision(db, {
        ...reader(reviewerId),
        suggestionId,
        suggestionDigest: 'f'.repeat(64),
      })
    ).resolves.toBeNull();

    // Accepting admits the candidate for follow-up work only: the stored version is untouched.
    expect(
      await db('knowledge_research_suggestion_versions')
        .where({ version: 1 })
        .first('visibility', 'status')
    ).toMatchObject({ visibility: 'INTERNAL', status: 'unreviewed' });
    await expect(
      readResearchSuggestionVersion(db, {
        authenticatedReader: actor(),
        suggestionId,
        resolverForTransaction,
      })
    ).resolves.toMatchObject({ status: 'unreviewed' });
    expect(await db('knowledge_research_graph_records')).toHaveLength(0);
  });

  it('pins a decision to one version, so an appended version needs a decision of its own', async () => {
    const input = {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    };
    const [first] = await storeResearchSuggestions(db, input);
    await storeResearchSuggestions(db, {
      ...input,
      envelope: envelope(suggestion('Synthetic revised extractive passage.')),
    });
    const reviewerId = await addReviewer();
    const pinned = await recordResearchSuggestionReviewDecision(
      db,
      review(reviewerId, first!.suggestionId, { reviewedVersion: 1 })
    );
    expect(pinned.reviewed_version).toBe(1);
    expect(pinned.suggestion_digest).toBe(first!.digest);
    const latest = await recordResearchSuggestionReviewDecision(
      db,
      review(reviewerId, first!.suggestionId, { outcome: 'rejected' })
    );
    expect(latest).toMatchObject({ reviewed_version: 2, outcome: 'rejected' });
    expect(await db('knowledge_research_suggestion_review_decisions')).toHaveLength(2);
  });

  it('refuses a decision without a stored version, a blank rationale, or a forged row shape', async () => {
    const reviewerId = await addReviewer();
    await expect(
      recordResearchSuggestionReviewDecision(db, review(reviewerId, 'mw:suggestion:never-stored'))
    ).rejects.toThrow(/must bind a stored version/u);
    const [stored] = await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    await expect(
      recordResearchSuggestionReviewDecision(
        db,
        review(reviewerId, stored!.suggestionId, { rationale: '   ' })
      )
    ).rejects.toThrow(/bounded rationale/u);
    await expect(
      recordResearchSuggestionReviewDecision(db, {
        ...review(reviewerId, stored!.suggestionId),
        suggestionId: 'suggestion:synthetic-summary',
      })
    ).rejects.toThrow(/review context is invalid/u);
    await expect(
      recordResearchSuggestionReviewDecision(db, {
        ...review(reviewerId, stored!.suggestionId),
        outcome: 'promoted' as 'accepted',
      })
    ).rejects.toThrow(/accepted or rejected/u);
    expect(await db('knowledge_research_suggestion_review_decisions')).toHaveLength(0);
  });

  it('replays one reviewer’s decision idempotently and refuses a contradictory second outcome', async () => {
    const [stored] = await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    const reviewerId = await addReviewer();
    const first = await recordResearchSuggestionReviewDecision(
      db,
      review(reviewerId, stored!.suggestionId)
    );
    const replay = await recordResearchSuggestionReviewDecision(
      db,
      review(reviewerId, stored!.suggestionId)
    );
    expect(replay).toMatchObject({ id: first.id, outcome: 'accepted' });
    expect(await db('knowledge_research_suggestion_review_decisions')).toHaveLength(1);
    await expect(
      recordResearchSuggestionReviewDecision(
        db,
        review(reviewerId, stored!.suggestionId, { outcome: 'rejected' })
      )
    ).rejects.toThrow(/already recorded/u);
    expect(await db('knowledge_research_suggestion_review_decisions')).toHaveLength(1);
  });

  it('keeps decisions append-only and invisible to another company', async () => {
    const [stored] = await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    const reviewerId = await addReviewer();
    const decision = await recordResearchSuggestionReviewDecision(
      db,
      review(reviewerId, stored!.suggestionId)
    );
    const otherCompanyId = Number(
      await db('companies').insert({
        name: 'Separate suggestion tenant',
        timezone: 'UTC',
        active: true,
      })
    );
    await db('company_memberships').insert({
      user_id: reviewerId,
      company_id: otherCompanyId,
      is_default: false,
    });
    await expect(
      resolveResearchSuggestionReviewDecision(db, {
        ...reader(reviewerId, otherCompanyId),
        suggestionId: stored!.suggestionId,
        suggestionDigest: decision.suggestion_digest,
      })
    ).resolves.toBeNull();
    await expect(
      recordResearchSuggestionReviewDecision(
        db,
        review(reviewerId, stored!.suggestionId, { reviewerCompanyId: otherCompanyId })
      )
    ).rejects.toThrow(/must bind a stored version/u);

    const rowId = Number(
      (
        await db('knowledge_research_suggestion_review_decisions')
          .where({ suggestion_digest: decision.suggestion_digest })
          .first('id')
      )?.id
    );
    await expect(
      db('knowledge_research_suggestion_review_decisions')
        .where({ id: rowId })
        .update({ outcome: 'rejected' })
    ).rejects.toThrow(/append-only/u);
    await expect(
      db('knowledge_research_suggestion_review_decisions').where({ id: rowId }).delete()
    ).rejects.toThrow(/append-only/u);
  });

  it('yields nothing authorizing for a stored row that leaves canonical envelope form', async () => {
    const [stored] = await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    const reviewerId = await addReviewer();
    await recordResearchSuggestionReviewDecision(db, review(reviewerId, stored!.suggestionId));

    const forgedId = 'mw:suggestion:forged-review-shape';
    // Key order differs from canonical form while the digest still matches the stored bytes.
    const forgedJson = JSON.stringify({ ...suggestion(), id: forgedId });
    await db('knowledge_research_suggestion_versions').insert({
      company_id: companyId,
      suggestion_id: forgedId,
      version: 1,
      visibility: 'INTERNAL',
      status: 'unreviewed',
      suggestion_json: forgedJson,
      suggestion_digest: sha256(forgedJson),
      recorded_by_id: userId,
    });
    await expect(
      recordResearchSuggestionReviewDecision(db, review(reviewerId, forgedId))
    ).rejects.toThrow(/failed its own integrity check/u);
    expect(await db('knowledge_research_suggestion_review_decisions')).toHaveLength(1);
  });
});

beforeEach(async () => {
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await installAddons(db, [
    baseManifest,
    jobsManifest,
    notificationManifest,
    workflowManifest,
    manifest,
  ]);
  await db.schema.createTable('test_research_evidence_access', (table) => {
    table.string('evidence_id').primary();
    table.string('assertion_id').notNullable();
    table.boolean('active').notNullable();
    table.boolean('readable').notNullable();
  });
  await db.schema.createTable('test_research_assertion_access', (table) => {
    table.string('assertion_id').primary();
    table.boolean('active').notNullable();
    table.boolean('readable').notNullable();
  });
  await db.schema.createTable('test_research_passage_access', (table) => {
    table.string('source_id').notNullable();
    table.string('edition_id').notNullable();
    table.string('locator').notNullable();
    table.string('content_sha256').notNullable();
    table.text('text').notNullable();
    table.boolean('readable').notNullable();
    table.primary(['source_id', 'edition_id', 'locator']);
  });
  await db('test_research_evidence_access').insert({
    evidence_id: 'mw:evidence:synthetic-evidence',
    assertion_id: 'mw:assertion:synthetic-assertion',
    active: true,
    readable: true,
  });
  await db('test_research_assertion_access').insert({
    assertion_id: 'mw:assertion:synthetic-assertion',
    active: true,
    readable: true,
  });
  await db('test_research_passage_access').insert({
    source_id: 'mw:source:synthetic-source',
    edition_id: 'mw:edition:synthetic-edition',
    locator: 'synthetic:1',
    content_sha256: sha256('Synthetic extractive passage.'),
    text: 'Synthetic extractive passage.',
    readable: true,
  });
  await db('test_research_passage_access').insert({
    source_id: 'mw:source:synthetic-source',
    edition_id: 'mw:edition:synthetic-edition',
    locator: 'synthetic:revision',
    content_sha256: sha256('Synthetic revised extractive passage.'),
    text: 'Synthetic revised extractive passage.',
    readable: true,
  });
  userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
  companyId = Number((await db('companies').first('id'))?.id);
  await db('company_memberships')
    .insert({ user_id: userId, company_id: companyId, is_default: true })
    .onConflict(['user_id', 'company_id'])
    .ignore();
});

afterEach(async () => db.destroy());

describe('tenant-scoped INTERNAL research suggestion versions', () => {
  it('persists only unreviewed candidates, supports idempotent replay and immutable revisions', async () => {
    const input = {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    };
    const [first] = await storeResearchSuggestions(db, input);
    const [retry] = await storeResearchSuggestions(db, input);
    const [changed] = await storeResearchSuggestions(db, {
      ...input,
      envelope: envelope(suggestion('Synthetic revised extractive passage.')),
    });
    expect(first).toMatchObject({
      version: 1,
      visibility: 'INTERNAL',
      status: 'unreviewed',
      idempotent: false,
    });
    expect(retry).toMatchObject({ version: 1, digest: first!.digest, idempotent: true });
    expect(changed).toMatchObject({ version: 2, status: 'unreviewed', idempotent: false });
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(2);
    await expect(
      readResearchSuggestionVersion(db, {
        authenticatedReader: actor(),
        suggestionId: first!.suggestionId,
        resolverForTransaction,
      })
    ).resolves.toMatchObject({ version: 2, status: 'unreviewed', visibility: 'INTERNAL' });
    await expect(
      db('knowledge_research_suggestion_versions').where({ id: 1 }).update({ visibility: 'PUBLIC' })
    ).rejects.toThrow(/append-only/u);
    await expect(
      db('knowledge_research_suggestion_versions').where({ id: 1 }).delete()
    ).rejects.toThrow(/append-only/u);
    expect(await db('knowledge_research_graph_records')).toHaveLength(0);
  });

  it('rejects malformed or cross-tenant reads and inactive membership', async () => {
    await expect(
      storeResearchSuggestions(db, {
        authenticatedActor: actor(),
        envelope: { suggestions: [] },
        resolverForTransaction,
      })
    ).rejects.toThrow(/schema check/u);
    await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    await expect(
      readResearchSuggestionVersion(db, {
        authenticatedReader: { ...actor(), companyId: companyId + 1 },
        suggestionId: 'mw:suggestion:synthetic-summary',
        resolverForTransaction,
      })
    ).rejects.toThrow(/unavailable in this company context/u);
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    await expect(
      readResearchSuggestionVersion(db, {
        authenticatedReader: actor(),
        suggestionId: 'mw:suggestion:synthetic-summary',
        resolverForTransaction,
      })
    ).rejects.toThrow(/unavailable in this company context/u);
  });

  it('persists the resolver-validated snapshot even if caller input changes during validation', async () => {
    const candidate = envelope();
    const mutableActor = actor();
    const mutatingResolver = {
      ...resolver,
      async resolvePassage(
        selector: ReturnType<typeof suggestion>['citations'][number]['selector']
      ) {
        candidate.suggestions[0]!.text = 'Unsupported changed text';
        mutableActor.companyId += 1;
        return resolver.resolvePassage(selector);
      },
    };

    const [stored] = await storeResearchSuggestions(db, {
      authenticatedActor: mutableActor,
      envelope: candidate,
      resolverForTransaction: (trx) => ({
        ...mutatingResolver,
        resolveEvidence: resolverForTransaction(trx).resolveEvidence,
      }),
    });

    expect(stored?.suggestion.text).toBe('Synthetic extractive passage.');
    await expect(
      readResearchSuggestionVersion(db, {
        authenticatedReader: actor(),
        suggestionId: 'mw:suggestion:synthetic-summary',
        resolverForTransaction,
      })
    ).resolves.toMatchObject({ suggestion: { text: 'Synthetic extractive passage.' } });
  });

  it('revalidates authoritative evidence inside the storage transaction', async () => {
    const input = {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    };

    // Access is revoked after candidate preparation and before the storage transaction begins.
    await db('test_research_evidence_access')
      .where({ evidence_id: 'mw:evidence:synthetic-evidence' })
      .update({ active: false, readable: false });
    await expect(storeResearchSuggestions(db, input)).rejects.toThrow(
      /trusted source and evidence validation/u
    );
    expect(await db('knowledge_research_suggestion_versions')).toHaveLength(0);
  });

  it('snapshots the reader tenant before asynchronous database checks', async () => {
    await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    const mutableReader = actor();
    const read = readResearchSuggestionVersion(db, {
      authenticatedReader: mutableReader,
      suggestionId: 'mw:suggestion:synthetic-summary',
      resolverForTransaction,
    });
    mutableReader.companyId += 1;
    await expect(read).resolves.toMatchObject({
      version: 1,
      suggestionId: 'mw:suggestion:synthetic-summary',
    });
  });

  it('detects canonical-byte tampering even when the row contains valid JSON', async () => {
    await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    const forged = canonicalResearchJson({
      ...suggestion(),
      text: 'Out-of-band altered content.',
      status: 'unreviewed',
      visibility: 'INTERNAL',
    });
    // Simulate an out-of-band privileged database edit to exercise read-time integrity checks.
    await db.raw('DROP TRIGGER knowledge_research_suggestion_versions_reject_update');
    await db('knowledge_research_suggestion_versions')
      .where({ suggestion_id: 'mw:suggestion:synthetic-summary' })
      .update({ suggestion_json: forged });
    await expect(
      readResearchSuggestionVersion(db, {
        authenticatedReader: actor(),
        suggestionId: 'mw:suggestion:synthetic-summary',
        resolverForTransaction,
      })
    ).rejects.toThrow(/integrity verification/u);
  });

  it.each(['source', 'assertion', 'evidence'] as const)(
    'fails closed when current %s access or content changes after persistence',
    async (record) => {
      await storeResearchSuggestions(db, {
        authenticatedActor: actor(),
        envelope: envelope(),
        resolverForTransaction,
      });
      if (record === 'source') {
        await db('test_research_passage_access')
          .where({ locator: 'synthetic:1' })
          .update({
            content_sha256: sha256('Changed source passage.'),
            text: 'Changed source passage.',
          });
      } else if (record === 'assertion') {
        await db('test_research_assertion_access')
          .where({ assertion_id: 'mw:assertion:synthetic-assertion' })
          .update({ active: false });
      } else {
        await db('test_research_evidence_access')
          .where({ evidence_id: 'mw:evidence:synthetic-evidence' })
          .update({ active: false, readable: false });
      }

      await expect(
        readResearchSuggestionVersion(db, {
          authenticatedReader: actor(),
          suggestionId: 'mw:suggestion:synthetic-summary',
          resolverForTransaction,
        })
      ).rejects.toThrow(/trusted source and evidence validation/u);
    }
  );

  it('lists only the newest candidate identity per suggestion id inside the tenant', async () => {
    const input = {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    };
    await storeResearchSuggestions(db, input);
    await storeResearchSuggestions(db, {
      ...input,
      envelope: envelope({ ...suggestion(), id: 'mw:suggestion:synthetic-second' }),
    });
    await storeResearchSuggestions(db, {
      ...input,
      envelope: envelope(suggestion('Synthetic revised extractive passage.')),
    });
    const page = await listResearchSuggestionVersions(db, {
      authenticatedReader: actor(),
      limit: 10,
    });
    expect(page.truncated).toBe(false);
    expect(page.items).toEqual([
      {
        suggestionId: 'mw:suggestion:synthetic-second',
        version: 1,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        visibility: 'INTERNAL',
        status: 'unreviewed',
      },
      {
        suggestionId: 'mw:suggestion:synthetic-summary',
        version: 2,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        visibility: 'INTERNAL',
        status: 'unreviewed',
      },
    ]);
    expect(JSON.stringify(page)).not.toContain('citation');
    const bounded = await listResearchSuggestionVersions(db, {
      authenticatedReader: actor(),
      limit: 1,
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.items.map(({ suggestionId }) => suggestionId)).toEqual([
      'mw:suggestion:synthetic-second',
    ]);
    await expect(
      listResearchSuggestionVersions(db, {
        authenticatedReader: { ...actor(), companyId: companyId + 1 },
        limit: 10,
      })
    ).rejects.toThrow(/unavailable in this company context/u);
    await expect(
      listResearchSuggestionVersions(db, { authenticatedReader: actor(), limit: 0 })
    ).rejects.toThrow(/list context is invalid/u);
    await expect(
      listResearchSuggestionVersions(db, { authenticatedReader: actor(), limit: 101 })
    ).rejects.toThrow(/list context is invalid/u);
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    await expect(
      listResearchSuggestionVersions(db, { authenticatedReader: actor(), limit: 10 })
    ).rejects.toThrow(/unavailable in this company context/u);
  });

  it('fails closed when a listed candidate row no longer matches its stored digest', async () => {
    await storeResearchSuggestions(db, {
      authenticatedActor: actor(),
      envelope: envelope(),
      resolverForTransaction,
    });
    // Simulate an out-of-band privileged database edit to exercise list-time integrity checks.
    await db.raw('DROP TRIGGER knowledge_research_suggestion_versions_reject_update');
    await db('knowledge_research_suggestion_versions')
      .where({ suggestion_id: 'mw:suggestion:synthetic-summary' })
      .update({
        suggestion_json: canonicalResearchJson({
          ...suggestion(),
          text: 'Out-of-band altered content.',
        }),
      });
    await expect(
      listResearchSuggestionVersions(db, { authenticatedReader: actor(), limit: 10 })
    ).rejects.toThrow(/integrity verification/u);
  });
});
