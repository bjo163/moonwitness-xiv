import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import prettier from 'prettier';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputs = new Map([
  ['docs/guide/reference/generated-platform.json', renderPlatformJson],
  ['docs/guide/reference/generated-platform.md', renderPlatformMarkdown],
  ['docs/guide/reference/generated-models.md', renderModelsMarkdown],
  ['docs/guide/reference/generated-api.md', renderApiMarkdown],
]);

const compare = (left, right) => left.localeCompare(right, 'en');

function safeDefault(field) {
  return field.default === undefined ? undefined : '[redacted]';
}

function resolveTarget(target) {
  if (!target) return undefined;
  const model = typeof target === 'function' && !('modelName' in target) ? target() : target;
  return typeof model?.modelName === 'string' ? model.modelName : undefined;
}

export function normalizeModel(model) {
  if (!model || typeof model.modelName !== 'string' || typeof model.tableName !== 'string') {
    throw new Error('Model metadata must declare modelName and tableName');
  }
  if (!model.fields || typeof model.fields !== 'object' || Array.isArray(model.fields)) {
    throw new Error(`Model '${model.modelName}' has invalid fields metadata`);
  }
  const fields = Object.entries(model.fields)
    .sort(([left], [right]) => compare(left, right))
    .map(([name, field]) => {
      const validKinds = new Set([
        'string',
        'text',
        'integer',
        'boolean',
        'enum',
        'belongsTo',
        'hasMany',
        'password',
      ]);
      if (!field || typeof field !== 'object' || !validKinds.has(field.kind)) {
        throw new Error(`Unknown field kind for '${model.modelName}.${name}'`);
      }
      const relation = field.kind === 'belongsTo' || field.kind === 'hasMany';
      const target = resolveTarget(field.target);
      if (relation && !target) {
        throw new Error(`Relation '${model.modelName}.${name}' has no valid target model`);
      }
      return {
        name,
        kind: field.kind,
        column: field.kind === 'belongsTo' ? `${name}_id` : name,
        declaredRequired: field.required === true,
        required: field.required === true && field.default === undefined,
        unique: field.unique === true,
        optional: !(field.required === true && field.default === undefined),
        hasDefault: field.default !== undefined,
        ...(safeDefault(field) ? { default: '[redacted]' } : {}),
        ...(field.values ? { values: [...field.values].sort(compare) } : {}),
        ...(target ? { relation: target } : {}),
        ...(field.foreignKey ? { foreignKey: field.foreignKey } : {}),
      };
    });
  return {
    name: model.modelName,
    table: model.tableName,
    fields,
    uniqueConstraints: [...(model.uniqueConstraints ?? [])]
      .map((constraint) => [...constraint].sort(compare))
      .sort((left, right) => compare(left.join(','), right.join(','))),
  };
}

export function validateModelCatalog(models) {
  const names = new Set(models.map((model) => model.name));
  if (names.size !== models.length) throw new Error('Duplicate model name in reference catalog');
  const tables = new Set(models.map((model) => model.table));
  if (tables.size !== models.length) throw new Error('Duplicate table name in reference catalog');
  for (const model of models) {
    for (const field of model.fields) {
      if (field.relation && !names.has(field.relation)) {
        throw new Error(
          `Unknown relation target '${field.relation}' on '${model.name}.${field.name}'`
        );
      }
    }
  }
}

export function findStaleGeneratedPaths(actual, expected) {
  const paths = new Set([...actual.keys(), ...expected.keys()]);
  return [...paths].filter((file) => actual.get(file) !== expected.get(file)).sort(compare);
}

export function assertGeneratedOutputsCurrent(actual, expected) {
  const stalePaths = findStaleGeneratedPaths(actual, expected);
  if (stalePaths.length > 0) {
    throw new Error(
      `Generated references are stale; run pnpm docs:generate:\n${stalePaths.map((file) => `- ${file}`).join('\n')}`
    );
  }
}

