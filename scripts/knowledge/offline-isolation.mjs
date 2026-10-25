import process from 'node:process';

const permission = process.allowedNodeEnvironmentFlags.has('--permission')
  ? '--permission'
  : process.allowedNodeEnvironmentFlags.has('--experimental-permission')
    ? '--experimental-permission'
    : undefined;

/** Flag that turns the Node permission model on, when the runtime understands it. */
export const permissionFlag = permission;

/** Node only documents network permission from v25, so the flag list decides this, not the version. */
export const permissionDeniesNetwork =
  Boolean(permission) && process.allowedNodeEnvironmentFlags.has('--allow-net');

/** Linux can deny the child its network namespace through `sudo -n unshare --net`. */
export const linuxNamespaces = process.platform === 'linux' && Number.isInteger(process.getuid?.());

export const ISOLATION_REQUIREMENT =
  'requires the Node permission model with --allow-net or Linux network namespaces with passwordless sudo';

/**
 * Offline proofs are only meaningful when the child process genuinely cannot reach the network.
 * A developer workstation that offers neither mechanism skips instead of reporting a false defect.
 * CI keeps the recorded rule from `docs/roadmap/evidence/K1-005.md`: an environment that cannot deny
 * network access must fail the run rather than lose the proof to a skip.
 */
export function isolationSkip() {
  if (permissionDeniesNetwork || linuxNamespaces) return false;
  return process.env.CI ? false : ISOLATION_REQUIREMENT;
}
