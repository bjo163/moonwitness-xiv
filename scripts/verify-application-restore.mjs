import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { resolvePackageManager } from './package-manager.mjs';

const maintenanceUrl = process.env.POSTGRES_TEST_URL;
if (!maintenanceUrl) {
  process.stderr.write('POSTGRES_TEST_URL is required for the isolated restore drill.\n');
  process.exit(2);
}

let parsedMaintenanceUrl;
try {
  parsedMaintenanceUrl = new URL(maintenanceUrl);
} catch {
  process.stderr.write('POSTGRES_TEST_URL must be a PostgreSQL URL.\n');
  process.exit(2);
}
if (!['postgres:', 'postgresql:'].includes(parsedMaintenanceUrl.protocol)) {
  process.stderr.write('POSTGRES_TEST_URL must use the PostgreSQL protocol.\n');
  process.exit(2);
}
const normalizedHost = parsedMaintenanceUrl.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
const loopbackHost =
  normalizedHost === 'localhost' ||
  normalizedHost === '::1' ||
  /^127(?:\.\d{1,3}){3}$/u.test(normalizedHost);
const maintenanceDatabase = decodeURIComponent(parsedMaintenanceUrl.pathname.slice(1));
if (!loopbackHost || !/(?:^|[_-])(?:test|e2e|ci)(?:$|[_-])/iu.test(maintenanceDatabase)) {
  process.stderr.write(
    'Restore drill refused: POSTGRES_TEST_URL must use a loopback host and a test/e2e/ci database name.\n'
  );
  process.exit(2);
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const sourceName = `mw_restore_src_${suffix}`;
const targetName = `mw_restore_dst_${suffix}`;
const sourceUrl = new URL(maintenanceUrl);
sourceUrl.pathname = `/${sourceName}`;
const targetUrl = new URL(maintenanceUrl);
targetUrl.pathname = `/${targetName}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'moonwitness-restore-drill-'));
const expectationsFile = join(temporaryDirectory, 'expectations.json');
const backupFileDirectory = join(temporaryDirectory, 'backups');
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const postgresImage = process.env.POSTGRES_TOOL_IMAGE || 'postgres:16-bookworm';
const fixtureJwtSecret = randomBytes(32).toString('base64url');
const nativePostgresTools = ['bash', 'createdb', 'dropdb', 'pg_dump', 'pg_restore', 'psql'];
const missingNativeTools = nativePostgresTools.filter(
  (command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).error
);
const useDockerTools = process.platform === 'win32' || missingNativeTools.length > 0;
await chmod(temporaryDirectory, 0o700);
const fixturePassword = randomBytes(32).toString('base64url');

function safeDatabaseUrl(databaseUrl, useContainerHost = false) {
  const url = new URL(databaseUrl);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (useContainerHost && ['localhost', '127.0.0.1', '::1'].includes(host)) {
    url.hostname = 'host.docker.internal';
  }
  url.password = '';
  return url.toString();
}

function containerUrl(databaseUrl) {
  return safeDatabaseUrl(databaseUrl, true);
}

function spawnPostgresTool(command, args, options = {}) {
  const environment = options.env ?? process.env;
  const connectionUrls = [
    ...(environment.DATABASE_URL ? [environment.DATABASE_URL] : []),
    ...args.flatMap((argument) => {
      if (typeof argument !== 'string') return [];
      if (argument.startsWith('--maintenance-db='))
        return [argument.slice('--maintenance-db='.length)];
      if (argument.startsWith('--dbname=')) return [argument.slice('--dbname='.length)];
      return /^postgres(?:ql)?:\/\//iu.test(argument) ? [argument] : [];
    }),
  ];
  const connectionPassword = connectionUrls
    .map((value) => {
      try {
        return decodeURIComponent(new URL(value).password);
      } catch {
        return '';
      }
    })
    .find((value) => value.length > 0);
  if (!useDockerTools) {
    const safeArgs = args.map((argument) => {
      if (typeof argument !== 'string') return argument;
      if (argument.startsWith('--maintenance-db=')) {
        return `--maintenance-db=${safeDatabaseUrl(argument.slice('--maintenance-db='.length))}`;
      }
      if (argument.startsWith('--dbname=')) {
        return `--dbname=${safeDatabaseUrl(argument.slice('--dbname='.length))}`;
      }
      return /^postgres(?:ql)?:\/\//iu.test(argument) ? safeDatabaseUrl(argument) : argument;
    });
    return spawnSync(command, safeArgs, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
      env: {
        ...environment,
        ...(environment.DATABASE_URL
          ? { DATABASE_URL: safeDatabaseUrl(environment.DATABASE_URL) }
          : {}),
        ...(connectionPassword
          ? { PGPASSWORD: connectionPassword }
          : environment.PGPASSWORD
            ? { PGPASSWORD: environment.PGPASSWORD }
            : {}),
      },
    });
  }
  const mappedArgs = args.map((argument) => {
    if (typeof argument !== 'string') return argument;
    if (argument.startsWith('--maintenance-db=')) {
      return `--maintenance-db=${containerUrl(argument.slice('--maintenance-db='.length))}`;
    }
    if (argument.startsWith('--dbname=')) {
      return `--dbname=${containerUrl(argument.slice('--dbname='.length))}`;
    }
    if (
      (command === 'psql' || command === 'createdb' || command === 'dropdb') &&
      /^postgres(?:ql)?:\/\//iu.test(argument)
    ) {
      return containerUrl(argument);
    }
    if (argument === '--file') return argument;
    if (argument.startsWith('--file=')) {
      return `--file=/restore-drill/backups/${basename(argument.slice('--file='.length))}`;
    }
    if (
      ['pg_restore'].includes(command) &&
      argument.length > 0 &&
      !argument.startsWith('-') &&
      (argument.includes('/') || argument.includes('\\'))
    ) {
      return `/restore-drill/backups/${basename(argument)}`;
    }
    return argument;
  });
  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '--add-host=host.docker.internal:host-gateway',
    '--mount',
    `type=bind,source=${scriptsDirectory},target=/workspace/scripts,readonly`,
    '--mount',
    `type=bind,source=${temporaryDirectory},target=/restore-drill`,
    ...Object.keys({
      ...environment,
      ...(connectionPassword ? { PGPASSWORD: connectionPassword } : {}),
    }).flatMap((name) =>
      [
        'DATABASE_URL',
        'BACKUP_DIR',
        'BACKUP_FILE',
        'ALLOW_DATABASE_RESTORE',
        'PGPASSWORD',
      ].includes(name)
        ? ['--env', name]
        : []
    ),
    postgresImage,
    command,
    ...mappedArgs,
  ];
  return spawnSync('docker', dockerArgs, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
    env: {
      ...environment,
      ...(environment.DATABASE_URL ? { DATABASE_URL: containerUrl(environment.DATABASE_URL) } : {}),
      ...(environment.BACKUP_DIR ? { BACKUP_DIR: '/restore-drill/backups' } : {}),
      ...(environment.BACKUP_FILE
        ? { BACKUP_FILE: `/restore-drill/backups/${basename(environment.BACKUP_FILE)}` }
        : {}),
      ...(connectionPassword
        ? { PGPASSWORD: connectionPassword }
        : environment.PGPASSWORD
          ? { PGPASSWORD: environment.PGPASSWORD }
          : {}),
    },
  });
}

function runPostgresTool(command, args, options = {}) {
  const result = spawnPostgresTool(command, args, options);
  if (result.error || result.status !== 0) {
    const diagnostics = [result.stderr, result.stdout]
      .filter((output) => typeof output === 'string' && output.length > 0)
      .join('\n')
      .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[PostgreSQL URL redacted]')
      .replace(/((?:password|secret|token)(?:_hash)?\s*(?:=|:)\s*)[^,\s)]+/giu, '$1[redacted]')
      .split(/\r?\n/u)
      .slice(-10)
      .join('\n')
      .slice(-1600);
    throw new Error(
      `PostgreSQL ${useDockerTools ? 'Docker' : 'host'} utility ${command} failed${result.status === null ? '' : ` with exit ${result.status}`}${result.error ? `: ${result.error.message}` : ''}${diagnostics ? `:\n${diagnostics}` : ''}`
    );
  }
  return result.stdout.trim();
}

function run(command, args, options = {}) {
  const resolved =
    command === 'pnpm' && process.platform === 'win32'
      ? resolvePackageManager()
      : { command, prefixArgs: [], shell: false };
  if (!resolved) throw new Error(`Could not resolve executable: ${command}`);
  const result = spawnSync(resolved.command, [...resolved.prefixArgs, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: resolved.shell,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const diagnostics = [result.stderr, result.stdout]
      .filter((output) => typeof output === 'string' && output.length > 0)
      .join('\n')
      .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[PostgreSQL URL redacted]')
      .split(/\r?\n/u)
      .slice(-10)
      .join('\n')
      .slice(-1600);
    throw new Error(
      `${command} failed${result.status === null ? '' : ` with exit ${result.status}`}${result.error ? `: ${result.error.message}` : ''}${diagnostics ? `:\n${diagnostics}` : ''}`
    );
  }
  return result.stdout.trim();
}

function invokeFixture(mode, databaseUrl) {
  return JSON.parse(
    run(
      'pnpm',
      [
        '--filter',
        '@moonwitness/api',
        'exec',
        'tsx',
        'src/commands/restore-drill-fixture.ts',
        mode,
      ],
      {
        env: {
          ...process.env,
          JWT_SECRET: fixtureJwtSecret,
          RESTORE_DRILL_DATABASE_URL: databaseUrl,
          RESTORE_DRILL_EXPECTATIONS_FILE: expectationsFile,
          RESTORE_DRILL_PASSWORD: fixturePassword,
        },
      }
    )
  );
}

async function main() {
  const report = {};
  let createdSource = false;
  let createdTarget = false;
  try {
    runPostgresTool('createdb', [`--maintenance-db=${maintenanceUrl}`, sourceName]);
    createdSource = true;
    runPostgresTool('createdb', [`--maintenance-db=${maintenanceUrl}`, targetName]);
    createdTarget = true;

    report.fixtureSeed = invokeFixture('seed', sourceUrl.toString());
    const backupStarted = performance.now();
    const backupPath = runPostgresTool(
      'bash',
      [
        useDockerTools
          ? '/workspace/scripts/backup-postgres.sh'
          : join(scriptsDirectory, 'backup-postgres.sh'),
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: sourceUrl.toString(),
          BACKUP_DIR: backupFileDirectory,
        },
      }
    );
    let backupFile = backupPath;
    if (useDockerTools) {
      if (!backupPath.startsWith('/restore-drill/backups/')) {
        throw new Error(
          'PostgreSQL backup script returned a path outside the isolated drill directory'
        );
      }
      backupFile = join(backupFileDirectory, basename(backupPath));
    }
    report.backupDurationMs = Math.round(performance.now() - backupStarted);
    report.backupFileMode = '0600';

    const restoreEnvironment = {
      ...process.env,
      DATABASE_URL: targetUrl.toString(),
      BACKUP_FILE: backupFile,
      ALLOW_DATABASE_RESTORE: 'true',
    };
    runPostgresTool('psql', [
      targetUrl.toString(),
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "CREATE TABLE restore_drill_confirmation_sentinel (value text PRIMARY KEY); INSERT INTO restore_drill_confirmation_sentinel VALUES ('unchanged');",
    ]);
    const restoreScript = useDockerTools
      ? '/workspace/scripts/restore-postgres.sh'
      : join(scriptsDirectory, 'restore-postgres.sh');
    const mismatch = spawnPostgresTool('bash', [restoreScript], {
      encoding: 'utf8',
      input: 'wrong-database-confirmation\n',
      env: restoreEnvironment,
    });
    if (mismatch.error || mismatch.status !== 2 || !mismatch.stderr.includes('restore cancelled')) {
      const diagnostics = [mismatch.error?.message, mismatch.stderr, mismatch.stdout]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join('\n')
        .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[PostgreSQL URL redacted]')
        .slice(-1200);
      throw new Error(
        `Restore script did not reject a mismatched database confirmation (exit ${mismatch.status ?? 'unavailable'})${diagnostics ? `:\n${diagnostics}` : ''}`
      );
    }
    const targetAfterMismatch = runPostgresTool('psql', [
      targetUrl.toString(),
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'SELECT value FROM restore_drill_confirmation_sentinel',
    ]);
    if (targetAfterMismatch !== 'unchanged') {
      throw new Error('Target database changed after the mismatched confirmation');
    }
    runPostgresTool('psql', [
      targetUrl.toString(),
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP TABLE restore_drill_confirmation_sentinel',
    ]);

    const restoreStarted = performance.now();
    const restore = spawnPostgresTool('bash', [restoreScript], {
      encoding: 'utf8',
      input: `${targetName}\n`,
      env: restoreEnvironment,
    });
    if (restore.error || restore.status !== 0) throw new Error('PostgreSQL restore failed');
    report.restoreDurationMs = Math.round(performance.now() - restoreStarted);

    report.fixtureVerification = invokeFixture('verify', targetUrl.toString());
    report.status = 'passed';
    report.sourceAndTargetWereIsolated = true;
    report.postgresToolRuntime = useDockerTools ? 'docker' : 'host';
    if (missingNativeTools.length > 0) report.missingNativeTools = missingNativeTools;
    report.postgresToolImage = postgresImage;
    report.mismatchedConfirmationRejected = true;
    report.rpo = 'not-established-by-this-one-off-drill; backup scheduling is infrastructure-owned';
    report.rtoScope =
      'measured backup and PostgreSQL restore duration for this synthetic dataset only; excludes infrastructure provisioning and traffic cutover';
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    try {
      if (createdTarget) {
        runPostgresTool('dropdb', [
          `--maintenance-db=${maintenanceUrl}`,
          '--if-exists',
          targetName,
        ]);
      }
      if (createdSource) {
        runPostgresTool('dropdb', [
          `--maintenance-db=${maintenanceUrl}`,
          '--if-exists',
          sourceName,
        ]);
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Restore drill failed'}\n`);
  process.exitCode = 1;
});
