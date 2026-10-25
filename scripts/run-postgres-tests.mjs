import { spawnSync } from 'node:child_process';
import { argv, env, stderr, exit } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePackageManager } from './package-manager.mjs';

const args = argv.slice(2);
const built = args.length === 1 && args[0] === '--built';
if (args.length > 0 && !built) {
  stderr.write('Usage: run-postgres-tests.mjs [--built]\n');
  exit(2);
}

const connectionString = env.POSTGRES_TEST_URL;
if (!connectionString) {
  stderr.write('POSTGRES_TEST_URL is required for test:integration.\n');
  exit(2);
}
const packageManager = resolvePackageManager();
if (!packageManager) {
  stderr.write(
    'Run test:integration through pnpm so the package manager can be resolved safely.\n'
  );
  exit(2);
}

const childEnvironment = {
  ...env,
  REQUIRE_POSTGRES_TESTS: 'true',
};
const reportDirectory = resolve('test-results/junit');
await mkdir(reportDirectory, { recursive: true });

for (const args of [
  ...(built ? [] : [['build']]),
  [
    '--filter',
    '@moonwitness/orm-knowledge',
    'exec',
    'vitest',
    'run',
    'tests/postgres.integration.test.ts',
    'tests/research-actor-identity.postgres.integration.test.ts',
    'tests/privacy-revocation.postgres.integration.test.ts',
    'tests/research-suggestion-store.postgres.integration.test.ts',
    '--reporter=default',
  ],
  ['--filter', '@moonwitness/api', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.integration.json'],
  // These suites share one PostgreSQL server; serial files avoid lock-test timeout contention.
  [
    '--filter',
    '@moonwitness/api',
    'exec',
    'vitest',
    'run',
    'tests/postgres.integration.test.ts',
    'tests/whatsapp-attachments-job.postgres.integration.test.ts',
    'tests/postgres.performance.integration.test.ts',
    'tests/local-retrieval.postgres.integration.test.ts',
    'tests/local-ai-suggestion.postgres.integration.test.ts',
    '--no-file-parallelism',
    '--reporter=default',
    '--reporter=junit',
    `--outputFile.junit=${resolve(reportDirectory, 'postgres.xml')}`,
  ],
]) {
  const result = spawnSync(packageManager.command, [...packageManager.prefixArgs, ...args], {
    env: childEnvironment,
    stdio: 'inherit',
    ...(packageManager.shell ? { shell: true } : {}),
  });
  if (result.error) {
    stderr.write(`${result.error.message}\n`);
    exit(1);
  }
  if (result.status !== 0) exit(result.status ?? 1);
}
