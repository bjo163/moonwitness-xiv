import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { prepareApiRuntimeAssets } from './prepare-api-runtime-assets.mjs';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const installIndex = dockerfile.indexOf('pnpm install --frozen-lockfile');
const copiedWorkspaceManifests = new Set(
  [...dockerfile.matchAll(/^COPY ((?:apps|packages)\/[^\s]+\/package\.json) /gmu)].map(
    ([, manifestPath]) => manifestPath.replaceAll('\\', '/')
  )
);

test('production build copies every workspace manifest before frozen install', () => {
  assert.ok(installIndex >= 0, 'Dockerfile should install the frozen workspace lockfile');

  const missing = ['apps', 'packages'].flatMap((directory) =>
    readdirSync(directory)
      .filter((entry) => existsSync(path.join(directory, entry, 'package.json')))
      .map((entry) => `${directory}/${entry}/package.json`)
      .filter((manifestPath) => {
        const copyIndex = dockerfile.indexOf(`COPY ${manifestPath} `);
        return (
          copyIndex < 0 || copyIndex > installIndex || !copiedWorkspaceManifests.has(manifestPath)
        );
      })
  );

  assert.deepEqual(missing, []);
});

test('native SQLite dependency build installs its compiler toolchain only in the build stage', () => {
  const buildStage = dockerfile.slice(
    0,
    dockerfile.indexOf('\nFROM node:22-bookworm-slim AS runtime')
  );
  assert.match(buildStage, /apt-get install --yes --no-install-recommends python3 make g\+\+/u);
  assert.match(buildStage, /rm -rf \/var\/lib\/apt\/lists\/\*/u);
  assert.doesNotMatch(
    dockerfile.slice(dockerfile.indexOf('\nFROM node:22-bookworm-slim AS runtime')),
    /apt-get install/u
  );
});

test('runtime image applies current Debian security updates and removes apt indexes', () => {
  const runtimeStage = dockerfile.slice(
    dockerfile.indexOf('\nFROM node:22-bookworm-slim AS runtime'),
    dockerfile.indexOf('\nFROM build AS board-build')
  );

  assert.match(runtimeStage, /apt-get update[\s\S]*apt-get upgrade --yes/u);
  assert.match(runtimeStage, /rm -rf \/var\/lib\/apt\/lists\/\*/u);
});

test('production image uses legacy deployment for the non-injected workspace layout', () => {
  assert.match(dockerfile, /pnpm --filter @moonwitness\/api deploy --prod --legacy \/deploy\/api/u);
});

test('API runtime includes offline corpus data and exposes its explicit root', () => {
  const runtimeStage = dockerfile.slice(
    dockerfile.indexOf('\nFROM node:22-bookworm-slim AS runtime'),
    dockerfile.indexOf('\nFROM build AS board-build')
  );

  assert.match(runtimeStage, /COPY --from=build --chown=node:node \/workspace\/corpus \.\/corpus/u);
  assert.match(runtimeStage, /MOONWITNESS_CORPUS_ROOT=\/app\/corpus/u);
});

test('API deployment has an isolated stage so it cannot mutate the Board build workspace', () => {
  const buildStage = dockerfile.slice(0, dockerfile.indexOf('\nFROM build AS api-deploy'));
  const apiDeployStage = dockerfile.slice(
    dockerfile.indexOf('\nFROM build AS api-deploy'),
    dockerfile.indexOf('\nFROM node:22-bookworm-slim AS runtime')
  );
  const boardBuildStage = dockerfile.slice(dockerfile.indexOf('\nFROM build AS board-build'));

  assert.doesNotMatch(buildStage, /pnpm --filter @moonwitness\/api deploy/u);
  assert.match(
    apiDeployStage,
    /FROM build AS api-deploy[\s\S]*pnpm --filter @moonwitness\/api deploy/u
  );
  assert.match(dockerfile, /COPY --from=api-deploy --chown=node:node \/deploy\/api/u);
  assert.match(boardBuildStage, /FROM build AS board-build/u);
  assert.match(apiDeployStage, /node scripts\/prepare-api-runtime-assets\.mjs \/deploy\/api/u);
});

