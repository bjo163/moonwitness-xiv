import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  compareSchemaCompatibility,
  evaluateSchemaTransition,
  validateDocumentAtSchemaVersion,
  validateSchemaVersionRegistry,
  type JsonSchemaValue,
  type SchemaMigrationDeclaration,
  type SchemaReleaseSet,
} from '../src/schema-version.js';

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

const registrySchema = readJson('../../../ontology/versions/version-registry.schema.json');
const registry = readJson('../../../ontology/versions/registry.json');
const ontologyRecordSchema = readJson(
  '../../../ontology/versions/ontology/1.0.0/knowledge-record.schema.json'
);
const provenanceSchema = readJson(
  '../../../ontology/versions/ontology/1.0.0/provenance-graph.schema.json'
);
const corpusManifestSchema = readJson(
  '../../../ontology/versions/corpus/1.0.0/source-artifact-manifest.schema.json'
);
const availableSchemaPaths = new Set([
  'ontology/1.0.0/knowledge-record.schema.json',
  'ontology/1.0.0/provenance-graph.schema.json',
  'corpus/1.0.0/source-artifact-manifest.schema.json',
]);

const baselineRecord = {
  id: 'mw:entity:baseline-fixture',
  kind: 'Entity',
  schema_version: 1,
  lifecycle: 'draft',
  created_at: '2026-10-15T10:00:00.000Z',
  updated_at: '2026-10-15T10:00:00.000Z',
  origin_ref: 'fixture:baseline',
  visibility: 'INTERNAL',
  content_revision: 1,
};

const baselineManifest = {
  schema_version: 1,
  source_id: 'mw:source:synthetic-fixture',
  edition_id: 'mw:edition:synthetic-fixture',
  locale: 'en',
  rights: { state: 'unknown', allowed_uses: [] },
  artifact: { representation: 'metadata_only' },
  publication: { mode: 'metadata_only' },
};

