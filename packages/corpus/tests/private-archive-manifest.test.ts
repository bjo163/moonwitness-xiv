import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPrivateArchiveImportManifest,
  importPrivateArchive,
  validatePrivateArchiveImportManifest,
  type PrivateArchiveImportConsent,
  type PrivateArchiveImportRequest,
  type ImportPrivateArchiveRequest,
} from '../src/index.js';

const temporaryRoots: string[] = [];
const sourceBytes = Buffer.from('synthetic private archive; no user data', 'utf8');
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');

async function rootFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-private-archive-'));
  temporaryRoots.push(root);
  await writeFile(path.join(root, 'archive.json'), sourceBytes);
  return root;
}

function consent(
  overrides: Partial<PrivateArchiveImportConsent> = {}
): PrivateArchiveImportConsent {
  return {
    state: 'granted',
    sourceKind: 'account_export',
    sourcePath: 'archive.json',
    sourceSha256,
    subjectRef: 'urn:synthetic:subject:1',
    authorizedByRef: 'urn:synthetic:owner:1',
    authorizedAt: '2026-10-15T10:00:00.000Z',
    dataCategories: ['conversation_text'],
    purposes: ['private_research'],
    authorizedReviewers: ['urn:synthetic:reviewer:1'],
    intendedDerivedUses: ['local_review'],
    publicationScope: 'none',
    withdrawalPath: 'urn:synthetic:withdrawal:1',
    correctionPath: 'urn:synthetic:correction:1',
    decisionRef: 'urn:synthetic:consent-decision:1',
    ...overrides,
  };
}

function request(rootDirectory: string, overrides: Partial<PrivateArchiveImportRequest> = {}) {
  return {
    rootDirectory,
    workspaceRoot: process.cwd(),
    sourcePath: 'archive.json',
    manifestPath: 'manifests/intake.json',
    manifestId: 'synthetic-intake-v1',
    sourceKind: 'account_export',
    exportedAt: '2026-10-14T09:00:00.000Z',
    recordedAt: '2026-10-15T10:30:00.000Z',
    consent: consent(),
    ...overrides,
  } satisfies PrivateArchiveImportRequest;
}

