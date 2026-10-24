import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { env, execPath, platform, stdout } from 'node:process';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  extractPackageVerificationErrorCode,
  renderPackageVerificationAnnotation,
} from './verification-diagnostics.mjs';

const execFileAsync = promisify(execFile);
const packageManager = platform === 'win32' ? (env.ComSpec ?? 'cmd.exe') : 'pnpm';
const packageManagerPrefix = platform === 'win32' ? ['/d', '/s', '/c', 'pnpm'] : [];
const packageRoot = resolve(import.meta.dirname, '..');
const tempRoot = await mkdtemp(join(tmpdir(), 'moonwitness-ui-package-'));
let verificationPhase = 'create package archive';

try {
  const packed = await execFileAsync(
    packageManager,
    [...packageManagerPrefix, 'pack', '--pack-destination', tempRoot],
    {
      cwd: packageRoot,
      windowsHide: true,
    }
  );
  verificationPhase = 'validate package archive';
  const archiveName = packed.stdout.match(/moonwitness-ui-[\w.-]+\.tgz/u)?.[0];
  assert.ok(archiveName, 'pnpm pack should report the generated archive');

  const consumerRoot = join(tempRoot, 'consumer');
  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  verificationPhase = 'read locked consumer dependency versions';
  const consumerDependencyNames = ['react', 'react-dom', 'radix-ui', 'cmdk'];
  const consumerDependencySpecs = await Promise.all(
    consumerDependencyNames.map(async (dependencyName) => {
      const dependencyPackagePath = join(
        packageRoot,
        'node_modules',
        dependencyName,
        'package.json'
      );
      const dependencyPackage = JSON.parse(await readFile(dependencyPackagePath, 'utf8'));
      assert.match(
        dependencyPackage.version,
        /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u,
        `Expected an exact installed version for ${dependencyName}`
      );
      return `${dependencyName}@${dependencyPackage.version}`;
    })
  );
  verificationPhase = 'install isolated consumer dependencies';
  await execFileAsync(
    packageManager,
    [
      ...packageManagerPrefix,
      'add',
      '--prefer-offline',
      '--ignore-workspace',
      '--save-exact',
      `file:${join(tempRoot, archiveName)}`,
      ...consumerDependencySpecs,
    ],
    { cwd: consumerRoot, windowsHide: true }
  );

  const source = `
import assert from 'node:assert/strict';
import { Button } from '@moonwitness/ui/components/button';
import { ArtworkFrame } from '@moonwitness/ui/components/artwork-frame';
import { Command, CommandInput } from '@moonwitness/ui/components/command';
import { Field } from '@moonwitness/ui/components/field';
import { Label } from '@moonwitness/ui/components/label';
import { MetricTile } from '@moonwitness/ui/components/metric-tile';
import { PaperNote } from '@moonwitness/ui/components/paper-note';
import { Pagination } from '@moonwitness/ui/components/pagination';
import { Popover, PopoverContent } from '@moonwitness/ui/components/popover';
import { Sheet, SheetContent } from '@moonwitness/ui/components/sheet';
import { SectionRibbon } from '@moonwitness/ui/components/section-ribbon';
import { Switch } from '@moonwitness/ui/components/switch';
import { Table } from '@moonwitness/ui/components/table';
import { Textarea } from '@moonwitness/ui/components/textarea';
import { UserIcon } from '@moonwitness/ui/icons/user';
assert.equal(typeof Button, 'function');
assert.equal(typeof ArtworkFrame, 'function');
assert.equal(typeof Command, 'function');
assert.equal(typeof CommandInput, 'function');
assert.equal(typeof Field, 'function');
assert.equal(typeof Label, 'function');
assert.equal(typeof MetricTile, 'function');
assert.equal(typeof PaperNote, 'function');
assert.equal(typeof Pagination, 'function');
assert.equal(typeof Popover, 'function');
assert.equal(typeof PopoverContent, 'function');
assert.equal(typeof Sheet, 'function');
assert.equal(typeof SheetContent, 'function');
assert.equal(typeof SectionRibbon, 'function');
assert.equal(typeof Switch, 'function');
assert.equal(typeof Table, 'function');
assert.equal(typeof Textarea, 'function');
assert.equal(typeof UserIcon, 'function');
let internalPathWasRejected = false;
try { await import('@moonwitness/ui/dist/components/button.js'); }
catch (error) { internalPathWasRejected = error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
assert.equal(internalPathWasRejected, true);
  `;
  const consumerFile = join(consumerRoot, 'consumer.mjs');
  await writeFile(consumerFile, source);
  verificationPhase = 'run consumer import smoke test';
  await execFileAsync(execPath, [consumerFile], {
    cwd: consumerRoot,
    windowsHide: true,
  });

  const packageJson = JSON.parse(
    await readFile(join(consumerRoot, 'node_modules/@moonwitness/ui/package.json'), 'utf8')
  );
  verificationPhase = 'validate public stylesheet exports';
  for (const stylesheet of ['./components.css', './styles/tokens.css']) {
    assert.ok(packageJson.exports[stylesheet], `Missing public CSS export ${stylesheet}`);
  }
  stdout.write('Packed consumer imports, private-path rejection, and CSS exports passed.\n');
} catch (error) {
  const errorCode = extractPackageVerificationErrorCode(error);
  stdout.write(renderPackageVerificationAnnotation(verificationPhase, errorCode));
  throw error;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
