import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isLocalModelRegistry,
  verifyLocalModelArtifact,
  type LocalModelArtifact,
  type LocalModelRegistry,
} from '../src/index.js';

const roots: string[] = [];
const modelBytes = Buffer.from('synthetic model artifact fixture', 'utf8');
const modelDigest = createHash('sha256').update(modelBytes).digest('hex');

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-model-registry-'));
  roots.push(root);
  return root;
}

function artifact(overrides: Partial<LocalModelArtifact> = {}): LocalModelArtifact {
  return {
    id: 'synthetic-model',
    version: '1.0.0',
    sourceUrl: 'https://models.example.test/synthetic-model',
    license: {
      identifier: 'MIT',
      referenceUrl: 'https://licenses.example.test/MIT',
      reviewed: true,
      reviewedAt: '2026-10-16T10:00:00.000Z',
      reviewRef: 'synthetic-review-only',
    },
    file: { path: 'synthetic/model.bin', sha256: modelDigest, byteLength: modelBytes.byteLength },
    requirements: { minimumRamGiB: 1, minimumVramGiB: null },
    ...overrides,
  };
}

function registry(artifacts: readonly LocalModelArtifact[] = []): LocalModelRegistry {
  return {
    format: 'moonwitness-local-model-registry/v1',
    activeArtifactId: artifacts[0]?.id ?? null,
    artifacts,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local model artifact registry', () => {
  it('accepts an empty registry so no model is compulsory', () => {
    expect(isLocalModelRegistry(registry())).toBe(true);
  });

  it('validates duplicate IDs, missing active IDs, and malformed source/license metadata', () => {
    expect(isLocalModelRegistry(registry([artifact(), artifact()]))).toBe(false);
    expect(isLocalModelRegistry({ ...registry([artifact()]), activeArtifactId: 'missing' })).toBe(
      false
    );
    expect(
      isLocalModelRegistry(
        registry([artifact({ sourceUrl: 'http://insecure.example.test/model' })])
      )
    ).toBe(false);
  });

  it('rejects credential-bearing HTTPS references and non-ISO review timestamps', () => {
    expect(
      isLocalModelRegistry(
        registry([artifact({ sourceUrl: 'https://operator:secret@models.example.test/model' })])
      )
    ).toBe(false);
    expect(
      isLocalModelRegistry(
        registry([
          artifact({
            license: {
              ...artifact().license,
              referenceUrl: 'https://user:token@licenses.example.test/MIT',
            },
          }),
        ])
      )
    ).toBe(false);
    expect(
      isLocalModelRegistry(
        registry([artifact({ license: { ...artifact().license, reviewedAt: '10' } })])
      )
    ).toBe(false);
    expect(
      isLocalModelRegistry(
        registry([
          artifact({ license: { ...artifact().license, reviewedAt: '2026-02-31T10:00:00Z' } }),
        ])
      )
    ).toBe(false);
  });

  it('verifies a reviewed artifact digest in external model storage', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'workspace');
    const storage = path.join(root, 'private-model-store');
    await mkdir(workspace);
    await mkdir(path.join(storage, 'synthetic'), { recursive: true });
    await writeFile(path.join(storage, 'synthetic', 'model.bin'), modelBytes);

    await expect(verifyLocalModelArtifact(workspace, storage, artifact())).resolves.toEqual({
      valid: true,
      artifactId: 'synthetic-model',
      sha256: modelDigest,
      byteLength: modelBytes.byteLength,
    });
  });

  it('rejects an artifact stored inside the worktree', async () => {
    const workspace = await temporaryRoot();
    const storage = path.join(workspace, 'models');
    await mkdir(path.join(storage, 'synthetic'), { recursive: true });
    await writeFile(path.join(storage, 'synthetic', 'model.bin'), modelBytes);

    await expect(verifyLocalModelArtifact(workspace, storage, artifact())).resolves.toMatchObject({
      valid: false,
      reason: 'storage_inside_worktree',
    });
  });

  it('fails closed for missing, unreviewed, path-traversing, or digest-mismatched artifacts', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'workspace');
    const storage = path.join(root, 'private-model-store');
    await mkdir(workspace);
    await mkdir(storage);

    await expect(verifyLocalModelArtifact(workspace, storage, artifact())).resolves.toMatchObject({
      valid: false,
      reason: 'model_missing',
    });
    await expect(
      verifyLocalModelArtifact(
        workspace,
        storage,
        artifact({
          license: { ...artifact().license, reviewed: false },
        })
      )
    ).resolves.toMatchObject({ valid: false, reason: 'license_unreviewed' });
    await expect(
      verifyLocalModelArtifact(
        workspace,
        storage,
        artifact({
          file: { ...artifact().file, path: '../outside.bin' },
        })
      )
    ).resolves.toMatchObject({ valid: false, reason: 'path_invalid' });

    await mkdir(path.join(storage, 'synthetic'));
    await writeFile(path.join(storage, 'synthetic', 'model.bin'), 'different bytes');
    await expect(verifyLocalModelArtifact(workspace, storage, artifact())).resolves.toMatchObject({
      valid: false,
      reason: 'integrity_mismatch',
    });
  });
});
