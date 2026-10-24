import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import prettier from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readmePath = path.join(root, 'README.md');
const metadataPath = path.join(root, 'docs/guide/reference/generated-platform.json');
export const beginMarker = '<!-- BEGIN GENERATED WORKSPACE REFERENCE -->';
export const endMarker = '<!-- END GENERATED WORKSPACE REFERENCE -->';

function occurrences(source, marker) {
  return source.split(marker).length - 1;
}

function assertStandaloneLine(source, marker, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = source.indexOf('\n', index);
  const end = lineEnd === -1 ? source.length : lineEnd;
  if (source.slice(lineStart, index).trim() || source.slice(index + marker.length, end).trim()) {
    throw new Error(`README generated marker must be alone on its line: ${marker}`);
  }
}

export function replaceGeneratedReadmeBlock(readme, generatedBlock) {
  if (occurrences(readme, beginMarker) !== 1 || occurrences(readme, endMarker) !== 1) {
    throw new Error(
      'README must contain exactly one generated-block begin marker and one end marker'
    );
  }
  const beginIndex = readme.indexOf(beginMarker);
  const endIndex = readme.indexOf(endMarker);
  assertStandaloneLine(readme, beginMarker, beginIndex);
  assertStandaloneLine(readme, endMarker, endIndex);
  const beginLineEnd = readme.indexOf('\n', beginIndex);
  const contentStart = beginLineEnd === -1 ? readme.length : beginLineEnd + 1;
  const endLineStart = readme.lastIndexOf('\n', endIndex - 1) + 1;
  if (endLineStart < contentStart)
    throw new Error('README generated-block markers are out of order');
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  const block = generatedBlock.trimEnd().replace(/\r?\n/gu, newline);
  const replacement = `${newline}${block}${newline}${newline}`;
  return `${readme.slice(0, contentStart)}${replacement}${readme.slice(endLineStart)}`;
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ');
}

export function renderReadmeReference(metadata) {
  if (
    typeof metadata.rootVersion !== 'string' ||
    typeof metadata.generatedFromSha256 !== 'string' ||
    !Array.isArray(metadata.packages) ||
    !metadata.scripts?.root ||
    typeof metadata.scripts.root !== 'object'
  ) {
    throw new Error(
      'Generated platform metadata is missing version, fingerprint, packages, or root scripts'
    );
  }
  const lines = [
    '## Generated workspace reference',
    '',
    `Monorepo version: \`${cell(metadata.rootVersion)}\` · metadata fingerprint: \`${metadata.generatedFromSha256}\`.`,
    '',
    '| App/package | Kind | Version | Workspace scripts |',
    '| --- | --- | --- | --- |',
    ...metadata.packages.map((item) => {
      const scripts = item.scripts.map((name) => `\`${cell(name)}\``).join(', ') || '—';
      const kind = item.directory.startsWith('apps/') ? 'App' : 'Package';
      return `| \`${cell(item.name)}\` | ${kind} | \`${cell(item.version)}\` | ${scripts} |`;
    }),
    '',
    `Root commands: ${Object.keys(metadata.scripts.root)
      .map((name) => `\`pnpm ${cell(name)}\``)
      .join(', ')}.`,
    '',
    'Generated model, field, relation, access, environment-name, and endpoint references are in the [developer guide](docs/guide/index.md).',
  ];
  return lines.join('\n');
}

export async function updateReadme({ check = false } = {}) {
  const [readme, metadataSource] = await Promise.all([
    readFile(readmePath, 'utf8'),
    readFile(metadataPath, 'utf8'),
  ]);
  const metadata = JSON.parse(metadataSource);
  const options = await prettier.resolveConfig(readmePath);
  const generatedBlock = await prettier.format(renderReadmeReference(metadata), {
    ...options,
    filepath: readmePath,
  });
  const next = replaceGeneratedReadmeBlock(readme, generatedBlock);
  if (check) {
    if (next !== readme)
      throw new Error('README generated workspace block is stale; run pnpm readme:generate');
  } else {
    await writeFile(readmePath, next);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  updateReadme({ check: process.argv.includes('--check') }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'README update failed'}\n`);
    process.exitCode = 1;
  });
}
