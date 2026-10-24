import { expect, test, type Page } from '@playwright/test';
import { createE2eSuffix, E2E_SUPERADMIN_PASSWORD, loginPageUrl } from './constants.js';

interface BoardSession {
  access_token: string;
  user: { id: number; company_id?: number };
}

interface CreatedRecord {
  id: number;
}

async function loginSuperadmin(page: Page): Promise<BoardSession> {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  const session = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as BoardSession | null
  );
  expect(session).not.toBeNull();
  return session!;
}

test('list loading, offline errors, retry, and empty results preserve the current search', async ({
  page,
}) => {
  await loginSuperadmin(page);
  let delayInitialList = true;
  let simulateOffline = false;
  let allowRecovery = false;
  let failedRequests = 0;

  await page.route('**/api/base.partner**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname !== '/api/base.partner' || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    if (delayInitialList) {
      delayInitialList = false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (simulateOffline && !allowRecovery) {
      failedRequests += 1;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic E2E network outage' }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/board/m/base.partner');
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expect(page.getByRole('table').locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();

  const searchTerm = `no-resilience-match-${Date.now()}`;
  simulateOffline = true;
  await page.getByRole('textbox', { name: 'Search partners...' }).fill(searchTerm);
  const error = page
    .getByRole('alert')
    .filter({ hasText: 'Could not load records. Check your connection and try again.' });
  await expect(error).toContainText('Could not load records. Check your connection and try again.');
  expect(failedRequests).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('textbox', { name: 'Search partners...' })).toHaveValue(searchTerm);

  allowRecovery = true;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('table').getByText('No records found', { exact: true })
  ).toBeVisible();
  await expect(error).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search partners...' })).toHaveValue(searchTerm);
});

test('rapid duplicate save submits a new record only once', async ({ page }) => {
  const session = await loginSuperadmin(page);
  const suffix = createE2eSuffix();
  const name = `Resilience Save ${suffix}`;
  const email = `resilience-save-${suffix}@example.test`;
  let createRequests = 0;

  await page.route('**/api/base.partner**', async (route) => {
    if (
      new URL(route.request().url()).pathname === '/api/base.partner' &&
      route.request().method() === 'POST'
    ) {
      createRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });

  await page.goto('/board/m/base.partner/new');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  const save = page.getByRole('button', { name: 'Save Record' });
  await save.dispatchEvent('click');
  await save.dispatchEvent('click');
  await expect(page).toHaveURL(/\/m\/base\.partner\/\d+$/u);
  expect(createRequests).toBe(1);

  const created = await page.request.get('/api/base.partner', {
    headers: { authorization: `Bearer ${session.access_token}` },
    params: { domain: JSON.stringify([['email', '=', email]]) },
  });
  expect(created.status()).toBe(200);
  expect(((await created.json()) as { data: CreatedRecord[] }).data).toHaveLength(1);
});

test('signing into another account clears the previous account records', async ({ page }) => {
  const administrator = await loginSuperadmin(page);
  const suffix = createE2eSuffix();
  const adminOnlyName = `Account A Private ${suffix}`;
  const viewerName = `Account B Private ${suffix}`;
  const headers = { authorization: `Bearer ${administrator.access_token}` };
  const adminPartnerResponse = await page.request.post('/api/base.partner', {
    headers,
    data: { name: adminOnlyName },
  });
  expect(adminPartnerResponse.status()).toBe(201);
  const partnerResponse = await page.request.post('/api/base.partner', {
    headers,
    data: { name: viewerName },
  });
  expect(partnerResponse.status()).toBe(201);
  const viewerLogin = `scope-viewer-${suffix}`;
  const viewerPassword = `scope-viewer-password-${suffix}`;
  const userResponse = await page.request.post('/auth/register', {
    data: {
      login: viewerLogin,
      password: viewerPassword,
      name: viewerName,
    },
  });
  expect(userResponse.status()).toBe(201);
  expect(userResponse.status()).toBe(201);

  await page.goto('/board/m/base.partner');
  const search = page.getByRole('textbox', { name: 'Search partners...' });
  await search.fill(adminOnlyName);
  await expect(page.getByRole('table').getByText(adminOnlyName)).toBeVisible();
  await page.getByRole('button', { name: 'superadmin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(loginPageUrl);

  await page.getByLabel('Email or Username').fill(viewerLogin);
  await page.getByLabel('Password', { exact: true }).fill(viewerPassword);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/m\/base\.partner$/u);
  await page.goto('/board/m/base.partner');
  await expect(page.getByRole('table').getByText(adminOnlyName)).toHaveCount(0);
});

test('switching companies never renders a record from the previous query scope', async ({
  page,
}) => {
  const session = await loginSuperadmin(page);
  const headers = { authorization: `Bearer ${session.access_token}` };
  const suffix = createE2eSuffix();
  const companyName = `Resilience Company ${suffix}`;
  const companyResponse = await page.request.post('/api/base.company', {
    headers,
    data: { name: companyName, timezone: 'UTC' },
  });
  expect(companyResponse.status()).toBe(201);
  const company = (await companyResponse.json()) as { data: CreatedRecord };
  const membershipResponse = await page.request.post('/api/base.company_membership', {
    headers,
    data: {
      user_id: session.user.id,
      company_id: company.data.id,
      is_default: false,
    },
  });
  expect(membershipResponse.status()).toBe(201);

  await page.route('**/api/base.partner**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname !== '/api/base.partner' || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const requestedCompany = route.request().headers()['x-company-id'];
    const isNewCompany = requestedCompany === String(company.data.id);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        total: 1,
        data: [
          {
            id: isNewCompany ? 920002 : 920001,
            name: isNewCompany ? 'Company B Scoped Record' : 'Company A Scoped Record',
            active: true,
          },
        ],
      }),
    });
  });

  await page.goto('/board/m/base.partner');
  await expect(page.getByRole('table').getByText('Company A Scoped Record')).toBeVisible();
  await page.getByRole('button', { name: /^Switch company/u }).click();
  await page.getByRole('menuitem', { name: companyName }).click();
  await expect(page.getByRole('table').getByText('Company B Scoped Record')).toBeVisible();
  await expect(page.getByRole('table').getByText('Company A Scoped Record')).toHaveCount(0);
});
