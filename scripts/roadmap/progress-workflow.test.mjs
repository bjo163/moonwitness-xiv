import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

// The assertion anchors below are LF-only and a Windows checkout carries CRLF.
const workflow = (
  await readFile(new URL('../../.github/workflows/roadmap-progress.yml', import.meta.url), 'utf8')
).replaceAll('\r\n', '\n');

test('progress report workflow reads dev and publishes only short-lived Markdown and JSON artifacts', () => {
  assert.match(workflow, /branches: \[dev\]/u);
  assert.match(
    workflow,
    /github\.event_name == 'schedule' \|\| github\.ref == 'refs\/heads\/dev'/u
  );
  assert.match(workflow, /ref: dev\n/u);
  assert.match(workflow, /mkdir -p dist\/roadmap-progress/u);
  assert.match(workflow, /permissions:\n\x20{2}contents: read\n/u);
  assert.doesNotMatch(workflow, /^\s+(?:issues|pull-requests|contents):\s+write\s*$/mu);
  assert.match(
    workflow,
    /name: Generate Markdown progress report\n\s+run: node scripts\/roadmap\/progress-dashboard\.mjs --output dist\/roadmap-progress\/roadmap-progress\.md/u
  );
  assert.match(
    workflow,
    /name: Generate JSON progress report\n\s+run: node scripts\/roadmap\/progress-dashboard\.mjs --format json --output dist\/roadmap-progress\/roadmap-progress\.json/u
  );
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 7/u);
});

test('progress workflow checks out the trusted dev ref without persisting credentials', () => {
  assert.match(workflow, /ref: dev\n[\s\S]{0,80}persist-credentials: false/u);
  assert.match(
    workflow,
    /github\.event_name == 'schedule' \|\| github\.ref == 'refs\/heads\/dev'/u
  );
});

test('workflow CLI commands write valid source-bound Markdown and JSON reports', async () => {
  const outputDirectory = path.join(
    repositoryRoot,
    'dist',
    `roadmap-progress-test-${randomUUID()}`
  );
  const cliPath = path.join(repositoryRoot, 'scripts/roadmap/progress-dashboard.mjs');
  const markdownPath = path.join(outputDirectory, 'roadmap-progress.md');
  const jsonPath = path.join(outputDirectory, 'roadmap-progress.json');
  const relativeMarkdownPath = path.relative(repositoryRoot, markdownPath);
  const relativeJsonPath = path.relative(repositoryRoot, jsonPath);
  await mkdir(outputDirectory, { recursive: true });

  try {
    execFileSync(process.execPath, [cliPath, '--output', relativeMarkdownPath], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, [cliPath, '--format', 'json', '--output', relativeJsonPath], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    });

    const [markdown, json] = await Promise.all([
      readFile(markdownPath, 'utf8'),
      readFile(jsonPath, 'utf8').then((contents) => JSON.parse(contents)),
    ]);
    assert.match(markdown, /^# Roadmap progress\n/u);
    assert.match(markdown, /Source SHA: `[a-f0-9]{40}`/u);
    assert.equal(json.schemaVersion, 1);
    assert.match(json.sourceSha, /^[a-f0-9]{40}$/u);
    const roadmap = JSON.parse(
      await readFile(new URL('../../docs/roadmap/tasks.json', import.meta.url), 'utf8')
    );
    assert.equal(json.totals.taskCount, roadmap.tasks.length);
    assert.equal(typeof json.sourceDirty, 'boolean');
    assert.ok(
      markdown.includes(`Source tree: ${json.sourceDirty ? 'dirty' : 'clean'}`),
      'Markdown must disclose whether the source tree is dirty'
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
