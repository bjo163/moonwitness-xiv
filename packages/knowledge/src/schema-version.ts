import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import type { KnowledgeValidationIssue, KnowledgeValidationResult } from './types.js';

export type SchemaVersionComponent = 'ontology' | 'corpus';
export type JsonSchemaValue = boolean | Record<string, unknown>;

export interface VersionedDocumentContract {
  component: SchemaVersionComponent;
  releaseVersion: string;
  documentSchemaVersion: number;
  schemaName: string;
  schema: JsonSchemaValue;
}

export interface SchemaCompatibilityChange {
  path: string;
  keyword: string;
  impact: 'compatible' | 'breaking' | 'unknown';
  message: string;
}

export interface SchemaReleaseSet {
  component: SchemaVersionComponent;
  version: string;
  schemas: Record<string, JsonSchemaValue>;
}

export interface SchemaVersionReleaseEntry {
  version: string;
  status: 'baseline' | 'released';
  document_schema_versions: Record<string, number>;
  schemas: Record<string, string>;
}

export interface SchemaVersionRegistry {
  registry_version: 1;
  components: Record<
    SchemaVersionComponent,
    {
      current: string;
      releases: SchemaVersionReleaseEntry[];
    }
  >;
}

export interface SchemaMigrationDeclaration {
  component: SchemaVersionComponent;
  fromVersion: string;
  toVersion: string;
  id: string;
  implementation: string;
  deterministic: boolean;
  reversible?: boolean;
}

export interface SchemaTransitionResult {
  status: 'compatible' | 'migration_required' | 'blocked';
  direction: 'upgrade' | 'downgrade';
  component: SchemaVersionComponent;
  fromVersion: string;
  toVersion: string;
  changes: SchemaCompatibilityChange[];
  migrationId?: string;
  issues: string[];
}

