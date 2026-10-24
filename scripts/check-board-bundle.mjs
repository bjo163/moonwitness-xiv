import { gzipSync } from 'node:zlib';
import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.join(root, 'apps/board');
const staticRoot = path.join(appRoot, '.next/static');
const manifestFile = path.join(appRoot, '.next/server/app/page_client-reference-manifest.js');
const budgetFile = path.join(appRoot, 'bundle-budget.json');

export function parseNextClientManifest(source) {
  const match = source.match(/globalThis\.__RSC_MANIFEST\["[^"]+"\]\s*=\s*(\{[\s\S]*\});\s*$/u);
  if (!match)
    throw new Error(
      'Next.js App Router client-reference manifest could not be read. Run `pnpm --filter @moonwitness/board build` first.'
    );
  const parsed = JSON.parse(match[1]);
  if (!parsed.entryJSFiles || !parsed.entryCSSFiles)
    throw new Error('Next.js route asset entries are missing.');
  return parsed;
}

function measured(files, limit) {
  const rawBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const gzipBytes = files.reduce((sum, file) => sum + gzipSync(file.bytes).length, 0);
  return {
    files: files.map((file) => file.name),
    rawBytes,
    gzipBytes,
    maxRawBytes: limit.maxRawBytes,
    maxGzipBytes: limit.maxGzipBytes,
    passed: rawBytes <= limit.maxRawBytes && gzipBytes <= limit.maxGzipBytes,
  };
}

export async function measureNextRouteAssets(manifest, readAsset, budget) {
  const routeModules = {
    homepage: ['/src/app/layout', '/src/app/page'],
    board: ['/src/app/layout', '/src/app/board/layout', '/src/app/board/page'],
    login: ['/src/app/layout', '/src/app/login/page'],
    model: ['/src/app/layout', '/src/app/board/layout', '/src/app/board/m/[model]/page'],
  };
  const results = {};
  for (const [route, suffixes] of Object.entries(routeModules)) {
    const routeManifest = manifest[route] ?? manifest;
    const js = new Set();
    const css = new Set();
    for (const suffix of suffixes) {
      const key = Object.keys(routeManifest.entryJSFiles).find((candidate) =>
        candidate.endsWith(suffix)
      );
      if (!key) throw new Error(`Next.js client manifest is missing route module ${suffix}.`);
      for (const asset of routeManifest.entryJSFiles[key] ?? []) js.add(asset);
      for (const asset of routeManifest.entryCSSFiles[key] ?? [])
        css.add(typeof asset === 'string' ? asset : asset.path);
    }
    const read = async (names) =>
      Promise.all([...names].map(async (name) => ({ name, bytes: await readAsset(name) })));
    results[route] = {
      javascript: measured(await read(js), budget.routes[route].javascript),
      stylesheet: measured(await read(css), budget.routes[route].stylesheet),
    };
  }
  return results;
}

export function renderNextBudgetReport(results, audioBytes) {
  const lines = ['MoonWitness Next.js client asset budget:'];
  for (const [route, metrics] of Object.entries(results)) {
    for (const [kind, value] of Object.entries(metrics))
      lines.push(
        `  ${route} ${kind}: ${value.rawBytes} raw / ${value.gzipBytes} gzip bytes (${value.passed ? 'pass' : 'FAIL'})`
      );
  }
  lines.push(`  interface audio: ${audioBytes} bytes; loaded on demand`);
  return `${lines.join('\n')}\n`;
}

async function readStaticAsset(name) {
  const relative = name.replace(/^\/?_next\//u, '').replace(/^\/?static\//u, '');
  if (relative.split('/').includes('..') || path.isAbsolute(relative))
    throw new Error(`Unsafe Next.js asset path: ${name}`);
  return readFile(path.join(staticRoot, relative));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const budget = JSON.parse(await readFile(budgetFile, 'utf8'));
  if (
    budget.schemaVersion !== 2 ||
    !budget.routes ||
    !Number.isSafeInteger(budget.audio?.maxCombinedBytes)
  )
    throw new Error(
      'Board Next.js bundle budget needs schemaVersion 2, route limits, and an audio size limit.'
    );
  const manifest = {
    homepage: parseNextClientManifest(await readFile(manifestFile, 'utf8')),
    board: parseNextClientManifest(
      await readFile(
        path.join(appRoot, '.next/server/app/board/page_client-reference-manifest.js'),
        'utf8'
      )
    ),
    login: parseNextClientManifest(
      await readFile(
        path.join(appRoot, '.next/server/app/login/page_client-reference-manifest.js'),
        'utf8'
      )
    ),
    model: parseNextClientManifest(
      await readFile(
        path.join(appRoot, '.next/server/app/board/m/[model]/page_client-reference-manifest.js'),
        'utf8'
      )
    ),
  };
  const results = await measureNextRouteAssets(manifest, readStaticAsset, budget);
  const soundFiles = (await readdir(path.join(root, 'packages/assets/sounds'))).filter((file) =>
    /\.(?:wav|mp3|ogg)$/u.test(file)
  );
  let audioBytes = 0;
  for (const file of soundFiles)
    audioBytes += (await stat(path.join(root, 'packages/assets/sounds', file))).size;
  const report = renderNextBudgetReport(results, audioBytes);
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n\n${report}`);
  const failures = Object.entries(results).flatMap(([route, metrics]) =>
    Object.entries(metrics)
      .filter(([, value]) => !value.passed)
      .map(([kind]) => `${route} ${kind}`)
  );
  if (audioBytes > budget.audio.maxCombinedBytes) failures.push('combined SFX size');
  if (failures.length) {
    console.error(`Board asset budget exceeded: ${failures.join(', ')}`);
    process.exit(1);
  }
}
