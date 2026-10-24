import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectMarkdownAnchors,
  findBrokenMarkdownLinks,
  listMarkdownFiles,
  checkMarkdownLinks,
  slugHeading,
  stripFencedCode,
} from './check-docs.mjs';

test('heading anchors follow stable GitHub-like slugs and duplicate headings', () => {
  const anchors = collectMarkdownAnchors(
    '# Addon `base`\n\n## Access & roles\n\n## Repeated\n\n## Repeated\n'
  );
  assert.equal(anchors.has('addon-base'), true);
  assert.equal(anchors.has('access-roles'), true);
  assert.equal(anchors.has('repeated'), true);
  assert.equal(anchors.has('repeated-1'), true);
  assert.equal(slugHeading('User Profile / Settings'), 'user-profile-settings');
  assert.equal(slugHeading('A <em>styled</em> heading'), 'a-styled-heading');
});

test('links in code blocks are ignored and local fragments are validated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-doc-links-'));
  try {
    const guide = path.join(root, 'guide');
    await mkdir(guide, { recursive: true });
    const sourceFile = path.join(guide, 'start.md');
    const targetFile = path.join(guide, 'target.md');
    const outsideFile = path.join(root, 'outside.md');
    const source = [
      '# Start',
      '',
      '[valid](target.md#good-heading)',
      '[bad anchor](target.md#missing)',
      '[missing page](absent.md)',
      '[outside](../../outside.md)',
      '```md',
      '[ignored](ghost.md#nope)',
      '```',
    ].join('\n');
    await writeFile(sourceFile, source);
    await writeFile(targetFile, '# Good heading\n');
    await writeFile(outsideFile, '# Outside\n');
    assert.equal(stripFencedCode(source).includes('ghost.md'), false);
    assert.deepEqual(await findBrokenMarkdownLinks([sourceFile], root), [
      'guide/start.md:4: missing anchor target.md#missing',
      'guide/start.md:5: missing target absent.md',
      'guide/start.md:6: target escapes repository ../../outside.md',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a checkout reads only tracked documents so local and hosted gates share a file set', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonwitness-doc-tracked-'));
  const root = await realpath(tempRoot);
  const git = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  try {
    git(['init', '--quiet']);
    await writeFile(path.join(root, '.gitignore'), 'scratch-included/**\n');
    await writeFile(path.join(root, 'release.md'), '# Release\n\n[notes](notes.md)\n');
    await writeFile(path.join(root, 'notes.md'), '# Notes\n');
    git(['add', 'release.md', 'notes.md']);
    await writeFile(path.join(root, 'scratch-excluded.md'), '# Scratch\n\n[absent](nowhere.md)\n');
    await mkdir(path.join(root, 'scratch-included'), { recursive: true });
    await writeFile(
      path.join(root, 'scratch-included', 'draft.md'),
      '# Draft\n\n[absent](../nowhere.md)\n'
    );

    const listed = await listMarkdownFiles(root);
    assert.deepEqual(listed.map((file) => path.relative(root, file).replaceAll('\\', '/')).sort(), [
      'notes.md',
      'release.md',
    ]);
    assert.equal(
      await checkMarkdownLinks(root),
      2,
      'untracked scratch documents cannot fail a gate the runner never sees'
    );

    git(['add', '--force', 'scratch-included/draft.md']);
    await assert.rejects(
      checkMarkdownLinks(root),
      /scratch-included\/draft\.md:3: missing target/u
    );
  } finally {
    // Windows keeps the directory locked briefly after the `git` child exits.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
