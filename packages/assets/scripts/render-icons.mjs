import { Buffer } from 'node:buffer';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const outputPath = resolve(repositoryRoot, 'docs/design/assets/icon-contact-sheet-current.png');
const brandOutputPath = resolve(
  repositoryRoot,
  'docs/design/assets/brand-contact-sheet-current.png'
);
const artworkOutputPath = resolve(
  repositoryRoot,
  'docs/design/assets/artwork-contact-sheet-current.png'
);
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'manifest.json'), 'utf8'));
const icons = manifest.assets.filter((asset) => asset.kind === 'icon');
const illustrations = manifest.assets.filter(
  (asset) => asset.kind === 'illustration' || asset.kind === 'pattern'
);

function dataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const previews = await Promise.all(
  icons.map(async (asset) => {
    const filename = asset.path.slice('icons/'.length);
    const svg = await readFile(resolve(packageRoot, asset.path), 'utf8');
    const light = dataUrl(svg.replaceAll('currentColor', '#0d0d0d'));
    const dark = dataUrl(svg.replaceAll('currentColor', '#f3efe4'));
    return { filename, light, dark };
  })
);

const iconCells = previews
  .map(
    ({ filename, light, dark }) => `<article>
      <h2>${filename}</h2>
      <div class="samples light">${[16, 20, 24, 32]
        .map(
          (size) =>
            `<div><img src="${light}" alt="" width="${size}" height="${size}"><span>${size}</span></div>`
        )
        .join('')}</div>
      <div class="samples dark">${[16, 20, 24, 32]
        .map(
          (size) =>
            `<div><img src="${dark}" alt="" width="${size}" height="${size}"><span>${size}</span></div>`
        )
        .join('')}</div>
    </article>`
  )
  .join('\n');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#e8e4d9;color:#0d0d0d;font:13px Arial,sans-serif}
    h1{margin:0 0 16px;font-size:22px}p{margin:0 0 18px;color:#3a3a36}
    main{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
    article{min-height:116px;padding:9px 10px;border:2px solid #0d0d0d;background:#fffdf6;box-shadow:3px 3px #0d0d0d}
    h2{overflow:hidden;margin:0 0 7px;font:700 12px ui-monospace,monospace;text-overflow:ellipsis;white-space:nowrap}
    .samples{display:flex;align-items:center;justify-content:space-between;padding:3px 5px}
    .samples div{display:flex;align-items:center;gap:3px;font:9px Arial,sans-serif}
    .samples img{display:block;object-fit:contain}.dark{background:#0e0e10;color:#f3efe4}
    </style></head><body><h1>MoonWitness UI icon inventory</h1>
    <p>Original 24×24 rounded-stroke symbols, rendered at 16 / 20 / 24 / 32 px on light and dark surfaces.</p>
    <main>${iconCells}</main></body></html>`);

  const imageStates = await page.locator('main img').evaluateAll((images) =>
    images.map((image) => ({
      loaded: image.complete && image.naturalWidth > 0,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }))
  );
  if (imageStates.some(({ loaded }) => !loaded)) {
    throw new Error(
      `Icon contact sheet contains invalid SVG previews: ${JSON.stringify(imageStates)}`
    );
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath, fullPage: true, animations: 'disabled' });
  stdout.write(
    `Rendered ${icons.length} icons across ${imageStates.length} size/theme samples to ${outputPath}.\n`
  );
  await page.close();

  const illustrationOutput = resolve(
    repositoryRoot,
    'docs/design/assets/illustration-contact-sheet-current.png'
  );
  const illustrationCells = await Promise.all(
    illustrations.map(async (asset) => {
      const svg = await readFile(resolve(packageRoot, asset.path), 'utf8');
      const data = dataUrl(svg);
      return `<article class="${asset.variant}"><h2>${asset.path.slice('illustrations/'.length)}</h2><img src="${data}" alt="" width="${asset.width}" height="${asset.height}"></article>`;
    })
  );
  const illustrationPage = await browser.newPage({
    viewport: { width: 1320, height: 1000 },
    deviceScaleFactor: 1,
  });
  await illustrationPage.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#e8e4d9;color:#0d0d0d;font:14px Arial,sans-serif}h1{margin:0 0 8px;font-size:24px}p{margin:0 0 20px;color:#3a3a36}main{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}article{min-height:210px;padding:12px;border:2px solid #0d0d0d;background:#fffdf6;box-shadow:3px 3px #0d0d0d}article.dark{background:#0d0d0d;color:#f3efe4}h2{margin:0 0 8px;font:700 12px ui-monospace,monospace}img{display:block;width:100%;height:160px;object-fit:contain}
    </style></head><body><h1>MoonWitness interface illustrations</h1><p>Original empty, search, activity, access, not-found, offline, onboarding and orbit pattern assets in light and dark variants.</p><main>${illustrationCells.join('')}</main></body></html>`);
  const illustrationImages = await illustrationPage
    .locator('main img')
    .evaluateAll((images) => images.map((image) => image.complete && image.naturalWidth > 0));
  if (illustrationImages.length !== illustrations.length || illustrationImages.includes(false)) {
    throw new Error('Illustration contact sheet contains invalid SVG previews.');
  }
  await mkdir(dirname(illustrationOutput), { recursive: true });
  await illustrationPage.screenshot({
    path: illustrationOutput,
    fullPage: true,
    animations: 'disabled',
  });
  stdout.write(
    `Rendered ${illustrations.length} themed illustration previews to ${illustrationOutput}.\n`
  );
  await illustrationPage.close();

  const brandVariants = ['light', 'dark', 'mono-light', 'mono-dark'];
  const brandItems = await Promise.all(
    brandVariants.map(async (variant) => ({
      variant,
      wordmark: dataUrl(
        await readFile(resolve(packageRoot, `brand/moonwitness-wordmark-${variant}.svg`), 'utf8')
      ),
      lockup: dataUrl(
        await readFile(resolve(packageRoot, `brand/moonwitness-lockup-${variant}.svg`), 'utf8')
      ),
      symbol: dataUrl(
        await readFile(resolve(packageRoot, `brand/moonwitness-symbol-${variant}.svg`), 'utf8')
      ),
    }))
  );
  const brandCells = brandItems
    .map(
      ({ variant, wordmark, lockup, symbol }) => `<article class="${variant}">
        <h2>${variant}</h2><div class="lockup"><img src="${lockup}" alt=""><img src="${symbol}" alt=""></div>
        <div class="wordmark"><img src="${wordmark}" alt=""></div></article>`
    )
    .join('');
  const brandPage = await browser.newPage({
    viewport: { width: 1320, height: 900 },
    deviceScaleFactor: 1,
  });
  await brandPage.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:28px;background:#17171a;color:#f3efe4;font:16px Arial,sans-serif}h1{margin:0 0 8px;font-size:30px}p{margin:0 0 24px;color:#cbc7bd}main{display:grid;grid-template-columns:1fr 1fr;gap:16px}article{min-height:250px;padding:20px;border:2px solid #0d0d0d;background:#f3efe4;color:#0d0d0d;box-shadow:5px 5px #000}article.dark{background:#0e0e10;color:#f3efe4;border-color:#f3efe4}article.mono-light{background:#fff;color:#0d0d0d}article.mono-dark{background:#0d0d0d;color:#fff;border-color:#fff}.lockup{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:100px}.lockup img:first-child{display:block;width:min(82%,640px);height:80px;object-fit:contain;object-position:left}.lockup img:last-child{width:64px;height:64px;object-fit:contain}.wordmark{margin-top:18px;padding:10px 14px;background:#ffe031}.wordmark img{display:block;width:100%;height:72px;object-fit:contain;object-position:left}.dark .wordmark{background:#17171a}
    </style></head><body><h1>MoonWitness crown + brush wordmark</h1><p>Canonical paths rendered in four accessible palette variants; no text element or remote font is used in the vector.</p><main>${brandCells}</main></body></html>`);
  const brandImages = await brandPage
    .locator('main img')
    .evaluateAll((images) => images.map((image) => image.complete && image.naturalWidth > 0));
  if (brandImages.length !== 12 || brandImages.includes(false)) {
    throw new Error('Brand contact sheet contains invalid SVG previews.');
  }
  await mkdir(dirname(brandOutputPath), { recursive: true });
  await brandPage.screenshot({ path: brandOutputPath, fullPage: true, animations: 'disabled' });
  await brandPage.close();

  const artworkOrder = [
    'illustrations/home-hero-desktop.webp',
    'illustrations/home-hero-mobile.webp',
    'illustrations/board-masthead.webp',
    'illustrations/editorial-people.webp',
    'illustrations/editorial-knowledge.webp',
    'illustrations/editorial-stories.webp',
  ];
  const artworkAssets = artworkOrder.map((path) =>
    manifest.assets.find((asset) => asset.path === path)
  );
  if (artworkAssets.some((asset) => asset?.kind !== 'artwork')) {
    throw new Error('Artwork contact sheet is missing a required visual asset from the manifest.');
  }
  const artworkPage = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  const artworkPreviews = await Promise.all(
    artworkAssets.map(async ({ path }) => ({
      path,
      data: `data:image/webp;base64,${(await readFile(resolve(packageRoot, path))).toString('base64')}`,
    }))
  );
  const artworkMarkup = artworkPreviews
    .map(
      ({ path, data }) =>
        `<article class="${path.split('/').at(-1)?.replace('.webp', '')}"><h2>${path.split('/').at(-1)}</h2><img src="${data}" alt=""></article>`
    )
    .join('');
  await artworkPage.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:26px;background:#17171a;color:#f3efe4;font:14px Arial,sans-serif}h1{margin:0 0 8px;font-size:25px}p{margin:0 0 18px;color:#cbc7bd}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}article{min-width:0;padding:12px;border:2px solid #f3efe4;background:#0d0d0d}h2{margin:0 0 9px;font:12px monospace;color:#ffe031}img{display:block;width:100%;height:280px;object-fit:contain;background:#090909}article.home-hero-desktop{grid-column:span 2}article.home-hero-desktop img{height:440px;object-fit:cover}article.home-hero-mobile img{height:420px}article.board-masthead img{height:auto;aspect-ratio:1600 / 440}article.editorial-people img,article.editorial-knowledge img,article.editorial-stories img{height:220px;object-fit:cover}
    </style></head><body><h1>Manga and collage artwork — optimized crops</h1><p>Illustration-only artwork. All brand names, headlines, and interface text render as selectable HTML.</p><main>${artworkMarkup}</main></body></html>`);
  const artworkImages = await artworkPage
    .locator('main img')
    .evaluateAll((images) => images.map((image) => image.complete && image.naturalWidth > 0));
  if (artworkImages.length !== artworkAssets.length || artworkImages.includes(false)) {
    throw new Error('Artwork contact sheet contains invalid image previews.');
  }
  await mkdir(dirname(artworkOutputPath), { recursive: true });
  await artworkPage.screenshot({
    path: artworkOutputPath,
    fullPage: true,
    animations: 'disabled',
  });
  await artworkPage.close();
  stdout.write(
    `Rendered brand and artwork proofs to ${brandOutputPath} and ${artworkOutputPath}.\n`
  );
} finally {
  await browser.close();
}