function routeLiteral(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

// Fastify plugins receive the instance as their first parameter; route files name it either
// `fastify` or an alias, and an alias must not silently drop that file from the reference.
const routeReceivers = new Set(['fastify', 'app', 'server']);

export function extractRoutes(source, fileName = 'routes.ts') {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (file.parseDiagnostics.length > 0) {
    throw new Error(`Could not parse route source '${fileName}'`);
  }
  const routes = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text.toUpperCase();
      const receiver = node.expression.expression;
      if (
        ts.isIdentifier(receiver) &&
        routeReceivers.has(receiver.text) &&
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)
      ) {
        const route = routeLiteral(node.arguments[0]);
        if (route === undefined || !route.startsWith('/')) {
          throw new Error(`Route '${method}' in '${fileName}' must use a static absolute path`);
        }
        routes.push({ method, path: route });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const keys = routes.map((route) => `${route.method} ${route.path}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Duplicate static route declaration in '${fileName}'`);
  }
  return routes.sort(
    (left, right) => compare(left.path, right.path) || compare(left.method, right.method)
  );
}

function envNames(sources, example) {
  const names = new Set();
  for (const { path: sourcePath, source } of sources) {
    const file = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    if (file.parseDiagnostics.length > 0) {
      throw new Error(`Could not parse environment source '${sourcePath}'`);
    }
    function visit(node) {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === 'process.env') {
        names.add(node.name.text);
      }
      if (ts.isElementAccessExpression(node) && node.expression.getText(file) === 'process.env') {
        const key = routeLiteral(node.argumentExpression);
        if (key) names.add(key);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  const examples = new Map(
    example.split(/\r?\n/u).flatMap((line) => {
      const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/u.exec(line);
      return match?.[1] ? [[match[1], match[2]?.trim() ?? '']] : [];
    })
  );
  const exampleNames = new Set(examples.keys());
  return [...new Set([...names, ...exampleNames])].sort(compare).map((name) => ({
    name,
    configuredInExample: exampleNames.has(name),
    secret: /PASSWORD|TOKEN|SECRET|DATABASE_URL|CREDENTIAL|KEY/u.test(name),
    valueType: inferEnvironmentType(name, examples.get(name)),
  }));
}

function inferEnvironmentType(name, exampleValue) {
  if (/PASSWORD|TOKEN|SECRET|CREDENTIAL|KEY/u.test(name)) return 'secret';
  if (name === 'DATABASE_URL' || name === 'POSTGRES_TEST_URL') return 'url';
  if (exampleValue !== undefined && /^(?:true|false)$/iu.test(exampleValue)) return 'boolean';
  if (exampleValue !== undefined && /^-?\d+$/u.test(exampleValue)) return 'integer';
  if (/(?:PORT|_TTL_SECONDS|_RATE_MAX|_TIMEOUT_MS|_POOL_(?:MIN|MAX)|_BYTES)$/u.test(name))
    return 'integer';
  if (/^(?:LOG_TO_FILE|LOG_PRETTY)$/u.test(name)) return 'boolean';
  return 'string';
}

async function filesUnder(directory, extension) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(relativePath, extension)));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(relativePath);
  }
  return files.sort(compare);
}

export function fingerprintReferenceMetadata(metadata) {
  const { generatedFromSha256: _sourceFingerprint, ...renderedMetadata } = metadata;
  return createHash('sha256').update(JSON.stringify(renderedMetadata)).digest('hex');
}

