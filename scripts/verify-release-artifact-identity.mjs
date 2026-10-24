import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const artifactMetadataQuery =
  '{id: (.id | tostring), name, expired, digest, workflow_run: {head_sha: .workflow_run.head_sha, id: (.workflow_run.id | tostring)}}';

export function assertReleaseArtifactIdentity(artifact, expected) {
  const mismatches = [];
  if (artifact.id !== expected.id) mismatches.push('artifact id');
  if (artifact.name !== expected.name) mismatches.push('artifact name');
  if (artifact.expired !== false) mismatches.push('expiration state');
  if (artifact.digest !== `sha256:${expected.digest}`) mismatches.push('artifact digest');
  if (artifact.workflow_run?.head_sha !== expected.sourceSha) mismatches.push('source SHA');
  if (artifact.workflow_run?.id !== expected.runId) mismatches.push('workflow run id');

  if (mismatches.length > 0) {
    throw new Error(`Release artifact metadata mismatch: ${mismatches.join(', ')}`);
  }
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) {
    throw new Error(`Missing or invalid ${name} for release artifact verification`);
  }
  return value;
}

function main() {
  const repository = requiredEnvironment('GH_REPO', /^[\w.-]+\/[\w.-]+$/u);
  const expected = {
    id: requiredEnvironment('EXPECTED_ARTIFACT_ID', /^\d+$/u),
    digest: requiredEnvironment('EXPECTED_ARTIFACT_DIGEST', /^[a-f\d]{64}$/iu),
    name: requiredEnvironment('EXPECTED_ARTIFACT_NAME', /^release-images-[a-f\d]{40}$/iu),
    sourceSha: requiredEnvironment('EXPECTED_SOURCE_SHA', /^[a-f\d]{40}$/iu),
    runId: requiredEnvironment('EXPECTED_RUN_ID', /^\d+$/u),
  };
  const endpoint = `repos/${repository}/actions/artifacts/${expected.id}`;
  const rawMetadata = execFileSync('gh', ['api', endpoint, '--jq', artifactMetadataQuery], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  assertReleaseArtifactIdentity(JSON.parse(rawMetadata), expected);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
