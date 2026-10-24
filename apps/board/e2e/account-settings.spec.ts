import { expect, test } from '@playwright/test';
import { createE2eSuffix, E2E_SUPERADMIN_PASSWORD, loginPageUrl } from './constants.js';

test('users can edit only their profile, persist preferences, and change password safely', async ({
  page,
}) => {
  const suffix = createE2eSuffix();
  const login = `e2e-account-${suffix}`;
  const initialPassword = `account-e2e-${suffix}`;
  const updatedPassword = `account-updated-${suffix}`;

  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  const adminSession = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as {
        access_token: string;
      } | null
  );
  expect(adminSession).not.toBeNull();
  const adminProfileResponse = await page.request.get('/auth/me', {
    headers: { authorization: `Bearer ${adminSession!.access_token}` },
  });
  expect(adminProfileResponse.status()).toBe(200);
  const adminProfile = (await adminProfileResponse.json()) as {
    data: { company_id?: number };
  };

  const partner = await page.request.post('/api/base.partner', {
    headers: { authorization: `Bearer ${adminSession!.access_token}` },
    data: {
      name: `Account E2E ${suffix}`,
      email: `account-${suffix}@example.test`,
      company_id: adminProfile.data.company_id,
    },
  });
  expect(partner.status()).toBe(201);
  const partnerPayload = (await partner.json()) as { data: { id: number } };
  const user = await page.request.post('/api/base.user', {
    headers: { authorization: `Bearer ${adminSession!.access_token}` },
    data: {
      login,
      password: initialPassword,
      role: 'user',
      partner_id: partnerPayload.data.id,
      active: true,
    },
  });
  expect(user.status()).toBe(201);

  await page.getByRole('button', { name: 'superadmin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(loginPageUrl);
  await page.getByLabel('Email or Username').fill(login);
  await page.getByLabel('Password', { exact: true }).fill(initialPassword);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  const ordinarySession = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as {
        access_token: string;
      } | null
  );
  expect(ordinarySession).not.toBeNull();
  const ordinaryHeaders = { authorization: `Bearer ${ordinarySession!.access_token}` };
  const accountUser = await page.request.get('/auth/me', { headers: ordinaryHeaders });
  expect(accountUser.status()).toBe(200);
  const accountUserPayload = (await accountUser.json()) as {
    data: { partner_id?: number };
  };
  expect(accountUserPayload.data.partner_id).toBe(partnerPayload.data.id);

  await page.goto('/board/profile');
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  const updatedName = `Updated ${suffix}`;
  await page.getByLabel('Full name').fill(updatedName);
  await page.getByLabel('Email', { exact: true }).fill(`updated-${suffix}@example.test`);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('heading', { name: updatedName })).toBeVisible();
  const profileReload = await page.request.get('/api/base.partner', {
    headers: ordinaryHeaders,
    params: { domain: JSON.stringify([['id', '=', partnerPayload.data.id]]) },
  });
  expect(profileReload.status()).toBe(200);
  const profilePayload = (await profileReload.json()) as {
    data: Array<{ id: number; name: string; email: string }>;
  };
  expect(profilePayload.data[0]).toMatchObject({
    id: partnerPayload.data.id,
    name: updatedName,
    email: `updated-${suffix}@example.test`,
  });

  await page.goto('/board/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByLabel('Language').click();
  const languages = page.getByRole('listbox');
  await languages.getByRole('option', { name: /English \(US\) \(en-US\)/u }).click();
  await page.getByLabel('Time zone').click();
  await page.getByRole('listbox').getByRole('option', { name: 'Asia/Jakarta' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Language' })).toContainText('English (US)');
  await expect(page.getByRole('combobox', { name: 'Time zone' })).toContainText('Asia/Jakarta');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');

  const partnerDetailResponse = await page.request.get('/api/base.partner', {
    headers: ordinaryHeaders,
    params: {
      domain: JSON.stringify([['id', '=', partnerPayload.data.id]]),
      fields: 'id,create_date',
    },
  });
  expect(partnerDetailResponse.status()).toBe(200);
  const partnerDetail = (await partnerDetailResponse.json()) as {
    data: Array<{ id: number; create_date: string }>;
  };
  const createdPartner = partnerDetail.data[0];
  expect(createdPartner).toBeDefined();
  const localizedCreateTime = await page.evaluate(
    ({ value, locale, timeZone }) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
      }).format(new Date(value)),
    { value: createdPartner!.create_date, locale: 'en-US', timeZone: 'Asia/Jakarta' }
  );
  await page.goto(`/board/m/base.partner/${partnerPayload.data.id}`);
  await expect(page.getByText('Created At', { exact: true })).toBeVisible();
  await expect(page.getByText('Created At', { exact: true }).locator('..')).toContainText(
    localizedCreateTime
  );
  await page.goto('/board/settings');
  await expect(page.getByLabel('Current password')).toBeVisible();

  const wrongCurrentPassword = await page.request.post('/auth/me/password', {
    headers: ordinaryHeaders,
    data: { current_password: 'incorrect-current-password', new_password: updatedPassword },
  });
  expect(wrongCurrentPassword.status()).toBe(400);

  await page.getByLabel('Current password').fill(initialPassword);
  await page.getByLabel('New password', { exact: true }).fill(updatedPassword);
  await page.getByLabel('Confirm new password').fill(`${updatedPassword}-mismatch`);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/board\/settings$/u);

  await page.getByLabel('New password', { exact: true }).fill(updatedPassword);
  await page.getByLabel('Confirm new password').fill(updatedPassword);
  const passwordChangeResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/auth/me/password' &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Change password' }).click();
  expect((await passwordChangeResponse).status()).toBe(200);
  await expect(page).toHaveURL(loginPageUrl);
  await page.getByLabel('Email or Username').fill(login);
  await page.getByLabel('Password', { exact: true }).fill(initialPassword);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid credentials' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(updatedPassword);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await expect(page.getByRole('heading', { name: `Command center`, exact: false })).toBeVisible();
});
