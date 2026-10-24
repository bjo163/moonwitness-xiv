import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const cli = path.join(scriptDirectory, 'rebuild.mjs');
const sourceFiles = [
  'corpus/manifests/quran-passage-index.json',
  'corpus/manifests/textual-witness-index.json',
  'corpus/manifests/tanzil-quran-text-v1.1-uthmani-q7-46.json',
  'corpus/manifests/webp-protestant-genesis-1-1.json',
  'corpus/reference/sha256/6f/6ff83b01099fb7992b5f7fa101cfab3d6556607ca6b1fe69d53cb76f97027760',
  'corpus/reference/sha256/ae/ae5c2799fad97b0e65334aa39be6193d487419f0d31713caaac58a47f6b4d8b1',
];
const webpArtifact = sourceFiles.at(-1);

function isolatedInvocation() {
  const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission')
    ? '--permission'
    : process.allowedNodeEnvironmentFlags.has('--experimental-permission')
      ? '--experimental-permission'
      : undefined;
  if (permissionFlag && process.allowedNodeEnvironmentFlags.has('--allow-net')) {
    return {
      command: process.execPath,
      prefix: [permissionFlag, '--allow-fs-read=*', '--allow-fs-write=*'],
    };
  }
  assert.equal(
    process.platform,
    'linux',
    'Offline rebuild proof requires Node permission support or Linux network namespaces'
  );
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  assert.ok(Number.isInteger(uid) && Number.isInteger(gid), 'Linux UID/GID are required');
  return {
    command: 'sudo',
    prefix: [
      '-n',
      'unshare',
      '--net',
      '--',
      'setpriv',
      `--reuid=${uid}`,
      `--regid=${gid}`,
      '--clear-groups',
      '--',
      process.execPath,
    ],
  };
}

