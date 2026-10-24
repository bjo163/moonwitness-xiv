import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import prettier from 'prettier';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDirectory = path.join(rootDirectory, 'docs/architecture/diagrams');
const flowSourcePath = path.join(rootDirectory, 'scripts/architecture/flows.json');
const addonManifestPaths = [
  {
    entry: 'packages/orm-base/dist/index.js',
    sourceRoot: 'packages/orm-base/src',
    manifest: 'manifest.ts',
  },
  {
    entry: 'packages/auth/dist/index.js',
    sourceRoot: 'packages/auth/src',
    manifest: 'manifest.ts',
  },
  {
    entry: 'packages/jobs/dist/index.js',
    exportName: 'jobsManifest',
    sourceRoot: 'packages/jobs/src',
    manifest: 'models.ts',
  },
  {
    entry: 'packages/orm-notification/dist/index.js',
    sourceRoot: 'packages/orm-notification/src',
    manifest: 'manifest.ts',
  },
  {
    entry: 'packages/orm-storage/dist/index.js',
    sourceRoot: 'packages/orm-storage/src',
    exportName: 'storageManifest',
    manifest: 'index.ts',
  },
  {
    entry: 'packages/orm-workflow/dist/manifest.js',
    sourceRoot: 'packages/orm-workflow/src',
    manifest: 'manifest.ts',
  },
  {
    entry: 'packages/orm-request/dist/manifest.js',
    sourceRoot: 'packages/orm-request/src',
    manifest: 'manifest.ts',
  },
  {
    entry: 'packages/orm-organization/dist/manifest.js',
    sourceRoot: 'packages/orm-organization/src',
    manifest: 'manifest.ts',
  },
  {
    entry: 'packages/orm-integration/dist/manifest.js',
    sourceRoot: 'packages/orm-integration/src',
    manifest: 'manifest.ts',
  },
  {
    entry: 'packages/orm-knowledge/dist/manifest.js',
    sourceRoot: 'packages/orm-knowledge/src',
    manifest: 'manifest.ts',
  },
];

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeMermaid(value) {
  return String(value).replaceAll('"', '#quot;').replaceAll('\n', ' ');
}

export function hashSources(sources) {
  const hash = createHash('sha256');
  // Hash inputs must have the same order across Node/ICU versions. localeCompare
  // can collate paths differently between developer machines and CI runners.
  for (const source of [...sources].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )) {
    hash.update(source.path.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(source.contents.replace(/\r\n?/gu, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function hashWorkspaceGraph(graph) {
  return createHash('sha256').update(JSON.stringify(graph)).digest('hex');
}

function relationTarget(field) {
  if (!field.target) return undefined;
  const target =
    typeof field.target === 'function' && !('modelName' in field.target)
      ? field.target()
      : field.target;
  if (!target || typeof target !== 'function' || typeof target.modelName !== 'string') {
    throw new Error(`Invalid ORM relation target for field kind '${field.kind}'`);
  }
  return target.modelName;
}

export function createWorkspaceGraph(manifests) {
  const names = manifests.map(({ manifest }) => manifest.name);
  if (names.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new Error('Every workspace package manifest must declare a non-empty name');
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Workspace package names must be unique');
  }
  const packages = manifests.map(({ manifest, directory }) => ({
    name: manifest.name,
    kind: directory.replaceAll('\\', '/').startsWith('apps/') ? 'app' : 'package',
    version: manifest.version,
    manifest: directory.replaceAll('\\', '/'),
  }));
  const knownNames = new Set(packages.map(({ name }) => name));
  for (const { manifest } of manifests) {
    const dependencies = [
      manifest.dependencies,
      manifest.peerDependencies,
      manifest.devDependencies,
    ];
    for (const group of dependencies) {
      for (const [name, version] of Object.entries(group ?? {})) {
        if (String(version).startsWith('workspace:') && !knownNames.has(name)) {
          throw new Error(
            `Workspace dependency '${name}' from '${manifest.name}' has no workspace manifest`
          );
        }
      }
    }
  }
  const edges = [];
  for (const { manifest, directory } of manifests) {
    const dependencyKinds = [
      ['runtime', manifest.dependencies],
      ['peer', manifest.peerDependencies],
      ['development', manifest.devDependencies],
    ];
    for (const [kind, dependencies] of dependencyKinds) {
      for (const name of Object.keys(dependencies ?? {}).sort(compareText)) {
        if (!knownNames.has(name)) continue;
        edges.push({
          from: manifest.name,
          to: name,
          kind,
          manifest: directory.replaceAll('\\', '/'),
        });
      }
    }
  }
  edges.sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.kind, right.kind) ||
      compareText(left.to, right.to)
  );
  return { packages: packages.sort((left, right) => compareText(left.name, right.name)), edges };
}

export function createModelGraph(models) {
  const modelNames = new Set(models.map(({ modelName }) => modelName));
  const entities = models
    .map((model) => ({ name: model.modelName, table: model.tableName }))
    .sort((left, right) => compareText(left.name, right.name));
  const edges = [];
  for (const model of models) {
    for (const [name, field] of Object.entries(model.fields)) {
      if (field.kind !== 'belongsTo' && field.kind !== 'hasMany') continue;
      const target = relationTarget(field);
      if (!target || !modelNames.has(target)) {
        throw new Error(
          `Model relation target '${target ?? ''}' is absent from its addon manifest`
        );
      }
      edges.push({
        from: model.modelName,
        field: name,
        to: target,
        cardinality: field.kind === 'hasMany' ? '1:N' : field.unique === true ? '1:1' : 'N:1',
        kind: field.kind,
      });
    }
  }
  edges.sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.field, right.field) ||
      compareText(left.to, right.to)
  );
  return { entities, edges };
}

