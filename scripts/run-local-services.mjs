import { spawn } from 'node:child_process';
import { localServiceScripts } from './local-service-scripts.mjs';

const mode = process.argv[2];
const selected = localServiceScripts[mode];
if (!selected) throw new Error('Expected dev, start, or start:built');

const processes = [];
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.unref();
    } else {
      child.kill('SIGTERM');
    }
  }
  process.exitCode = code;
}

for (const [packageName, script] of selected) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(command, ['--filter', packageName, script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  processes.push(child);
  child.on('error', () => stopAll(1));
  child.on('exit', (code, signal) => {
    if (!stopping) stopAll(code ?? (signal ? 1 : 0));
  });
}

process.on('SIGINT', () => stopAll(130));
process.on('SIGTERM', () => stopAll(143));
