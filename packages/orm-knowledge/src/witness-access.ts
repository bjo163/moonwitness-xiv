import type { Knex } from 'knex';
import { syntheticWitnessSubjectRefSha256 } from './privacy-revocation.js';

export interface AuthenticatedWitnessSteward {
  userId: number;
  companyId: number;
  role: string;
}

type WitnessTimePrecision = 'instant' | 'day' | 'month' | 'year' | 'unknown';
type WitnessVisibility = 'RESTRICTED' | 'INTERNAL' | 'PUBLIC';
type WitnessEpistemicStatus = 'hypothesis' | 'supported' | 'contested' | 'rejected';

interface WitnessTestimonyRow {
  active: boolean;
  id: number;
  external_key: string;
  original_text: string;
  source_label: string;
  source_locator: string;
  source_digest: string;
  received_time_text: string;
  received_time_precision: WitnessTimePrecision;
  uncertainty_note: string | null;
  visibility: WitnessVisibility;
  company_id: number | null;
  created_by_id: number;
  synthetic: boolean;
}

interface WitnessCorrectionRow {
  active: boolean;
  recorded_by_id: number;
  testimony_id: number;
  synthetic: boolean;
  sequence: number;
  correction_text: string;
  reason: string;
  source_label: string;
  source_locator: string;
  source_digest: string;
  asserted_time_text: string;
  asserted_time_precision: WitnessTimePrecision;
  uncertainty_note: string | null;
}

interface WitnessInterpretationRow {
  active: boolean;
  id: number;
  testimony_id: number;
  synthetic: boolean;
  assertion_ref: string;
  evidence_ref: string;
  interpretation_text: string;
  method_label: string;
  method_version: string;
  epistemic_status: WitnessEpistemicStatus;
  visibility: WitnessVisibility;
}

export interface ScopedSyntheticWitness {
  id: number;
  externalKey: string;
  originalText: string;
  sourceLabel: string;
  sourceLocator: string;
  sourceDigest: string;
  receivedTimeText: string;
  receivedTimePrecision: WitnessTimePrecision;
  uncertaintyNote: string | null;
  corrections: Array<{
    sequence: number;
    correctionText: string;
    reason: string;
    sourceLabel: string;
    sourceLocator: string;
    sourceDigest: string;
    assertedTimeText: string;
    assertedTimePrecision: WitnessTimePrecision;
    uncertaintyNote: string | null;
  }>;
  interpretations: Array<{
    assertionRef: string;
    evidenceRef: string;
    interpretationText: string;
    methodLabel: string;
    methodVersion: string;
    epistemicStatus: WitnessEpistemicStatus;
    visibility: WitnessVisibility;
  }>;
}

export type WitnessAccessErrorCode = 'FORBIDDEN' | 'NOT_FOUND';

export class WitnessAccessError extends Error {
  constructor(readonly code: WitnessAccessErrorCode) {
    super(code === 'FORBIDDEN' ? 'Witness access denied' : 'Witness record not found');
    this.name = 'WitnessAccessError';
  }
}

/** The three attribution fields a correction claims to be derived from. */
export interface WitnessCorrectionSourceReference {
  readonly source_label: string;
  readonly source_locator: string;
  readonly source_digest: string;
}

/** A trusted local resolver returns this only after verifying source bytes and citation rights. */
export interface VerifiedWitnessCorrectionSource extends WitnessCorrectionSourceReference {
  readonly bytes_verified: true;
  readonly rights_state: 'permitted';
  readonly allowed_uses: readonly string[];
}

export type WitnessCorrectionSourceResolver = (
  reference: WitnessCorrectionSourceReference
) => Promise<VerifiedWitnessCorrectionSource | null>;

export interface AppendSyntheticWitnessCorrectionInput {
  readonly sequence: number;
  readonly correctionText: string;
  readonly reason: string;
  readonly sourceLabel: string;
  readonly sourceLocator: string;
  readonly sourceDigest: string;
  readonly assertedTimeText: string;
  readonly assertedTimePrecision: WitnessTimePrecision;
  readonly uncertaintyNote?: string | null;
  readonly resolveSource?: WitnessCorrectionSourceResolver;
}

export interface AppendedSyntheticWitnessCorrection {
  readonly sequence: number;
  readonly correctionText: string;
  readonly idempotent: boolean;
}

