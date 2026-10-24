import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const scriptPath = fileURLToPath(new URL('./check-docs-publication.mjs', import.meta.url));

function withSite(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-docs-site-'));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function scan(directory) {
  return spawnSync(process.execPath, [scriptPath, directory], { encoding: 'utf8' });
}

test('accepts static public output without secrets or source maps', () => {
  withSite((directory) => {
    fs.writeFileSync(path.join(directory, 'index.html'), '<main>MoonWitness docs</main>');
    fs.writeFileSync(path.join(directory, 'build-info.json'), '{"sourceSha":"a"}');
    assert.equal(scan(directory).status, 0);
  });
});

test('rejects credential-like values in public output', () => {
  withSite((directory) => {
    fs.writeFileSync(
      path.join(directory, 'index.html'),
      'const password="synthetic-super-secret-value"'
    );
    const result = scan(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Potential secret detected/);
  });
});

test('rejects common provider tokens, bearer credentials, JWTs, and unquoted secret assignments', () => {
  const credentials = [
    `Authorization: Bearer ${'a'.repeat(32)}`,
    `provider key: AIza${'A'.repeat(35)}`,
    `registry token: npm_${'a'.repeat(36)}`,
    `messaging token: xoxb-${'1'.repeat(12)}-${'2'.repeat(12)}-${'a'.repeat(24)}`,
    `AI client key: sk-proj-${'c'.repeat(30)}`,
    `payment key: sk_live_${'d'.repeat(24)}`,
    `session: eyJ${'a'.repeat(16)}.${'b'.repeat(16)}.${'c'.repeat(16)}`,
    `password=${'a'.repeat(24)}`,
  ];

  for (const [index, credential] of credentials.entries()) {
    withSite((directory) => {
      fs.writeFileSync(path.join(directory, `sample-${index}.txt`), credential);
      const result = scan(directory);
      assert.equal(result.status, 1, `expected fixture ${index} to be rejected`);
      assert.match(result.stderr, /Potential secret detected/);
    });
  }
});

test('rejects credential-like values in BOM-marked UTF-16 public files', () => {
  const credential = 'password="synthetic-super-secret-value"';
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(credential, 'utf16le')]);
  const utf16beBody = Buffer.from(credential, 'utf16le').swap16();
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody]);

  for (const [name, contents] of [
    ['sample-le.txt', utf16le],
    ['sample-be.txt', utf16be],
  ]) {
    withSite((directory) => {
      fs.writeFileSync(path.join(directory, name), contents);
      const result = scan(directory);
      assert.equal(result.status, 1, `expected ${name} to be rejected`);
      assert.match(result.stderr, /Potential secret detected/);
    });
  }
});

test('rejects credential-like values in BOM-marked UTF-32 public files', () => {
  const secret = 'password="synthetic-super-secret-value"';
  const codePoints = Array.from(secret, (character) => character.codePointAt(0));
  for (const littleEndian of [true, false]) {
    withSite((directory) => {
      const contents = Buffer.alloc(4 + codePoints.length * 4);
      if (littleEndian) contents.set([0xff, 0xfe, 0x00, 0x00]);
      else contents.set([0x00, 0x00, 0xfe, 0xff]);
      codePoints.forEach((codePoint, index) => {
        if (littleEndian) contents.writeUInt32LE(codePoint, 4 + index * 4);
        else contents.writeUInt32BE(codePoint, 4 + index * 4);
      });
      fs.writeFileSync(path.join(directory, 'encoded.txt'), contents);
      const result = scan(directory);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Potential secret detected/);
    });
  }
});

test('rejects env/auth artifacts and source maps', () => {
  withSite((directory) => {
    fs.writeFileSync(path.join(directory, '.env.production'), 'SECRET=fixture');
    assert.match(scan(directory).stderr, /Forbidden publication path/);
  });
  withSite((directory) => {
    fs.writeFileSync(path.join(directory, 'index.js.map'), '{}');
    assert.match(scan(directory).stderr, /Source maps are not allowed/);
  });
});
