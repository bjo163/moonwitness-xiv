import assert from 'node:assert/strict';
import test from 'node:test';
import {
  measureNextRouteAssets,
  parseNextClientManifest,
  renderNextBudgetReport,
} from './check-board-bundle.mjs';

const limit = { maxRawBytes: 100, maxGzipBytes: 100 };
const budget = {
  routes: Object.fromEntries(
    ['homepage', 'board', 'login', 'model'].map((route) => [
      route,
      { javascript: limit, stylesheet: limit },
    ])
  ),
};

test('parses the Next App Router client asset manifest', () => {
  const value = {
    entryJSFiles: { '[project]/apps/board/src/app/layout': ['static/chunks/app.js'] },
    entryCSSFiles: { '[project]/apps/board/src/app/layout': ['static/chunks/app.css'] },
  };
  const parsed = parseNextClientManifest(
    `globalThis.__RSC_MANIFEST["/page"] = ${JSON.stringify(value)};\n`
  );
  assert.deepEqual(parsed.entryJSFiles, value.entryJSFiles);
  assert.throws(() => parseNextClientManifest('{}'), /could not be read/u);
});

test('measures route entry chunks without counting shared files twice', async () => {
  const modules = [
    '/src/app/layout',
    '/src/app/page',
    '/src/app/board/layout',
    '/src/app/board/page',
    '/src/app/login/page',
    '/src/app/board/m/[model]/page',
  ];
  const js = Object.fromEntries(
    modules.map((suffix, index) => [
      `[project]/apps/board${suffix}`,
      index === 0
        ? ['static/chunks/shared.js']
        : ['static/chunks/shared.js', `static/chunks/route-${index}.js`],
    ])
  );
  const css = Object.fromEntries(
    modules.map((suffix) => [`[project]/apps/board${suffix}`, ['static/chunks/base.css']])
  );
  const assets = new Map([
    ['static/chunks/shared.js', Buffer.from('shared')],
    ['static/chunks/base.css', Buffer.from('css')],
  ]);
  for (const index of [1, 2, 3, 4, 5])
    assets.set(`static/chunks/route-${index}.js`, Buffer.from(`route-${index}`));
  const result = await measureNextRouteAssets(
    { entryJSFiles: js, entryCSSFiles: css },
    async (name) => assets.get(name),
    budget
  );
  assert.equal(result.homepage.javascript.files.length, 2);
  assert.equal(result.homepage.stylesheet.files.length, 1);
  assert.equal(result.board.javascript.files.length, 3);
  assert.ok(
    Object.values(result).every((route) => route.javascript.passed && route.stylesheet.passed)
  );
  assert.match(
    renderNextBudgetReport(result, 123),
    /interface audio: 123 bytes; loaded on demand/u
  );
});

test('flags any route chunk over its budget', async () => {
  const files = Object.fromEntries(
    [
      '/src/app/layout',
      '/src/app/page',
      '/src/app/board/layout',
      '/src/app/board/page',
      '/src/app/login/page',
      '/src/app/board/m/[model]/page',
    ].map((suffix) => [`[project]/apps/board${suffix}`, ['static/chunks/large.js']])
  );
  const result = await measureNextRouteAssets(
    {
      entryJSFiles: files,
      entryCSSFiles: Object.fromEntries(Object.keys(files).map((key) => [key, []])),
    },
    async () => Buffer.alloc(200),
    budget
  );
  assert.equal(result.homepage.javascript.passed, false);
});