async function verifyWitnessSteward(
  db: Knex,
  steward: AuthenticatedWitnessSteward,
  lock = false
): Promise<void> {
  if (
    steward.role !== 'superadmin' ||
    !Number.isSafeInteger(steward.userId) ||
    steward.userId < 1 ||
    !Number.isSafeInteger(steward.companyId) ||
    steward.companyId < 1
  ) {
    throw new WitnessAccessError('FORBIDDEN');
  }

  const userQuery = db('users').where({ id: steward.userId, role: 'superadmin', active: true });
  const companyMembershipQuery = db('company_memberships as membership')
    .join('companies as company', 'company.id', 'membership.company_id')
    .where({
      'membership.user_id': steward.userId,
      'membership.company_id': steward.companyId,
      'membership.active': true,
      'company.active': true,
    });
  const witnessGroupMembershipQuery = db('group_memberships as membership')
    .join('access_groups as access_group', 'access_group.id', 'membership.group_id')
    .where({
      'membership.user_id': steward.userId,
      'membership.active': true,
      'access_group.code': 'knowledge_witness_steward',
      'access_group.active': true,
    });
  if (lock) {
    userQuery.forUpdate();
    companyMembershipQuery.forUpdate();
    witnessGroupMembershipQuery.forUpdate();
  }
  const [user, companyMembership, witnessGroupMembership] = await Promise.all([
    userQuery.first('id'),
    companyMembershipQuery.first('membership.id'),
    witnessGroupMembershipQuery.first('membership.id'),
  ]);

  if (!user || !companyMembership || !witnessGroupMembership) {
    throw new WitnessAccessError('FORBIDDEN');
  }
}

/** Read one active owner- and tenant-scoped synthetic witness; no list/search or write path exists. */
export async function readOwnedSyntheticWitness(
  db: Knex,
  steward: AuthenticatedWitnessSteward,
  testimonyId: number
): Promise<ScopedSyntheticWitness> {
  if (!Number.isSafeInteger(testimonyId) || testimonyId < 1) {
    throw new WitnessAccessError('NOT_FOUND');
  }

  return db.transaction(async (trx) => {
    await verifyWitnessSteward(trx, steward);
    const testimony = await trx<WitnessTestimonyRow>('knowledge_witness_testimonies')
      .where({
        id: testimonyId,
        active: true,
        company_id: steward.companyId,
        created_by_id: steward.userId,
        synthetic: true,
        visibility: 'RESTRICTED',
      })
      .first(
        'id',
        'external_key',
        'original_text',
        'source_label',
        'source_locator',
        'source_digest',
        'received_time_text',
        'received_time_precision',
        'uncertainty_note',
        'visibility',
        'company_id',
        'created_by_id',
        'synthetic'
      );
    if (!testimony) throw new WitnessAccessError('NOT_FOUND');

    const subjectRefSha256 = syntheticWitnessSubjectRefSha256(
      steward.companyId,
      testimony.external_key
    );
    // Serialize reads with withdrawal: the revocation service locks these projection rows
    // before recording the withdrawal and clearing their content.
    await trx('knowledge_privacy_projections')
      .where({
        company_id: steward.companyId,
        subject_ref_sha256: subjectRefSha256,
        synthetic: true,
      })
      .orderBy('id', 'asc')
      .forUpdate()
      .select('id');
    const revocation = await trx('knowledge_privacy_revocations')
      .where({ company_id: steward.companyId, subject_ref_sha256: subjectRefSha256 })
      .first('id');
    if (revocation) throw new WitnessAccessError('NOT_FOUND');

    const [corrections, interpretations] = await Promise.all([
      trx<WitnessCorrectionRow>('knowledge_witness_corrections')
        .where({ testimony_id: testimony.id, synthetic: true, active: true })
        .orderBy('sequence', 'asc')
        .select(
          'sequence',
          'correction_text',
          'reason',
          'source_label',
          'source_locator',
          'source_digest',
          'asserted_time_text',
          'asserted_time_precision',
          'uncertainty_note'
        ),
      trx<WitnessInterpretationRow>('knowledge_witness_interpretations')
        .where({
          testimony_id: testimony.id,
          synthetic: true,
          active: true,
          visibility: 'RESTRICTED',
        })
        .orderBy('id', 'asc')
        .select(
          'assertion_ref',
          'evidence_ref',
          'interpretation_text',
          'method_label',
          'method_version',
          'epistemic_status',
          'visibility'
        ),
    ]);

    return {
      id: testimony.id,
      externalKey: testimony.external_key,
      originalText: testimony.original_text,
      sourceLabel: testimony.source_label,
      sourceLocator: testimony.source_locator,
      sourceDigest: testimony.source_digest,
      receivedTimeText: testimony.received_time_text,
      receivedTimePrecision: testimony.received_time_precision,
      uncertaintyNote: testimony.uncertainty_note,
      corrections: corrections.map((correction) => ({
        sequence: correction.sequence,
        correctionText: correction.correction_text,
        reason: correction.reason,
        sourceLabel: correction.source_label,
        sourceLocator: correction.source_locator,
        sourceDigest: correction.source_digest,
        assertedTimeText: correction.asserted_time_text,
        assertedTimePrecision: correction.asserted_time_precision,
        uncertaintyNote: correction.uncertainty_note,
      })),
      interpretations: interpretations.map((interpretation) => ({
        assertionRef: interpretation.assertion_ref,
        evidenceRef: interpretation.evidence_ref,
        interpretationText: interpretation.interpretation_text,
        methodLabel: interpretation.method_label,
        methodVersion: interpretation.method_version,
        epistemicStatus: interpretation.epistemic_status,
        visibility: interpretation.visibility,
      })),
    };
  });
}

