import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { URL } from 'node:url';

const requireKnowledgeDependency = createRequire(
  new URL('../../packages/knowledge/package.json', import.meta.url)
);
const Ajv2020 = requireKnowledgeDependency('ajv/dist/2020.js').default;
const addFormats = requireKnowledgeDependency('ajv-formats').default;
const schema = JSON.parse(
  await readFile(
    new URL('../../ontology/domains/revelation-identity.schema.json', import.meta.url),
    'utf8'
  )
);
const example = JSON.parse(
  await readFile(
    new URL('../../corpus/reference/revelation-identity-example.json', import.meta.url),
    'utf8'
  )
);
const webpIdentity = JSON.parse(
  await readFile(
    new URL('../../corpus/reference/webp-protestant-genesis-1-1.identity.json', import.meta.url),
    'utf8'
  )
);
const webpManifest = JSON.parse(
  await readFile(
    new URL('../../corpus/manifests/webp-protestant-genesis-1-1.json', import.meta.url),
    'utf8'
  )
);
const webpIndex = JSON.parse(
  await readFile(
    new URL('../../corpus/manifests/textual-witness-index.json', import.meta.url),
    'utf8'
  )
);
const quranIndex = JSON.parse(
  await readFile(
    new URL('../../corpus/manifests/quran-passage-index.json', import.meta.url),
    'utf8'
  )
);
const sourceArtifactSchema = JSON.parse(
  await readFile(
    new URL(
      '../../packages/knowledge/schemas/source-artifact-manifest.schema.json',
      import.meta.url
    ),
    'utf8'
  )
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);
const validateSourceArtifact = ajv.compile(sourceArtifactSchema);

function validateDomain(dataset) {
  const errors = [];
  if (!validateSchema(dataset)) {
    errors.push(
      ...(validateSchema.errors ?? []).map((error) => error.message ?? 'schema violation')
    );
    return errors;
  }
  const entities = new Map();
  for (const entity of dataset.entities) {
    if (entities.has(entity.id)) errors.push(`duplicate entity ID: ${entity.id}`);
    entities.set(entity.id, entity.identityClass);
  }
  const relationIds = new Set();
  const relationStates = new Map();
  const expectedClasses = {
    witness_of: ['TextualWitness', 'RevelationIdentity'],
    member_of_canon: ['TextualWitness', 'Canon'],
    edition_of: ['Edition', 'TextualWitness'],
  };
  for (const relation of dataset.relations) {
    if (relationIds.has(relation.id)) errors.push(`duplicate relation ID: ${relation.id}`);
    relationIds.add(relation.id);
    const subjectClass = entities.get(relation.subjectId);
    const objectClass = entities.get(relation.objectId);
    if (!subjectClass || !objectClass) {
      errors.push(`dangling relation: ${relation.id}`);
      continue;
    }
    const expected = expectedClasses[relation.predicate];
    if (expected && (subjectClass !== expected[0] || objectClass !== expected[1])) {
      errors.push(`relation endpoint class mismatch: ${relation.id}`);
    }
    const key = `${relation.subjectId}\0${relation.predicate}\0${relation.objectId}`;
    const state = relationStates.get(key);
    if (state && state !== relation.status)
      errors.push(`contradictory relation state: ${relation.id}`);
    relationStates.set(key, relation.status);
  }
  return errors;
}

function copyExample() {
  return JSON.parse(JSON.stringify(example));
}

test('revelation example keeps the four named identities distinct and asserts no witness equivalence', () => {
  assert.equal(validateDomain(example).length, 0);
  assert.equal(example.entities.length, 4);
  assert.equal(new Set(example.entities.map(({ id }) => id)).size, 4);
  assert.ok(example.entities.every(({ identityClass }) => identityClass === 'RevelationIdentity'));
  assert.deepEqual(example.relations, []);
  assert.deepEqual(example.policy, {
    inferIdentityEquivalence: false,
    canonImpliesRevelationIdentity: false,
  });
});

