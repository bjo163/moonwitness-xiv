import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseEnvFile,
  validateAttachmentStorageProductionEnvironment,
} from './verify-attachment-storage-production-env.mjs';

const validEnvironment = {
  ATTACHMENT_STORAGE_DRIVER: 's3',
  ATTACHMENT_S3_ENDPOINT: 'https://s3.moonwitness.biz.id',
  ATTACHMENT_S3_BUCKET: 'moonwitness-attachments',
  ATTACHMENT_S3_ACCESS_KEY: 'GK00000000000000000000000000000000',
  ATTACHMENT_S3_SECRET_KEY: 'application-secret',
};

test('accepts production configuration pointing at the hosted Garage bucket', () => {
  assert.deepEqual(validateAttachmentStorageProductionEnvironment(validEnvironment), []);
});

test('rejects missing credentials and does not include secret values in diagnostics', () => {
  const invalid = { ...validEnvironment, ATTACHMENT_S3_SECRET_KEY: '' };
  const errors = validateAttachmentStorageProductionEnvironment(invalid);
  assert.ok(errors.some((error) => error.includes('ATTACHMENT_S3_SECRET_KEY')));
  assert.equal(errors.join('\n').includes('application-secret'), false);
});

test('rejects an access key that looks like a mangled copy-paste', () => {
  const errors = validateAttachmentStorageProductionEnvironment({
    ...validEnvironment,
    ATTACHMENT_S3_ACCESS_KEY: 'GK00000 0000000000000000000000000/',
  });
  assert.ok(errors.some((error) => error.includes('must not contain slash or whitespace')));
});

test('rejects inline endpoint credentials, malformed bucket names, and local driver', () => {
  const errors = validateAttachmentStorageProductionEnvironment({
    ...validEnvironment,
    ATTACHMENT_STORAGE_DRIVER: 'local',
    ATTACHMENT_S3_ENDPOINT: 'http://user:password@s3.example.com',
    ATTACHMENT_S3_BUCKET: 'invalid..bucket',
  });
  assert.ok(errors.some((error) => error.includes('must be s3')));
  assert.ok(errors.some((error) => error.includes('must not contain credentials')));
  assert.ok(errors.some((error) => error.includes('valid DNS-compatible')));
  assert.equal(errors.join('\n').includes('password'), false);
});

test('requires HTTPS for every attachment storage endpoint', () => {
  const errors = validateAttachmentStorageProductionEnvironment({
    ...validEnvironment,
    ATTACHMENT_S3_ENDPOINT: 'http://10.0.0.5:3984',
  });
  assert.ok(errors.some((error) => error.includes('must use HTTPS')));
  assert.deepEqual(
    validateAttachmentStorageProductionEnvironment({
      ...validEnvironment,
      ATTACHMENT_S3_ENDPOINT: 'https://garage.internal.example',
    }),
    []
  );
});

test('parses dotenv-style assignments while omitting comments', () => {
  assert.deepEqual(
    parseEnvFile(`
# secret values never appear in diagnostics
export ATTACHMENT_STORAGE_DRIVER=s3
ATTACHMENT_S3_ENDPOINT="https://s3.moonwitness.biz.id"
ATTACHMENT_S3_SECRET_KEY=has=equals
`),
    {
      ATTACHMENT_STORAGE_DRIVER: 's3',
      ATTACHMENT_S3_ENDPOINT: 'https://s3.moonwitness.biz.id',
      ATTACHMENT_S3_SECRET_KEY: 'has=equals',
    }
  );
});