function spawnOffline(args, options = {}) {
  const isolated = isolatedInvocation();
  const result = spawnSync(isolated.command, [...isolated.prefix, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

async function fixture(root) {
  for (const relativePath of sourceFiles) {
    const destination = path.join(root, relativePath);
    await (await import('node:fs/promises')).mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, relativePath), destination);
  }
}

function runRebuild(root, output) {
  return spawnOffline([cli, '--root', root, '--output', output]);
}

test('reconstructs local source bytes offline from an empty output and emits identical manifests', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-offline-rebuild-'));
  try {
    const sourceRoot = path.join(temporary, 'source');
    await fixture(sourceRoot);
    const outputA = path.join(temporary, 'empty-output-a');
    const outputB = path.join(temporary, 'empty-output-b');

    const deniedProbe = spawnOffline([
      '--input-type=module',
      '-e',
      "const networkPermission = process.permission?.has('net'); if (networkPermission === true) process.exit(1); import net from 'node:net'; try { const socket = net.connect({ host: '192.0.2.1', port: 9 }); socket.on('error', (error) => process.exit(['ERR_ACCESS_DENIED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code) ? 0 : 1)); socket.setTimeout(3000, () => process.exit(1)); } catch (error) { process.exit(['ERR_ACCESS_DENIED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code) ? 0 : 1); }",
    ]);
    assert.equal(deniedProbe.status, 0, deniedProbe.stderr);

    const first = runRebuild(sourceRoot, outputA);
    assert.equal(first.status, 0, first.stderr);
    const firstReport = JSON.parse(first.stdout);
    assert.deepEqual(firstReport.summary, { indexed: 2, imported: 2, errors: 0 });
    assert.ok(firstReport.sources.every((source) => source.rightsState === 'permitted'));
    assert.ok(firstReport.sources.every((source) => source.byteLength > 0));
    assert.deepEqual(firstReport.importErrors, []);

    const second = runRebuild(sourceRoot, outputB);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.equal(
      await readFile(path.join(outputA, 'source-reconstruction.json'), 'utf8'),
      await readFile(path.join(outputB, 'source-reconstruction.json'), 'utf8')
    );
    for (const relativePath of ['quran-passage-index.json', 'textual-witness-index.json']) {
      const original = await readFile(path.join(sourceRoot, 'corpus/manifests', relativePath));
      const copied = await readFile(path.join(outputA, 'indexes', relativePath));
      assert.deepEqual(copied, original, `${relativePath} must be byte-identical`);
    }
    for (const source of firstReport.sources) {
      const outputManifest = await readFile(path.join(outputA, source.manifestPath));
      const outputArtifact = await readFile(path.join(outputA, source.artifactPath));
      const inputManifest = await readFile(
        path.join(
          sourceRoot,
          'corpus/manifests',
          source.kind === 'quran-passage'
            ? 'tanzil-quran-text-v1.1-uthmani-q7-46.json'
            : 'webp-protestant-genesis-1-1.json'
        )
      );
      assert.deepEqual(outputManifest, inputManifest, 'source manifest must be byte-identical');
      assert.equal(
        createHash('sha256').update(outputManifest).digest('hex'),
        source.manifestSha256,
        'report digest must identify the copied validated manifest bytes'
      );
      assert.equal(outputArtifact.byteLength, source.byteLength);
      assert.deepEqual(
        outputArtifact,
        await readFile(
          path.join(sourceRoot, source.kind === 'quran-passage' ? sourceFiles[4] : webpArtifact)
        )
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('records a broken-source import error and succeeds bit-identically after source repair', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-rebuild-retry-'));
  try {
    const sourceRoot = path.join(temporary, 'source');
    await fixture(sourceRoot);
    const baseline = runRebuild(sourceRoot, path.join(temporary, 'baseline'));
    assert.equal(baseline.status, 0, baseline.stderr);

    const artifactPath = path.join(sourceRoot, webpArtifact);
    const originalBytes = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.from('damaged source bytes\n'));
    const failed = runRebuild(sourceRoot, path.join(temporary, 'failed-attempt'));
    assert.equal(failed.status, 1, failed.stderr);
    const failedReport = JSON.parse(failed.stdout);
    assert.deepEqual(failedReport.summary, { indexed: 2, imported: 1, errors: 1 });
    assert.match(failedReport.importErrors[0].error, /checksum or size mismatch/u);
    assert.equal(
      JSON.parse(
        await readFile(path.join(temporary, 'failed-attempt/source-reconstruction.json'), 'utf8')
      ).summary.errors,
      1,
      'the failed import report must persist instead of hiding the error'
    );

    await writeFile(artifactPath, originalBytes);
    const retried = runRebuild(sourceRoot, path.join(temporary, 'repaired-attempt'));
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(
      retried.stdout,
      baseline.stdout,
      'repaired source must reconstruct identical report bytes'
    );
    assert.equal(
      await readFile(path.join(temporary, 'baseline/source-reconstruction.json'), 'utf8'),
      await readFile(path.join(temporary, 'repaired-attempt/source-reconstruction.json'), 'utf8')
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects output directories inside the source root, including Windows case variants', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-rebuild-path-boundary-'));
  try {
    const sourceRoot = path.join(temporary, 'source');
    await fixture(sourceRoot);
    const nestedOutput = path.join(sourceRoot, 'reconstructed');
    const nested = runRebuild(sourceRoot, nestedOutput);
    assert.equal(nested.status, 2, nested.stderr);
    assert.match(nested.stderr, /outside the source root/u);

    if (process.platform === 'win32') {
      const caseVariantRoot = sourceRoot
        .split('')
        .map((character, index) =>
          index % 2 === 0 ? character.toUpperCase() : character.toLowerCase()
        )
        .join('');
      const caseVariantOutput = path.join(caseVariantRoot, 'case-variant-output');
      const caseVariant = runRebuild(sourceRoot, caseVariantOutput);
      assert.equal(caseVariant.status, 2, caseVariant.stderr);
      assert.match(caseVariant.stderr, /outside the source root/u);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects output paths that resolve inside the source root through a symlink alias', async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-rebuild-symlink-boundary-'));
  try {
    const sourceRoot = path.join(temporary, 'source');
    await fixture(sourceRoot);
    const sourceAlias = path.join(temporary, 'source-alias');
    try {
      await symlink(sourceRoot, sourceAlias, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
        context.skip('directory symlink creation is unavailable');
        return;
      }
      throw error;
    }
    const nestedViaAlias = runRebuild(sourceRoot, path.join(sourceAlias, 'reconstructed'));
    assert.equal(nestedViaAlias.status, 2, nestedViaAlias.stderr);
    assert.match(nestedViaAlias.stderr, /outside the source root/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('does not copy a source manifest reached through a symlink', async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-rebuild-manifest-link-'));
  try {
    const sourceRoot = path.join(temporary, 'source');
    await fixture(sourceRoot);
    const manifestPath = path.join(sourceRoot, 'corpus/manifests/webp-protestant-genesis-1-1.json');
    const externalManifest = path.join(temporary, 'external-manifest.json');
    await rename(manifestPath, externalManifest);
    try {
      await symlink(externalManifest, manifestPath, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
        context.skip('file symlink creation is unavailable');
        return;
      }
      throw error;
    }

    const result = runRebuild(sourceRoot, path.join(temporary, 'output'));
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.summary, { indexed: 2, imported: 1, errors: 1 });
    assert.match(report.importErrors[0].error, /symbolic links/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