describe('knowledge schema version baselines', () => {
  it('pins ontology and corpus independently with valid baseline registry entries', () => {
    expect(registry.registry_version).toBe(1);
    expect(registry.components).toMatchObject({
      ontology: { current: '1.0.0' },
      corpus: { current: '1.0.0' },
    });
    expect(readJson('../../../packages/knowledge/schemas/knowledge-record.schema.json')).toEqual(
      ontologyRecordSchema
    );
    expect(readJson('../../../packages/knowledge/schemas/provenance-graph.schema.json')).toEqual(
      provenanceSchema
    );
    expect(
      readJson('../../../packages/knowledge/schemas/source-artifact-manifest.schema.json')
    ).toEqual(corpusManifestSchema);

    const validateRegistry = new Ajv2020({ allErrors: true, strict: true }).compile(registrySchema);
    expect(validateRegistry(registry)).toBe(true);
    expect(validateSchemaVersionRegistry(registry, availableSchemaPaths)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it('rejects inconsistent current versions, schema key sets, missing files, and escaping paths', () => {
    type MutableRegistry = {
      registry_version: number;
      components: Record<
        string,
        {
          current: string;
          releases: Array<{
            version: string;
            status: string;
            document_schema_versions: Record<string, number>;
            schemas: Record<string, string>;
          }>;
        }
      >;
    };
    const clone = (): MutableRegistry => JSON.parse(JSON.stringify(registry)) as MutableRegistry;

    const staleCurrent = clone();
    staleCurrent.components.ontology.current = '2.0.0';
    expect(validateSchemaVersionRegistry(staleCurrent, availableSchemaPaths).valid).toBe(false);

    const keyMismatch = clone();
    delete keyMismatch.components.ontology.releases[0]?.schemas['provenance-graph'];
    expect(validateSchemaVersionRegistry(keyMismatch, availableSchemaPaths).valid).toBe(false);

    const traversal = clone();
    traversal.components.ontology.releases[0]!.schemas['knowledge-record'] =
      '../../corpus/1.0.0/source-artifact-manifest.schema.json';
    expect(validateSchemaVersionRegistry(traversal, availableSchemaPaths).valid).toBe(false);

    expect(validateSchemaVersionRegistry(registry, new Set()).valid).toBe(false);
  });

  it('validates prior ontology records against their declared immutable version', () => {
    const result = validateDocumentAtSchemaVersion(baselineRecord, {
      component: 'ontology',
      releaseVersion: '1.0.0',
      documentSchemaVersion: 1,
      schemaName: 'knowledge-record',
      schema: ontologyRecordSchema,
    });
    expect(result).toEqual({ valid: true, issues: [] });

    const mismatch = validateDocumentAtSchemaVersion(
      { ...baselineRecord, schema_version: 2 },
      {
        component: 'ontology',
        releaseVersion: '1.0.0',
        documentSchemaVersion: 1,
        schemaName: 'knowledge-record',
        schema: ontologyRecordSchema,
      }
    );
    expect(mismatch.valid).toBe(false);
    if (!mismatch.valid) expect(mismatch.issues[0]?.path).toBe('/schema_version');
  });

  it('validates prior corpus manifests using the corpus version only', () => {
    const result = validateDocumentAtSchemaVersion(baselineManifest, {
      component: 'corpus',
      releaseVersion: '1.0.0',
      documentSchemaVersion: 1,
      schemaName: 'source-artifact-manifest',
      schema: corpusManifestSchema,
    });
    expect(result).toEqual({ valid: true, issues: [] });

    const wrongComponentVersion = validateDocumentAtSchemaVersion(
      { ...baselineManifest, schema_version: 2 },
      {
        component: 'corpus',
        releaseVersion: '1.0.0',
        documentSchemaVersion: 1,
        schemaName: 'source-artifact-manifest',
        schema: corpusManifestSchema,
      }
    );
    expect(wrongComponentVersion.valid).toBe(false);
  });

  it('fails closed for invalid release versions and schemas', () => {
    expect(
      validateDocumentAtSchemaVersion(baselineRecord, {
        component: 'ontology',
        releaseVersion: 'v1',
        documentSchemaVersion: 1,
        schemaName: 'knowledge-record',
        schema: ontologyRecordSchema,
      }).valid
    ).toBe(false);

    expect(
      validateDocumentAtSchemaVersion(baselineRecord, {
        component: 'ontology',
        releaseVersion: '1.0.0',
        documentSchemaVersion: 1,
        schemaName: 'broken-schema',
        schema: { type: 'not-a-json-schema-type' },
      }).valid
    ).toBe(false);
  });
});

describe('semantic compatibility diff', () => {
  it('allows optional properties and widened types without invalidating older documents', () => {
    const changes = compareSchemaCompatibility(
      { type: 'string', maxLength: 40, enum: ['a', 'b'] },
      { type: ['string', 'null'], maxLength: 80, enum: ['a', 'b', 'c'] }
    );
    expect(changes.every((change) => change.impact === 'compatible')).toBe(true);
    expect(
      compareSchemaCompatibility(
        { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
          },
        }
      ).every((change) => change.impact === 'compatible')
    ).toBe(true);
  });

  it('reports newly required fields, removed accepted values and narrowed bounds as breaking', () => {
    const changes = compareSchemaCompatibility(
      {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1 }, state: { enum: ['draft', 'active'] } },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'state'],
        properties: { id: { type: 'string', minLength: 4 }, state: { enum: ['active'] } },
      }
    );
    expect(
      changes.filter((change) => change.impact === 'breaking').map((change) => change.keyword)
    ).toEqual(expect.arrayContaining(['required', 'minLength', 'enum']));
  });

  it('blocks changed keywords outside its declared semantic subset', () => {
    const changes = compareSchemaCompatibility(
      { type: 'string', pattern: '^[a-z]+$' },
      { type: 'string', pattern: '^[a-z0-9]+$' }
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ keyword: 'pattern', impact: 'unknown' })
    );
    const removedPatternConstraint = compareSchemaCompatibility(
      {
        type: 'object',
        additionalProperties: false,
        patternProperties: { '^x-': { type: 'string' } },
      },
      { type: 'object', additionalProperties: false }
    );
    expect(removedPatternConstraint).toContainEqual(
      expect.objectContaining({ keyword: 'patternProperties', impact: 'unknown' })
    );
    const removedUnknownKeyword = compareSchemaCompatibility(
      { type: 'object', $ref: '#/$defs/legacy' },
      { type: 'object' }
    );
    expect(removedUnknownKeyword).toContainEqual(
      expect.objectContaining({ keyword: '$ref', impact: 'unknown' })
    );
    const changedBaseUri = compareSchemaCompatibility(
      { $id: 'https://example.test/v1/schema.json', $ref: 'common.json' },
      { $id: 'https://example.test/v2/schema.json', $ref: 'common.json' }
    );
    expect(changedBaseUri).toContainEqual(
      expect.objectContaining({ keyword: '$id', impact: 'unknown' })
    );
    const changedDialect = compareSchemaCompatibility(
      { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' },
      { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'string' }
    );
    expect(changedDialect).toContainEqual(
      expect.objectContaining({ keyword: '$schema', impact: 'unknown' })
    );
  });

  it('treats removed old properties as incompatible when the new schema rejects extras', () => {
    const changes = compareSchemaCompatibility(
      {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, old: { type: 'string' } },
      },
      { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } }
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ keyword: 'properties', impact: 'breaking' })
    );
  });

  it('checks newly named properties against the old additionalProperties rule', () => {
    const changes = compareSchemaCompatibility(
      { type: 'object', additionalProperties: { type: 'string' } },
      {
        type: 'object',
        additionalProperties: { type: 'string' },
        properties: { count: { type: 'number' } },
      }
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ path: '/properties/count', keyword: 'type', impact: 'breaking' })
    );
  });

  it('catches uniqueness and combined inclusive/exclusive numeric bound tightenings', () => {
    const arrayChanges = compareSchemaCompatibility(
      { type: 'array', items: { type: 'string' } },
      { type: 'array', uniqueItems: true, items: { type: 'string' } }
    );
    expect(arrayChanges).toContainEqual(
      expect.objectContaining({ keyword: 'uniqueItems', impact: 'breaking' })
    );

    const numericChanges = compareSchemaCompatibility(
      { type: 'number', minimum: 0, exclusiveMinimum: 5 },
      { type: 'number', minimum: 10, exclusiveMinimum: 5 }
    );
    expect(numericChanges).toContainEqual(
      expect.objectContaining({ keyword: 'minimum', impact: 'breaking' })
    );
  });
});

