import { mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderUnitRunnerFailureReport } from './unit-runner-report.mjs';
import { resolvePackageManager } from './package-manager.mjs';
import { unitRunnerChecks } from './unit-runner-policy.mjs';
import {
  findFailedWorkspacePackage,
  renderWorkspaceBuildFailure,
  summarizeWorkspaceBuildDiagnostics,
} from './ci/workspace-build-diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDirectory = path.join(root, 'test-results', 'junit');
const packageManager = resolvePackageManager();
if (!packageManager) {
  process.stderr.write(
    'Run test:unit:ci through pnpm so the package manager can be resolved safely.\n'
  );
  process.exit(2);
}

await mkdir(reportDirectory, { recursive: true });

function run(args, label) {
  const result = spawnSync(packageManager.command, [...packageManager.prefixArgs, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...(packageManager.shell ? { shell: true } : {}),
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  if (result.error) {
    writeFileSync(
      path.join(reportDirectory, 'unit-runner.xml'),
      renderUnitRunnerFailureReport(label, 1),
      'utf8'
    );
    process.stderr.write(`${label} could not be started.\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const buildFailure =
      label === 'Build' ? renderWorkspaceBuildFailure(output, result.status ?? 1) : undefined;
    writeFileSync(
      path.join(reportDirectory, 'unit-runner.xml'),
      renderUnitRunnerFailureReport(label, result.status ?? 1, buildFailure),
      'utf8'
    );
    if (buildFailure && process.env.GITHUB_STEP_SUMMARY) {
      const summary = [
        '## Workspace build failure diagnostics',
        '',
        `- Failed package: ${buildFailure.failedPackage ?? 'unknown package'}`,
        `- Exit code: ${buildFailure.exitCode}`,
        ...(buildFailure.diagnostics.length > 0
          ? buildFailure.diagnostics.map(
              (item) => `- TypeScript: \`${item.path}:${item.line}:${item.column}\` — ${item.code}`
            )
          : ['- No allowlisted TypeScript location could be extracted from this build output.']),
        '',
      ].join('\n');
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a', encoding: 'utf8' });
    }
    if (label === 'Build') {
      const diagnostics = summarizeWorkspaceBuildDiagnostics(output);
      for (const diagnostic of diagnostics) {
        process.stdout.write(
          `::error file=${diagnostic.path},line=${diagnostic.line},col=${diagnostic.column},title=Workspace build ${diagnostic.code}::See compiler details in the runner log.\n`
        );
      }
      if (diagnostics.length === 0) {
        const packageName = findFailedWorkspacePackage(output);
        const subject = packageName ? ` for ${packageName}` : '';
        process.stdout.write(
          `::error title=Workspace build failed::Recursive build${subject} exited ${result.status ?? 1}; see the runner log.\n`
        );
      }
    }
    process.stderr.write(`${label} failed with exit code ${result.status ?? 1}\n`);
    process.exit(result.status ?? 1);
  }
}

run(['run', 'test:unit-runner-policy'], 'Unit runner CI ownership policy');
run(['build'], 'Build');
run(['--filter', '@moonwitness/whatsapp', 'test'], 'WhatsApp worker');
run(['exec', 'node', '--test', 'scripts/roadmap/addon-conformance.test.mjs'], 'Addon conformance');
for (const check of unitRunnerChecks) {
  run(check.args, check.name);
}

const suites = [
  {
    name: 'api',
    packageName: '@moonwitness/api',
    excludePostgres: true,
    maxWorkers: 2,
    coverage: ['src/auth/policy.ts', 'src/auth/rules.ts'],
  },
  {
    name: 'auth',
    packageName: '@moonwitness/auth',
    typecheck: true,
    coverage: ['src/service.ts', 'src/refresh-token.ts'],
  },
  { name: 'client', packageName: '@moonwitness/client', typecheck: true },
  { name: 'jobs', packageName: '@moonwitness/jobs', typecheck: true, coverage: ['src/runtime.ts'] },
  { name: 'logger', packageName: '@moonwitness/logger' },
  { name: 'orm', packageName: '@moonwitness/orm', coverage: ['src/addon.ts'] },
  {
    name: 'orm-base',
    packageName: '@moonwitness/orm-base',
    typecheck: true,
    coverage: ['src/manifest.ts', 'src/data.ts'],
  },
  {
    name: 'orm-integration',
    packageName: '@moonwitness/orm-integration',
    typecheck: true,
    coverage: ['src/webhook-security.ts', 'src/runtime.ts'],
  },
  {
    name: 'orm-notification',
    packageName: '@moonwitness/orm-notification',
    typecheck: true,
    coverage: ['src/manifest.ts', 'src/runtime.ts'],
  },
  { name: 'orm-request', packageName: '@moonwitness/orm-request', typecheck: true },
  {
    name: 'orm-storage',
    packageName: '@moonwitness/orm-storage',
    typecheck: true,
    coverage: ['src/index.ts'],
  },
  {
    name: 'orm-workflow',
    packageName: '@moonwitness/orm-workflow',
    typecheck: true,
    coverage: ['src/manifest.ts', 'src/runtime.ts'],
  },
  {
    name: 'orm-organization',
    packageName: '@moonwitness/orm-organization',
    typecheck: true,
    coverage: ['src/validation.ts'],
  },
  {
    name: 'orm-knowledge',
    packageName: '@moonwitness/orm-knowledge',
    typecheck: true,
  },
  {
    name: 'knowledge',
    packageName: '@moonwitness/knowledge',
    typecheck: true,
    typecheckConfig: 'tsconfig.test.json',
  },
  {
    name: 'corpus',
    packageName: '@moonwitness/corpus',
    typecheck: true,
    typecheckConfig: 'tsconfig.test.json',
  },
];

for (const suite of suites) {
  if (suite.typecheck) {
    run(
      [
        '--filter',
        suite.packageName,
        'exec',
        'tsc',
        '-p',
        suite.typecheckConfig ?? 'tsconfig.check.json',
      ],
      `${suite.name} typecheck`
    );
  }
  const args = ['--filter', suite.packageName, 'exec', 'vitest', 'run'];
  if (suite.maxWorkers) args.push(`--maxWorkers=${suite.maxWorkers}`);
  if (suite.excludePostgres) {
    args.push(
      '--exclude',
      'tests/postgres.integration.test.ts',
      '--exclude',
      'tests/postgres.performance.integration.test.ts'
    );
  }
  args.push(
    '--reporter=default',
    '--reporter=junit',
    `--outputFile.junit=${path.join(reportDirectory, `${suite.name}.xml`)}`
  );
  if (suite.coverage) {
    args.push(
      '--coverage',
      '--coverage.provider=v8',
      '--coverage.reporter=json',
      '--coverage.reporter=json-summary',
      ...suite.coverage.map((file) => `--coverage.include=${file}`),
      `--coverage.reportsDirectory=${path.join(root, 'test-results', 'coverage', suite.name)}`
    );
  }
  run(args, `${suite.name} tests`);
}

run(['run', 'test:knowledge-cli:built'], 'Knowledge offline validator CLI');
run(['exec', 'node', 'scripts/check-coverage.mjs'], 'Critical branch coverage');
process.stdout.write(`JUnit reports written to ${path.relative(root, reportDirectory)}\n`);
