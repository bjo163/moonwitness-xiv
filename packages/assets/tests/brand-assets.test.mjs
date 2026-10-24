import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'manifest.json'), 'utf8'));
const assetByPath = new Map(manifest.assets.map((asset) => [asset.path, asset]));

test('manifest describes all stable brand and icon exports with unique paths', () => {
  assert.equal(manifest.name, '@moonwitness/assets');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.licenseManifest, 'licenses.json');
  assert.equal(assetByPath.size, manifest.assets.length);
  for (const path of [
    'brand/source/moonwitness-master.svg',
    'source/artwork/home-hero-master.png',
    'source/artwork/board-masthead-master.png',
    'source/artwork/story-workbench-masthead-master.png',
    'source/fonts/RoadRage-Regular.ttf',
    'illustrations/home-hero-desktop.webp',
    'illustrations/home-hero-mobile.webp',
    'illustrations/board-masthead.webp',
    'illustrations/story-workbench-masthead.webp',
    'fonts/RoadRage-latin.woff2',
  ]) {
    assert.ok(assetByPath.has(path), `${path} is in the manifest`);
  }

  for (const kind of ['symbol', 'wordmark', 'lockup']) {
    for (const variant of ['light', 'dark', 'mono-light', 'mono-dark']) {
      assert.ok(assetByPath.has(`brand/moonwitness-${kind}-${variant}.svg`));
    }
  }
  for (const requiredPath of [
    'brand/favicon.svg',
    'brand/app-icon-192.png',
    'brand/app-icon-512.png',
    'brand/social-card.svg',
    'brand/social-card.png',
    'brand/readme-banner.svg',
  ]) {
    assert.ok(assetByPath.has(requiredPath), `${requiredPath} is exported`);
  }
  for (const sound of ['ui-success.wav', 'ui-alert.wav', 'ui-signal.wav']) {
    const asset = assetByPath.get(`sounds/${sound}`);
    assert.equal(asset?.kind, 'sound', `${sound} is exported as a sound`);
    assert.ok(asset.durationSeconds > 0 && asset.durationSeconds <= 3);
  }
  const iconNames = [
    'user',
    'users',
    'document',
    'knowledge',
    'image',
    'partner',
    'company',
    'team',
    'addon',
    'model',
    'field',
    'relation',
    'activity',
    'attachment',
    'notification',
    'jobs',
    'workflow',
    'security',
    'check',
    'warning',
    'error',
    'info',
    'search',
    'close',
    'add',
    'edit',
    'save',
    'delete',
    'settings',
    'calendar',
    'filter',
    'sort',
    'upload',
    'download',
    'refresh',
    'external-link',
    'menu',
    'home',
    'arrow-right',
    'chevron-right',
    'globe',
    'moon',
    'play',
    'pause',
    'volume',
    'volume-off',
    'lock',
    'mail',
    'visibility',
    'visibility-off',
    'archive',
    'book-open',
    'story',
    'signal',
    'signal-off',
    'bank',
    'code',
    'credit-card',
    'currency',
    'hash',
    'key',
    'keyboard',
    'language',
    'logout',
    'map-pin',
    'message',
    'send',
    'smartphone',
    'sparkle',
    'sun',
    'bolt',
    'chevrons-left',
    'chevrons-right',
    'columns',
    'grid',
    'sort-ascending',
    'sort-descending',
    'tag',
    'calendar-clock',
    'check-square',
    'inbox',
    'phone',
  ];
  for (const name of iconNames) {
    assert.ok(assetByPath.has(`icons/${name}.svg`), `${name} icon is exported`);
  }
  const iconAssets = manifest.assets.filter(({ kind }) => kind === 'icon');
  assert.ok(iconAssets.length > 0, 'canonical icon inventory is not empty');
  for (const icon of iconAssets) {
    assert.match(icon.path, /^icons\/[a-z0-9-]+\.svg$/u);
    assert.equal(icon.variant, 'currentColor');
    assert.equal(icon.width, 24);
    assert.equal(icon.height, 24);
  }
  const illustrationNames = [
    'empty',
    'no-results',
    'no-activity',
    'access-denied',
    'not-found',
    'offline',
    'onboarding',
  ];
  for (const name of illustrationNames) {
    for (const theme of ['light', 'dark']) {
      const illustration = assetByPath.get(`illustrations/${name}-${theme}.svg`);
      assert.ok(illustration, `${name} illustration ${theme} variant is exported`);
      assert.equal(illustration.kind, 'illustration');
      assert.equal(illustration.width, 164);
      assert.equal(illustration.height, 152);
    }
  }
  assert.ok(assetByPath.has('illustrations/orbit-pattern-light.svg'));
  assert.ok(assetByPath.has('illustrations/orbit-pattern-dark.svg'));
  for (const path of [
    'illustrations/home-hero-desktop.webp',
    'illustrations/home-hero-mobile.webp',
    'illustrations/board-masthead.webp',
  ]) {
    assert.equal(assetByPath.get(path)?.kind, 'artwork');
    assert.equal(assetByPath.get(path)?.format, 'webp');
  }
});

