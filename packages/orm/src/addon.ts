import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { Registry } from './registry.js';
import type { BaseModel } from './base.model.js';
import { columnName, type DefinedModel, type Field, type FieldMap } from './model-definition.js';
import { registerView, type ViewDefinition } from './view.js';

function resolveTargetModel(
  target: typeof BaseModel | (() => typeof BaseModel) | undefined
): typeof BaseModel | undefined {
  if (!target) return undefined;
  if (typeof target === 'function' && !('tableName' in target)) {
    return (target as () => typeof BaseModel)();
  }
  return target as typeof BaseModel;
}

type AddonModel = typeof BaseModel & { readonly fields: FieldMap };
export interface SeedReference {
  readonly $ref: string;
}
export const ref = (id: string): SeedReference => ({ $ref: id });
type SeedValue = string | number | boolean | null | SeedReference;
type Value<F> = F extends { kind: 'belongsTo' }
  ? SeedReference
  : F extends Field<infer V>
    ? V
    : never;
type SeedValues<F extends FieldMap> = {
  [
    K in keyof F as F[K] extends { required: true }
      ? F[K] extends { default: unknown }
        ? never
        : K
      : never
  ]: Value<F[K]>;
} & {
  [
    K in keyof F as F[K] extends { required: true }
      ? F[K] extends { default: unknown }
        ? K
        : never
      : K
  ]?: Value<F[K]> | null;
};

export interface SeedRecord {
  readonly id: string;
  readonly model: AddonModel;
  readonly values: Readonly<Record<string, SeedValue>>;
}

export function seed<const F extends FieldMap>(
  model: DefinedModel<F>,
  id: string,
  values: SeedValues<NoInfer<F>>
): SeedRecord {
  return { id, model, values };
}

export interface Addon {
  readonly name: string;
  readonly version: string;
  readonly depends?: readonly string[];
  readonly models: readonly AddonModel[];
  readonly data?: readonly SeedRecord[];
  readonly views?: readonly ViewDefinition[];
  readonly menus?: readonly AddonMenu[];
  /** Idempotent database setup run transactionally after addon tables are synchronized. */
  readonly setup?: (transaction: Knex.Transaction) => Promise<void>;
  /** Programmatic, transactional data/schema backfills keyed by the exact prior addon version. */
  readonly upgrade?: Readonly<Record<string, (transaction: Knex.Transaction) => Promise<void>>>;
}

export interface AddonMenu {
  readonly model: string;
  readonly label?: string;
  readonly group: string;
  readonly sequence?: number;
  readonly developmentOnly?: boolean;
}

export interface ModelMenuInfo {
  label?: string;
  group: string;
  sequence: number;
  developmentOnly: boolean;
}

const modelMenus = new Map<string, ModelMenuInfo>();

export function getModelMenuInfo(model: string): ModelMenuInfo {
  return (
    modelMenus.get(model) ?? {
      group: model.split('.')[0] ?? 'other',
      sequence: 1000,
      developmentOnly: true,
    }
  );
}
export function defineAddon(addon: Addon): Readonly<Addon> {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(addon.version)) {
    throw new Error(`Addon '${addon.name}' must use a semantic version (major.minor.patch)`);
  }
  const models = new Set(addon.models.map((model) => model.modelName));
  const menuModels = new Set<string>();
  for (const menu of addon.menus ?? []) {
    if (!models.has(menu.model))
      throw new Error(`Menu model '${menu.model}' is not in addon '${addon.name}'`);
    if (menuModels.has(menu.model))
      throw new Error(`Duplicate menu model '${menu.model}' in addon '${addon.name}'`);
    if (!menu.group.trim()) throw new Error(`Menu group is required for '${menu.model}'`);
    menuModels.add(menu.model);
  }
  return Object.freeze(addon);
}

