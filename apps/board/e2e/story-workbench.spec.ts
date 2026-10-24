import { expect, test } from '@playwright/test';
import { E2E_SUPERADMIN_PASSWORD } from './constants.js';

test('story workbench preserves page text while selecting and reordering pages', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await page.getByRole('link', { name: 'Story workbench' }).click();
  await expect(page.getByRole('heading', { name: 'Story workbench' })).toBeVisible();

  const pageSelector = page.getByLabel('Story page');
  const originalPageId = await pageSelector.inputValue();
  const initialPageCount = await pageSelector.locator('option').count();
  const editor = page.getByLabel('Page text · exact whitespace is preserved');
  await page.getByRole('button', { name: 'Add page' }).click();
  const addedPageId = await pageSelector.inputValue();
  const secondPageText = `Synthetic page ${Date.now()}\n  `;
  await editor.fill(secondPageText);
  await page.getByRole('button', { name: 'Move up' }).click();
  await expect(pageSelector).toHaveValue(addedPageId);
  await page.getByRole('button', { name: 'Move down' }).click();
  await expect(pageSelector).toHaveValue(addedPageId);

  await pageSelector.selectOption(originalPageId);
  await editor.fill('Synthetic first page.\n');
  await expect(pageSelector).toHaveValue(originalPageId);
  await expect(editor).toHaveValue('Synthetic first page.\n');
  await pageSelector.selectOption(addedPageId);
  await expect(editor).toHaveValue(secondPageText);
  await page.getByRole('button', { name: 'Remove page' }).click();
  await expect(pageSelector.locator('option')).toHaveCount(initialPageCount);
  await pageSelector.selectOption(originalPageId);
  await expect(editor).toHaveValue('Synthetic first page.\n');
});

test('story workbench keeps drafts and requires retry after an unavailable read', async ({
  page,
}) => {
  let readAttempts = 0;
  let writeAttempts = 0;
  await page.route('**/api/research/stories/**', async (route) => {
    if (route.request().method() === 'POST') {
      writeAttempts += 1;
      await route.fulfill({ status: 500, json: { success: false, error: 'Unexpected write' } });
      return;
    }
    readAttempts += 1;
    await route.fulfill(
      readAttempts === 1
        ? { status: 503, json: { success: false, error: 'Temporary failure' } }
        : { status: 404, json: { success: false, error: 'Story is unavailable' } }
    );
  });

  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await page.getByRole('link', { name: 'Story workbench' }).click();
  await expect(page.getByRole('heading', { name: 'Story workbench' })).toBeVisible();
  await expect(page.getByText(/Could not confirm the saved story state/u)).toBeVisible();

  const editor = page.getByLabel('Page text · exact whitespace is preserved');
  const draft = 'Unsubmitted synthetic draft.\n  keep whitespace  ';
  await editor.fill(draft);
  await expect(page.getByRole('button', { name: 'Save revision 1' })).toBeDisabled();
  expect(writeAttempts).toBe(0);

  await page.getByRole('button', { name: 'Retry loading story' }).click();
  await expect(page.getByText(/No saved sample is available in this company yet/u)).toBeVisible();
  await expect(editor).toHaveValue(draft);
  await expect(page.getByRole('button', { name: 'Save revision 1' })).toBeEnabled();
  expect(readAttempts).toBe(2);
  expect(writeAttempts).toBe(0);
});

test('story workbench reads immutable prior revisions without losing the latest draft', async ({
  page,
}) => {
  let writeAttempts = 0;
  await page.route('**/api/research/stories/**', async (route) => {
    if (route.request().method() === 'POST') {
      writeAttempts += 1;
      await route.fulfill({ status: 500, json: { success: false, error: 'Unexpected write' } });
      return;
    }
    const version = new URL(route.request().url()).searchParams.get('version');
    const revision = version === '1' ? 1 : 2;
    const pageText = revision === 1 ? 'Immutable original page.' : 'Latest revised page.';
    const digest = revision === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
    await route.fulfill({
      status: 200,
      json: {
        success: true,
        data: {
          storyId: 'mw:story:editorial-sample',
          version: revision,
          digest,
          previousDigest: revision === 1 ? null : 'a'.repeat(64),
          visibility: 'INTERNAL',
          idempotent: false,
          story: {
            schema_version: 1,
            story_id: 'mw:story:editorial-sample',
            version: revision,
            title: 'Editorial sample',
            visibility: 'INTERNAL',
            pages: [
              {
                page_id: 'mw:story-page:editorial-sample-1',
                page_order: 1,
                original_text: pageText,
              },
            ],
          },
        },
      },
    });
  });

  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await page.getByRole('link', { name: 'Story workbench' }).click();
  const editor = page.getByLabel('Page text · exact whitespace is preserved');
  const preview = page.getByRole('article', { name: 'Private preview of page 1' });
  await expect(editor).toHaveValue('Latest revised page.');
  await expect(preview).toContainText('Latest revised page.');
  const latestDraft = 'Unsaved latest draft must survive history browsing.';
  await editor.fill(latestDraft);
  await expect(preview).toContainText(latestDraft);

  await page.getByLabel('Previous revision number').fill('1');
  await page.getByRole('button', { name: 'Load revision' }).click();
  await expect(editor).toHaveValue('Immutable original page.');
  await expect(preview).toContainText('Immutable original page.');
  await expect(editor).toHaveAttribute('readonly', '');
  await expect(page.getByText('Viewing immutable revision 1; editing is disabled.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save revision 3' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add page' })).toBeDisabled();

  await page.getByRole('button', { name: 'Return to latest revision' }).click();
  await expect(editor).toHaveValue(latestDraft);
  await expect(preview).toContainText(latestDraft);
  await expect(editor).not.toHaveAttribute('readonly', '');
  expect(writeAttempts).toBe(0);
});
