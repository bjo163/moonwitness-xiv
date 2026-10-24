import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import knex, { type Knex } from 'knex';
import { installAddons } from '@moonwitness/orm';
import { manifest as baseManifest } from '@moonwitness/orm-base';
import { jobsManifest } from '@moonwitness/jobs';
import { manifest as notificationManifest } from '@moonwitness/orm-notification';
import { manifest as workflowManifest } from '@moonwitness/orm-workflow';
import {
  manifest,
  readTextualAlignmentCandidateVersion,
  storeTextualAlignmentCandidates,
} from '../src/index.js';
import { canonicalResearchJson } from '../src/research-release.js';

let db: Knex;
let userId: number;
let companyId: number;
const leftText = 'Synthetic passage left.';
const rightText = 'Synthetic passage right.';
const selector = (tradition: string, text: string, quote: string) => {
  const start = Array.from(text.slice(0, text.indexOf(quote))).length;
  return {
    source_id: `mw:source:synthetic-${tradition}`,
    expression_id: `mw:expression:synthetic-${tradition}`,
    edition_id: `mw:edition:synthetic-${tradition}-v1`,
    locator: `synthetic:${tradition}:1`,
    content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    range: { unit: 'unicode_scalar' as const, start, end: start + Array.from(quote).length },
    quote,
  };
};
const passages = [
  {
    evidence_id: 'mw:evidence:synthetic-left',
    tradition_context_id: 'mw:tradition:synthetic-left',
    ...selector('left', leftText, 'passage left'),
    text: leftText,
  },
  {
    evidence_id: 'mw:evidence:synthetic-right',
    tradition_context_id: 'mw:tradition:synthetic-right',
    ...selector('right', rightText, 'passage right'),
    text: rightText,
  },
];
function candidate(note = 'Synthetic only; unresolved review subject.') {
  return {
    id: 'mw:textual-alignment-candidate:synthetic-pair',
    left: {
      evidence_id: passages[0]!.evidence_id,
      selector: selector('left', leftText, 'passage left'),
    },
    right: {
      evidence_id: passages[1]!.evidence_id,
      selector: selector('right', rightText, 'passage right'),
    },
    similarity_score: 0.42,
    method: { id: 'mw:alignment-method:synthetic', version: '1.0.0' },
    uncertainty: { level: 'high', note },
  };
}
const resolver = async (evidenceId: string) =>
  passages.find((passage) => passage.evidence_id === evidenceId) ?? null;
const actor = () => ({ userId, companyId, role: 'superadmin' as const });

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
  userId = Number((await db('users').where({ login: 'superadmin' }).first('id'))?.id);
  companyId = Number((await db('companies').first('id'))?.id);
  await db('company_memberships')
    .insert({ user_id: userId, company_id: companyId, is_default: true })
    .onConflict(['user_id', 'company_id'])
    .ignore();
});
afterEach(async () => db.destroy());

describe('tenant-scoped INTERNAL textual alignment candidate versions', () => {
  it('re-projects untrusted candidates, retries idempotently, appends changes, and reads scoped canonical bytes', async () => {
    const input = {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    };
    const [first] = await storeTextualAlignmentCandidates(db, input);
    const [retry] = await storeTextualAlignmentCandidates(db, input);
    const [changed] = await storeTextualAlignmentCandidates(db, {
      ...input,
      candidates: [candidate('Different synthetic uncertainty.')],
    });
    expect(first).toMatchObject({ version: 1, visibility: 'INTERNAL', idempotent: false });
    expect(retry).toMatchObject({ version: 1, digest: first!.digest, idempotent: true });
    expect(changed).toMatchObject({ version: 2, idempotent: false });
    expect(first!.candidate.left).not.toHaveProperty('text');
    expect(await db('knowledge_textual_alignment_candidate_versions')).toHaveLength(2);
    expect(
      await readTextualAlignmentCandidateVersion(db, {
        authenticatedReader: actor(),
        candidateId: first!.candidateId,
      })
    ).toMatchObject({ version: 2, visibility: 'INTERNAL' });
    await expect(
      db('knowledge_textual_alignment_candidate_versions')
        .where({ id: 1 })
        .update({ visibility: 'PUBLIC' })
    ).rejects.toThrow(/append-only/u);
    await expect(
      db('knowledge_textual_alignment_candidate_versions').where({ id: 1 }).delete()
    ).rejects.toThrow(/append-only/u);
  });

  it('rejects duplicate IDs, resolver mismatch, inactive tenant membership, and cross-company reads', async () => {
    await expect(
      storeTextualAlignmentCandidates(db, {
        authenticatedActor: actor(),
        resolvePassage: resolver,
        candidates: [candidate(), candidate()],
      })
    ).rejects.toThrow(/duplicate candidate IDs/u);
    await expect(
      storeTextualAlignmentCandidates(db, {
        authenticatedActor: actor(),
        resolvePassage: async () => null,
        candidates: [candidate()],
      })
    ).rejects.toThrow();
    await storeTextualAlignmentCandidates(db, {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    });
    await expect(
      readTextualAlignmentCandidateVersion(db, {
        authenticatedReader: { ...actor(), companyId: companyId + 1 },
        candidateId: 'mw:textual-alignment-candidate:synthetic-pair',
      })
    ).rejects.toThrow(/unavailable in this company context/u);
    await db('company_memberships')
      .where({ user_id: userId, company_id: companyId })
      .update({ active: false });
    await expect(
      storeTextualAlignmentCandidates(db, {
        authenticatedActor: actor(),
        resolvePassage: resolver,
        candidates: [candidate()],
      })
    ).rejects.toThrow(/unavailable in this company context/u);
  });

  it('rejects stored rows that add nested text outside the citation-only projection', async () => {
    const [stored] = await storeTextualAlignmentCandidates(db, {
      authenticatedActor: actor(),
      resolvePassage: resolver,
      candidates: [candidate()],
    });
    const candidateId = 'mw:textual-alignment-candidate:forged-read-shape';
    const forged = structuredClone(stored!.candidate) as unknown as {
      id: string;
      left: Record<string, unknown>;
    };
    forged.id = candidateId;
    forged.left.selector = { text: 'synthetic full passage must never be returned' };
    const candidateJson = canonicalResearchJson(forged);
    const candidateDigest = createHash('sha256').update(candidateJson, 'utf8').digest('hex');
    await db('knowledge_textual_alignment_candidate_versions').insert({
      company_id: companyId,
      candidate_id: candidateId,
      version: 1,
      visibility: 'INTERNAL',
      candidate_json: candidateJson,
      candidate_digest: candidateDigest,
      recorded_by_id: userId,
    });
    await expect(
      readTextualAlignmentCandidateVersion(db, {
        authenticatedReader: actor(),
        candidateId,
      })
    ).rejects.toThrow(
      'Stored textual alignment candidate failed canonical projection verification'
    );
  });
});