function svgDocument({ title, description, width, height, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="diagram-title diagram-description"><title id="diagram-title">${escapeXml(title)}</title><desc id="diagram-description">${escapeXml(description)}</desc><rect width="100%" height="100%" fill="#fbfaf6"/><text x="32" y="38" fill="#141414" font-family="Arial,sans-serif" font-size="22" font-weight="700">${escapeXml(title)}</text>${body}</svg>\n`;
}

function wrapText(value, maxCharacters) {
  const words = String(value).split(/\s+/u);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharacters && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function relationRowsSvg({ title, description, edges, leftHeader, middleHeader, rightHeader }) {
  const rowHeight = 34;
  const height = 86 + Math.max(edges.length, 1) * rowHeight;
  const header = `<rect x="20" y="54" width="1260" height="30" rx="4" fill="#17212b"/><text x="38" y="74" fill="#ffffff" font-family="Arial,sans-serif" font-size="13" font-weight="700">${escapeXml(leftHeader)}</text><text x="490" y="74" fill="#ffffff" font-family="Arial,sans-serif" font-size="13" font-weight="700">${escapeXml(middleHeader)}</text><text x="850" y="74" fill="#ffffff" font-family="Arial,sans-serif" font-size="13" font-weight="700">${escapeXml(rightHeader)}</text>`;
  const rows = edges.length
    ? edges
        .map((edge, index) => {
          const y = 85 + index * rowHeight;
          const fill = index % 2 === 0 ? '#ffffff' : '#f0efe9';
          const field = edge.field ? `${edge.field} · ${edge.cardinality}` : edge.kind;
          return `<g><rect x="20" y="${y}" width="1260" height="${rowHeight}" fill="${fill}"/><text x="38" y="${y + 22}" fill="#17212b" font-family="Arial,sans-serif" font-size="13">${escapeXml(edge.from)}</text><text x="490" y="${y + 22}" fill="#435466" font-family="Arial,sans-serif" font-size="13">${escapeXml(field)}</text><path d="M 700 ${y + 17} H 822" fill="none" stroke="#62758a" stroke-width="1.5" marker-end="url(#arrow)"/><text x="850" y="${y + 22}" fill="#17212b" font-family="Arial,sans-serif" font-size="13">${escapeXml(edge.to)}</text></g>`;
        })
        .join('')
    : '<text x="38" y="112" fill="#435466" font-family="Arial,sans-serif" font-size="14">No relationships were found in the current metadata.</text>';
  const body = `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="#62758a"/></marker></defs>${header}${rows}`;
  return svgDocument({ title, description, width: 1300, height, body });
}

export function renderWorkspaceSvg(graph) {
  const representedPackages = new Set(graph.edges.flatMap(({ from, to }) => [from, to]));
  const isolatedPackages = graph.packages
    .filter(({ name }) => !representedPackages.has(name))
    .map(({ name, kind }) => ({ from: name, kind: `isolated ${kind}`, to: '—' }));
  return relationRowsSvg({
    title: 'MoonWitness workspace dependency map',
    description: `${graph.packages.length} apps and packages with ${graph.edges.length} internal runtime, peer, and development dependencies.`,
    edges: [...graph.edges, ...isolatedPackages],
    leftHeader: 'Workspace app or package',
    middleHeader: 'Dependency type',
    rightHeader: 'Workspace dependency',
  });
}

export function renderModelSvg(graph) {
  const representedModels = new Set(graph.edges.flatMap(({ from, to }) => [from, to]));
  const isolatedModels = graph.entities
    .filter(({ name }) => !representedModels.has(name))
    .map(({ name }) => ({ from: name, field: '—', cardinality: 'no relations', to: '—' }));
  return relationRowsSvg({
    title: 'Core addon model relations',
    description: `${graph.entities.length} models and ${graph.edges.length} relations generated from the base, auth, jobs, and notification addon model field metadata.`,
    edges: [...graph.edges, ...isolatedModels],
    leftHeader: 'Source model',
    middleHeader: 'Relation field · cardinality',
    rightHeader: 'Target model',
  });
}

function mermaidWorkspace(graph) {
  const ids = new Map(graph.packages.map(({ name }, index) => [name, `pkg${index}`]));
  const lines = ['flowchart LR'];
  for (const item of graph.packages) {
    lines.push(`  ${ids.get(item.name)}["${escapeMermaid(item.name)}"]`);
  }
  for (const edge of graph.edges) {
    lines.push(`  ${ids.get(edge.from)} -->|${edge.kind}| ${ids.get(edge.to)}`);
  }
  return `${lines.join('\n')}\n`;
}

function mermaidModels(graph) {
  const ids = new Map(graph.entities.map(({ name }, index) => [name, `model${index}`]));
  const lines = ['flowchart LR'];
  for (const entity of graph.entities)
    lines.push(`  ${ids.get(entity.name)}["${escapeMermaid(entity.name)}"]`);
  for (const edge of graph.edges) {
    lines.push(
      `  ${ids.get(edge.from)} -->|${escapeMermaid(`${edge.field} ${edge.cardinality}`)}| ${ids.get(edge.to)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

export function validateFlows(flows) {
  if (flows.schemaVersion !== 1 || !Array.isArray(flows.flows)) {
    throw new Error('Unsupported curated architecture flow format');
  }
  const ids = new Set();
  for (const flow of flows.flows) {
    if (!/^[a-z][a-z0-9-]*$/u.test(flow.id)) {
      throw new Error(`Invalid Mermaid-safe architecture flow id '${flow.id}'`);
    }
    if (ids.has(flow.id)) throw new Error(`Duplicate architecture flow '${flow.id}'`);
    ids.add(flow.id);
    const participants = new Set(flow.participants.map(({ id }) => id));
    if (participants.size !== flow.participants.length) {
      throw new Error(`Flow '${flow.id}' contains duplicate participants`);
    }
    if ([...participants].some((id) => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(id))) {
      throw new Error(`Flow '${flow.id}' contains an invalid Mermaid participant id`);
    }
    for (const message of flow.messages) {
      if (!participants.has(message.from) || !participants.has(message.to)) {
        throw new Error(`Flow '${flow.id}' references an unknown participant`);
      }
      if (message.from === message.to)
        throw new Error(`Flow '${flow.id}' contains an unsupported self-message`);
    }
  }
  return flows.flows;
}

function renderMermaidFlow(flow) {
  const lines = ['sequenceDiagram'];
  for (const participant of flow.participants) {
    lines.push(`  participant ${participant.id} as ${escapeMermaid(participant.label)}`);
  }
  for (const message of flow.messages) {
    const arrow = message.kind === 'return' ? '-->>' : '->>';
    lines.push(`  ${message.from}${arrow}${message.to}: ${escapeMermaid(message.label)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderSequenceSvg(flow) {
  const width = 1320;
  const sideMargin = 140;
  const step =
    flow.participants.length > 1 ? (width - sideMargin * 2) / (flow.participants.length - 1) : 0;
  const positions = new Map(
    flow.participants.map((participant, index) => [participant.id, sideMargin + step * index])
  );
  const wrapped = flow.messages.map((message) => {
    const distance = Math.abs(positions.get(message.to) - positions.get(message.from));
    const maxCharacters = Math.max(22, Math.floor((distance - 28) / 7));
    const lines = wrapText(message.label, maxCharacters);
    return { message, lines, height: Math.max(54, 27 + lines.length * 15) };
  });
  const contentTop = 116;
  const height = contentTop + wrapped.reduce((total, row) => total + row.height, 0) + 28;
  const participantBoxes = flow.participants
    .map((participant) => {
      const x = positions.get(participant.id);
      const lines = wrapText(participant.label, 22);
      const boxY = 70;
      const label = lines
        .map(
          (line, index) =>
            `<text x="${x}" y="${boxY + 22 + index * 16}" text-anchor="middle" fill="#17212b" font-family="Arial,sans-serif" font-size="13" font-weight="700">${escapeXml(line)}</text>`
        )
        .join('');
      return `<g><rect x="${x - 88}" y="${boxY}" width="176" height="48" rx="6" fill="#e8eef3" stroke="#62758a"/><line x1="${x}" y1="${boxY + 48}" x2="${x}" y2="${height - 18}" stroke="#a6b2bd" stroke-dasharray="5 5"/>${label}</g>`;
    })
    .join('');
  let cursor = contentTop;
  const messages = wrapped
    .map(({ message, lines, height: rowHeight }) => {
      const y = cursor;
      cursor += rowHeight;
      const from = positions.get(message.from);
      const to = positions.get(message.to);
      const start = Math.min(from, to) + 92;
      const end = Math.max(from, to) - 92;
      const textCenter = (from + to) / 2;
      const label = lines
        .map(
          (line, index) =>
            `<text x="${textCenter}" y="${y + 15 + index * 15}" text-anchor="middle" fill="#243746" font-family="Arial,sans-serif" font-size="12">${escapeXml(line)}</text>`
        )
        .join('');
      const lineY = y + rowHeight - 13;
      const stroke = message.kind === 'return' ? ' stroke-dasharray="5 4"' : '';
      const direction = from < to ? 'right' : 'left';
      const marker =
        direction === 'right'
          ? 'marker-end="url(#arrow-right)"'
          : 'marker-start="url(#arrow-left)"';
      return `<g>${label}<line x1="${start}" y1="${lineY}" x2="${end}" y2="${lineY}" stroke="#435466" stroke-width="1.5"${stroke} ${marker}/></g>`;
    })
    .join('');
  const body = `<defs><marker id="arrow-right" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="#435466"/></marker><marker id="arrow-left" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto"><path d="M 8 0 L 0 4 L 8 8 z" fill="#435466"/></marker></defs>${participantBoxes}${messages}`;
  return svgDocument({ title: flow.title, description: flow.description, width, height, body });
}

async function collectManifests() {
  const manifests = [];
  const sources = [];
  for (const workspaceRoot of ['apps', 'packages']) {
    const root = path.join(rootDirectory, workspaceRoot);
    const directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareText);
    for (const name of directories) {
      const relativePath = `${workspaceRoot}/${name}/package.json`;
      let contents;
      try {
        contents = await readFile(path.join(rootDirectory, relativePath), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      sources.push({ path: relativePath, contents });
      manifests.push({ directory: `${workspaceRoot}/${name}`, manifest: JSON.parse(contents) });
    }
  }
  return { manifests, sources };
}

async function createArtifacts({
  packageGraph,
  modelGraph,
  packageSourceHash,
  modelSourceHash,
  flows,
}) {
  const packageMetadata = {
    schemaVersion: 1,
    generatedFrom: 'apps/*/package.json and packages/*/package.json',
    sourceSha256: packageSourceHash,
    packages: packageGraph.packages,
    dependencies: packageGraph.edges,
  };
  const modelMetadata = {
    schemaVersion: 1,
    addons: ['auth', 'base', 'jobs', 'notification'],
    generatedFrom: 'core addon manifests and model field metadata; no seed values included',
    sourceSha256: modelSourceHash,
    models: modelGraph.entities,
    relations: modelGraph.edges,
  };
  const artifacts = new Map([
    [
      'workspace-dependencies.json',
      await prettier.format(`${JSON.stringify(packageMetadata, null, 2)}\n`, { parser: 'json' }),
    ],
    ['workspace-dependencies.mmd', mermaidWorkspace(packageGraph)],
    ['workspace-dependencies.svg', renderWorkspaceSvg(packageGraph)],
    [
      'core-model-relations.json',
      await prettier.format(`${JSON.stringify(modelMetadata, null, 2)}\n`, { parser: 'json' }),
    ],
    ['core-model-relations.mmd', mermaidModels(modelGraph)],
    ['core-model-relations.svg', renderModelSvg(modelGraph)],
  ]);
  for (const flow of flows) {
    artifacts.set(`${flow.id}.mmd`, renderMermaidFlow(flow));
    artifacts.set(`${flow.id}.svg`, renderSequenceSvg(flow));
  }
  return artifacts;
}

export async function generateArchitectureDiagrams({ check = false } = {}) {
  const [{ manifests: packageManifests }, addonModules, flowSource] = await Promise.all([
    collectManifests(),
    Promise.all(
      addonManifestPaths.map(
        ({ entry }) => import(pathToFileURL(path.join(rootDirectory, entry)).href)
      )
    ),
    readFile(flowSourcePath, 'utf8').then(JSON.parse),
  ]);
  const modelSourcePaths = [];
  for (const { sourceRoot, manifest } of addonManifestPaths) {
    modelSourcePaths.push(`${sourceRoot}/${manifest}`);
    const modelRoot = path.join(rootDirectory, sourceRoot, 'models');
    try {
      modelSourcePaths.push(
        ...(await readdir(modelRoot))
          .filter((name) => name.endsWith('.ts'))
          .map((name) => `${sourceRoot}/models/${name}`)
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const modelSources = await Promise.all(
    modelSourcePaths.map(async (relativePath) => ({
      path: relativePath,
      contents: await readFile(path.join(rootDirectory, relativePath), 'utf8'),
    }))
  );
  const packageGraph = createWorkspaceGraph(packageManifests);
  const modelGraph = createModelGraph(
    addonModules.flatMap(
      (module, index) => module[addonManifestPaths[index].exportName ?? 'manifest'].models
    )
  );
  const artifacts = await createArtifacts({
    packageGraph,
    modelGraph,
    packageSourceHash: hashWorkspaceGraph(packageGraph),
    modelSourceHash: hashSources(modelSources),
    flows: validateFlows(flowSource),
  });
  const differences = [];
  for (const [name, contents] of artifacts) {
    const target = path.join(outputDirectory, name);
    let current;
    try {
      current = await readFile(target, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === contents) continue;
    differences.push(name);
    if (!check) {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(target, contents, 'utf8');
    }
  }
  if (check && differences.length) {
    throw new Error(
      `Architecture diagrams are stale: ${differences.join(', ')}. Run pnpm architecture:generate.`
    );
  }
  return {
    artifactCount: artifacts.size,
    packageCount: packageGraph.packages.length,
    modelCount: modelGraph.entities.length,
    relationCount: modelGraph.edges.length,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  generateArchitectureDiagrams({ check })
    .then((result) => {
      const action = check ? 'Verified' : 'Generated';
      process.stdout.write(
        `${action} ${result.artifactCount} architecture artifacts from ${result.packageCount} packages, ${result.modelCount} core addon models, and ${result.relationCount} model relations.\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
