import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import sourceArtifactManifestSchema from '../schemas/source-artifact-manifest.schema.json' with { type: 'json' };
import type { KnowledgeValidationIssue, KnowledgeValidationResult } from './types.js';

export type SourceRightsState =
  'unknown' | 'review_pending' | 'permitted' | 'restricted' | 'disputed' | 'withdrawn';

export type SourceAllowedUse =
  'read_analyze' | 'store' | 'transform' | 'quote_excerpt' | 'redistribute_full' | 'model_training';

export interface SourceRightsDecision {
  state: SourceRightsState;
  allowed_uses: SourceAllowedUse[];
  reviewer?: string;
  decision_date?: string;
  evidence_ref?: string;
  scope?: string;
  expiry?: string;
  territories?: string[];
}

export interface SourceAttribution {
  text: string;
  display_locations: string[];
}

export interface SourceArtifactManifestBase {
  schema_version: 1;
  source_id: `mw:source:${string}`;
  edition_id: `mw:edition:${string}`;
  locale: string;
  references?: string[];
  rights: SourceRightsDecision;
  transformations?: Array<{
    recipe: string;
    version: string;
    output_sha256: string;
  }>;
}

export type MetadataOnlySourceArtifactManifest = SourceArtifactManifestBase & {
  artifact: { representation: 'metadata_only'; media_type?: string };
  publication: { mode: 'metadata_only'; release_ref?: string };
};

export type SourceBytesManifest = SourceArtifactManifestBase & {
  artifact: {
    representation: 'source_bytes';
    media_type?: string;
    sha256: string;
    byte_length: number;
    retrieved_at?: string;
  };
  rights: SourceRightsDecision & {
    state: 'permitted';
    reviewer: string;
    decision_date: string;
    evidence_ref: string;
    scope: string;
  };
  attribution: SourceAttribution;
  complaint_process_owner: string;
  publication: { mode: 'source_bytes'; release_ref?: string };
};

/** Structural types and schema only; this does not establish source permission. */
export type SourceArtifactManifest = MetadataOnlySourceArtifactManifest | SourceBytesManifest;

export { sourceArtifactManifestSchema };

const ajv = new Ajv2020({ allErrors: true, strict: true });
formatsModule.default.default(ajv, { mode: 'full' });
const validateManifest = ajv.compile(sourceArtifactManifestSchema);

function pointerForIssue(
  instancePath: string,
  keyword: string,
  params: Record<string, unknown>
): string {
  if (keyword === 'required' && typeof params.missingProperty === 'string') {
    return `${instancePath}/${params.missingProperty.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  if (keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    return `${instancePath}/${params.additionalProperty.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  return instancePath || '/';
}

/** Validate manifest structure only; this does not determine whether its rights claims are true. */
export function validateSourceArtifactManifest(value: unknown): KnowledgeValidationResult {
  if (validateManifest(value)) return { valid: true, issues: [] };

  const issues: KnowledgeValidationIssue[] = (validateManifest.errors ?? []).map((error) => ({
    path: pointerForIssue(error.instancePath, error.keyword, error.params),
    keyword: error.keyword,
    message: error.message ?? 'does not match the source artifact manifest contract',
  }));
  return { valid: false, issues };
}
