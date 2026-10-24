import { spawn } from 'node:child_process';

const mode = process.argv[2];
const scripts = {
  dev: ['dev', 'jobs:outbox', 'dev'],
  start: ['start', 'jobs:outbox', 'start'],
  'start:built': ['start:built', 'jobs:outbox', 'start:built'],
};
const selected = scripts[mode];
if (!selected) throw new Error('Expected dev, start, or start:built');

const packages = ['@moonwitness/api', '@moonwitness/api', '@moonwitness/board'];
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

for (let index = 0; index < selected.length; index++) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(command, ['--filter', packages[index], selected[index]], {
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
