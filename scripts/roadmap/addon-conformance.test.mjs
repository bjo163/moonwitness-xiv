import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAddons } from '../../packages/orm/dist/index.js';
import * as base from '../../packages/orm-base/dist/index.js';
import * as auth from '../../packages/auth/dist/index.js';
import * as jobs from '../../packages/jobs/dist/index.js';
import * as notification from '../../packages/orm-notification/dist/index.js';
import * as organization from '../../packages/orm-organization/dist/index.js';
import * as storage from '../../packages/orm-storage/dist/index.js';
import * as workflow from '../../packages/orm-workflow/dist/index.js';
import * as request from '../../packages/orm-request/dist/index.js';
import * as integration from '../../packages/orm-integration/dist/index.js';
import * as witness from '../../packages/orm-knowledge/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromApi = createRequire(path.join(root, 'apps/api/package.json'));
const knex = requireFromApi('knex');

const addonPackages = [
  { directory: 'orm-base', module: base, manifest: base.manifest },
  { directory: 'auth', module: auth, manifest: auth.manifest },
  { directory: 'jobs', module: jobs, manifest: jobs.jobsManifest },
  { directory: 'orm-notification', module: notification, manifest: notification.manifest },
  { directory: 'orm-organization', module: organization, manifest: organization.manifest },
  { directory: 'orm-storage', module: storage, manifest: storage.manifest },
  { directory: 'orm-workflow', module: workflow, manifest: workflow.manifest },
  { directory: 'orm-request', module: request, manifest: request.manifest },
  { directory: 'orm-integration', module: integration, manifest: integration.manifest },
  { directory: 'orm-knowledge', module: witness, manifest: witness.manifest },
];
const addonManifests = addonPackages.map(({ manifest }) => manifest);
const modelName = (model) => model.modelName;

