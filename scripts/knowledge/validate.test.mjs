import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const cli = path.join(scriptDirectory, 'validate.mjs');
const fixture = path.join(repositoryRoot, 'packages/knowledge/tests/fixtures/validator-dataset');

async function withFreshDataset(run) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'moonwitness-knowledge-validator-'));
  const dataset = path.join(temporaryRoot, 'dataset');
  await cp(fixture, dataset, { recursive: true });
  try {
    await run(dataset);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function invoke(dataset, nodeFlags = [], cliFlags = []) {
  return spawnSync(process.execPath, [...nodeFlags, cli, dataset, ...cliFlags], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

test('validates a fresh filesystem fixture with canonical records, aliases, rights, and provenance', async () => {
  await withFreshDataset((dataset) => {
    const result = invoke(dataset, [], ['--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true);
    assert.deepEqual(report.counts, {
      records: 6,
      aliases: 1,
      sourceArtifacts: 1,
      provenanceActivities: 1,
    });
  });
});

test('fails with a nonzero exit for record kind and canonical ID mismatch', async () => {
  await withFreshDataset(async (dataset) => {
    const recordPath = path.join(dataset, 'records/edition.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.id = 'mw:concept:synthetic-edition';
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /record kind Edition does not match canonical ID kind Concept/);
  });
});

test('fails closed for dangling aliases and source edition references', async () => {
  await withFreshDataset(async (dataset) => {
    const aliasesPath = path.join(dataset, 'aliases.json');
    const aliases = JSON.parse(await readFile(aliasesPath, 'utf8'));
    aliases[0].targetId = 'mw:concept:missing-target';
    await writeFile(aliasesPath, `${JSON.stringify(aliases, null, 2)}\n`);
    const manifestPath = path.join(dataset, 'source-artifacts/edition.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.edition_id = 'mw:edition:missing-edition';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dangling-alias/);
    assert.match(result.stderr, /edition record does not resolve/);
  });
});

test('fails closed for unresolved full-dataset provenance references', async () => {
  await withFreshDataset(async (dataset) => {
    await rm(path.join(dataset, 'records/agent.json'));
    await rm(path.join(dataset, 'records/activity.json'));

    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /provenance activity must resolve to a ProvenanceActivity record/);
    assert.match(result.stderr, /provenance reference does not resolve in records\//);
  });
});

test('rejects alias collisions and duplicate canonical record IDs', async () => {
  await withFreshDataset(async (dataset) => {
    const editionPath = path.join(dataset, 'records/edition.json');
    await cp(editionPath, path.join(dataset, 'records/duplicate-edition.json'));
    const aliasesPath = path.join(dataset, 'aliases.json');
    const aliases = JSON.parse(await readFile(aliasesPath, 'utf8'));
    aliases.push({ ...aliases[0], targetId: 'mw:edition:missing-target' });
    await writeFile(aliasesPath, `${JSON.stringify(aliases, null, 2)}\n`);

    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicateId/);
    assert.match(result.stderr, /aliasConflict/);
  });
});

test('rejects provenance metadata that contradicts the actual record derivation', async () => {
  await withFreshDataset(async (dataset) => {
    const filename = path.join(dataset, 'records/assertion.json');
    const record = JSON.parse(await readFile(filename, 'utf8'));
    record.derivation.method_version = 'different-version';
    await writeFile(filename, JSON.stringify(record));
    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /methodMismatch/);
  });
});

test('rejects differing derivation inputs even when both graphs are independently valid', async () => {
  await withFreshDataset(async (dataset) => {
    const filename = path.join(dataset, 'records/assertion.json');
    const record = JSON.parse(await readFile(filename, 'utf8'));
    record.derivation.input_ids = ['mw:artifact:synthetic-artifact'];
    await writeFile(filename, JSON.stringify(record));
    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /derivationMismatch/);
  });
});

test('rejects malformed alias rows even when their target is never otherwise referenced', async () => {
  await withFreshDataset(async (dataset) => {
    const aliasesPath = path.join(dataset, 'aliases.json');
    const aliases = JSON.parse(await readFile(aliasesPath, 'utf8'));
    delete aliases[0].targetId;
    await writeFile(aliasesPath, `${JSON.stringify(aliases, null, 2)}\n`);

    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Alias registry contains an invalid entry/);
  });
});

test('fails closed when source-byte publication has no permitted redistribution decision', async () => {
  await withFreshDataset(async (dataset) => {
    const manifestPath = path.join(dataset, 'source-artifacts/edition.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.publication.mode = 'source_bytes';
    manifest.artifact = {
      representation: 'source_bytes',
      sha256: 'a'.repeat(64),
      byte_length: 4,
    };
    manifest.rights = { state: 'unknown', allowed_uses: [] };
    manifest.attribution = { text: 'Synthetic', display_locations: ['catalog'] };
    manifest.complaint_process_owner = 'synthetic-owner';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be equal to constant|must contain at least 1 valid item/);
  });
});

test('rejects malformed external source URI formats without fetching them', async () => {
  await withFreshDataset(async (dataset) => {
    const manifestPath = path.join(dataset, 'source-artifacts/edition.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.references = ['not a valid URI'];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = invoke(dataset);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /format|URI/);
  });
});

test('reports the same issue order for the same dataset contents', async () => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), 'moonwitness-validator-order-a-'));
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'moonwitness-validator-order-b-'));
  const first = path.join(firstRoot, 'dataset');
  const second = path.join(secondRoot, 'dataset');
  try {
    await cp(fixture, first, { recursive: true });
    await cp(fixture, second, { recursive: true });
    const malformed = JSON.stringify({ id: 'not-canonical', kind: 'Concept' });
    await writeFile(path.join(first, 'records/z-invalid.json'), malformed);
    await writeFile(path.join(first, 'records/a-invalid.json'), malformed);
    await writeFile(path.join(second, 'records/a-invalid.json'), malformed);
    await writeFile(path.join(second, 'records/z-invalid.json'), malformed);

    const resultA = invoke(first, [], ['--json']);
    const resultB = invoke(second, [], ['--json']);
    assert.equal(resultA.status, 1);
    assert.equal(resultB.status, 1);
    assert.equal(resultA.stdout, resultB.stdout);
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission')
  ? '--permission'
  : process.allowedNodeEnvironmentFlags.has('--experimental-permission')
    ? '--experimental-permission'
    : undefined;

test('validates successfully in an environment with network access denied', async () => {
  await withFreshDataset((dataset) => {
    const probe = `import net from 'node:net';
        try {
          const socket = net.connect({ host: '192.0.2.1', port: 9 });
          socket.on('connect', () => process.exit(1));
          socket.on('error', (error) => process.exit(['ENETUNREACH', 'ERR_ACCESS_DENIED'].includes(error.code) ? 0 : 1));
          socket.setTimeout(2000, () => process.exit(1));
        } catch (error) { process.exit(error.code === 'ERR_ACCESS_DENIED' ? 0 : 1); }`;
    const permissionDeniesNetwork =
      permissionFlag && process.allowedNodeEnvironmentFlags.has('--allow-net');
    let command;
    let prefix;
    if (permissionDeniesNetwork) {
      command = process.execPath;
      prefix = [permissionFlag, '--allow-fs-read=*'];
    } else {
      assert.equal(
        process.platform,
        'linux',
        'Network isolation requires Node 25+ or Linux unshare'
      );
      command = 'sudo';
      prefix = ['-n', 'unshare', '--net', '--', process.execPath];
    }
    const denied = spawnSync(command, [...prefix, '--input-type=module', '-e', probe], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(
      denied.status,
      0,
      denied.stderr || denied.error?.message || 'Network denial probe failed'
    );
    const result = spawnSync(command, [...prefix, cli, dataset], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Knowledge dataset valid: 6 records/);
  });
});