describe('version transition gates', () => {
  const oldRecordSchema: JsonSchemaValue = {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' }, status: { enum: ['draft', 'active'] } },
  };
  const newRecordSchema: JsonSchemaValue = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status'],
    properties: { id: { type: 'string' }, status: { enum: ['active'] } },
  };
  const from: SchemaReleaseSet = {
    component: 'ontology',
    version: '1.0.0',
    schemas: { record: oldRecordSchema },
  };
  const to: SchemaReleaseSet = {
    component: 'ontology',
    version: '1.1.0',
    schemas: { record: newRecordSchema },
  };

  it('blocks breaking upgrades unless an exact deterministic migration is declared', () => {
    expect(evaluateSchemaTransition(from, to).status).toBe('blocked');
    const migration: SchemaMigrationDeclaration = {
      component: 'ontology',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      id: 'fixture:ontology-1.0.0-to-1.1.0',
      implementation: 'scripts/migrations/ontology-1.0.0-to-1.1.0.mjs',
      deterministic: true,
    };
    expect(evaluateSchemaTransition(from, to, [migration])).toMatchObject({
      status: 'migration_required',
      direction: 'upgrade',
      migrationId: migration.id,
    });
    expect(
      evaluateSchemaTransition(from, to, [{ ...migration, deterministic: false }]).status
    ).toBe('blocked');
    expect(evaluateSchemaTransition(from, to, [{ ...migration, toVersion: '1.2.0' }]).status).toBe(
      'blocked'
    );
  });

  it('blocks incompatible downgrades unless the exact migration is deterministic and reversible', () => {
    const relaxedNewerRelease: SchemaReleaseSet = {
      ...to,
      schemas: {
        record: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: ['string', 'null'] },
            status: { enum: ['draft', 'active', 'withdrawn'] },
          },
        },
      },
    };
    const downgradeFrom = relaxedNewerRelease;
    const downgradeTo = from;
    const migration: SchemaMigrationDeclaration = {
      component: 'ontology',
      fromVersion: '1.1.0',
      toVersion: '1.0.0',
      id: 'fixture:ontology-1.1.0-to-1.0.0',
      implementation: 'scripts/migrations/ontology-1.1.0-to-1.0.0.mjs',
      deterministic: true,
      reversible: false,
    };
    expect(evaluateSchemaTransition(downgradeFrom, downgradeTo, [migration]).status).toBe(
      'blocked'
    );
    expect(
      evaluateSchemaTransition(downgradeFrom, downgradeTo, [{ ...migration, reversible: true }])
    ).toMatchObject({
      status: 'migration_required',
      direction: 'downgrade',
    });
  });

  it('rejects cross-component transitions and invalid semver labels', () => {
    expect(evaluateSchemaTransition(from, { ...to, component: 'corpus' }).status).toBe('blocked');
    expect(evaluateSchemaTransition(from, { ...to, version: 'v2' }).issues).toContain(
      'Both versions must use strict major.minor.patch syntax.'
    );
  });

  it('allows a compatible transition without requiring a migration', () => {
    const compatible: SchemaReleaseSet = {
      ...to,
      schemas: {
        record: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: ['string', 'null'] },
            status: { enum: ['draft', 'active', 'withdrawn'] },
          },
        },
      },
    };
    expect(evaluateSchemaTransition(from, compatible).status).toBe('compatible');
  });
});
