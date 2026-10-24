import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const brandRoot = resolve(packageRoot, 'brand');
const proofPath = resolve(repositoryRoot, 'docs/design/assets/brand-identity-contact-sheet.png');
const socialPath = resolve(brandRoot, 'social-card.png');
const docsSocialPath = resolve(repositoryRoot, 'docs/assets/moonwitness/brand/social-card.png');

function dataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const browser = await chromium.launch({ headless: true });
try {
  const socialSvg = await readFile(resolve(brandRoot, 'social-card.svg'), 'utf8');
  const socialPage = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await socialPage.setContent(
    `<html><body style="margin:0;width:1200px;height:630px;overflow:hidden"><img alt="MoonWitness social card" style="display:block;width:1200px;height:630px" src="${dataUrl(socialSvg)}"></body></html>`
  );
  await socialPage.locator('img').evaluate((image) => image.decode());
  await socialPage.screenshot({ path: socialPath, animations: 'disabled' });
  await mkdir(dirname(docsSocialPath), { recursive: true });
  await copyFile(socialPath, docsSocialPath);
  await socialPage.close();

  const previews = await Promise.all(
    [
      'moonwitness-symbol-light.svg',
      'moonwitness-symbol-dark.svg',
      'moonwitness-symbol-mono-light.svg',
      'moonwitness-symbol-mono-dark.svg',
      'moonwitness-wordmark-light.svg',
      'moonwitness-wordmark-dark.svg',
      'moonwitness-wordmark-mono-light.svg',
      'moonwitness-wordmark-mono-dark.svg',
      'moonwitness-lockup-light.svg',
      'moonwitness-lockup-dark.svg',
      'moonwitness-lockup-mono-light.svg',
      'moonwitness-lockup-mono-dark.svg',
      'favicon.svg',
    ].map(async (filename) => {
      const svg = await readFile(resolve(brandRoot, filename), 'utf8');
      return { filename, src: dataUrl(svg) };
    })
  );
  const rows = previews
    .map(({ filename, src }) => {
      const scaleSamples = filename.includes('symbol') || filename === 'favicon.svg';
      const samples = scaleSamples
        ? `<div><img src="${src}" style="width:16px;height:16px" alt=""><span>16px</span></div>
           <div><img src="${src}" style="width:24px;height:24px" alt=""><span>24px</span></div>
           <div><img src="${src}" style="width:32px;height:32px" alt=""><span>32px</span></div>
           <div><img src="${src}" style="width:48px;height:48px" alt=""><span>48px</span></div>`
        : '<span>native proportions</span>';
      return `<article><h2>${filename}</h2><div class="samples">${samples}
        <img class="large" src="${src}" alt="${filename}">
      </div></article>`;
    })
    .join('\n');
  const previewPage = await browser.newPage({
    viewport: { width: 1400, height: 1200 },
    deviceScaleFactor: 1,
  });
  await previewPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#e8e4d9;color:#0d0d0d;font:14px Arial,sans-serif}
    h1{margin:0 0 18px;font-size:22px}main{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    article{min-height:124px;padding:10px 12px;border:2px solid #0d0d0d;background:#fffdf6;box-shadow:3px 3px #0d0d0d}
    article:nth-child(even){background:#0e0e10;color:#fffdf6}.samples{display:flex;align-items:center;gap:18px;height:64px}
    .samples div{display:flex;align-items:center;gap:4px;font-size:10px}.samples .large{max-width:240px;max-height:42px;margin-left:auto}
    </style></head><body><h1>MoonWitness brand assets — scale and theme check</h1><main>${rows}</main></body></html>`);
  await previewPage.locator('main article').last().waitFor();
  await previewPage
    .locator('img')
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  const imageStates = await previewPage.locator('img').evaluateAll((images) =>
    images.map((image) => ({
      loaded: image.complete && image.naturalWidth > 0,
      width: image.naturalWidth,
      bounds: Math.round(image.getBoundingClientRect().width),
    }))
  );
  if (imageStates.some(({ loaded }) => !loaded)) {
    throw new Error(`Brand preview has broken SVGs: ${JSON.stringify(imageStates)}`);
  }
  stdout.write(`Rendered ${imageStates.length} preview images.\n`);
  await mkdir(dirname(proofPath), { recursive: true });
  await previewPage.screenshot({ path: proofPath, fullPage: true, animations: 'disabled' });
  await previewPage.close();
} finally {
  await browser.close();
}

stdout.write(`Rendered ${socialPath} and ${proofPath}.\n`);
await import('./render-icons.mjs');
