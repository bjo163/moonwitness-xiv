import { existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, stderr, stdout, exit, argv } from 'node:process';
import { URL } from 'node:url';
import { writeE2EPreflightFailure } from './e2e-preflight-report.mjs';
import { renderWorkspaceBuildFailure } from './ci/workspace-build-diagnostics.mjs';
import { resolvePackageManager } from './package-manager.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = resolve(root, 'apps/board/playwright.config.ts');
const args = argv.slice(2);
const built = args[0] === '--built';
const forwardedArgs = built ? args.slice(1) : args;
const playwrightArgs = forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
if (!env.POSTGRES_TEST_URL) {
  stderr.write('POSTGRES_TEST_URL is required for test:e2e.\n');
  exit(2);
}
let testDatabaseName;
let testDatabaseHostname;
try {
  const testDatabaseUrl = new URL(env.POSTGRES_TEST_URL);
  if (!['postgres:', 'postgresql:'].includes(testDatabaseUrl.protocol)) {
    throw new Error('The E2E database URL must use PostgreSQL.');
  }
  testDatabaseName = decodeURIComponent(testDatabaseUrl.pathname.slice(1));
  testDatabaseHostname = testDatabaseUrl.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
} catch {
  stderr.write('POSTGRES_TEST_URL must be a valid PostgreSQL connection URL.\n');
  exit(2);
}
const loopbackHost =
  testDatabaseHostname === 'localhost' ||
  testDatabaseHostname === '::1' ||
  (isIP(testDatabaseHostname) === 4 && Number(testDatabaseHostname.split('.')[0]) === 127);
if (!loopbackHost || !/(?:^|[_-])(?:test|e2e|ci)(?:$|[_-])/iu.test(testDatabaseName)) {
  stderr.write(
    'Refusing E2E setup: POSTGRES_TEST_URL must target a loopback database named for test, e2e, or ci.\n'
  );
  exit(2);
}
if (!existsSync(config)) {
  stderr.write('E2E is not configured yet; complete roadmap task M3.01 before running test:e2e.\n');
  exit(2);
}
const junitDirectory = resolve(root, 'test-results/junit');
await mkdir(junitDirectory, { recursive: true });
await Promise.all(
  ['board-e2e.xml', 'board-e2e-retries.json'].map(async (file) => {
    try {
      await unlink(resolve(junitDirectory, file));
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  })
);

async function runPreflight(stage, command, args, commandEnv = env) {
  stderr.write(`Running Board E2E preflight: ${stage}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: commandEnv,
    ...(stage === 'build-api'
      ? { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      : { stdio: 'inherit' }),
  });
  if (stage === 'build-api') stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error || result.status !== 0) {
    if (result.error) stderr.write(`Could not start Board E2E preflight stage: ${stage}.\n`);
    const details =
      stage === 'build-api'
        ? renderWorkspaceBuildFailure(
            `${result.stdout ?? ''}${result.stderr ?? ''}`,
            result.status ?? 1
          )
        : undefined;
    await writeE2EPreflightFailure(junitDirectory, stage, result.status ?? 1, details);
    exit(result.status ?? 1);
  }
}

const packageManager = resolvePackageManager();
if (!packageManager) {
  stderr.write('Run test:e2e through pnpm so the package manager can be resolved safely.\n');
  await writeE2EPreflightFailure(junitDirectory, 'pnpm-invocation', 2);
  exit(2);
}

await runPreflight('flaky-policy', 'node', ['scripts/check-flaky-policy.mjs']);
// The Board web server serves apps/board/public, which is not checked in; without this
// copy every /illustrations, /brand and /sounds request in the browser lane returns 404.
await runPreflight('board-public-assets', 'node', ['scripts/copy-board-public-assets.mjs']);
if (built) {
  stderr.write('Using the existing workspace build for Board E2E.\n');
} else {
  await runPreflight('build-api', 'node', [
    'scripts/ci/build-workspace.mjs',
    '@moonwitness/api...',
  ]);
  await runPreflight(
    'build-ui',
    packageManager.command,
    [...packageManager.prefixArgs, '--filter', '@moonwitness/ui', 'build'],
    { ...env, ...(packageManager.shell ? { shell: true } : {}) }
  );
}

const e2ePassword = env.MW_E2E_SUPERADMIN_PASSWORD ?? 'e2e-only-password';
await runPreflight(
  'reset-superadmin-password',
  packageManager.command,
  [
    ...packageManager.prefixArgs,
    '--filter',
    '@moonwitness/api',
    'run',
    'reset:superadmin-password',
  ],
  {
    ...env,
    DATABASE_URL: env.POSTGRES_TEST_URL,
    SUPERADMIN_PASSWORD: e2ePassword,
    ...(packageManager.shell ? { shell: true } : {}),
  },
  packageManager.command
);

await runPreflight(
  'seed-knowledge-search-fixture',
  packageManager.command,
  [
    ...packageManager.prefixArgs,
    '--filter',
    '@moonwitness/api',
    'exec',
    'tsx',
    'src/commands/seed-knowledge-e2e.ts',
  ],
  {
    ...env,
    DATABASE_URL: env.POSTGRES_TEST_URL,
    ...(packageManager.shell ? { shell: true } : {}),
  }
);

stderr.write('Starting Board E2E tests with Playwright.\n');
const result = spawnSync(
  packageManager.command,
  [
    ...packageManager.prefixArgs,
    'exec',
    'playwright',
    'test',
    '--config',
    'apps/board/playwright.config.ts',
    ...playwrightArgs,
  ],
  {
    cwd: root,
    env: { ...env, ...(built ? { MW_E2E_USE_BUILT_API: 'true' } : {}) },
    stdio: 'inherit',
    ...(packageManager.shell ? { shell: true } : {}),
  }
);
if (
  result.error ||
  (result.status !== 0 && !existsSync(resolve(junitDirectory, 'board-e2e.xml')))
) {
  if (result.error) stderr.write('Could not start the Playwright test process.\n');
  await writeE2EPreflightFailure(junitDirectory, 'start-playwright', result.status ?? 1);
}
exit(result.status ?? 1);