test('supports typed witness, canon, edition, and explicitly evidenced relationship fixtures', () => {
  const dataset = copyExample();
  dataset.entities.push(
    {
      id: 'mw:expression:synthetic-witness',
      identityClass: 'TextualWitness',
      label: 'Synthetic witness fixture',
      sourceArtifactId: 'mw:artifact:synthetic-source',
    },
    {
      id: 'mw:concept:synthetic-canon',
      identityClass: 'Canon',
      label: 'Synthetic canon',
      tradition: 'test',
    },
    {
      id: 'mw:edition:synthetic-edition',
      identityClass: 'Edition',
      label: 'Synthetic edition',
      sourceArtifactId: 'mw:artifact:synthetic-edition-source',
    }
  );
  dataset.relations.push(
    {
      id: 'mw:relation:witness-source',
      subjectId: 'mw:expression:synthetic-witness',
      predicate: 'witness_of',
      objectId: 'mw:work:quran-revelation',
      status: 'candidate',
      evidenceIds: [],
    },
    {
      id: 'mw:relation:witness-canon',
      subjectId: 'mw:expression:synthetic-witness',
      predicate: 'member_of_canon',
      objectId: 'mw:concept:synthetic-canon',
      status: 'candidate',
      evidenceIds: [],
    },
    {
      id: 'mw:relation:edition-witness',
      subjectId: 'mw:edition:synthetic-edition',
      predicate: 'edition_of',
      objectId: 'mw:expression:synthetic-witness',
      status: 'candidate',
      evidenceIds: [],
    },
    {
      id: 'mw:relation:explicit-equivalence',
      subjectId: 'mw:expression:synthetic-witness',
      predicate: 'explicit_identity_equivalence',
      objectId: 'mw:work:quran-revelation',
      status: 'accepted',
      evidenceIds: ['mw:evidence:synthetic-review'],
    }
  );
  assert.deepEqual(validateDomain(dataset), []);
});

test('rejects class-incompatible, dangling, and contradictory relation fixtures', () => {
  const dataset = copyExample();
  dataset.entities.push({
    id: 'mw:expression:synthetic-witness',
    identityClass: 'TextualWitness',
    label: 'Synthetic witness fixture',
    sourceArtifactId: 'mw:artifact:synthetic-source',
  });
  dataset.relations.push(
    {
      id: 'mw:relation:wrong-endpoint',
      subjectId: 'mw:work:quran-revelation',
      predicate: 'witness_of',
      objectId: 'mw:work:taurat-revelation',
      status: 'candidate',
      evidenceIds: [],
    },
    {
      id: 'mw:relation:dangling',
      subjectId: 'mw:expression:synthetic-witness',
      predicate: 'witness_of',
      objectId: 'mw:work:missing-revelation',
      status: 'candidate',
      evidenceIds: [],
    },
    {
      id: 'mw:relation:candidate-state',
      subjectId: 'mw:expression:synthetic-witness',
      predicate: 'witness_of',
      objectId: 'mw:work:quran-revelation',
      status: 'candidate',
      evidenceIds: [],
    },
    {
      id: 'mw:relation:opposite-state',
      subjectId: 'mw:expression:synthetic-witness',
      predicate: 'witness_of',
      objectId: 'mw:work:quran-revelation',
      status: 'rejected',
      evidenceIds: [],
    }
  );
  assert.deepEqual(validateDomain(dataset), [
    'relation endpoint class mismatch: mw:relation:wrong-endpoint',
    'dangling relation: mw:relation:dangling',
    'contradictory relation state: mw:relation:opposite-state',
  ]);
});