export async function collectReferenceMetadata() {
  const packageDirs = [];
  for (const group of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, group), { withFileTypes: true })) {
      if (entry.isDirectory()) packageDirs.push(`${group}/${entry.name}`);
    }
  }
  packageDirs.sort(compare);
  const packages = [];
  const scripts = {};
  for (const directory of packageDirs) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const localScripts = Object.fromEntries(
      Object.entries(manifest.scripts ?? {}).sort(([a], [b]) => compare(a, b))
    );
    packages.push({
      name: manifest.name,
      version: manifest.version,
      directory: directory.replaceAll('\\', '/'),
      scripts: Object.keys(localScripts),
    });
    if (Object.keys(localScripts).length) scripts[manifest.name] = localScripts;
  }

  const basePath = path.join(root, 'packages/orm-base/dist/manifest.js');
  const authPath = path.join(root, 'packages/auth/dist/manifest.js');
  const jobsPath = path.join(root, 'packages/jobs/dist/models.js');
  const notificationPath = path.join(root, 'packages/orm-notification/dist/manifest.js');
  const storagePath = path.join(root, 'packages/orm-storage/dist/index.js');
  const workflowPath = path.join(root, 'packages/orm-workflow/dist/manifest.js');
  const requestPath = path.join(root, 'packages/orm-request/dist/manifest.js');
  const organizationPath = path.join(root, 'packages/orm-organization/dist/manifest.js');
  const integrationPath = path.join(root, 'packages/orm-integration/dist/manifest.js');
  const witnessPath = path.join(root, 'packages/orm-knowledge/dist/manifest.js');
  const [
    { manifest: base },
    { manifest: auth },
    { jobsManifest: jobs },
    { manifest: notification },
    { storageManifest },
    { manifest: workflow },
    { manifest: request },
    { manifest: organization },
    { manifest: integration },
    { manifest: witness },
  ] = await Promise.all([
    import(pathToFileURL(basePath).href),
    import(pathToFileURL(authPath).href),
    import(pathToFileURL(jobsPath).href),
    import(pathToFileURL(notificationPath).href),
    import(pathToFileURL(storagePath).href),
    import(pathToFileURL(workflowPath).href),
    import(pathToFileURL(requestPath).href),
    import(pathToFileURL(organizationPath).href),
    import(pathToFileURL(integrationPath).href),
    import(pathToFileURL(witnessPath).href),
  ]);
  const addons = [
    base,
    auth,
    jobs,
    notification,
    storageManifest,
    workflow,
    request,
    organization,
    integration,
    witness,
  ]
    .sort((left, right) => compare(left.name, right.name))
    .map((addon) => {
      const models = addon.models
        .map(normalizeModel)
        .sort((left, right) => compare(left.name, right.name));
      return {
        name: addon.name,
        version: addon.version,
        depends: [...(addon.depends ?? [])].sort(compare),
        models,
        menus: [...(addon.menus ?? [])]
          .map((menu) => ({
            model: menu.model,
            label: menu.label ?? menu.model,
            group: menu.group,
            sequence: menu.sequence ?? 1000,
            developmentOnly: menu.developmentOnly ?? false,
          }))
          .sort((left, right) => compare(left.model, right.model)),
        views: [...(addon.views ?? [])].map(({ model }) => model).sort(compare),
        seeds: Object.fromEntries(
          [...(addon.data ?? [])].reduce(
            (counts, item) =>
              counts.set(item.model.modelName, (counts.get(item.model.modelName) ?? 0) + 1),
            new Map()
          )
        ),
        accessRules: [...(addon.data ?? [])]
          .filter(({ model }) => model.modelName === 'base.model_access')
          .map(({ values }) => {
            const group = values.group;
            if (
              !group ||
              typeof group !== 'object' ||
              !('$ref' in group) ||
              typeof group.$ref !== 'string'
            ) {
              throw new Error('Access seed must reference a declared access group');
            }
            if (typeof values.model_name !== 'string')
              throw new Error('Access seed has no model name');
            return {
              group: group.$ref,
              model: values.model_name,
              read: values.read === true,
              create: values.create === true,
              write: values.write === true,
              unlink: values.unlink === true,
            };
          })
          .sort((left, right) =>
            compare(`${left.group}.${left.model}`, `${right.group}.${right.model}`)
          ),
      };
    });
  const addonNames = new Set(addons.map((addon) => addon.name));
  const installedModelNames = new Set(
    addons.flatMap((addon) => addon.models.map((model) => model.name))
  );
  for (const addon of addons) {
    for (const dependency of addon.depends) {
      if (!addonNames.has(dependency)) {
        throw new Error(`Addon '${addon.name}' depends on unknown addon '${dependency}'`);
      }
    }
    const modelNames = new Set(addon.models.map((model) => model.name));
    for (const menu of addon.menus) {
      if (!modelNames.has(menu.model))
        throw new Error(`Menu references unknown model '${menu.model}'`);
    }
    for (const model of addon.views) {
      if (!modelNames.has(model)) throw new Error(`View references unknown model '${model}'`);
    }
    for (const modelName of Object.keys(addon.seeds)) {
      if (!installedModelNames.has(modelName))
        throw new Error(`Seed references unknown model '${modelName}'`);
    }
  }
  validateModelCatalog(addons.flatMap((addon) => addon.models));

  const envSourcePaths = [
    ...(await filesUnder('apps/api/src', '.ts')),
    ...(await filesUnder('packages/jobs/src', '.ts')),
    ...(await filesUnder('packages/orm-notification/src', '.ts')),
    ...(await filesUnder('packages/orm-storage/src', '.ts')),
    ...(await filesUnder('packages/orm-workflow/src', '.ts')),
    ...(await filesUnder('packages/orm-request/src', '.ts')),
    ...(await filesUnder('packages/orm-organization/src', '.ts')),
    ...(await filesUnder('packages/orm-integration/src', '.ts')),
    ...(await filesUnder('packages/orm-knowledge/src', '.ts')),
  ].sort(compare);
  const envSources = await Promise.all(
    envSourcePaths.map(async (file) => ({
      path: file,
      source: await readFile(path.join(root, file), 'utf8'),
    }))
  );
  const routePaths = await filesUnder('apps/api/src/routes', '.ts');
  const routeSources = await Promise.all(
    routePaths.map(async (file) => ({
      path: file,
      source: await readFile(path.join(root, file), 'utf8'),
    }))
  );
  const routes = routeSources
    .flatMap(({ source, path: file }) => extractRoutes(source, file))
    .sort((left, right) => compare(left.path, right.path) || compare(left.method, right.method));
  const routeKeys = routes.map(({ method, path: route }) => `${method} ${route}`);
  if (new Set(routeKeys).size !== routeKeys.length)
    throw new Error('Duplicate API route declaration found');

  const example = await readFile(path.join(root, '.env.example'), 'utf8');
  const env = envNames(envSources, example);
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  scripts.root = Object.fromEntries(
    Object.entries(rootManifest.scripts ?? {}).sort(([left], [right]) => compare(left, right))
  );
  const metadata = {
    schemaVersion: 1,
    rootVersion: rootManifest.version,
    safety: {
      applicationStarted: false,
      databaseConnected: false,
      realEnvironmentLoaded: false,
      seedValuesIncluded: false,
      defaultsIncluded: false,
    },
    packages,
    scripts,
    environment: env,
    addons,
    routes,
  };
  return { ...metadata, generatedFromSha256: fingerprintReferenceMetadata(metadata) };
}

