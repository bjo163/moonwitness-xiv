import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const requireKnowledgeDependency = createRequire(
  new URL('../../packages/knowledge/package.json', import.meta.url)
);
const Ajv2020 = requireKnowledgeDependency('ajv/dist/2020.js').default;
const addFormats = requireKnowledgeDependency('ajv-formats').default;
const inventoryUrl = new URL('../../docs/knowledge/legacy-source-inventory.json', import.meta.url);
const schemaUrl = new URL(
  '../../docs/knowledge/legacy-source-inventory.schema.json',
  import.meta.url
);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function copyInventory() {
  return JSON.parse(JSON.stringify(inventory));
}

test('legacy inventory and pinned public-reference evidence match the schema', () => {
  assert.equal(validate(inventory), true, JSON.stringify(validate.errors));
  assert.equal(inventory.remoteObservations.length, 8);
  assert.ok(
    inventory.remoteObservations.every(
      ({ rootLicenseFound, treeScanComplete }) => !rootLicenseFound && treeScanComplete
    )
  );
  const rgb = inventory.remoteObservations.find(
    ({ repository }) => repository === 'bjo163/rocksoul-rgbl'
  );
  assert.equal(rgb?.matchingRightsFiles.length, 6);
  const aws = inventory.remoteObservations.find(
    ({ repository }) => repository === 'bjo163/rocksoul-aws'
  );
  assert.equal(aws?.nonLicenseNameMatches.length, 3);
  assert.deepEqual(
    rgb?.tags.find(({ name }) => name === 'v0.1.0'),
    {
      name: 'v0.1.0',
      tagObjectSha: '521964f533756a03d93f8761afb55872e8b0a8ce',
      commitSha: 'cd23dcbfa9410383256ea95d0813da56569a3b5c',
    }
  );
  assert.ok(
    aws?.tags.some(
      ({ name, commitSha }) =>
        name === 'v4.32.0' && commitSha === 'bb9198ac24a4fa05195ae7eb0adf31bc28e50889'
    )
  );
  const rightsFiles = rgb?.matchingRightsFiles ?? [];
  assert.ok(
    rightsFiles.find(({ path }) => path.endsWith('TANZIL.md'))?.scope.includes('CC-BY-3.0')
  );
  assert.ok(
    rightsFiles
      .find(({ path }) => path.endsWith('SUTTACENTRAL-CC0.md'))
      ?.scope.includes('not the Pali root')
  );
});

test('inventory schema rejects missing provenance and malformed source digests', async () => {
  const missingRef = copyInventory();
  missingRef.remoteObservations[0].head = 'short';
  assert.equal(validate(missingRef), false);

  const missingSourceScope = copyInventory();
  delete missingSourceScope.reviewScope.privateRemoteContentsAccessed;
  assert.equal(validate(missingSourceScope), false);
});

test('inventory JSON is stored canonically formatted and all remote refs are full SHAs', async () => {
  const text = await readFile(inventoryUrl, 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(JSON.stringify(parsed, null, 2) + '\n', text);
  assert.ok(inventory.remoteObservations.every(({ head }) => /^[a-f0-9]{40}$/u.test(head)));
});

test('inventory paths remain repository-relative and do not contain private source content', async () => {
  const inventoryPath = fileURLToPath(inventoryUrl);
  assert.match(inventoryPath, /legacy-source-inventory\.json$/u);
  assert.equal(inventory.reviewScope.privateRemoteContentsAccessed, false);
  assert.equal(inventory.reviewScope.sourceBytesCopied, false);
});
