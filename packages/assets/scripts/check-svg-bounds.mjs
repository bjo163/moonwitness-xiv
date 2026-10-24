import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import manifest from '../manifest.json' with { type: 'json' };

const packageRoot = resolve(import.meta.dirname, '..');
const svgAssets = manifest.assets.filter((asset) => asset.format === 'svg');
const intentionalBleed = new Map([
  [
    'brand/social-card.svg',
    {
      elements: ['mw-brand-social-card-orbit-outer'],
      reason:
        'the outer orbit ring is intentionally cropped at the right edge of the social-card canvas',
    },
  ],
]);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const failures = [];

try {
  for (const asset of svgAssets) {
    const source = await readFile(resolve(packageRoot, asset.path), 'utf8');
    await page.setContent(`<body>${source}</body>`);
    const exception = intentionalBleed.get(asset.path);
    const bounds = await page.locator('svg').evaluate((svg, allowedElements) => {
      const viewBox = svg.viewBox.baseVal;
      const outside = (rendered) =>
        rendered.x < viewBox.x - 0.05 ||
        rendered.y < viewBox.y - 0.05 ||
        rendered.x + rendered.width > viewBox.x + viewBox.width + 0.05 ||
        rendered.y + rendered.height > viewBox.y + viewBox.height + 0.05;
      const intentional = allowedElements.map((id) => svg.querySelector(`#${id}`));
      if (intentional.some((element) => !element)) {
        return { error: `documented bleed element missing: ${allowedElements.join(', ')}` };
      }
      if (intentional.some((element) => !outside(element.getBBox()))) {
        return {
          error: `documented bleed element no longer exceeds viewBox: ${allowedElements.join(', ')}`,
        };
      }
      const measuredSvg = intentional.length ? svg.cloneNode(true) : svg;
      intentional.forEach((element) => measuredSvg.querySelector(`#${element.id}`)?.remove());
      const rendered = measuredSvg.getBBox();
      return {
        x: rendered.x,
        y: rendered.y,
        width: rendered.width,
        height: rendered.height,
        minX: viewBox.x,
        minY: viewBox.y,
        maxX: viewBox.x + viewBox.width,
        maxY: viewBox.y + viewBox.height,
      };
    }, exception?.elements ?? []);
    if ('error' in bounds) {
      failures.push({ path: asset.path, error: bounds.error });
    } else if (
      bounds.x < bounds.minX - 0.05 ||
      bounds.y < bounds.minY - 0.05 ||
      bounds.x + bounds.width > bounds.maxX + 0.05 ||
      bounds.y + bounds.height > bounds.maxY + 0.05
    ) {
      failures.push({ path: asset.path, bounds });
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  throw new Error(
    `Rendered SVG painted bounds fall outside their viewBoxes:\n${failures
      .map(({ path, bounds, error }) => `- ${path}: ${error ?? JSON.stringify(bounds)}`)
      .join('\n')}\nCorrect the source bounds or document an intentional decorative bleed.`
  );
}

const bleedDetails = [...intentionalBleed].map(
  ([path, exception]) => `${path} [${exception.elements.join(', ')}]: ${exception.reason}`
);
process.stdout.write(
  `Checked ${svgAssets.length} SVG viewBoxes; all artwork is in bounds except named decorative elements:\n- ${bleedDetails.join('\n- ')}\n`
);