function renderPlatformJson(metadata) {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function renderPlatformMarkdown(metadata) {
  return [
    '# Generated platform reference',
    '',
    `Source fingerprint: \`${metadata.generatedFromSha256}\`. This reference contains package names, script names and environment variable names only; it does not contain local environment values.`,
    '',
    '## Workspace packages and apps',
    '',
    '| Name | Kind | Version | Scripts |',
    '| --- | --- | --- | --- |',
    ...metadata.packages.map(
      (item) =>
        `| \`${item.name}\` | ${item.directory.startsWith('apps/') ? 'App' : 'Package'} | ${item.version} | ${item.scripts.map((script) => `\`${script}\``).join(', ') || '—'} |`
    ),
    '',
    '## Environment variable names',
    '',
    '| Name | Value category | Present in `.env.example` | Sensitive value redacted |',
    '| --- | --- | --- | --- |',
    ...metadata.environment.map(
      (item) =>
        `| \`${item.name}\` | ${item.valueType} | ${item.configuredInExample ? 'Yes' : 'No'} | ${item.secret ? 'Yes' : 'No'} |`
    ),
    '',
    'The generator reads only `.env.example` and the names referenced by the typed config source. It never reads `.env` and does not emit values or defaults.',
    '',
    'Value categories are inferred from variable names and example syntax; requiredness and validation limits remain defined by the source configuration.',
    '',
    '## Root commands',
    '',
    ...Object.keys(metadata.scripts.root ?? {}).map((name) => `- \`pnpm ${name}\``),
    '',
  ].join('\n');
}