interface InstalledAddon {
  name: string;
  version: string;
  installed_at?: string;
  upgraded_at?: string;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function sort<T>(
  items: readonly T[],
  key: (item: T) => string,
  dependencies: (item: T) => readonly string[]
): T[] {
  const lookup = new Map(items.map((item) => [key(item), item]));
  if (lookup.size !== items.length) throw new Error('Duplicate addon or model name');
  const visiting = new Set<string>();
  const done = new Set<string>();
  const sorted: T[] = [];
  function visit(name: string) {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular dependency: ${name}`);
    const item = lookup.get(name);
    if (!item) throw new Error(`Missing dependency: ${name}`);
    visiting.add(name);
    for (const dependency of dependencies(item)) visit(dependency);
    visiting.delete(name);
    done.add(name);
    sorted.push(item);
  }
  for (const item of items) visit(key(item));
  return sorted;
}

function addField(
  table: Knex.CreateTableBuilder,
  name: string,
  field: Field,
  includeForeignKey = true
) {
  const column = columnName(name, field);
  const builder =
    field.kind === 'integer' || field.kind === 'belongsTo'
      ? table.integer(column)
      : field.kind === 'text'
        ? table.text(column)
        : field.kind === 'boolean'
          ? table.boolean(column)
          : table.string(column, 255);
  if (field.required || field.default !== undefined) builder.notNullable();
  else builder.nullable();
  if (field.default !== undefined) builder.defaultTo(field.default);
  if (field.unique) builder.unique();
  if (field.values) builder.checkIn([...field.values]);
  const targetModel = resolveTargetModel(field.target);
  if (field.kind === 'belongsTo' && targetModel && includeForeignKey)
    builder.references('id').inTable(targetModel.tableName).onDelete('RESTRICT');
}

async function syncModel(db: Knex.Transaction, model: AddonModel) {
  const entries = Object.entries(model.fields);
  const tableExists = await db.schema.hasTable(model.tableName);
  if (!tableExists) {
    await db.schema.createTable(model.tableName, (table) => {
      table.increments('id').primary();
      table.boolean('active').notNullable().defaultTo(true);
      table.timestamp('create_date').notNullable().defaultTo(db.fn.now());
      table.timestamp('write_date').notNullable().defaultTo(db.fn.now());
      table.integer('create_uid').nullable();
      table.integer('write_uid').nullable();
      for (const [name, field] of entries) addField(table, name, field);
    });
  } else {
    for (const [name, field] of entries) {
      if (await db.schema.hasColumn(model.tableName, columnName(name, field))) continue;
      const populated: unknown = await db(model.tableName).first('id');
      if (populated && ((field.required && field.default === undefined) || field.unique)) {
        throw new Error(
          `Cannot safely add ${model.modelName}.${name} to an existing populated table; backfill explicitly first`
        );
      }
      await db.schema.alterTable(model.tableName, (table) =>
        addField(table, name, field, db.client.config.client !== 'better-sqlite3')
      );
    }
  }

  const indexes = [
    ['active', 'id'],
    ['create_uid'],
    ...entries.flatMap(([name, field]) =>
      field.kind === 'belongsTo' ? [[columnName(name, field)]] : []
    ),
  ];
  for (const columns of indexes) {
    const suffix = createHash('sha256')
      .update(`${model.tableName}.${columns.join('.')}`)
      .digest('hex')
      .slice(0, 12);
    const indexName = `mw_idx_${suffix}`;
    const identifiers = columns.map(() => '??').join(', ');
    await db.raw(`CREATE INDEX IF NOT EXISTS ?? ON ?? (${identifiers})`, [
      indexName,
      model.tableName,
      ...columns,
    ]);
  }
  for (const constraint of model.uniqueConstraints) {
    if (constraint.length === 0) throw new Error(`Empty unique constraint on ${model.modelName}`);
    const columns = constraint.map((name) => {
      const field = model.fields[name];
      if (!field) throw new Error(`Unknown unique field: ${model.modelName}.${name}`);
      return columnName(name, field);
    });
    const suffix = createHash('sha256')
      .update(`${model.tableName}.unique.${columns.join('.')}`)
      .digest('hex')
      .slice(0, 12);
    const indexName = `mw_uq_${suffix}`;
    const identifiers = columns.map(() => '??').join(', ');
    await db.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (${identifiers})`, [
      indexName,
      model.tableName,
      ...columns,
    ]);
  }
}