function verifiedCorrectionSource(
  reference: WitnessCorrectionSourceReference,
  resolver: WitnessCorrectionSourceResolver | undefined
): Promise<boolean> {
  if (!resolver) return Promise.resolve(false);
  return resolver(reference).then(
    (resolved) =>
      resolved !== null &&
      resolved.source_label === reference.source_label &&
      resolved.source_locator === reference.source_locator &&
      resolved.source_digest === reference.source_digest &&
      resolved.bytes_verified === true &&
      resolved.rights_state === 'permitted' &&
      resolved.allowed_uses.includes('quote_excerpt')
  );
}

/**
 * Append an owned synthetic restricted correction after shape-checking its attribution metadata
 * and verifying the claimed source through the caller's resolver. Without a resolver the source
 * stays unverified and the append fails closed.
 */
export async function appendOwnedSyntheticWitnessCorrection(
  db: Knex,
  steward: AuthenticatedWitnessSteward,
  testimonyId: number,
  input: AppendSyntheticWitnessCorrectionInput
): Promise<AppendedSyntheticWitnessCorrection> {
  if (
    !Number.isSafeInteger(testimonyId) ||
    testimonyId < 1 ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !input.correctionText.trim() ||
    !input.reason.trim() ||
    !input.sourceLabel.trim() ||
    !input.sourceLocator.trim() ||
    !/^[a-f0-9]{64}$/u.test(input.sourceDigest) ||
    !input.assertedTimeText.trim() ||
    (input.uncertaintyNote !== undefined &&
      input.uncertaintyNote !== null &&
      typeof input.uncertaintyNote !== 'string') ||
    !['instant', 'day', 'month', 'year', 'unknown'].includes(input.assertedTimePrecision)
  ) {
    throw new TypeError('Invalid synthetic witness correction');
  }

  return db.transaction(async (trx) => {
    await verifyWitnessSteward(trx, steward, true);
    const testimony = await trx<WitnessTestimonyRow>('knowledge_witness_testimonies')
      .where({
        id: testimonyId,
        active: true,
        company_id: steward.companyId,
        created_by_id: steward.userId,
        synthetic: true,
        visibility: 'RESTRICTED',
      })
      .forUpdate()
      .first('id');
    if (!testimony) throw new WitnessAccessError('NOT_FOUND');

    const chain = await trx<WitnessCorrectionRow>('knowledge_witness_corrections')
      .where({ testimony_id: testimony.id })
      .orderBy('sequence', 'asc')
      .forUpdate();
    if (chain.some((row, index) => Number(row.sequence) !== index + 1)) {
      throw new TypeError('Synthetic witness correction chain is inconsistent');
    }

    if (
      !(await verifiedCorrectionSource(
        {
          source_label: input.sourceLabel,
          source_locator: input.sourceLocator,
          source_digest: input.sourceDigest,
        },
        input.resolveSource
      ))
    ) {
      throw new TypeError(
        'Correction source must resolve to verified local bytes with quote_excerpt permission'
      );
    }

    const existing = chain.find((row) => Number(row.sequence) === input.sequence);
    const payload = {
      testimony_id: testimony.id,
      sequence: input.sequence,
      correction_text: input.correctionText,
      reason: input.reason,
      source_label: input.sourceLabel,
      source_locator: input.sourceLocator,
      source_digest: input.sourceDigest,
      asserted_time_text: input.assertedTimeText,
      asserted_time_precision: input.assertedTimePrecision,
      uncertainty_note: input.uncertaintyNote ?? null,
      recorded_by_id: steward.userId,
      synthetic: true,
    };
    if (existing) {
      if (
        existing.active &&
        existing.synthetic &&
        Number(existing.recorded_by_id) === steward.userId &&
        existing.correction_text === payload.correction_text &&
        existing.reason === payload.reason &&
        existing.source_label === payload.source_label &&
        existing.source_locator === payload.source_locator &&
        existing.source_digest === payload.source_digest &&
        existing.asserted_time_text === payload.asserted_time_text &&
        existing.asserted_time_precision === payload.asserted_time_precision &&
        existing.uncertainty_note === payload.uncertainty_note
      ) {
        return {
          sequence: input.sequence,
          correctionText: existing.correction_text,
          idempotent: true,
        };
      }
      throw new TypeError('Correction sequence already exists with a different payload');
    }
    if (input.sequence !== chain.length + 1) {
      throw new TypeError('Correction sequence must be the next contiguous value');
    }
    await trx('knowledge_witness_corrections').insert(payload);
    return { sequence: input.sequence, correctionText: input.correctionText, idempotent: false };
  });
}