function renderModelsMarkdown(metadata) {
  const lines = [
    '# Generated model and addon reference',
    '',
    `Source fingerprint: \`${metadata.generatedFromSha256}\`. Seed values and field defaults are intentionally omitted.`,
    '',
  ];
  for (const addon of metadata.addons) {
    lines.push(
      `## Addon \`${addon.name}\``,
      '',
      `Version: \`${addon.version}\`; dependencies: ${addon.depends.map((name) => `\`${name}\``).join(', ') || 'none'}.`,
      '',
      `Models: ${addon.models.length}; declared views: ${addon.views.length}; menu entries: ${addon.menus.length}; seed rows: ${Object.values(addon.seeds).reduce((total, count) => total + count, 0)}.`,
      ''
    );
    lines.push(
      '| Model | Table | Field | Kind | Required | Optional | Default | Relation |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |'
    );
    for (const model of addon.models) {
      for (const field of model.fields) {
        lines.push(
          `| \`${model.name}\` | \`${model.table}\` | \`${field.name}\` | ${field.kind} | ${field.required ? 'Yes' : 'No'} | ${field.optional ? 'Yes' : 'No'} | ${field.hasDefault ? '[redacted]' : 'No'} | ${field.relation ? `\`${field.relation}\`` : '—'} |`
        );
      }
    }
    lines.push(
      '',
      '### Menus and seed coverage',
      '',
      '| Menu model | Label | Group | Sequence | Visibility |',
      '| --- | --- | --- | ---: | --- |',
      ...addon.menus.map(
        (menu) =>
          `| \`${menu.model}\` | ${menu.label} | ${menu.group} | ${menu.sequence} | ${menu.developmentOnly ? 'Development mode' : 'Standard'} |`
      ),
      '',
      ...Object.entries(addon.seeds)
        .sort(([a], [b]) => compare(a, b))
        .map(
          ([model, count]) =>
            `- Seed coverage: \`${model}\` has ${count} declared seed row(s); seed values are not included.`
        ),
      ''
    );
    if (addon.accessRules.length) {
      lines.push(
        '### Seeded model access rules',
        '',
        '| Group reference | Model | Read | Create | Write | Delete |',
        '| --- | --- | --- | --- | --- | --- |',
        ...addon.accessRules.map(
          (rule) =>
            `| \`${rule.group}\` | \`${rule.model}\` | ${rule.read ? 'Yes' : 'No'} | ${rule.create ? 'Yes' : 'No'} | ${rule.write ? 'Yes' : 'No'} | ${rule.unlink ? 'Yes' : 'No'} |`
        ),
        ''
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderApiMarkdown(metadata) {
  const lines = [
    '# Generated API route reference',
    '',
    `Extracted from literal Fastify route declarations. Source fingerprint: \`${metadata.generatedFromSha256}\`. Generic handler request payloads are not inferred where the source does not declare a static schema.`,
    '',
    '| Method | Path |',
    '| --- | --- |',
  ];
  for (const route of metadata.routes) lines.push(`| ${route.method} | \`${route.path}\` |`);
  return `${lines.join('\n')}\n`;
}

export async function generateReference({ check = false } = {}) {
  const metadata = await collectReferenceMetadata();
  const temporaryRoot = check
    ? await mkdtemp(path.join(tmpdir(), 'moonwitness-docs-check-'))
    : undefined;
  const expectedOutputs = new Map();
  const actualOutputs = new Map();
  try {
    for (const [relativePath, render] of outputs) {
      const destination = path.join(root, relativePath);
      const options = await prettier.resolveConfig(destination);
      const expected = await prettier.format(render(metadata), {
        ...options,
        filepath: destination,
      });
      if (check && temporaryRoot) {
        const temporaryPath = path.join(temporaryRoot, relativePath);
        await mkdir(path.dirname(temporaryPath), { recursive: true });
        await writeFile(temporaryPath, expected);
        let actual = '';
        try {
          actual = await readFile(destination, 'utf8');
        } catch {
          // A missing generated file is reported as stale below.
        }
        const rendered = await readFile(temporaryPath, 'utf8');
        actualOutputs.set(relativePath, actual);
        expectedOutputs.set(relativePath, rendered);
      } else {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, expected);
      }
    }
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
  if (check) assertGeneratedOutputsCurrent(actualOutputs, expectedOutputs);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  generateReference({ check: process.argv.includes('--check') }).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Documentation reference generation failed'}\n`
    );
    process.exitCode = 1;
  });
}