interface ExternalRecord {
  id: string;
  model: string;
  record_id: number;
}
interface Identity {
  id: number;
}

async function installData(db: Knex.Transaction, data: readonly SeedRecord[]) {
  if (!(await db.schema.hasTable('_orm_data'))) {
    await db.schema.createTable('_orm_data', (table) => {
      table.string('id').primary();
      table.string('model').notNullable();
      table.integer('record_id').notNullable();
      table.unique(['model', 'record_id']);
    });
  }
  const pending = new Map(data.map((record) => [record.id, record]));
  if (pending.size !== data.length) throw new Error('Duplicate external data ID');
  const resolving = new Set<string>();
  async function resolveValues(
    record: SeedRecord
  ): Promise<Record<string, string | number | boolean | null>> {
    const values: Record<string, string | number | boolean | null> = {};
    for (const [name, value] of Object.entries(record.values)) {
      const field = record.model.fields[name];
      if (!field) throw new Error(`Unknown seed field: ${record.model.modelName}.${name}`);
      if (typeof value === 'object' && value !== null) {
        const linked = await ensure(value.$ref);
        const targetModel = resolveTargetModel(field.target);
        if (targetModel?.modelName !== linked.model)
          throw new Error(`Invalid relation for ${record.id}.${name}`);
        values[columnName(name, field)] = linked.record_id;
      } else values[columnName(name, field)] = value;
    }
    return values;
  }
  async function ensure(id: string): Promise<ExternalRecord> {
    const known = await db<ExternalRecord>('_orm_data').where({ id }).first();
    const record = pending.get(id);
    if (known) {
      if (record && known.model !== record.model.modelName)
        throw new Error(`Data ID ${id} changed model`);
      if (
        record &&
        !(await db<Identity>(record.model.tableName).where({ id: known.record_id }).first())
      ) {
        throw new Error(`Seed record ${id} was deleted; restore it explicitly`);
      }
      if (record) {
        const defaults = await resolveValues(record);
        for (const [field, value] of Object.entries(defaults)) {
          const current = await db<Identity & Record<string, unknown>>(record.model.tableName)
            .where({ id: known.record_id })
            .select(field)
            .first();
          if (current?.[field] === null || current?.[field] === undefined) {
            await db(record.model.tableName)
              .where({ id: known.record_id })
              .whereNull(field)
              .update({ [field]: value, write_date: new Date() });
          }
        }
      }
      return known;
    }
    if (!record) throw new Error(`Unknown data reference: ${id}`);
    if (resolving.has(id)) throw new Error(`Circular data reference: ${id}`);
    resolving.add(id);
    const values = await resolveValues(record);
    // Adopt existing default records once, then track only immutable external IDs.
    let existing: Identity | undefined;
    const adopt = (match: Identity | undefined) => {
      if (existing && match && existing.id !== match.id)
        throw new Error(`Conflicting seed identity: ${id}`);
      existing = match ?? existing;
    };
    for (const [name, field] of Object.entries(record.model.fields)) {
      const value = values[columnName(name, field)];
      if (!field.unique || value === undefined || value === null || field.kind === 'belongsTo')
        continue;
      const match = await db<Identity>(record.model.tableName)
        .where(columnName(name, field), value)
        .first('id');
      adopt(match);
    }
    for (const constraint of record.model.uniqueConstraints) {
      const columns = constraint.map((name) => columnName(name, record.model.fields[name]!));
      const identity = Object.fromEntries(columns.map((column) => [column, values[column]]));
      if (Object.values(identity).some((value) => value === undefined || value === null)) continue;
      const match = await db<Identity>(record.model.tableName).where(identity).first('id');
      adopt(match);
    }
    const created = existing ?? (await record.model.query(db).insertAndFetch(values));
    const identity = { id, model: record.model.modelName, record_id: created.id };
    const mappedRecord = await db<ExternalRecord>('_orm_data')
      .where({ model: identity.model, record_id: identity.record_id })
      .first('id');
    // A legacy/manual row may already belong to another external seed ID. Keep
    // that canonical mapping; the current seed can still reference its record.
    if (!mappedRecord) await db<ExternalRecord>('_orm_data').insert(identity);
    resolving.delete(id);
    return identity;
  }
  for (const record of data) await ensure(record.id);
}

