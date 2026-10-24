import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  collectReferenceMetadata,
  fingerprintReferenceMetadata,
  extractRoutes,
  assertGeneratedOutputsCurrent,
  generateReference,
  normalizeModel,
  validateModelCatalog,
} from './generate-reference.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('reference provenance follows rendered metadata and excludes dependency-only manifest changes', async () => {
  const metadata = await collectReferenceMetadata();
  const { generatedFromSha256, ...renderedMetadata } = metadata;
  assert.equal(generatedFromSha256, fingerprintReferenceMetadata(renderedMetadata));
  assert.deepEqual(Object.keys(metadata.packages[0]).sort(), [
    'directory',
    'name',
    'scripts',
    'version',
  ]);
  assert.match(generatedFromSha256, /^[a-f0-9]{64}$/u);
});

test('stale generated output fails and reports every changed or missing path deterministically', () => {
  const actual = new Map([
    ['docs/z.md', 'old'],
    ['docs/a.md', 'old'],
    ['docs/removed.md', 'old'],
  ]);
  const expected = new Map([
    ['docs/z.md', 'new'],
    ['docs/a.md', 'old'],
    ['docs/added.md', 'new'],
  ]);
  assert.throws(
    () => assertGeneratedOutputsCurrent(actual, expected),
    /docs\/added\.md\n- docs\/removed\.md\n- docs\/z\.md/u
  );
});

test('reference check mode compares rendered output without changing tracked files', async () => {
  const paths = [
    'docs/guide/reference/generated-platform.json',
    'docs/guide/reference/generated-platform.md',
    'docs/guide/reference/generated-models.md',
    'docs/guide/reference/generated-api.md',
  ];
  const before = await Promise.all(
    paths.map((relativePath) => readFile(path.join(root, relativePath), 'utf8'))
  );
  await generateReference({ check: true });
  const after = await Promise.all(
    paths.map((relativePath) => readFile(path.join(root, relativePath), 'utf8'))
  );
  assert.deepEqual(after, before);
});

test('model metadata preserves optionality and redacts defaults', () => {
  const model = normalizeModel({
    modelName: 'test.example',
    tableName: 'test_examples',
    fields: {
      optional_name: { kind: 'string' },
      required_name: { kind: 'string', required: true },
      configured_name: { kind: 'string', required: true, default: 'private-value' },
    },
    uniqueConstraints: [],
  });
  assert.deepEqual(model.fields, [
    {
      name: 'configured_name',
      kind: 'string',
      column: 'configured_name',
      declaredRequired: true,
      required: false,
      unique: false,
      optional: true,
      hasDefault: true,
      default: '[redacted]',
    },
    {
      name: 'optional_name',
      kind: 'string',
      column: 'optional_name',
      declaredRequired: false,
      required: false,
      unique: false,
      optional: true,
      hasDefault: false,
    },
    {
      name: 'required_name',
      kind: 'string',
      column: 'required_name',
      declaredRequired: true,
      required: true,
      unique: false,
      optional: false,
      hasDefault: false,
    },
  ]);
  assert.equal(JSON.stringify(model).includes('private-value'), false);
});

test('unknown field kinds and incomplete or unresolved relations fail clearly', () => {
  const model = (field) => ({
    modelName: 'test.example',
    tableName: 'test_examples',
    fields: { field },
    uniqueConstraints: [],
  });
  assert.throws(() => normalizeModel(model({ kind: 'mystery' })), /Unknown field kind/u);
  assert.throws(() => normalizeModel(model({ kind: 'belongsTo' })), /no valid target/u);
  const unresolved = normalizeModel(
    model({ kind: 'hasMany', target: { modelName: 'test.missing' } })
  );
  assert.throws(() => validateModelCatalog([unresolved]), /Unknown relation target/u);
});

test('route extraction accepts static paths and rejects computed or malformed routes', () => {
  const routes = extractRoutes(`
    fastify.get('/api/things', handler);
    fastify.post(\`/api/things\`, handler);
    fastify.patch('/api/things/:id', handler);
  `);
  assert.deepEqual(routes, [
    { method: 'GET', path: '/api/things' },
    { method: 'POST', path: '/api/things' },
    { method: 'PATCH', path: '/api/things/:id' },
  ]);
  assert.throws(
    () => extractRoutes("fastify.get(pathPrefix + '/api/things', handler);"),
    /static absolute path/u
  );
  assert.throws(
    () => extractRoutes("fastify.get('/api/things', first); fastify.get('/api/things', second);"),
    /Duplicate static route declaration/u
  );
  assert.throws(() => extractRoutes('fastify.get(', 'broken.ts'), /Could not parse route source/u);
});

test('the plugin instance is recognised under its conventional aliases and nothing wider', () => {
  assert.deepEqual(
    extractRoutes(`
      app.get('/whatsapp/account', handler);
      app.post('/whatsapp/connect', handler);
      server.get('/health', handler);
    `),
    [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/whatsapp/account' },
      { method: 'POST', path: '/whatsapp/connect' },
    ]
  );
  assert.deepEqual(
    extractRoutes('router.get("/api/things", handler); cache.get("/api/other");'),
    [],
    'only the Fastify instance identifiers may register routes'
  );
  assert.throws(
    () => extractRoutes("app.patch({ status: 'connecting' });"),
    /static absolute path/u,
    'an aliased instance keeps the fail-closed static-path rule'
  );
});

test('generated API reference matches literal route declarations in source', async () => {
  const routesDirectory = path.join(root, 'apps/api/src/routes');
  const routeFiles = (await readdir(routesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(routesDirectory, entry.name));
  const routeGroups = await Promise.all(
    routeFiles.map(async (file) => extractRoutes(await readFile(file, 'utf8'), file))
  );
  const sourceRoutes = routeGroups.flat();
  const metadata = await collectReferenceMetadata();
  const repeatedMetadata = await collectReferenceMetadata();
  assert.deepEqual(repeatedMetadata, metadata);
  assert.deepEqual(
    metadata.routes,
    sourceRoutes.sort(
      (left, right) =>
        left.path.localeCompare(right.path, 'en') || left.method.localeCompare(right.method, 'en')
    )
  );
  assert.equal(metadata.safety.applicationStarted, false);
  assert.equal(metadata.safety.databaseConnected, false);
  assert.equal(metadata.safety.realEnvironmentLoaded, false);
  assert.ok(Object.keys(metadata.scripts.root).includes('verify'));
  assert.ok(
    metadata.environment.some((item) => item.name === 'DATABASE_URL' && item.valueType === 'url')
  );
  assert.ok(metadata.environment.some((item) => item.name === 'JWT_SECRET' && item.secret));
  assert.equal(JSON.stringify(metadata).includes('postgresql://'), false);
});

test('real addon fields, access, menus, and seed coverage are represented without seed values', async () => {
  const { Registry } = await import('../../packages/orm/dist/index.js');
  const registryBeforeExtraction = Registry.getNames();
  const metadata = await collectReferenceMetadata();
  const base = metadata.addons.find((addon) => addon.name === 'base');
  assert.ok(base);
  assert.ok(base.models.length >= 20);
  assert.ok(base.menus.length > 0);
  assert.ok(
    base.accessRules.some(
      (rule) => rule.group === 'base.group_user' && rule.model === 'base.partner' && rule.read
    )
  );
  assert.ok(Object.values(base.seeds).reduce((sum, count) => sum + count, 0) > 0);
  assert.equal(metadata.safety.seedValuesIncluded, false);
  assert.equal(metadata.safety.defaultsIncluded, false);
  assert.deepEqual(Registry.getNames(), registryBeforeExtraction);
});
