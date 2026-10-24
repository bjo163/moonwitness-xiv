import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('API startup bootstrap', () => {
  it('reports sanitized diagnostics for configuration import failures', () => {
    const secret = 'short-metrics-secret-value';
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: apiRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://test:db-password@127.0.0.1:5432/moonwitness_test',
        METRICS_TOKEN: secret,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain('"event":"api_startup_failure"');
    expect(output).toContain('METRICS_TOKEN must be at least 32 characters');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('db-password');
  });
});
