export interface EnvConfig {
  superadminPassword?: string;
  metricsToken?: string;
  attachmentStorageDirectory: string;
  attachmentStorageDriver: 'local' | 's3';
  s3Storage?: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  env: string;
  host: string;
  port: number;
  db: {
    client: string;
    connection: string;
    poolMin: number;
    poolMax: number;
    acquireTimeoutMs: number;
    statementTimeoutMs: number;
  };
  log?: {
    level?: string;
    dir?: string;
    fileName?: string;
    enableFile?: boolean;
    prettyPrint?: boolean;
  };
  auth?: {
    /** Persistent HMAC secret for access tokens; required in every environment (>= 32 chars). */
    jwtSecret?: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    /** Max login attempts per IP per minute. */
    loginRateMax: number;
  };
}