const annotations = new Set([
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const componentNames: readonly SchemaVersionComponent[] = ['ontology', 'corpus'];

const modeledKeywords = new Set([
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
  );
}

function pointer(parent: string, token: string): string {
  return `${parent}/${token.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function addChange(
  changes: SchemaCompatibilityChange[],
  path: string,
  keyword: string,
  impact: SchemaCompatibilityChange['impact'],
  message: string
): void {
  changes.push({ path: path || '/', keyword, impact, message });
}

function asTypeSet(value: unknown): Set<string> | undefined {
  if (typeof value === 'string') return new Set([value]);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return new Set(value);
  }
  return undefined;
}

function compareType(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  const before = asTypeSet(previous.type);
  const after = asTypeSet(next.type);
  if (before === undefined && after === undefined) return;
  if (before === undefined) {
    addChange(
      changes,
      path,
      'type',
      'breaking',
      'The new type restriction may reject previously valid documents.'
    );
    return;
  }
  if (after === undefined) return;
  if ([...before].every((type) => after.has(type))) return;
  addChange(
    changes,
    path,
    'type',
    'breaking',
    'The new schema removes one or more previously accepted types.'
  );
}

function compareFiniteSet(
  keyword: 'enum' | 'const',
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  const beforeHas = Object.hasOwn(previous, keyword);
  const afterHas = Object.hasOwn(next, keyword);
  if (!beforeHas && !afterHas) return;
  if (!beforeHas && afterHas) {
    addChange(
      changes,
      path,
      keyword,
      'breaking',
      `The new ${keyword} restriction may reject previously valid documents.`
    );
    return;
  }
  if (beforeHas && !afterHas) return;

  const beforeValues = keyword === 'const' ? [previous.const] : (previous.enum as unknown[]);
  const afterValues = keyword === 'const' ? [next.const] : (next.enum as unknown[]);
  if (!Array.isArray(beforeValues) || !Array.isArray(afterValues)) {
    addChange(
      changes,
      path,
      keyword,
      'unknown',
      `The ${keyword} change cannot be compared safely.`
    );
    return;
  }
  if (beforeValues.every((value) => afterValues.some((candidate) => sameValue(value, candidate))))
    return;
  addChange(
    changes,
    path,
    keyword,
    'breaking',
    `The new ${keyword} excludes a previously accepted value.`
  );
}

function compareRequired(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  const before = Array.isArray(previous.required) ? previous.required : [];
  const after = Array.isArray(next.required) ? next.required : [];
  if (after.every((property) => before.includes(property))) return;
  addChange(
    changes,
    path,
    'required',
    'breaking',
    'The new schema requires a property that old valid documents could omit.'
  );
}

function compareBound(
  keyword: 'minLength' | 'minItems' | 'maxLength' | 'maxItems',
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  const before = previous[keyword];
  const after = next[keyword];
  if (after === undefined || sameValue(before, after)) return;
  if (before === undefined) {
    addChange(
      changes,
      path,
      keyword,
      'breaking',
      `The new ${keyword} bound may reject old valid documents.`
    );
    return;
  }
  const isMinimum = keyword.startsWith('min');
  const relaxed =
    typeof before === 'number' &&
    typeof after === 'number' &&
    (isMinimum ? after <= before : after >= before);
  if (!relaxed) {
    addChange(
      changes,
      path,
      keyword,
      'breaking',
      `The new ${keyword} bound narrows accepted values.`
    );
  }
}

interface NumericBound {
  value: number;
  exclusive: boolean;
}

function numericLower(schema: Record<string, unknown>): NumericBound | undefined {
  const bounds: NumericBound[] = [];
  if (typeof schema.exclusiveMinimum === 'number')
    bounds.push({ value: schema.exclusiveMinimum, exclusive: true });
  if (typeof schema.minimum === 'number') bounds.push({ value: schema.minimum, exclusive: false });
  return bounds.reduce<NumericBound | undefined>((strongest, bound) => {
    if (
      !strongest ||
      bound.value > strongest.value ||
      (bound.value === strongest.value && bound.exclusive && !strongest.exclusive)
    )
      return bound;
    return strongest;
  }, undefined);
}

function numericUpper(schema: Record<string, unknown>): NumericBound | undefined {
  const bounds: NumericBound[] = [];
  if (typeof schema.exclusiveMaximum === 'number')
    bounds.push({ value: schema.exclusiveMaximum, exclusive: true });
  if (typeof schema.maximum === 'number') bounds.push({ value: schema.maximum, exclusive: false });
  return bounds.reduce<NumericBound | undefined>((strongest, bound) => {
    if (
      !strongest ||
      bound.value < strongest.value ||
      (bound.value === strongest.value && bound.exclusive && !strongest.exclusive)
    )
      return bound;
    return strongest;
  }, undefined);
}

function compareNumericBounds(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  const beforeLower = numericLower(previous);
  const afterLower = numericLower(next);
  if (afterLower && !beforeLower) {
    addChange(
      changes,
      path,
      'minimum',
      'breaking',
      'The new lower bound may reject old valid documents.'
    );
  } else if (beforeLower && afterLower) {
    const tighter =
      afterLower.value > beforeLower.value ||
      (afterLower.value === beforeLower.value && afterLower.exclusive && !beforeLower.exclusive);
    if (tighter)
      addChange(changes, path, 'minimum', 'breaking', 'The new lower bound is stricter.');
  }

  const beforeUpper = numericUpper(previous);
  const afterUpper = numericUpper(next);
  if (afterUpper && !beforeUpper) {
    addChange(
      changes,
      path,
      'maximum',
      'breaking',
      'The new upper bound may reject old valid documents.'
    );
  } else if (beforeUpper && afterUpper) {
    const tighter =
      afterUpper.value < beforeUpper.value ||
      (afterUpper.value === beforeUpper.value && afterUpper.exclusive && !beforeUpper.exclusive);
    if (tighter)
      addChange(changes, path, 'maximum', 'breaking', 'The new upper bound is stricter.');
  }
}

function compareProperties(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  const before = isObject(previous.properties) ? previous.properties : {};
  const after = isObject(next.properties) ? next.properties : {};
  const afterAdditional = next.additionalProperties;

  for (const [name, beforeSchema] of Object.entries(before)) {
    const propertyPath = pointer(pointer(path, 'properties'), name);
    if (Object.hasOwn(after, name)) {
      compareSchema(beforeSchema, after[name], propertyPath, changes);
    } else if (afterAdditional === false) {
      addChange(
        changes,
        propertyPath,
        'properties',
        'breaking',
        'Removing this property while rejecting additional properties invalidates old documents that contain it.'
      );
    } else if (isObject(afterAdditional) || typeof afterAdditional === 'boolean') {
      compareSchema(beforeSchema, afterAdditional, propertyPath, changes);
    }
  }

  for (const [name, afterSchema] of Object.entries(after)) {
    if (Object.hasOwn(before, name) || previous.additionalProperties === false) continue;
    compareSchema(
      previous.additionalProperties ?? true,
      afterSchema,
      pointer(pointer(path, 'properties'), name),
      changes
    );
  }
}

function compareAdditionalProperties(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  const before = previous.additionalProperties;
  const after = next.additionalProperties;
  if (after === undefined || sameValue(before, after)) return;
  if (before === undefined || before === true) {
    if (after === false || isObject(after)) {
      addChange(
        changes,
        path,
        'additionalProperties',
        'breaking',
        'The new additionalProperties rule may reject old documents with extra properties.'
      );
    }
    return;
  }
  if (before === false) return;
  if (after === false || after === true) {
    if (after === false)
      addChange(
        changes,
        path,
        'additionalProperties',
        'breaking',
        'The new additionalProperties rule is stricter.'
      );
    return;
  }
  compareSchema(before, after, pointer(path, 'additionalProperties'), changes);
}

function compareUniqueItems(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  if (previous.uniqueItems !== true && next.uniqueItems === true) {
    addChange(
      changes,
      path,
      'uniqueItems',
      'breaking',
      'The new schema rejects duplicate array items that were previously valid.'
    );
  }
}

function compareSchema(
  previousValue: unknown,
  nextValue: unknown,
  path: string,
  changes: SchemaCompatibilityChange[]
): void {
  if (sameValue(previousValue, nextValue)) return;
  if (previousValue === false || nextValue === true) return;
  if (previousValue === true || nextValue === false) {
    addChange(
      changes,
      path,
      'schema',
      'breaking',
      'The schema boolean change may reject previously valid documents.'
    );
    return;
  }
  if (!isObject(previousValue) || !isObject(nextValue)) {
    addChange(
      changes,
      path,
      'schema',
      'unknown',
      'The schema shape changed in a way the compatibility checker cannot compare.'
    );
    return;
  }

  const previous = previousValue;
  const next = nextValue;
  compareType(previous, next, path, changes);
  compareFiniteSet('enum', previous, next, path, changes);
  compareFiniteSet('const', previous, next, path, changes);
  compareRequired(previous, next, path, changes);
  compareBound('minLength', previous, next, path, changes);
  compareBound('maxLength', previous, next, path, changes);
  compareBound('minItems', previous, next, path, changes);
  compareBound('maxItems', previous, next, path, changes);
  compareUniqueItems(previous, next, path, changes);
  compareNumericBounds(previous, next, path, changes);
  compareProperties(previous, next, path, changes);
  compareAdditionalProperties(previous, next, path, changes);

  const previousItems = previous.items;
  const nextItems = next.items;
  if (nextItems !== undefined && previousItems === undefined) {
    addChange(
      changes,
      path,
      'items',
      'breaking',
      'The new items schema may reject old array values.'
    );
  } else if (previousItems !== undefined && nextItems !== undefined) {
    compareSchema(previousItems, nextItems, pointer(path, 'items'), changes);
  }

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const keyword of keys) {
    if (annotations.has(keyword) || modeledKeywords.has(keyword)) continue;
    const beforeHas = Object.hasOwn(previous, keyword);
    const afterHas = Object.hasOwn(next, keyword);
    if (beforeHas && afterHas && sameValue(previous[keyword], next[keyword])) continue;
    addChange(
      changes,
      path,
      keyword,
      'unknown',
      `The changed ${keyword} keyword is outside the automatic compatibility subset.`
    );
  }
}

/** Compare whether every document accepted by the previous schema remains accepted by the next schema. */
export function compareSchemaCompatibility(
  previous: JsonSchemaValue,
  next: JsonSchemaValue
): SchemaCompatibilityChange[] {
  const changes: SchemaCompatibilityChange[] = [];
  compareSchema(previous, next, '', changes);
  return changes.sort((left, right) =>
    left.path < right.path
      ? -1
      : left.path > right.path
        ? 1
        : left.keyword < right.keyword
          ? -1
          : left.keyword > right.keyword
            ? 1
            : left.impact < right.impact
              ? -1
              : left.impact > right.impact
                ? 1
                : 0
  );
}

/** Validate registry structure, confined paths, and existence in the available immutable archive paths. */
export function validateSchemaVersionRegistry(
  value: unknown,
  availableSchemaPaths: ReadonlySet<string>
): KnowledgeValidationResult {
  const issues: KnowledgeValidationIssue[] = [];
  const addIssue = (path: string, keyword: string, message: string): void => {
    issues.push({ path, keyword, message });
  };

  if (!isObject(value)) {
    return {
      valid: false,
      issues: [{ path: '/', keyword: 'type', message: 'must be a version registry object' }],
    };
  }
  if (value.registry_version !== 1) {
    addIssue('/registry_version', 'const', 'must equal the supported registry contract version 1');
  }
  for (const key of Object.keys(value)) {
    if (key !== '$schema' && key !== 'registry_version' && key !== 'components') {
      addIssue(pointer('', key), 'additionalProperties', 'registry property is not supported');
    }
  }
  if (!isObject(value.components)) {
    addIssue('/components', 'type', 'must contain ontology and corpus component registries');
    return { valid: false, issues };
  }
  const extraComponents = Object.keys(value.components).filter(
    (name) => !componentNames.includes(name as SchemaVersionComponent)
  );
  for (const name of extraComponents) {
    addIssue(pointer('/components', name), 'additionalProperties', 'component is not supported');
  }

  for (const component of componentNames) {
    const componentPath = pointer('/components', component);
    const componentValue = value.components[component];
    if (!isObject(componentValue)) {
      addIssue(componentPath, 'required', 'component registry is required');
      continue;
    }
    for (const key of Object.keys(componentValue)) {
      if (key !== 'current' && key !== 'releases') {
        addIssue(
          pointer(componentPath, key),
          'additionalProperties',
          'component property is not supported'
        );
      }
    }
    const current = componentValue.current;
    if (typeof current !== 'string' || !releaseVersionPattern.test(current)) {
      addIssue(
        pointer(componentPath, 'current'),
        'format',
        'must use strict major.minor.patch syntax'
      );
    }
    const releases = componentValue.releases;
    if (!Array.isArray(releases) || releases.length === 0) {
      addIssue(
        pointer(componentPath, 'releases'),
        'minItems',
        'must declare at least one immutable release'
      );
      continue;
    }

    const seenVersions = new Set<string>();
    let currentFound = false;
    releases.forEach((release, releaseIndex) => {
      const releasePath = pointer(pointer(componentPath, 'releases'), String(releaseIndex));
      if (!isObject(release)) {
        addIssue(releasePath, 'type', 'release entry must be an object');
        return;
      }
      for (const key of Object.keys(release)) {
        if (
          key !== 'version' &&
          key !== 'status' &&
          key !== 'document_schema_versions' &&
          key !== 'schemas'
        ) {
          addIssue(
            pointer(releasePath, key),
            'additionalProperties',
            'release property is not supported'
          );
        }
      }
      const version = release.version;
      if (typeof version !== 'string' || !releaseVersionPattern.test(version)) {
        addIssue(
          pointer(releasePath, 'version'),
          'format',
          'must use strict major.minor.patch syntax'
        );
      } else {
        if (seenVersions.has(version)) {
          addIssue(
            pointer(releasePath, 'version'),
            'uniqueItems',
            'release version must be unique within its component'
          );
        }
        seenVersions.add(version);
        if (version === current) currentFound = true;
      }
      if (release.status !== 'baseline' && release.status !== 'released') {
        addIssue(pointer(releasePath, 'status'), 'enum', 'must be baseline or released');
      }
      const documentVersions = release.document_schema_versions;
      const schemas = release.schemas;
      if (!isObject(documentVersions) || Object.keys(documentVersions).length === 0) {
        addIssue(
          pointer(releasePath, 'document_schema_versions'),
          'minProperties',
          'must map each schema name to a positive document version'
        );
      }
      if (!isObject(schemas) || Object.keys(schemas).length === 0) {
        addIssue(
          pointer(releasePath, 'schemas'),
          'minProperties',
          'must map each schema name to an immutable schema path'
        );
      }
      if (!isObject(documentVersions) || !isObject(schemas)) return;

      const documentNames = Object.keys(documentVersions).sort();
      const schemaNames = Object.keys(schemas).sort();
      if (!sameValue(documentNames, schemaNames)) {
        addIssue(
          pointer(releasePath, 'schemas'),
          'keySet',
          'schema names must exactly match document_schema_versions names'
        );
      }
      for (const [name, documentVersion] of Object.entries(documentVersions)) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          addIssue(
            pointer(pointer(releasePath, 'document_schema_versions'), name),
            'pattern',
            'schema names must be lowercase identifier tokens'
          );
        }
        if (
          typeof documentVersion !== 'number' ||
          !Number.isInteger(documentVersion) ||
          documentVersion < 1
        ) {
          addIssue(
            pointer(pointer(releasePath, 'document_schema_versions'), name),
            'minimum',
            'must be a positive integer'
          );
        }
      }
      for (const [name, schemaPath] of Object.entries(schemas)) {
        const schemaPathPointer = pointer(pointer(releasePath, 'schemas'), name);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          addIssue(
            schemaPathPointer,
            'pattern',
            'schema names must be lowercase identifier tokens'
          );
        }
        const expectedPath =
          typeof version === 'string' ? `${component}/${version}/${name}.schema.json` : undefined;
        if (typeof schemaPath !== 'string' || !expectedPath || schemaPath !== expectedPath) {
          addIssue(
            schemaPathPointer,
            'pathConfinement',
            'must exactly identify this component/version immutable .schema.json path'
          );
        } else if (!availableSchemaPaths.has(schemaPath)) {
          addIssue(
            schemaPathPointer,
            'reference',
            'immutable schema file is missing from the available version archive'
          );
        }
      }
    });
    if (typeof current === 'string' && !currentFound) {
      addIssue(
        pointer(componentPath, 'current'),
        'reference',
        'must identify a version in releases'
      );
    }
  }
  return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues };
}

function parseVersion(version: string): [bigint, bigint, bigint] | undefined {
  const match = releaseVersionPattern.exec(version);
  if (!match) return undefined;
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function compareVersions(left: [bigint, bigint, bigint], right: [bigint, bigint, bigint]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function schemaSetChanges(
  previous: SchemaReleaseSet,
  next: SchemaReleaseSet
): SchemaCompatibilityChange[] {
  const changes: SchemaCompatibilityChange[] = [];
  for (const [name, oldSchema] of Object.entries(previous.schemas)) {
    const newSchema = next.schemas[name];
    if (newSchema === undefined) {
      addChange(
        changes,
        `/${name}`,
        'schema',
        'breaking',
        'The new release removes a schema used by the previous release.'
      );
    } else {
      changes.push(
        ...compareSchemaCompatibility(oldSchema, newSchema).map((change) => ({
          ...change,
          path: `/${name}${change.path === '/' ? '' : change.path}`,
        }))
      );
    }
  }
  return changes.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

/** Evaluate an upgrade or downgrade; unrecognized semantic changes fail closed. */
export function evaluateSchemaTransition(
  from: SchemaReleaseSet,
  to: SchemaReleaseSet,
  migrations: readonly SchemaMigrationDeclaration[] = []
): SchemaTransitionResult {
  const issues: string[] = [];
  const fromVersion = parseVersion(from.version);
  const toVersion = parseVersion(to.version);
  const direction =
    fromVersion && toVersion && compareVersions(fromVersion, toVersion) > 0
      ? 'downgrade'
      : 'upgrade';

  if (from.component !== to.component)
    issues.push('Schema versions cannot transition across ontology and corpus components.');
  if (!fromVersion || !toVersion)
    issues.push('Both versions must use strict major.minor.patch syntax.');
  if (fromVersion && toVersion && compareVersions(fromVersion, toVersion) === 0) {
    issues.push('A schema transition must change the semantic version.');
  }
  if (Object.keys(from.schemas).length === 0 || Object.keys(to.schemas).length === 0) {
    issues.push('Both releases must declare at least one named schema.');
  }

  const changes = schemaSetChanges(from, to);
  const matchingMigration = migrations.find(
    (migration) =>
      migration.component === from.component &&
      migration.component === to.component &&
      migration.fromVersion === from.version &&
      migration.toVersion === to.version &&
      migration.id.trim().length > 0 &&
      migration.implementation.trim().length > 0 &&
      migration.deterministic &&
      (direction === 'upgrade' || migration.reversible === true)
  );
  const hasBreak = changes.some((change) => change.impact !== 'compatible');
  const status =
    issues.length > 0
      ? 'blocked'
      : !hasBreak
        ? 'compatible'
        : matchingMigration
          ? 'migration_required'
          : 'blocked';
  if (hasBreak && !matchingMigration) {
    issues.push(
      'Breaking or unknown schema changes require a deterministic migration bound to this exact component and version pair.'
    );
  }

  return {
    status,
    direction,
    component: from.component,
    fromVersion: from.version,
    toVersion: to.version,
    changes,
    ...(matchingMigration ? { migrationId: matchingMigration.id } : {}),
    issues,
  };
}

function validationPointer(
  instancePath: string,
  keyword: string,
  params: Record<string, unknown>
): string {
  if (keyword === 'required' && typeof params.missingProperty === 'string') {
    return pointer(instancePath, params.missingProperty);
  }
  if (keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') {
    return pointer(instancePath, params.additionalProperty);
  }
  return instancePath || '/';
}

/** Validate a document using the immutable schema and integer version declared for its component. */
export function validateDocumentAtSchemaVersion(
  value: unknown,
  contract: VersionedDocumentContract
): KnowledgeValidationResult {
  const issues: KnowledgeValidationIssue[] = [];
  if (!parseVersion(contract.releaseVersion)) {
    issues.push({
      path: '/releaseVersion',
      keyword: 'format',
      message: 'must use strict major.minor.patch syntax',
    });
  }
  if (!Number.isInteger(contract.documentSchemaVersion) || contract.documentSchemaVersion < 1) {
    issues.push({
      path: '/documentSchemaVersion',
      keyword: 'minimum',
      message: 'must be a positive integer',
    });
  }
  if (contract.schemaName.trim().length === 0) {
    issues.push({ path: '/schemaName', keyword: 'minLength', message: 'must not be empty' });
  }
  if (issues.length > 0) return { valid: false, issues };

  if (!isObject(value) || value.schema_version !== contract.documentSchemaVersion) {
    return {
      valid: false,
      issues: [
        {
          path: '/schema_version',
          keyword: 'const',
          message: `must equal ${contract.documentSchemaVersion} declared for ${contract.component} schema set ${contract.releaseVersion} (${contract.schemaName})`,
        },
      ],
    };
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  formatsModule.default.default(ajv, { mode: 'full' });
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(contract.schema as Parameters<typeof ajv.compile>[0]);
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          path: '/schema',
          keyword: 'schema',
          message: error instanceof Error ? error.message : 'declared schema could not be compiled',
        },
      ],
    };
  }
  if (validate(value)) return { valid: true, issues: [] };
  return {
    valid: false,
    issues: (validate.errors ?? []).map((error) => ({
      path: validationPointer(error.instancePath, error.keyword, error.params),
      keyword: error.keyword,
      message: error.message ?? 'does not match the declared schema version',
    })),
  };
}
