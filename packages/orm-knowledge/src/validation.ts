import { WitnessCorrection } from './models.js';

export interface CorrectionProvenance {
  readonly sequence: number;
  readonly source_label: string;
  readonly source_locator: string;
  readonly source_digest: string;
  readonly asserted_time_text: string;
  readonly asserted_time_precision: 'instant' | 'day' | 'month' | 'year' | 'unknown';
  readonly recorded_by_id: number;
}

/** Validate required provenance and a strictly positive sequence before inserting a correction. */
export function isValidCorrectionProvenance(value: CorrectionProvenance): boolean {
  return (
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    Number.isSafeInteger(value.recorded_by_id) &&
    value.recorded_by_id > 0 &&
    value.source_label.trim().length > 0 &&
    value.source_locator.trim().length > 0 &&
    /^[a-f0-9]{64}$/.test(value.source_digest) &&
    value.asserted_time_text.trim().length > 0 &&
    ['instant', 'day', 'month', 'year', 'unknown'].includes(value.asserted_time_precision)
  );
}

/** A correction may be appended only as the next number in its testimony's chain. */
export async function isNextCorrectionSequence(
  testimonyId: number,
  sequence: number
): Promise<boolean> {
  if (!Number.isSafeInteger(testimonyId) || testimonyId <= 0) return false;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return false;
  const corrections = await WitnessCorrection.query()
    .where('testimony_id', testimonyId)
    .orderBy('sequence', 'asc')
    .select('sequence');
  if (corrections.some((correction, index) => Number(correction.sequence) !== index + 1)) {
    return false;
  }
  return sequence === corrections.length + 1;
}