test('API deployment stages only the external JSON assets referenced by packaged workspace modules', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'moonwitness-runtime-assets-'));
  const repositoryRoot = path.join(temporaryRoot, 'source');
  const deployRoot = path.join(temporaryRoot, 'deploy');
  const sourcePackage = path.join(repositoryRoot, 'packages', 'research');
  const sourceDist = path.join(sourcePackage, 'dist');
  const sourceModule = path.join(sourceDist, 'assertion.js');
  const sourceSchema = path.join(repositoryRoot, 'ontology', 'core', 'assertion.schema.json');
  const deployedPackageStore = path.join(
    deployRoot,
    'node_modules',
    '.pnpm',
    '@moonwitness+research@file+packages+research',
    'node_modules',
    '@moonwitness',
    'research'
  );
  const deployedPackageLink = path.join(deployRoot, 'node_modules', '@moonwitness', 'research');

  try {
    await Promise.all([
      mkdir(sourceDist, { recursive: true }),
      mkdir(path.dirname(sourceSchema), { recursive: true }),
      mkdir(deployedPackageStore, { recursive: true }),
      mkdir(path.dirname(deployedPackageLink), { recursive: true }),
      mkdir(deployRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(sourcePackage, 'package.json'),
        JSON.stringify({ name: '@moonwitness/research' })
      ),
      writeFile(
        path.join(deployRoot, 'package.json'),
        JSON.stringify({ name: '@moonwitness/api' })
      ),
      writeFile(sourceSchema, JSON.stringify({ title: 'source-bound assertion schema' })),
      writeFile(
        sourceModule,
        "import schema from '../../../ontology/core/assertion.schema.json' with { type: 'json' };\nexport default schema;\n"
      ),
    ]);
    await symlink(deployedPackageStore, deployedPackageLink, 'junction');
    await mkdir(path.join(deployedPackageStore, 'dist'), { recursive: true });
    await writeFile(
      path.join(deployedPackageStore, 'dist', 'assertion.js'),
      await readFile(sourceModule, 'utf8')
    );

    const result = await prepareApiRuntimeAssets({
      root: repositoryRoot,
      deployDirectory: deployRoot,
    });
    const deployedModule = path.join(deployedPackageStore, 'dist', 'assertion.js');
    const loaded = await import(`${pathToFileURL(deployedModule).href}?fixture=runtime-assets`);

    assert.equal(result.copiedAssetCount, 1);
    assert.deepEqual(loaded.default, { title: 'source-bound assertion schema' });
    assert.equal(
      existsSync(
        path.resolve(deployedPackageStore, '..', '..', 'ontology', 'core', 'assertion.schema.json')
      ),
      true
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('API runtime asset staging rejects missing source JSON imports instead of building a broken image', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'moonwitness-runtime-assets-missing-'));
  const repositoryRoot = path.join(temporaryRoot, 'source');
  const deployRoot = path.join(temporaryRoot, 'deploy');
  const sourcePackage = path.join(repositoryRoot, 'packages', 'research');
  const sourceDist = path.join(sourcePackage, 'dist');
  const deployedPackage = path.join(deployRoot, 'node_modules', '@moonwitness', 'research');

  try {
    await Promise.all([
      mkdir(sourceDist, { recursive: true }),
      mkdir(path.join(deployedPackage, 'dist'), { recursive: true }),
      mkdir(deployRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(sourcePackage, 'package.json'),
        JSON.stringify({ name: '@moonwitness/research' })
      ),
      writeFile(
        path.join(deployRoot, 'package.json'),
        JSON.stringify({ name: '@moonwitness/api' })
      ),
      writeFile(
        path.join(sourceDist, 'assertion.js'),
        "import schema from '../../../ontology/core/missing.schema.json' with { type: 'json' };\nexport default schema;\n"
      ),
      writeFile(
        path.join(deployedPackage, 'dist', 'assertion.js'),
        "import schema from '../../../ontology/core/missing.schema.json' with { type: 'json' };\nexport default schema;\n"
      ),
    ]);

    await assert.rejects(
      prepareApiRuntimeAssets({ root: repositoryRoot, deployDirectory: deployRoot }),
      /ENOENT|missing\.schema\.json/u
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('API runtime asset staging rejects workspace package names that could escape deploy paths', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'moonwitness-runtime-assets-name-'));
  const repositoryRoot = path.join(temporaryRoot, 'source');
  const deployRoot = path.join(temporaryRoot, 'deploy');
  const sourcePackage = path.join(repositoryRoot, 'packages', 'research');

  try {
    await Promise.all([
      mkdir(sourcePackage, { recursive: true }),
      mkdir(deployRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(sourcePackage, 'package.json'),
        JSON.stringify({ name: '@moonwitness/../outside' })
      ),
      writeFile(
        path.join(deployRoot, 'package.json'),
        JSON.stringify({ name: '@moonwitness/api' })
      ),
    ]);

    await assert.rejects(
      prepareApiRuntimeAssets({ root: repositoryRoot, deployDirectory: deployRoot }),
      /Invalid workspace package name/u
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('API runtime asset staging rejects source JSON symlinks that resolve outside the repository', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'moonwitness-runtime-assets-symlink-'));
  const repositoryRoot = path.join(temporaryRoot, 'source');
  const deployRoot = path.join(temporaryRoot, 'deploy');
  const sourcePackage = path.join(repositoryRoot, 'packages', 'research');
  const sourceDist = path.join(sourcePackage, 'dist');
  const externalOntology = path.join(temporaryRoot, 'external-ontology');
  const deployedPackage = path.join(deployRoot, 'node_modules', '@moonwitness', 'research');
  const moduleSource = [
    "import schema from '../../../ontology/core/assertion.schema.json' with { type: 'json' };",
    'export default schema;',
    '',
  ].join('\n');

  try {
    await Promise.all([
      mkdir(sourceDist, { recursive: true }),
      mkdir(path.join(externalOntology, 'core'), { recursive: true }),
      mkdir(path.join(deployedPackage, 'dist'), { recursive: true }),
      mkdir(deployRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(sourcePackage, 'package.json'),
        JSON.stringify({ name: '@moonwitness/research' })
      ),
      writeFile(
        path.join(deployRoot, 'package.json'),
        JSON.stringify({ name: '@moonwitness/api' })
      ),
      writeFile(
        path.join(externalOntology, 'core', 'assertion.schema.json'),
        JSON.stringify({ title: 'external source' })
      ),
      writeFile(path.join(sourceDist, 'assertion.js'), moduleSource),
      writeFile(path.join(deployedPackage, 'dist', 'assertion.js'), moduleSource),
    ]);
    await symlink(
      externalOntology,
      path.join(repositoryRoot, 'ontology'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    await assert.rejects(
      prepareApiRuntimeAssets({ root: repositoryRoot, deployDirectory: deployRoot }),
      /resolves outside the repository/u
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
