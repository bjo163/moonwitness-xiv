import { expect, test } from '@playwright/test';
import { createE2eSuffix, E2E_SUPERADMIN_PASSWORD } from './constants.js';

interface BoardSession {
  access_token: string;
}

interface ApiListResponse<TRecord> {
  total: number;
  data: TRecord[];
}

test('list search, filters, sorting, pagination, counts, and user relations work on PostgreSQL', async ({
  page,
}) => {
  const suffix = createE2eSuffix();
  const prefix = `List E2E ${suffix}`;

  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const session = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as BoardSession | null
  );
  expect(session).not.toBeNull();
  const authorization = { authorization: `Bearer ${session!.access_token}` };
  const names = Array.from(
    { length: 23 },
    (_, index) => `${prefix} ${String(index + 1).padStart(2, '0')}`
  );
  const partnersResponse = await page.request.post('/api/base.partner', {
    headers: authorization,
    data: names.map((name, index) => ({
      name,
      email: `list-${suffix}-${index + 1}@example.test`,
      active: index < 21,
    })),
  });
  expect(partnersResponse.status()).toBe(201);

  const usersResponse = await page.request.get('/api/base.user', {
    headers: authorization,
    params: {
      domain: JSON.stringify([['login', '=', 'superadmin']]),
      limit: '20',
      order: 'login asc',
      with: 'partner,language',
      count: 'true',
    },
  });
  expect(usersResponse.status()).toBe(200);
  const users = (await usersResponse.json()) as ApiListResponse<{
    login: string;
    partner: { name: string };
    language: { code: string } | null;
  }>;
  expect(users.total).toBe(1);
  expect(users.data).toHaveLength(1);
  expect(users.data[0]).toMatchObject({
    login: 'superadmin',
    partner: { name: 'Super Administrator' },
  });
  expect(users.data[0]).toHaveProperty('language');

  await page.goto('/board/m/base.partner');
  await expect(page.getByRole('heading', { name: 'Partners' })).toBeVisible();
  const search = page.getByRole('textbox', { name: 'Search partners...' });
  await search.fill(prefix);
  const table = page.getByRole('table');
  await expect(table.getByText(names[0], { exact: true })).toBeVisible();
  await expect(page.getByText('Showing 1 to 20 of 21')).toBeVisible();
  await page.getByRole('button', { name: 'Next Page' }).click();
  await expect(page.getByText('Showing 21 to 21 of 21')).toBeVisible();
  await expect(table.getByText(names[20], { exact: true })).toBeVisible();

  await search.fill(`${suffix} 21`);
  await expect(page.getByText('Showing 1 to 1 of 1')).toBeVisible();
  await expect(table.getByText(names[20], { exact: true })).toBeVisible();

  await search.fill(suffix);
  await expect(page.getByText('Showing 1 to 20 of 21')).toBeVisible();
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(page.getByText('Showing 1 to 2 of 2')).toBeVisible();
  await expect(table.getByText(names[21], { exact: true })).toBeVisible();
  await expect(table.getByText(names[0], { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByText('Showing 1 to 20 of 21')).toBeVisible();
  await search.fill(prefix);
  await expect(page.getByText('Showing 1 to 20 of 21')).toBeVisible();
  await page.getByRole('columnheader', { name: 'Name' }).click();
  await expect(page.getByText('Showing 1 to 20 of 21')).toBeVisible();
  await expect(table.getByText(names[20], { exact: true })).toBeVisible();
});
