import { defineView } from '@moonwitness/orm';
import { WitnessCorrection, WitnessInterpretation, WitnessTestimony } from './models.js';

export const views = [
  defineView(WitnessTestimony, {
    title: 'Witness Testimony',
    list: {
      columns: ['external_key', 'source_label', 'received_time_text', 'visibility'],
      order: 'create_date desc',
    },
    form: {
      sections: [
        {
          title: 'Original Source',
          fields: [
            'external_key',
            'original_text',
            'source_label',
            'source_locator',
            'source_digest',
            'received_time_text',
            'received_time_precision',
            'uncertainty_note',
            'visibility',
            'created_by',
          ],
        },
      ],
    },
    search: { fields: ['external_key', 'source_label'] },
  }),
  defineView(WitnessCorrection, {
    title: 'Witness Corrections',
    list: {
      columns: ['testimony', 'sequence', 'reason', 'source_label', 'asserted_time_text'],
      order: 'testimony_id asc, sequence asc',
    },
    form: {
      sections: [
        {
          title: 'Sourced Correction',
          fields: [
            'testimony',
            'sequence',
            'correction_text',
            'reason',
            'source_label',
            'source_locator',
            'source_digest',
            'asserted_time_text',
            'asserted_time_precision',
            'uncertainty_note',
            'recorded_by',
          ],
        },
      ],
    },
    search: { fields: ['reason', 'source_label'] },
  }),
  defineView(WitnessInterpretation, {
    title: 'Witness Interpretations',
    list: {
      columns: ['testimony', 'assertion_ref', 'evidence_ref', 'method_label', 'epistemic_status'],
      order: 'testimony_id asc, id asc',
    },
    form: {
      sections: [
        {
          title: 'Interpretation and Links',
          fields: [
            'testimony',
            'assertion_ref',
            'evidence_ref',
            'interpretation_text',
            'method_label',
            'method_version',
            'epistemic_status',
            'visibility',
            'recorded_by',
          ],
        },
      ],
    },
    search: { fields: ['assertion_ref', 'evidence_ref', 'method_label'] },
  }),
];
