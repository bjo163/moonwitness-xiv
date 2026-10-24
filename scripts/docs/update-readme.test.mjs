import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginMarker,
  endMarker,
  renderReadmeReference,
  replaceGeneratedReadmeBlock,
} from './update-readme.mjs';

const metadata = {
  rootVersion: '1.2.3-rc.1',
  generatedFromSha256: 'a'.repeat(64),
  packages: [
    {
      name: '@moonwitness/api',
      directory: 'apps/api',
      version: '1.2.3-rc.1',
      scripts: ['build', 'test'],
    },
    {
      name: '@moonwitness/orm',
      directory: 'packages/orm',
      version: '1.2.3-rc.1',
      scripts: [],
    },
  ],
  scripts: { root: { build: 'private-command-value', verify: 'private-command-value' } },
};

test('README partial update preserves every byte outside the generated block', () => {
  const prefix = `# Manual introduction\r\nKeep this text exactly.\r\n${beginMarker}\r\n`;
  const suffix = `${endMarker}\r\n\r\n## Manual quickstart\r\nPreserve spacing and links.\r\n`;
  const source = `${prefix}old generated content\r\n${suffix}`;
  const rendered = renderReadmeReference(metadata).replaceAll('\n', '\r\n');
  const updated = replaceGeneratedReadmeBlock(source, rendered);
  assert.equal(updated.slice(0, prefix.length), prefix);
  assert.equal(updated.slice(updated.indexOf(endMarker)), suffix);
  assert.ok(updated.includes('Monorepo version: `1.2.3-rc.1`'));
  assert.ok(updated.includes('| `@moonwitness/api` | App |'));
});

test('a line-feed generated block adopts the CRLF README instead of mixing line endings', () => {
  const prefix = `# Manual introduction\r\n${beginMarker}\r\n`;
  const suffix = `${endMarker}\r\n## Manual quickstart\r\n`;
  const source = `${prefix}old generated content\r\n${suffix}`;
  const updated = replaceGeneratedReadmeBlock(source, renderReadmeReference(metadata));
  assert.equal(updated.includes('\r\n'), true);
  const uniform = updated
    .split('\n')
    .every((line, index, all) => index === all.length - 1 || line.endsWith('\r'));
  assert.equal(uniform, true);
  assert.equal(replaceGeneratedReadmeBlock(updated, renderReadmeReference(metadata)), updated);
});

test('missing, duplicate, reversed, or inline markers fail without returning a rewrite', () => {
  assert.throws(() => replaceGeneratedReadmeBlock('manual text', 'generated'), /exactly one/u);
  assert.throws(
    () => replaceGeneratedReadmeBlock(`${beginMarker}\n${beginMarker}\n${endMarker}`, 'generated'),
    /exactly one/u
  );
  assert.throws(
    () => replaceGeneratedReadmeBlock(`${endMarker}\n${beginMarker}`, 'generated'),
    /out of order/u
  );
  assert.throws(
    () => replaceGeneratedReadmeBlock(`intro ${beginMarker}\n${endMarker}`, 'generated'),
    /alone on its line/u
  );
});

test('generated workspace summary is deterministic and lists scripts without command values', () => {
  const rendered = renderReadmeReference(metadata);
  assert.equal(rendered, renderReadmeReference(metadata));
  assert.match(rendered, /`pnpm build`, `pnpm verify`/u);
  assert.equal(rendered.includes('private-command-value'), false);
});