/** Install an ordered set of addons atomically; restart preserves user-edited seed values. */
export async function installAddons(db: Knex, addons: readonly Addon[]): Promise<void> {
  const ordered = sort(
    addons,
    (addon) => addon.name,
    (addon) => addon.depends ?? []
  );
  const nextMenus = new Map<string, ModelMenuInfo>();
  for (const addon of ordered) {
    for (const menu of addon.menus ?? []) {
      if (nextMenus.has(menu.model)) throw new Error(`Duplicate addon menu model: ${menu.model}`);
      nextMenus.set(menu.model, {
        ...(menu.label ? { label: menu.label } : {}),
        group: menu.group,
        sequence: menu.sequence ?? 1000,
        developmentOnly: menu.developmentOnly ?? false,
      });
    }
  }
  const models = sort(
    ordered.flatMap((addon) => [...addon.models]),
    (model) => model.modelName,
    (model) =>
      Object.values(model.fields).flatMap((field) => {
        // Only belongsTo fields create foreign keys from this model's table.
        // hasMany references point the other way and must not create a cycle.
        if (field.kind !== 'belongsTo') return [];
        const targetModel = resolveTargetModel(field.target);
        return targetModel && targetModel.modelName !== model.modelName
          ? [targetModel.modelName]
          : [];
      })
  );
  if (new Set(models.map((model) => model.tableName)).size !== models.length)
    throw new Error('Duplicate addon table');
  const data = ordered.flatMap((addon) => [...(addon.data ?? [])]);
  for (const record of data) {
    if (!models.includes(record.model))
      throw new Error(`Seed model not installed: ${record.model.modelName}`);
  }
  await db.transaction(async (trx) => {
    // API and worker replicas can start together during a rolling deployment.
    // Serialize schema/seed installation per database before inspecting tables.
    if (db.client.config.client === 'pg') {
      await trx.raw('select pg_advisory_xact_lock(?, hashtext(?))', [
        1297564238,
        'moonwitness.addon.install',
      ]);
    }
    for (const model of models) await syncModel(trx, model);
    if (!(await trx.schema.hasTable('_orm_addons'))) {
      await trx.schema.createTable('_orm_addons', (table) => {
        table.string('name').primary();
        table.string('version').notNullable();
        table.timestamp('installed_at').notNullable().defaultTo(trx.fn.now());
        table.timestamp('upgraded_at').notNullable().defaultTo(trx.fn.now());
      });
    }
    for (const addon of ordered) {
      const installed = await trx<InstalledAddon>('_orm_addons')
        .where({ name: addon.name })
        .first();
      if (installed && compareVersions(addon.version, installed.version) < 0) {
        throw new Error(
          `Addon downgrade rejected for '${addon.name}': ${installed.version} -> ${addon.version}`
        );
      }
      if (installed && compareVersions(addon.version, installed.version) > 0) {
        await addon.upgrade?.[installed.version]?.(trx);
      }
    }
    for (const addon of ordered) await addon.setup?.(trx);
    await installData(trx, data);
    for (const addon of ordered) {
      await trx<InstalledAddon>('_orm_addons')
        .insert({ name: addon.name, version: addon.version })
        .onConflict('name')
        .merge({ version: addon.version, upgraded_at: trx.fn.now() });
    }
  });
  for (const model of models) {
    model.knex(db);
    Registry.register(model);
  }
  for (const addon of ordered) {
    for (const view of addon.views ?? []) {
      if (!models.some((model) => model.modelName === view.model))
        throw new Error(`View model not installed: ${view.model}`);
      registerView(view);
    }
  }
  modelMenus.clear();
  for (const [name, menu] of nextMenus) modelMenus.set(name, menu);
}