test('every manifest path exists and its dimensions match the declared media size', async () => {
  for (const asset of manifest.assets) {
    const filePath = resolve(packageRoot, asset.path);
    const file = await stat(filePath);
    assert.ok(file.isFile(), `${asset.path} is a file`);
    assert.ok(file.size > 0, `${asset.path} is non-empty`);
    if (asset.format === 'svg') {
      const svg = await readFile(filePath, 'utf8');
      assert.match(svg, new RegExp(`viewBox="0 0 ${asset.width} ${asset.height}"`, 'u'));
      assert.match(svg, /<svg\s/u);
    }
  }
});

test('all checked-in asset generator inputs are inventoried', async () => {
  for (const path of [
    'brand/source/moonwitness-master.svg',
    'source/artwork/home-hero-master.png',
    'source/artwork/board-masthead-master.png',
    'source/fonts/RoadRage-Regular.ttf',
  ]) {
    assert.ok(assetByPath.has(path), `${path} has a manifest entry`);
    assert.equal(assetByPath.get(path)?.kind, 'source');
  }
});

test('social card raster is a real 1200 by 630 PNG', async () => {
  const png = await readFile(resolve(packageRoot, 'brand/social-card.png'));
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('app icons are canonical square PNG derivatives at installable sizes', async () => {
  for (const size of [192, 512]) {
    const path = `brand/app-icon-${size}.png`;
    const asset = assetByPath.get(path);
    assert.equal(asset?.kind, 'app-icon');
    assert.equal(asset?.source, 'brand/favicon.svg');
    const metadata = await sharp(resolve(packageRoot, path)).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }
});

test('all SVG exports are self-contained and have no executable or external references', async () => {
  for (const asset of manifest.assets.filter(({ format }) => format === 'svg')) {
    const svg = await readFile(resolve(packageRoot, asset.path), 'utf8');
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b/iu, asset.path);
    assert.doesNotMatch(svg, /(?:href|src)\s*=\s*["'](?:https?:|\/\/)/iu, asset.path);
    assert.doesNotMatch(svg, /@import|url\(\s*["']?(?:https?:|\/\/)/iu, asset.path);
  }
});

test('brand master is hand-authored vector and artwork has intentional optimized crops', async () => {
  const master = await readFile(
    resolve(packageRoot, 'brand/source/moonwitness-master.svg'),
    'utf8'
  );
  assert.match(master, /id="mw-brand-source-moonwitness-master-svg-crown"/u);
  assert.match(master, /id="mw-brand-source-moonwitness-master-svg-wordmark"/u);
  assert.doesNotMatch(master, /<text\b|<image\b|base64,/iu);
  assert.doesNotMatch(
    master,
    /NaN|Infinity/u,
    'canonical wordmark paths contain valid SVG numbers'
  );
  const wordmark = master.match(
    /<g id="mw-brand-source-moonwitness-master-svg-wordmark"[^>]*>([\s\S]*?)<\/g>/u
  )?.[1];
  assert.ok(wordmark, 'canonical source includes an outlined wordmark');
  assert.equal(
    (wordmark.match(/<path\b/gu) ?? []).length,
    11,
    'MOONWITNESS has 11 outlined glyphs'
  );
  const brandGenerator = await readFile(
    resolve(packageRoot, 'scripts/prepare-brand-master.mjs'),
    'utf8'
  );
  assert.match(brandGenerator, /const wordmark = 'MOONWITNESS'/u);
  for (const variant of ['light', 'dark', 'mono-light', 'mono-dark']) {
    const output = await readFile(
      resolve(packageRoot, `brand/moonwitness-wordmark-${variant}.svg`),
      'utf8'
    );
    assert.equal((output.match(/<path\b/gu) ?? []).length, 11, `${variant} includes all glyphs`);
    assert.doesNotMatch(output, /NaN|Infinity/u, `${variant} has valid SVG path numbers`);
  }

  const artwork = manifest.assets.filter(({ kind }) => kind === 'artwork');
  assert.ok(artwork.length >= 3, 'the manifest includes the required production artwork crops');
  for (const asset of artwork) {
    assert.equal(
      asset.license,
      'OpenAI Terms of Use (Output owned by user, subject to applicable law)'
    );
    const image = sharp(resolve(packageRoot, asset.path));
    const metadata = await image.metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, asset.width);
    assert.equal(metadata.height, asset.height);
  }
});

test('mobile homepage hero stays within its reviewed 220 KB transfer budget', async () => {
  const heroPath = resolve(packageRoot, 'illustrations/home-hero-mobile.webp');
  const [metadata, file] = await Promise.all([sharp(heroPath).metadata(), stat(heroPath)]);
  assert.equal(metadata.width, 920);
  assert.equal(metadata.height, 1150);
  assert.ok(file.size <= 220_000, `mobile hero is ${file.size} bytes; target is 220000 bytes`);
});

test('package exports only framework-independent static assets', async () => {
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.equal(packageJson.exports['./brand/*'], './brand/*');
  assert.equal(packageJson.exports['./fonts/*'], './fonts/*');
  assert.equal(packageJson.exports['./fonts.css'], './fonts.css');
  assert.equal(packageJson.exports['./icons/*'], './icons/*');
  assert.equal(packageJson.exports['./illustrations/*'], './illustrations/*');
  assert.equal(packageJson.exports['./manifest.json'], './manifest.json');
  assert.equal(packageJson.exports['./licenses.json'], './licenses.json');
  assert.ok(packageJson.files.includes('brand'));
  assert.ok(packageJson.files.includes('fonts'));
  assert.ok(packageJson.files.includes('fonts.css'));
  assert.ok(packageJson.files.includes('icons'));
  assert.ok(packageJson.files.includes('illustrations'));
  assert.ok(packageJson.files.includes('manifest.json'));
  for (const asset of manifest.assets.filter(({ kind }) => kind !== 'source')) {
    assert.ok(
      packageJson.files.includes(asset.path.split('/')[0]),
      `${asset.path} is included by the published package file allowlist`
    );
  }
});

test('pnpm package tarball contains every public manifest asset and export target', async () => {
  const packed = JSON.parse(
    execSync('pnpm pack --dry-run --json', { cwd: packageRoot, encoding: 'utf8' })
  );
  const packedPaths = new Set(packed.files.map(({ path }) => path));
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  for (const asset of manifest.assets.filter(({ kind }) => kind !== 'source')) {
    assert.ok(packedPaths.has(asset.path), `${asset.path} is present in the package tarball`);
  }
  for (const target of Object.values(packageJson.exports).filter((path) => !path.includes('*'))) {
    assert.ok(packedPaths.has(target.slice(2)), `${target} is present in the package tarball`);
  }
});

test('provenance covers original design assets and every externally sourced font family', async () => {
  const provenance = JSON.parse(await readFile(resolve(packageRoot, 'licenses.json'), 'utf8'));
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.packageLicense, 'ISC');
  assert.equal(provenance.originalAssets.source, 'packages/assets/scripts/generate.mjs');
  assert.equal(
    provenance.originalAssets.additionalSource,
    'packages/assets/scripts/generate-illustrations.mjs'
  );
  assert.equal(provenance.originalAssets.license, 'ISC');
  assert.equal(provenance.fonts.length, 4);
  assert.deepEqual(
    provenance.fonts.map(({ family }) => family).sort(),
    ['Anton', 'JetBrains Mono', 'Road Rage', 'Space Grotesk'].sort()
  );
  for (const font of provenance.fonts) {
    assert.equal(font.license, 'SIL Open Font License 1.1');
    assert.match(font.source, /^https:\/\//u);
    assert.match(font.usage, /Bundled/u);
    assert.ok(font.files.length >= 1);
    for (const file of font.files) {
      assert.match(file.path, /^fonts\/.+\.woff2$/u);
      assert.match(file.source, /^https:\/\//u);
      assert.match(file.sha256, /^[A-F0-9]{64}$/u);
      const fontAsset = assetByPath.get(file.path);
      assert.equal(fontAsset?.kind, 'font', `${file.path} is inventoried as a font`);
      assert.equal(fontAsset?.format, 'woff2', `${file.path} records its format`);
      assert.equal(fontAsset?.license, font.license, `${file.path} records its license`);
      assert.equal(
        fontAsset?.source,
        file.sourceFile ?? file.source,
        `${file.path} records its source asset or upstream source`
      );
      assert.equal(fontAsset?.sha256, file.sha256, `${file.path} hash matches provenance`);
      const bytes = await readFile(resolve(packageRoot, file.path));
      assert.equal(bytes.toString('hex', 0, 4), '774f4632', `${file.path} is WOFF2`);
      assert.equal(createHash('sha256').update(bytes).digest('hex').toUpperCase(), file.sha256);
      if (font.family !== 'Road Rage') {
        assert.match(file.source, /^https:\/\/fonts\.gstatic\.com\//u);
      }
    }
    const licensePath = resolve(packageRoot, `fonts/OFL-${font.family.replaceAll(' ', '')}.txt`);
    const licenseText = await readFile(licensePath, 'utf8');
    assert.match(licenseText, /SIL OPEN FONT LICENSE Version 1\.1/u);
  }

  const roadRage = provenance.fonts.find(({ family }) => family === 'Road Rage');
  assert.equal(roadRage.files.length, 1);
  assert.equal(roadRage.files[0].sourceFile, 'source/fonts/RoadRage-Regular.ttf');
  assert.match(
    await readFile(resolve(packageRoot, 'fonts/OFL-RoadRage.txt'), 'utf8'),
    /SIL OPEN FONT LICENSE Version 1\.1/u
  );
  const manifestArtwork = manifest.assets
    .filter(({ kind }) => kind === 'artwork')
    .map(({ path }) => path)
    .sort();
  const licensedArtwork = provenance.artwork.map(({ path }) => path).sort();
  assert.deepEqual(licensedArtwork, manifestArtwork);
  assert.ok(
    provenance.artwork.every(({ terms, source, sourceFile, generatedOn, notes }) =>
      Boolean(terms && source && sourceFile && generatedOn && notes)
    )
  );
  assert.ok(
    (await stat(resolve(packageRoot, 'illustrations/story-workbench-masthead.webp'))).size <=
      180 * 1024
  );
});

test('Board, UI catalog, and docs portal consume the shared local font export', async () => {
  const consumers = [
    resolve(packageRoot, '../../apps/board/src/index.css'),
    resolve(packageRoot, '../../apps/ui-catalog/src/styles.css'),
    resolve(packageRoot, '../../apps/docs/src/styles.css'),
  ];
  for (const consumerPath of consumers) {
    const stylesheet = await readFile(consumerPath, 'utf8');
    assert.match(stylesheet, /@import ['"]@moonwitness\/assets\/fonts\.css['"]/u, consumerPath);
  }

  const boardLayout = await readFile(
    resolve(packageRoot, '../../apps/board/src/app/layout.tsx'),
    'utf8'
  );
  const boardGlobalStyles = await readFile(
    resolve(packageRoot, '../../apps/board/src/app/global.css'),
    'utf8'
  );
  assert.match(boardLayout, /import ['"]\.\/global\.css['"]/u);
  assert.match(boardGlobalStyles, /@import ['"]\.\.\/index\.css['"]/u);
  assert.doesNotMatch(
    `${boardLayout}\n${boardGlobalStyles}`,
    /fonts\.googleapis\.com|fonts\.gstatic\.com/u
  );
});
