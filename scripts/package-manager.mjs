import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { env, execPath, platform } from 'node:process';

/** Resolve the pnpm executable for both direct CLI use and CI shell invocations. */
export function resolvePackageManager(environment = env, operatingSystem = platform) {
  const cli = environment.npm_execpath;
  if (typeof cli === 'string' && cli.length > 0 && existsSync(cli)) {
    return { command: execPath, prefixArgs: [cli], shell: false };
  }

  let command = 'pnpm';
  let prefixArgs = [];
  if (operatingSystem === 'win32') {
    const locatedShim = spawnSync('where.exe', ['pnpm.cmd'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const shimPaths =
      locatedShim.status === 0
        ? locatedShim.stdout
            .split(/\r?\n/u)
            .map((path) => path.trim())
            .filter(Boolean)
        : [];
    const pnpmCli = shimPaths
      .flatMap((shimPath) => {
        const adjacentCli = ['mjs', 'cjs'].map((extension) =>
          join(dirname(shimPath), 'node_modules', 'pnpm', 'bin', `pnpm.${extension}`)
        );
        let shimSource = '';
        try {
          shimSource = readFileSync(shimPath, 'utf8');
        } catch {
          // A stale PATH entry should not prevent trying the next shim.
        }
        const referencedCli = [
          ...shimSource.matchAll(/["']([^"'\r\n]*pnpm\.(?:mjs|cjs|js))["']/giu),
        ]
          .map((match) => match[1])
          .filter((path) => typeof path === 'string')
          .map((path) => resolve(path.replaceAll('%~dp0', `${dirname(shimPath)}${sep}`)));
        return [...adjacentCli, ...referencedCli];
      })
      .find((path) => existsSync(path));
    if (!pnpmCli) return undefined;
    command = execPath;
    prefixArgs = [pnpmCli];
  }
  const probe = spawnSync(command, [...prefixArgs, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0 || probe.error) return undefined;
  return { command, prefixArgs, shell: false };
}
