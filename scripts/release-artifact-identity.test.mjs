import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseArtifactIdentity } from './verify-release-artifact-identity.mjs';

const sourceSha = 'a'.repeat(40);
const expected = {
  id: '9007199254740993',
  digest: 'b'.repeat(64),
  name: `release-images-${sourceSha}`,
  sourceSha,
  runId: '9007199254740995',
};

const validArtifact = {
  id: expected.id,
  name: expected.name,
  expired: false,
  digest: `sha256:${expected.digest}`,
  workflow_run: { head_sha: expected.sourceSha, id: expected.runId },
};

test('accepts exact artifact metadata while preserving large numeric identifiers as strings', () => {
  assert.doesNotThrow(() => assertReleaseArtifactIdentity(validArtifact, expected));
});

test('rejects mismatched artifact identity metadata before consuming the artifact', () => {
  const mismatches = [
    [{ ...validArtifact, id: '9007199254740992' }, 'artifact id'],
    [{ ...validArtifact, name: 'release-images-wrong-source' }, 'artifact name'],
    [{ ...validArtifact, expired: true }, 'expiration state'],
    [{ ...validArtifact, digest: `sha256:${'c'.repeat(64)}` }, 'artifact digest'],
    [
      {
        ...validArtifact,
        workflow_run: { ...validArtifact.workflow_run, head_sha: 'c'.repeat(40) },
      },
      'source SHA',
    ],
    [
      { ...validArtifact, workflow_run: { ...validArtifact.workflow_run, id: '9007199254740994' } },
      'workflow run id',
    ],
    [{ ...validArtifact, workflow_run: null }, 'workflow run id'],
  ];

  for (const [artifact, mismatch] of mismatches) {
    assert.throws(
      () => assertReleaseArtifactIdentity(artifact, expected),
      new RegExp(mismatch, 'u')
    );
  }
});