async function importFixture() {
  const container = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-private-copy-'));
  temporaryRoots.push(container);
  const workspaceRoot = path.join(container, 'workspace');
  const sourceRootDirectory = path.join(container, 'source');
  const rootDirectory = path.join(container, 'destination');
  await Promise.all([
    mkdir(workspaceRoot, { mode: 0o700 }),
    mkdir(sourceRootDirectory, { mode: 0o700 }),
    mkdir(rootDirectory, { mode: 0o700 }),
  ]);
  await writeFile(path.join(sourceRootDirectory, 'archive.json'), sourceBytes);
  return {
    ...request(rootDirectory, { workspaceRoot }),
    sourceRootDirectory,
  } satisfies ImportPrivateArchiveRequest;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('private archive import manifest', () => {
  it('refuses to place archive intake metadata inside the workspace', async () => {
    const root = await rootFixture();

    await expect(
      createPrivateArchiveImportManifest(request(root, { workspaceRoot: root }))
    ).rejects.toThrow('rootDirectory must be outside the workspace');
    await expect(readdir(root)).resolves.toEqual(['archive.json']);
  });

  it('refuses an intake root nested anywhere inside the workspace', async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-private-workspace-'));
    temporaryRoots.push(container);
    const workspace = path.join(container, 'workspace');
    const root = path.join(workspace, 'private', 'intake');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'archive.json'), sourceBytes);

    await expect(
      createPrivateArchiveImportManifest(request(root, { workspaceRoot: workspace }))
    ).rejects.toThrow('rootDirectory must be outside the workspace');
    await expect(readdir(root)).resolves.toEqual(['archive.json']);
  });

  it('rejects source and manifest-parent symlinks', async ({ skip }) => {
    const root = await rootFixture();
    const sourceLink = path.join(root, 'source-link.json');
    const outputTarget = path.join(root, 'actual-output');
    const outputLink = path.join(root, 'output-link');
    await mkdir(outputTarget);

    try {
      await symlink(path.join(root, 'archive.json'), sourceLink, 'file');
      await symlink(outputTarget, outputLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (
        process.platform === 'win32' &&
        (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP')
      ) {
        skip('The current Windows environment does not permit creating symbolic links');
      }
      throw error;
    }

    await expect(
      createPrivateArchiveImportManifest(
        request(root, {
          sourcePath: 'source-link.json',
          consent: consent({ sourcePath: 'source-link.json' }),
        })
      )
    ).rejects.toThrow('cannot traverse symbolic links');
    await expect(
      createPrivateArchiveImportManifest(request(root, { manifestPath: 'output-link/intake.json' }))
    ).rejects.toThrow('manifestPath parent directories must be real private directories');
    await expect(readdir(outputTarget)).resolves.toEqual([]);
  });

  it('records only source metadata and scoped consent for a local synthetic archive', async () => {
    const root = await rootFixture();
    const manifest = await createPrivateArchiveImportManifest(request(root));
    const serialized = await readFile(path.join(root, 'manifests/intake.json'), 'utf8');

    expect(manifest.source).toEqual({
      kind: 'account_export',
      path: 'archive.json',
      exportedAt: '2026-10-14T09:00:00.000Z',
      sha256: sourceSha256,
      byteLength: sourceBytes.byteLength,
    });
    expect(manifest.consent.sourceSha256).toBe(sourceSha256);
    expect(serialized).not.toContain(sourceBytes.toString('utf8'));
    expect(JSON.parse(serialized)).toEqual(manifest);
    expect(validatePrivateArchiveImportManifest(manifest)).toEqual({ valid: true, issues: [] });
  });

  it('denies missing, denied, or withdrawn consent before opening the source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-private-denial-'));
    temporaryRoots.push(root);
    await expect(
      createPrivateArchiveImportManifest(
        request(root, { consent: undefined as unknown as PrivateArchiveImportConsent })
      )
    ).rejects.toThrow('granted');
    for (const state of ['denied', 'withdrawn'] as const) {
      await expect(
        createPrivateArchiveImportManifest(request(root, { consent: consent({ state }) }))
      ).rejects.toThrow('granted');
    }
    await expect(readdir(path.join(root, 'manifests'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('denies source path and checksum mismatches without creating a manifest', async () => {
    const root = await rootFixture();
    await expect(
      createPrivateArchiveImportManifest(
        request(root, { consent: consent({ sourcePath: 'other.json' }) })
      )
    ).rejects.toThrow('exact local source path and kind');
    await expect(
      createPrivateArchiveImportManifest(
        request(root, { consent: consent({ sourceSha256: '0'.repeat(64) }) })
      )
    ).rejects.toThrow('checksum');
    await expect(readdir(path.join(root, 'manifests'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects remote, absolute, and parent source paths', async () => {
    const root = await rootFixture();
    for (const sourcePath of [
      'https://example.test/export.json',
      '../outside.json',
      'C:/private.json',
    ]) {
      await expect(
        createPrivateArchiveImportManifest(
          request(root, { sourcePath, consent: consent({ sourcePath }) })
        )
      ).rejects.toThrow();
    }
    await expect(readdir(path.join(root, 'manifests'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites an existing manifest', async () => {
    const root = await rootFixture();
    const first = await createPrivateArchiveImportManifest(request(root));
    const before = await readFile(path.join(root, 'manifests/intake.json'), 'utf8');
    await expect(createPrivateArchiveImportManifest(request(root))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(path.join(root, 'manifests/intake.json'), 'utf8')).toBe(before);
    expect(first.manifestId).toBe('synthetic-intake-v1');
  });

  it('refuses to use the source file as the manifest destination', async () => {
    const root = await rootFixture();
    await expect(
      createPrivateArchiveImportManifest(request(root, { manifestPath: 'archive.json' }))
    ).rejects.toThrow('manifestPath must not overwrite the source');
    await expect(readFile(path.join(root, 'archive.json'))).resolves.toEqual(sourceBytes);
  });

  it('copies a consent-bound local synthetic archive into external storage', async () => {
    const fixture = await importFixture();
    const manifest = await importPrivateArchive(fixture);
    const importedBytes = await readFile(path.join(fixture.rootDirectory, 'archive.json'));
    const serialized = await readFile(
      path.join(fixture.rootDirectory, 'manifests/intake.json'),
      'utf8'
    );

    expect(importedBytes).toEqual(sourceBytes);
    expect(manifest.source.sha256).toBe(sourceSha256);
    expect(manifest.source.byteLength).toBe(sourceBytes.byteLength);
    expect(serialized).not.toContain(sourceBytes.toString('utf8'));
    await expect(readdir(fixture.rootDirectory)).resolves.toEqual(['archive.json', 'manifests']);
    await expect(readdir(path.join(fixture.rootDirectory, 'manifests'))).resolves.toEqual([
      'intake.json',
    ]);
  });

  it('does not copy denied or checksum-mismatched archives', async () => {
    const fixture = await importFixture();
    await expect(
      importPrivateArchive({ ...fixture, consent: consent({ state: 'denied' }) })
    ).rejects.toThrow('granted');
    await expect(
      importPrivateArchive({ ...fixture, consent: consent({ sourceSha256: '0'.repeat(64) }) })
    ).rejects.toThrow('checksum');
    await expect(readdir(fixture.rootDirectory)).resolves.toEqual([]);
  });

  it('requires distinct external source and destination roots', async () => {
    const fixture = await importFixture();
    await expect(
      importPrivateArchive({ ...fixture, rootDirectory: fixture.sourceRootDirectory })
    ).rejects.toThrow('must be different directories');
    await expect(readdir(fixture.sourceRootDirectory)).resolves.toEqual(['archive.json']);
  });

  it('refuses externally accessible intake roots on POSIX filesystems', async ({ skip }) => {
    if (process.platform === 'win32') skip('Windows ACLs are not represented by POSIX mode bits');
    const fixture = await importFixture();
    await chmod(fixture.rootDirectory, 0o755);

    await expect(importPrivateArchive(fixture)).rejects.toThrow('private to the current user');
    await expect(readdir(fixture.rootDirectory)).resolves.toEqual([]);
  });

  it('refuses intake paths below a shared writable ancestor on POSIX filesystems', async ({
    skip,
  }) => {
    if (process.platform === 'win32') skip('Windows ACLs are not represented by POSIX mode bits');
    const fixture = await importFixture();
    await chmod(path.dirname(fixture.rootDirectory), 0o777);

    await expect(importPrivateArchive(fixture)).rejects.toThrow(
      'unsafe writable directory ancestor'
    );
    await expect(readdir(fixture.rootDirectory)).resolves.toEqual([]);
  });

  it('never overwrites an existing archive or removes it after a failed copy', async () => {
    const fixture = await importFixture();
    const destination = path.join(fixture.rootDirectory, 'archive.json');
    const existingBytes = Buffer.from('existing synthetic archive', 'utf8');
    await writeFile(destination, existingBytes);

    await expect(importPrivateArchive(fixture)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(destination)).resolves.toEqual(existingBytes);
  });

  it('removes newly copied bytes when manifest creation fails', async () => {
    const fixture = await importFixture();
    const manifestDirectory = path.join(fixture.rootDirectory, 'manifests');
    await mkdir(manifestDirectory, { mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(manifestDirectory, 0o700);
    }
    const existingManifest = Buffer.from('preserve existing manifest', 'utf8');
    await writeFile(path.join(manifestDirectory, 'intake.json'), existingManifest);

    await expect(importPrivateArchive(fixture)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readdir(fixture.rootDirectory)).resolves.toEqual(['manifests']);
    await expect(readdir(manifestDirectory)).resolves.toEqual(['intake.json']);
    await expect(readFile(path.join(manifestDirectory, 'intake.json'))).resolves.toEqual(
      existingManifest
    );
  });

  it('rejects unbound manifest declarations and unknown fields', () => {
    const value = {
      format: 'moonwitness-private-archive-import/v1',
      manifestId: 'fixture',
      recordedAt: '2026-10-15T10:30:00.000Z',
      source: {
        kind: 'account_export',
        path: 'archive.json',
        exportedAt: '2026-10-14T09:00:00.000Z',
        sha256: sourceSha256,
        byteLength: sourceBytes.byteLength,
      },
      consent: consent({ sourceSha256: '0'.repeat(64) }),
      unexpected: true,
    };
    const result = validatePrivateArchiveImportManifest(value);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('/unexpected');
    expect(result.issues.map((issue) => issue.path)).toContain('/consent/sourceSha256');
  });
});
