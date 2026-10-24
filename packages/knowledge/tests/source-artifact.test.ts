import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { validateSourceArtifactManifest } from '../src/index.js';
import schema from '../schemas/source-artifact-manifest.schema.json' with { type: 'json' };
import allowedScopedBytes from './fixtures/source-artifact/allowed-scoped-bytes.json' with { type: 'json' };
import invalidPublicAnalysisOnly from './fixtures/source-artifact/invalid-public-analysis-only.json' with { type: 'json' };
import invalidPublicMissingAttribution from './fixtures/source-artifact/invalid-public-missing-attribution.json' with { type: 'json' };
import invalidPublicMissingChecksum from './fixtures/source-artifact/invalid-public-missing-checksum.json' with { type: 'json' };
import invalidPublicMissingComplaintOwner from './fixtures/source-artifact/invalid-public-missing-complaint-owner.json' with { type: 'json' };
import invalidPublicMissingRights from './fixtures/source-artifact/invalid-public-missing-rights.json' with { type: 'json' };
import invalidPublicUnknown from './fixtures/source-artifact/invalid-public-unknown.json' with { type: 'json' };
import metadataUnknown from './fixtures/source-artifact/metadata-unknown.json' with { type: 'json' };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
formatsModule.default.default(ajv, { mode: 'full' });
const validate = ajv.compile(schema);

describe('source artifact rights manifest schema', () => {
  it('exposes the shared offline manifest validator used by the dataset CLI', () => {
    expect(validateSourceArtifactManifest(metadataUnknown)).toEqual({ valid: true, issues: [] });
    expect(validateSourceArtifactManifest(invalidPublicUnknown)).toMatchObject({ valid: false });
  });

  it('accepts metadata-only references when rights are unknown', () => {
    expect(validate(metadataUnknown)).toBe(true);
  });

  it('accepts source bytes only with an exact scoped rights decision and integrity metadata', () => {
    expect(validate(allowedScopedBytes)).toBe(true);
  });

  it.each([
    ['unknown rights', invalidPublicUnknown],
    ['missing rights', invalidPublicMissingRights],
    ['missing checksum', invalidPublicMissingChecksum],
    ['missing attribution', invalidPublicMissingAttribution],
    ['analysis-only permission', invalidPublicAnalysisOnly],
    ['missing complaint process owner', invalidPublicMissingComplaintOwner],
  ])('rejects public source bytes with %s', (_name, input) => {
    expect(validate(input)).toBe(false);
  });

  it('rejects undeclared manifest fields rather than treating them as permission', () => {
    expect(validate({ ...metadataUnknown, public_by_default: true })).toBe(false);
  });

  it.each(['unknown', 'review_pending', 'restricted', 'disputed', 'withdrawn'])(
    'rejects byte publication with rights state %s',
    (state) => {
      expect(
        validate({ ...allowedScopedBytes, rights: { ...allowedScopedBytes.rights, state } })
      ).toBe(false);
    }
  );

  it.each([{ decision_date: '2026-02-30' }, { expiry: 'not-a-date' }])(
    'rejects malformed rights dates %j',
    (dates) => {
      expect(
        validate({ ...allowedScopedBytes, rights: { ...allowedScopedBytes.rights, ...dates } })
      ).toBe(false);
    }
  );

  it('rejects malformed reference URIs and retrieval timestamps', () => {
    expect(validate({ ...metadataUnknown, references: ['not a URI'] })).toBe(false);
    expect(
      validate({
        ...allowedScopedBytes,
        artifact: { ...allowedScopedBytes.artifact, retrieved_at: '2026-02-30T00:00:00Z' },
      })
    ).toBe(false);
  });

  it('keeps bytes outside the metadata manifest instead of accepting rewritten content', () => {
    expect(
      validate({
        ...allowedScopedBytes,
        artifact: { ...allowedScopedBytes.artifact, content_base64: 'synthetic-only' },
      })
    ).toBe(false);
  });
});
