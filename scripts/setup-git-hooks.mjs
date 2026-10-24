import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error(
    'Could not configure Git to use the repository pre-push hook. Run `pnpm hooks:install` from the repository root.'
  );
  process.exit(result.status ?? 1);
}
console.log('Git pre-push hook installed for this checkout.');