test('requires reviewed evidence for accepted equivalence and rejects implicit canon identity', () => {
  const dataset = copyExample();
  dataset.policy.canonImpliesRevelationIdentity = true;
  assert.ok(validateDomain(dataset).some((error) => error.includes('must be equal to constant')));

  const equivalence = copyExample();
  equivalence.relations.push({
    id: 'mw:relation:unreviewed-equivalence',
    subjectId: 'mw:work:quran-revelation',
    predicate: 'explicit_identity_equivalence',
    objectId: 'mw:work:taurat-revelation',
    status: 'candidate',
    evidenceIds: [],
  });
  assert.ok(
    validateDomain(equivalence).some((error) => error.includes('must be equal to constant'))
  );

  const acceptedWithoutEvidence = copyExample();
  acceptedWithoutEvidence.relations.push({
    id: 'mw:relation:accepted-without-evidence',
    subjectId: 'mw:work:quran-revelation',
    predicate: 'explicit_identity_equivalence',
    objectId: 'mw:work:taurat-revelation',
    status: 'accepted',
    evidenceIds: [],
  });
  assert.ok(validateDomain(acceptedWithoutEvidence).length > 0);
});

test('WEBP witness sample keeps its expression and edition separate from Quran editions', async () => {
  assert.deepEqual(validateDomain(webpIdentity), []);
  assert.equal(webpIdentity.entities.length, 2);
  const witness = webpIdentity.entities.find(
    ({ identityClass }) => identityClass === 'TextualWitness'
  );
  const edition = webpIdentity.entities.find(({ identityClass }) => identityClass === 'Edition');
  assert.equal(witness.id, 'mw:expression:webp-protestant');
  assert.equal(edition.id, 'mw:edition:webp-protestant-2020-stable');
  assert.notEqual(witness.id, edition.id);
  assert.equal(witness.sourceArtifactId, 'mw:artifact:webp-protestant-genesis-1-1');
  assert.deepEqual(webpIdentity.relations, [
    {
      id: 'mw:relation:webp-edition-of-witness',
      subjectId: edition.id,
      predicate: 'edition_of',
      objectId: witness.id,
      status: 'accepted',
      evidenceIds: ['mw:evidence:ebible-webp-edition-source'],
    },
  ]);
  assert.ok(
    webpIdentity.relations.every(
      ({ predicate }) => predicate !== 'witness_of' && predicate !== 'explicit_identity_equivalence'
    )
  );

  const [sample] = webpIndex.entries;
  const [quran] = quranIndex.entries;
  assert.equal(sample.expression_id, witness.id);
  assert.equal(sample.edition_id, edition.id);
  assert.notEqual(sample.edition_id, quran.edition_id);
  assert.equal(sample.locator, 'Genesis 1:1');
  assert.equal(sample.source_manifest_path, 'corpus/manifests/webp-protestant-genesis-1-1.json');
  assert.equal(sample.sha256, webpManifest.artifact.sha256);
  assert.equal(webpManifest.edition_id, edition.id);
  assert.equal(webpManifest.artifact.representation, 'source_bytes');
  assert.equal(validateSourceArtifact(webpManifest), true);

  const bytes = await readFile(new URL(`../../${sample.artifact_path}`, import.meta.url));
  assert.equal(
    bytes.toString('utf8'),
    'In the beginning, God created the heavens and the earth.\n'
  );
  assert.equal(bytes.byteLength, webpManifest.artifact.byte_length);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256);
});

test('rights-restricted witness can retain metadata without exposing text bytes', () => {
  const restricted = JSON.parse(JSON.stringify(webpManifest));
  restricted.artifact = { representation: 'metadata_only' };
  restricted.rights = { state: 'restricted', allowed_uses: [] };
  restricted.publication = { mode: 'metadata_only' };
  delete restricted.attribution;
  delete restricted.complaint_process_owner;
  delete restricted.transformations;
  assert.equal(validateSourceArtifact(restricted), true);
  assert.equal(restricted.artifact.representation, 'metadata_only');
  assert.equal(restricted.publication.mode, 'metadata_only');
});
