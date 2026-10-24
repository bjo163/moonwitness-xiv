import { spawnSync } from 'node:child_process';
import process, { execPath } from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// Read-only drift checks. Build changed packages before running this command.
// Required CI checks and approvals still decide whether a candidate can release.
const checks = [
  ['Workspace Docker manifests', ['--test', 'scripts/docker-workspace-manifests.test.mjs']],
  ['Architecture artifacts', ['scripts/architecture/generate-diagrams.mjs', '--check']],
  ['Generated documentation', ['scripts/docs/generate-reference.mjs', '--check']],
  ['README workspace inventory', ['scripts/docs/update-readme.mjs', '--check']],
  ['Roadmap contracts', ['scripts/roadmap/validate-roadmap.mjs']],
];

let failed = false;
for (const [label, args] of checks) {
  process.stdout.write(`\n${label}\n`);
  const result = spawnSync(execPath, args, {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
