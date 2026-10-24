import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const requiredNames = [
  'ATTACHMENT_STORAGE_DRIVER',
  'ATTACHMENT_S3_ENDPOINT',
  'ATTACHMENT_S3_BUCKET',
  'ATTACHMENT_S3_ACCESS_KEY',
  'ATTACHMENT_S3_SECRET_KEY',
];

export function parseEnvFile(source) {
  const entries = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2] ?? '';
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }
    entries[match[1]] = value;
  }
  return entries;
}

export function validateAttachmentStorageProductionEnvironment(environment) {
  const errors = [];
  for (const name of requiredNames) {
    if (typeof environment[name] !== 'string' || environment[name].trim().length === 0) {
      errors.push(`${name} is required`);
    }
  }

  if (errors.length > 0) return errors;
  if (environment.ATTACHMENT_STORAGE_DRIVER !== 's3') {
    errors.push('ATTACHMENT_STORAGE_DRIVER must be s3 for production Compose');
  }

  try {
    const endpoint = new URL(environment.ATTACHMENT_S3_ENDPOINT);
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      errors.push('ATTACHMENT_S3_ENDPOINT must use HTTP or HTTPS');
    }
    if (endpoint.protocol !== 'https:') {
      errors.push('ATTACHMENT_S3_ENDPOINT must use HTTPS; the bucket is reached over a public URL');
    }
    if (endpoint.username || endpoint.password) {
      errors.push('ATTACHMENT_S3_ENDPOINT must not contain credentials');
    }
  } catch {
    errors.push('ATTACHMENT_S3_ENDPOINT must be a valid URL');
  }

  const bucket = environment.ATTACHMENT_S3_BUCKET;
  if (
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(bucket) ||
    bucket.includes('..')
  ) {
    errors.push('ATTACHMENT_S3_BUCKET must be a valid DNS-compatible bucket name');
  }

  for (const name of ['ATTACHMENT_S3_ACCESS_KEY']) {
    if (environment[name].includes('/') || /\s/u.test(environment[name])) {
      errors.push(`${name} must not contain slash or whitespace`);
    }
  }
  return errors;
}

async function main() {
  const filePath = process.argv[2];
  const environment = filePath ? parseEnvFile(await readFile(filePath, 'utf8')) : process.env;
  const errors = validateAttachmentStorageProductionEnvironment(environment);
  if (errors.length > 0) {
    process.stderr.write(
      `Attachment storage production environment is invalid:\n${errors
        .map((error) => `- ${error}`)
        .join('\n')}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    'Attachment storage production environment is valid; secret values were not printed.\n'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `Could not read the attachment storage environment${error?.code === 'ENOENT' ? ': file not found' : ''}.\n`
    );
    process.exitCode = 1;
  });
}