describe('workspace addon conformance', () => {
  it('exposes valid manifests, public models, dependencies, views, menus, and stable seed identities', async () => {
    const addonsByName = new Map(addonManifests.map((addon) => [addon.name, addon]));
    assert.equal(addonsByName.size, addonManifests.length, 'addon names must be unique');
    const allModels = new Map();
    const allSeedIds = new Set();

    for (const addon of addonManifests) {
      for (const model of addon.models) {
        assert.ok(!allModels.has(modelName(model)), `duplicate model ${modelName(model)}`);
        allModels.set(modelName(model), model);
      }
    }

    for (const { directory, manifest: addon } of addonPackages) {
      const packageJson = JSON.parse(
        await readFile(path.join(root, 'packages', directory, 'package.json'), 'utf8')
      );
      assert.equal(
        typeof packageJson.scripts?.build,
        'string',
        `${directory} needs a build script`
      );
      assert.equal(typeof packageJson.scripts?.test, 'string', `${directory} needs a test script`);
      assert.deepEqual(
        Object.keys(packageJson.exports ?? {}).sort(),
        ['.'],
        `${directory} must expose a deliberate root API only`
      );
      assert.match(addon.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
      for (const dependency of addon.depends ?? []) {
        assert.ok(addonsByName.has(dependency), `${addon.name} depends on missing ${dependency}`);
      }
      const addonModels = new Set(addon.models.map(modelName));
      assert.equal(addonModels.size, addon.models.length, `${addon.name} repeats a model`);
      for (const menu of addon.menus ?? []) {
        assert.ok(addonModels.has(menu.model), `${addon.name} menu references an undeclared model`);
        assert.ok(
          (addon.views ?? []).some((view) => view.model === menu.model),
          `${addon.name} menu model ${menu.model} has no view`
        );
        assert.ok(menu.group.trim(), `${addon.name} menu ${menu.model} has no group`);
      }
      for (const view of addon.views ?? []) {
        assert.ok(addonModels.has(view.model), `${addon.name} view references an undeclared model`);
      }
      for (const record of addon.data ?? []) {
        assert.ok(record.id.startsWith(`${addon.name}.`), `${record.id} is not namespaced`);
        assert.ok(!allSeedIds.has(record.id), `duplicate external ID ${record.id}`);
        assert.ok(
          allModels.has(modelName(record.model)) || addonModels.has(modelName(record.model)),
          `${record.id} references an unowned seed model`
        );
        allSeedIds.add(record.id);
      }
    }

    for (const { directory, module, manifest: addon } of addonPackages) {
      const exportedModels = new Set(
        Object.values(module)
          .filter((value) => typeof value === 'function' && typeof value.modelName === 'string')
          .map(modelName)
      );
      for (const model of addon.models) {
        assert.ok(
          exportedModels.has(modelName(model)),
          `${directory} does not export ${modelName(model)}`
        );
      }
    }

    // orm-storage is deliberately a provider-only package: it owns no ORM models or demo rows.
    assert.deepEqual(storage.manifest.models, []);
    assert.equal(storage.manifest.data, undefined);
    assert.equal(auth.manifest.data, undefined, 'auth sessions must never be seeded as demo data');
  });

  it('reinstalls all runtime addons without duplicating seeds or overwriting example edits', async () => {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: {
        afterCreate(connection, done) {
          connection.pragma('foreign_keys = ON');
          done(null, connection);
        },
      },
    });
    after(async () => db.destroy());

    await installAddons(db, [...addonManifests].reverse());
    const seeded = await db('_orm_data').count({ count: '*' }).first();
    const expectedSeedCount = addonManifests.reduce(
      (total, addon) => total + (addon.data?.length ?? 0),
      0
    );
    assert.equal(Number(seeded?.count), expectedSeedCount);
    assert.equal(Number((await db('users').count({ count: '*' }).first())?.count), 2);
    const exampleEndpointRef = await db('_orm_data')
      .where({ id: 'orm-integration.endpoint_example_disabled' })
      .first();
    assert.ok(exampleEndpointRef, 'integration addon needs a safe disabled endpoint example');
    assert.deepEqual(
      await db('integration_webhook_endpoints')
        .where({ id: exampleEndpointRef.record_id })
        .first('enabled', 'url', 'secret_ref'),
      {
        enabled: 0,
        url: 'https://example.invalid/moonwitness-webhook',
        secret_ref: 'MW_WEBHOOK_SECRET_C1_EXAMPLE',
      }
    );
    assert.equal(
      Number((await db('organization_departments').count({ count: '*' }).first())?.count),
      2
    );
    assert.equal(Number((await db('organization_teams').count({ count: '*' }).first())?.count), 2);
    assert.equal(
      Number((await db('organization_positions').count({ count: '*' }).first())?.count),
      2
    );
    assert.equal(
      Number((await db('organization_memberships').count({ count: '*' }).first())?.count),
      2
    );

    const editedSeeds = [
      { id: 'base.partner_acme', field: 'name' },
      { id: 'jobs.cron_example_disabled', field: 'name' },
      { id: 'notification.template_example_in_app', field: 'body' },
      { id: 'organization.department_operations', field: 'description' },
      { id: 'workflow.definition_sample_request_v1', field: 'name' },
      { id: 'request.example_laptop', field: 'description' },
      { id: 'orm-integration.endpoint_example_disabled', field: 'name' },
    ];
    const immutableSeeds = [
      {
        id: 'knowledge.synthetic_witness_001_interpretation_001',
        field: 'interpretation_text',
        attemptedValue: 'Maintainer edit to an append-only example',
      },
    ];
    const dataAddonNames = addonPackages
      .filter(({ manifest }) => (manifest.data?.length ?? 0) > 0)
      .map(({ manifest }) => manifest.name)
      .sort();
    const sampledAddonNames = [
      ...new Set(
        [...editedSeeds, ...immutableSeeds].map(({ id }) => id.slice(0, id.lastIndexOf('.')))
      ),
    ].sort();
    assert.deepEqual(
      sampledAddonNames,
      dataAddonNames,
      'every addon with seeds must have a representative edit-preservation or immutability check'
    );
    const allSeeds = addonManifests.flatMap((addon) => addon.data ?? []);
    const expectedEdits = new Map();
    for (const [index, { id, field }] of editedSeeds.entries()) {
      const record = allSeeds.find((candidate) => candidate.id === id);
      assert.ok(record, `missing representative seed ${id}`);
      assert.equal(typeof record.values[field], 'string', `${id}.${field} must be a text example`);
      const identity = await db('_orm_data').where({ id }).first();
      assert.ok(identity, `installer must track seed ${id}`);
      const value = `Maintainer edit ${index + 1}`;
      await db(record.model.tableName)
        .where({ id: identity.record_id })
        .update({ [field]: value });
      expectedEdits.set(id, { model: record.model, recordId: identity.record_id, field, value });
    }
    for (const { id, field, attemptedValue } of immutableSeeds) {
      const record = allSeeds.find((candidate) => candidate.id === id);
      assert.ok(record, `missing immutable representative seed ${id}`);
      const identity = await db('_orm_data').where({ id }).first();
      assert.ok(identity, `installer must track immutable seed ${id}`);
      await assert.rejects(
        db(record.model.tableName)
          .where({ id: identity.record_id })
          .update({ [field]: attemptedValue }),
        /append-only/
      );
    }
    await installAddons(db, addonManifests);

    assert.equal(
      Number((await db('_orm_data').count({ count: '*' }).first())?.count),
      expectedSeedCount
    );
    assert.equal(Number((await db('users').count({ count: '*' }).first())?.count), 2);
    for (const { model, recordId, field, value } of expectedEdits.values()) {
      const persisted = await db(model.tableName).where({ id: recordId }).first(field);
      assert.equal(persisted?.[field], value, `${model.modelName}.${field} must preserve edits`);
    }
    for (const { id, field } of immutableSeeds) {
      const record = allSeeds.find((candidate) => candidate.id === id);
      assert.ok(record);
      const identity = await db('_orm_data').where({ id }).first();
      assert.ok(identity);
      const persisted = await db(record.model.tableName)
        .where({ id: identity.record_id })
        .first(field);
      assert.equal(
        persisted?.[field],
        record.values[field],
        `${record.model.modelName}.${field} must remain append-only`
      );
    }
    assert.equal(
      Number((await db('_orm_addons').count({ count: '*' }).first())?.count),
      addonManifests.length
    );
  });
});
