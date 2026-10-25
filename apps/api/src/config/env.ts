import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvConfig } from '@moonwitness/types';
import { readLocalAiConfig } from '@moonwitness/local-ai';
import { requireProductionDatabaseUrl } from './production.js';
import { readDatabaseRuntimeLimits } from './database-runtime.js';

const apiDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(apiDirectory, '../../../../');
dotenv.config({ path: path.join(repositoryRoot, '.env') });
requireProductionDatabaseUrl(process.env);
export const localAiConfig = readLocalAiConfig(process.env);

const nodeEnvironment = process.env.NODE_ENV ?? 'development';

function optionalBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

const metricsToken = process.env.METRICS_TOKEN || undefined;
if (metricsToken && metricsToken.length < 32) {
  throw new Error('METRICS_TOKEN must be at least 32 characters when configured');
}

function readPort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function readDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol and include a host');
  }
  return value;
}

const attachmentStorageDriver = process.env.ATTACHMENT_STORAGE_DRIVER ?? 'local';
if (attachmentStorageDriver !== 'local' && attachmentStorageDriver !== 's3') {
  throw new Error('ATTACHMENT_STORAGE_DRIVER must be local or s3');
}

function readS3StorageConfig(): EnvConfig['s3Storage'] {
  if (attachmentStorageDriver !== 's3') return undefined;
  const endpoint = process.env.ATTACHMENT_S3_ENDPOINT;
  const bucket = process.env.ATTACHMENT_S3_BUCKET;
  const accessKeyId = process.env.ATTACHMENT_S3_ACCESS_KEY;
  const secretAccessKey = process.env.ATTACHMENT_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'ATTACHMENT_S3_ENDPOINT, ATTACHMENT_S3_BUCKET, ATTACHMENT_S3_ACCESS_KEY, and ATTACHMENT_S3_SECRET_KEY are required when ATTACHMENT_STORAGE_DRIVER=s3'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('ATTACHMENT_S3_ENDPOINT must be a valid http or https URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('ATTACHMENT_S3_ENDPOINT must be a valid http or https URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('ATTACHMENT_S3_ENDPOINT must not contain embedded credentials');
  }
  return {
    endpoint: parsed.toString(),
    region: process.env.ATTACHMENT_S3_REGION || 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: optionalBoolean(
      process.env.ATTACHMENT_S3_FORCE_PATH_STYLE,
      true,
      'ATTACHMENT_S3_FORCE_PATH_STYLE'
    ),
  };
}

const databaseUrl = readDatabaseUrl(
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/moonwitness_db'
);
const databaseRuntime = readDatabaseRuntimeLimits(process.env);

export const config: EnvConfig = {
  superadminPassword: process.env.SUPERADMIN_PASSWORD || undefined,
  metricsToken,
  attachmentStorageDirectory: path.resolve(
    repositoryRoot,
    process.env.ATTACHMENT_STORAGE_DIR || 'storage/attachments'
  ),
  attachmentStorageDriver,
  s3Storage: readS3StorageConfig(),
  env: nodeEnvironment,
  host: process.env.API_HOST ?? process.env.HOST ?? '0.0.0.0',
  port: readPort(process.env.API_PORT ?? process.env.PORT),
  db: {
    client: 'pg',
    connection: databaseUrl,
    ...databaseRuntime,
  },
  log: {
    level: process.env.LOG_LEVEL,
    dir: path.resolve(repositoryRoot, process.env.LOG_DIR || 'logs'),
    fileName: process.env.LOG_FILE_NAME || 'api.log',
    enableFile: optionalBoolean(
      'LOG_TO_FILE' in process.env ? process.env.LOG_TO_FILE : undefined,
      nodeEnvironment !== 'production',
      'LOG_TO_FILE'
    ),
    prettyPrint: optionalBoolean(
      'LOG_PRETTY' in process.env ? process.env.LOG_PRETTY : undefined,
      nodeEnvironment !== 'production',
      'LOG_PRETTY'
    ),
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET || undefined,
    accessTtlSeconds: readPositiveInt('ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTtlSeconds: readPositiveInt('REFRESH_TOKEN_TTL_SECONDS', 14 * 24 * 60 * 60),
    loginRateMax: readPositiveInt('AUTH_LOGIN_RATE_MAX', 10),
  },
};
