import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

interface RoadmapReport {
  sourceSha: string;
  generatedAt: string;
  totals: { taskCount: number };
  milestones: Record<string, { taskCount: number }>;
  items: Record<string, unknown>[];
}

// The public bundle may only carry source-derived task fields; issue bodies, comments and any
// other private discussion content must never reach it.
const publicTaskFields = [
  'taskId',
  'milestone',
  'priority',
  'labels',
  'lane',
  'workStatus',
  'deliveryStage',
  'blockers',
];

const repositoryBase = process.env.MW_DOCS_BASE_PATH ?? '/moonwitness-xiv/';
const portalPath = (route: string) => `${repositoryBase}${route.replace(/^\//u, '')}`;

test('lands in the guide and renders responsive navigation and document content', async ({
  page,
}) => {
  await page.goto('');
  await expect(page).toHaveURL(new RegExp(`${portalPath('guide/tutorials/quickstart')}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Quickstart lingkungan lokal' })).toBeVisible();
  await expect(page.getByLabel('Versi dokumentasi')).toContainText(/(?:Preview|Stable|Next)/u);
  await expect(page.getByLabel('Versi dokumentasi')).toContainText('1.0.0-rc.1');
  await expect(page.getByRole('navigation', { name: 'Mulai' })).toContainText('Arsitektur');

  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = page.getByRole('complementary', { name: 'Navigasi dokumentasi' });
  await expect(navigation).not.toHaveClass(/sidebar-open/u);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(navigation).toHaveClass(/sidebar-open/u);
  await page.getByRole('link', { name: /Membuat addon/u }).click();
  await expect(page.getByRole('heading', { name: 'Membuat addon' })).toBeVisible();
  await expect(navigation).not.toHaveClass(/sidebar-open/u);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('renders the source-bound roadmap dashboard with honest delivery status', async ({ page }) => {
  await page.goto('roadmap');
  await expect(page.getByRole('heading', { name: 'Roadmap progress' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Roadmap progress Status' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByText('Belum tersedia', { exact: true })).toBeVisible();
  await expect(page.getByText(/checkout berubah|bersih/u)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Buka roadmap ↗' })).toHaveAttribute(
    'href',
    /blob\/[a-f0-9]{40}\/ROADMAP\.md/u
  );
  await expect(page.getByRole('table', { name: /Status berdasarkan milestone/u })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('M11');
  await expect(page.getByRole('link', { name: /Metode dan batasan dashboard/u })).toHaveAttribute(
    'href',
    /docs\/roadmap\/evidence\/M11\.09\.md/u
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Roadmap progress' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('roadmap dashboard lists every milestone and stays reachable by keyboard and deep link', async ({
  page,
}) => {
  const report = JSON.parse(
    readFileSync(new URL('../../../dist/roadmap-progress.json', import.meta.url), 'utf8')
  ) as RoadmapReport;
  const milestoneNames = Object.keys(report.milestones);
  expect(milestoneNames.length).toBeGreaterThan(1);
  // A milestone dropped from the projection would shrink the table silently, so the rows have to
  // account for every task the report claims to cover.
  expect(milestoneNames.reduce((total, name) => total + report.milestones[name].taskCount, 0)).toBe(
    report.totals.taskCount
  );
  expect(
    [...new Set(report.items.flatMap((item) => Object.keys(item)))].filter(
      (field) => !publicTaskFields.includes(field)
    )
  ).toEqual([]);

  await page.goto('roadmap');
  const sourceLink = page.getByRole('link', {
    name: report.sourceSha.slice(0, 12),
    exact: true,
  });
  await expect(sourceLink).toHaveAttribute('href', new RegExp(`/tree/${report.sourceSha}$`, 'u'));
  await expect(page.locator('.roadmap-provenance time')).toHaveAttribute(
    'datetime',
    report.generatedAt
  );

  const milestoneRows = page
    .getByRole('table', { name: /Status berdasarkan milestone/u })
    .locator('tbody th[scope="row"]');
  await expect(milestoneRows).toHaveCount(milestoneNames.length);
  await expect(milestoneRows).toHaveText(milestoneNames);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${portalPath('roadmap')}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Roadmap progress' })).toBeVisible();

  // The milestone table is wider than a phone; it must scroll inside its own container instead of
  // pushing the document sideways.
  await expect(page.locator('.roadmap-table-wrap')).toHaveCSS('overflow-x', 'auto');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('');
  await page.getByRole('link', { name: 'Roadmap progress Status' }).press('Enter');
  await expect(page).toHaveURL(new RegExp(`${portalPath('roadmap')}$`, 'u'));
  await expect(page.getByRole('link', { name: 'Roadmap progress Status' })).toHaveAttribute(
    'aria-current',
    'page'
  );
});

test('publishes the interactive shared UI catalog from the docs site', async ({ page }) => {
  await page.goto('');
  const catalogLink = page.getByRole('link', { name: 'UI component catalog Design' });
  await expect(catalogLink).toHaveAttribute('href', '/moonwitness-xiv/components/');
  await catalogLink.click();
  await expect(page).toHaveURL(/\/moonwitness-xiv\/components\/$/u);
  await expect(page.getByRole('heading', { name: 'One system. Every screen.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use dark theme' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'One system. Every screen.' })).toBeVisible();
});

test('search is keyboard reachable and routes to matching guide pages', async ({ page }) => {
  await page.goto('');
  const search = page.getByRole('searchbox', { name: 'Cari dokumentasi' });
  await expect(search).toBeVisible();
  await page.keyboard.press('Slash');
  await expect(search).toBeFocused();
  await search.fill('addon');
  const result = page.getByRole('option', { name: /Membuat addon/u });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(new RegExp(`${portalPath('guide/how-to/addon-development')}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Membuat addon' })).toBeVisible();
});

test('nested page reload and branded not-found route work under the repository base path', async ({
  page,
}) => {
  await page.goto('guide/how-to/addon-development');
  await expect(page.getByRole('heading', { name: 'Membuat addon' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${portalPath('guide/how-to/addon-development')}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Membuat addon' })).toBeVisible();

  await page.goto('does-not-exist');
  await expect(page.getByRole('heading', { name: 'Halaman ini tidak ditemukan.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Buka panduan awal/u })).toHaveAttribute(
    'href',
    new RegExp(`${portalPath('guide/tutorials/quickstart')}`, 'u')
  );
});
