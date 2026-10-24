import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import {
  createModelGraph,
  createWorkspaceGraph,
  hashSources,
  hashWorkspaceGraph,
  renderModelSvg,
  renderSequenceSvg,
  renderWorkspaceSvg,
  validateFlows,
} from './generate-diagrams.mjs';

test('source fingerprints are stable across LF and CRLF checkouts', () => {
  assert.equal(
    hashSources([{ path: 'packages/addon/src/manifest.ts', contents: 'export {}\n' }]),
    hashSources([{ path: 'packages/addon/src/manifest.ts', contents: 'export {}\r\n' }])
  );
});

test('workspace graph keeps only known internal dependencies and records their source', () => {
  const graph = createWorkspaceGraph([
    {
      directory: 'apps/board',
      manifest: {
        name: '@moonwitness/board',
        version: '1.0.0',
        dependencies: { '@moonwitness/ui': 'workspace:*', react: '^19.0.0' },
      },
    },
    {
      directory: 'packages/ui',
      manifest: { name: '@moonwitness/ui', version: '1.0.0' },
    },
  ]);

  assert.deepEqual(
    graph.packages.map(({ name }) => name),
    ['@moonwitness/board', '@moonwitness/ui']
  );
  assert.deepEqual(graph.edges, [
    {
      from: '@moonwitness/board',
      to: '@moonwitness/ui',
      kind: 'runtime',
      manifest: 'apps/board',
    },
  ]);
});

test('workspace provenance ignores external dependency ranges outside the rendered graph', () => {
  const manifest = (version) => [
    {
      directory: 'apps/board',
      manifest: {
        name: '@moonwitness/board',
        version: '1.0.0',
        dependencies: { react: version },
      },
    },
  ];
  assert.equal(
    hashWorkspaceGraph(createWorkspaceGraph(manifest('^19.0.0'))),
    hashWorkspaceGraph(createWorkspaceGraph(manifest('^19.1.0')))
  );
});

test('workspace graph rejects duplicate names and unresolved workspace dependencies', () => {
  assert.throws(
    () =>
      createWorkspaceGraph([
        { directory: 'apps/a', manifest: { name: 'duplicate' } },
        { directory: 'packages/b', manifest: { name: 'duplicate' } },
      ]),
    /must be unique/u
  );
  assert.throws(
    () =>
      createWorkspaceGraph([
        {
          directory: 'apps/a',
          manifest: {
            name: '@moonwitness/a',
            dependencies: { '@moonwitness/missing': 'workspace:*' },
          },
        },
      ]),
    /has no workspace manifest/u
  );
});

test('model graph resolves declared relation metadata and rejects targets outside the addon', () => {
  class Partner {
    static modelName = 'base.partner';
    static tableName = 'base_partner';
  }
  class User {
    static modelName = 'base.user';
    static tableName = 'base_user';
  }

  const graph = createModelGraph([
    {
      modelName: User.modelName,
      tableName: User.tableName,
      fields: { partner: { kind: 'belongsTo', target: Partner } },
    },
    {
      modelName: Partner.modelName,
      tableName: Partner.tableName,
      fields: { user: { kind: 'hasMany', target: () => User } },
    },
  ]);
  assert.deepEqual(graph.edges, [
    { from: 'base.partner', field: 'user', to: 'base.user', cardinality: '1:N', kind: 'hasMany' },
    {
      from: 'base.user',
      field: 'partner',
      to: 'base.partner',
      cardinality: 'N:1',
      kind: 'belongsTo',
    },
  ]);
  assert.throws(
    () =>
      createModelGraph([
        {
          modelName: User.modelName,
          tableName: User.tableName,
          fields: { missing: { kind: 'belongsTo', target: Partner } },
        },
      ]),
    /absent from its addon manifest/u
  );
});

test('sequence validation rejects broken references, duplicate IDs, and self messages', () => {
  const validFlow = {
    id: 'valid',
    participants: [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ],
    messages: [{ from: 'one', to: 'two', label: 'Send' }],
  };
  assert.deepEqual(validateFlows({ schemaVersion: 1, flows: [validFlow] }), [validFlow]);
  assert.throws(
    () =>
      validateFlows({
        schemaVersion: 1,
        flows: [{ ...validFlow, id: 'bad', messages: [{ from: 'one', to: 'missing' }] }],
      }),
    /unknown participant/u
  );
  assert.throws(
    () => validateFlows({ schemaVersion: 1, flows: [validFlow, validFlow] }),
    /Duplicate architecture flow/u
  );
  assert.throws(
    () =>
      validateFlows({
        schemaVersion: 1,
        flows: [{ ...validFlow, messages: [{ from: 'one', to: 'one' }] }],
      }),
    /self-message/u
  );
});

test('sequence SVG uses defined arrow markers and safely escapes curated labels', () => {
  const svg = renderSequenceSvg({
    title: 'Flow <review>',
    description: 'A & B',
    participants: [
      { id: 'left', label: 'Left' },
      { id: 'right', label: 'Right' },
    ],
    messages: [
      { from: 'left', to: 'right', label: 'forward' },
      { from: 'right', to: 'left', label: 'return', kind: 'return' },
    ],
  });
  assert.match(svg, /<title id="diagram-title">Flow &lt;review&gt;<\/title>/u);
  assert.match(svg, /marker-end="url\(#arrow-right\)"/u);
  assert.match(svg, /marker-start="url\(#arrow-left\)"/u);
  assert.doesNotMatch(svg, /<script|foreignObject/iu);
});

test('workspace SVG documents its accessible summary', () => {
  const svg = renderWorkspaceSvg({
    packages: [
      { name: 'board', kind: 'app' },
      { name: 'assets', kind: 'package' },
    ],
    edges: [],
  });
  assert.match(svg, /role="img"/u);
  assert.match(svg, /2 apps and packages with 0 internal/u);
  assert.match(svg, /assets/u);
  assert.match(svg, /isolated package/u);
});

test('model SVG includes models without relations', () => {
  const svg = renderModelSvg({
    entities: [{ name: 'base.user' }, { name: 'base.audit_log' }],
    edges: [{ from: 'base.user', field: 'partner', cardinality: 'N:1', to: 'base.partner' }],
  });
  assert.match(svg, /base\.audit_log/u);
  assert.match(svg, /no relations/u);
});

test('curated architecture flows are valid and have unique Mermaid identifiers', async () => {
  const flows = JSON.parse(await readFile(new URL('./flows.json', import.meta.url), 'utf8'));
  const validFlows = validateFlows(flows);
  assert.deepEqual(
    validFlows.map(({ id }) => id),
    ['auth-refresh', 'jobs-outbox', 'addon-install', 'release-lifecycle']
  );
});

test('generated model metadata includes provenance without seed records or values', async () => {
  const metadata = JSON.parse(
    await readFile(
      new URL('../../docs/architecture/diagrams/core-model-relations.json', import.meta.url),
      'utf8'
    )
  );
  assert.deepEqual(Object.keys(metadata), [
    'schemaVersion',
    'addons',
    'generatedFrom',
    'sourceSha256',
    'models',
    'relations',
  ]);
  assert.deepEqual(metadata.addons, ['auth', 'base', 'jobs', 'notification']);
  assert.match(metadata.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.ok(
    metadata.models.every((model) =>
      Object.keys(model).every((key) => ['name', 'table'].includes(key))
    )
  );
  assert.ok(
    metadata.relations.every((relation) =>
      Object.keys(relation).every((key) =>
        ['from', 'field', 'to', 'cardinality', 'kind'].includes(key)
      )
    )
  );
});
