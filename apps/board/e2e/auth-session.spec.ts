import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  createE2eSuffix,
  E2E_JWT_SECRET,
  E2E_SUPERADMIN_PASSWORD,
  loginPageUrl,
} from './constants.js';

interface E2EUser {
  id: number;
  login: string;
  role: 'system' | 'superadmin' | 'user';
  partner_id?: number;
}

interface PersistedSession {
  access_token: string;
  refresh_token: string;
  user: E2EUser;
}

function expiredAccessToken(user: E2EUser): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: String(user.id),
      role: user.role,
      iss: 'moonwitness',
      iat: now - 120,
      exp: now - 60,
    })
  ).toString('base64url');
  const content = `${header}.${payload}`;
  const signature = createHmac('sha256', E2E_JWT_SECRET).update(content).digest('base64url');
  return `${content}.${signature}`;
}

async function loginSuperadmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await expect(page.getByRole('heading', { name: 'Command center', exact: false })).toBeVisible();
}

test('reload restores session, concurrent requests share expired-token refresh, and logout revokes it', async ({
  page,
}) => {
  await loginSuperadmin(page);
  const original = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as PersistedSession | null
  );
  expect(original).not.toBeNull();

  await page.reload();
  await expect(page).toHaveURL(/\/board$/u);
  await expect(page.getByRole('heading', { name: 'Command center', exact: false })).toBeVisible();

  const expired = expiredAccessToken(original!.user);
  await page.evaluate((token) => {
    const session = JSON.parse(
      localStorage.getItem('mw-board-session') ?? 'null'
    ) as PersistedSession | null;
    if (!session) throw new Error('Expected persisted E2E session');
    session.access_token = token;
    localStorage.setItem('mw-board-session', JSON.stringify(session));
  }, expired);

  let refreshRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/auth/refresh') refreshRequests += 1;
  });
  await page.reload();
  await expect(page).toHaveURL(/\/board$/u);
  await expect(page.getByRole('heading', { name: 'Command center', exact: false })).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const session = JSON.parse(
          localStorage.getItem('mw-board-session') ?? 'null'
        ) as PersistedSession | null;
        return session?.access_token;
      })
    )
    .not.toBe(expired);
  expect(refreshRequests).toBe(1);

  const rotated = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as PersistedSession | null
  );
  expect(rotated?.refresh_token).not.toBe(original?.refresh_token);
  await page.getByRole('button', { name: 'superadmin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(loginPageUrl);
  await expect(page.getByRole('heading', { name: 'Enter the Shadow' })).toBeVisible();
  await expect(page.evaluate(() => localStorage.getItem('mw-board-session'))).resolves.toBeNull();

  const replay = await page.request.post('/auth/refresh', {
    data: { refresh_token: rotated!.refresh_token },
  });
  expect(replay.status()).toBe(401);
  await page.goto('/board/profile');
  await expect(page).toHaveURL(loginPageUrl);
  await expect(page.getByRole('heading', { name: 'Enter the Shadow' })).toBeVisible();
});

test('disabled accounts cannot establish an authentication session', async ({ page }) => {
  await loginSuperadmin(page);
  const session = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as PersistedSession | null
  );
  expect(session).not.toBeNull();
  const headers = { authorization: `Bearer ${session!.access_token}` };
  const suffix = createE2eSuffix();
  const login = `e2e-disabled-${suffix}`;
  const password = `e2e-disabled-password-${suffix}`;

  const partnerResponse = await page.request.post('/api/base.partner', {
    headers,
    data: { name: `Disabled E2E ${suffix}` },
  });
  expect(partnerResponse.status()).toBe(201);
  const partnerBody = (await partnerResponse.json()) as { data: { id: number } };

  const userResponse = await page.request.post('/api/base.user', {
    headers,
    data: {
      login,
      password,
      role: 'user',
      partner_id: partnerBody.data.id,
      active: false,
    },
  });
  expect(userResponse.status()).toBe(201);

  const rejectedLogin = await page.request.post('/auth/login', { data: { login, password } });
  expect(rejectedLogin.status()).toBe(401);
  await expect(rejectedLogin.json()).resolves.toMatchObject({
    success: false,
    error: 'Invalid credentials',
  });
});

test('login returns to an internal page and rejects an external return target', async ({
  page,
}) => {
  await page.goto('/board/m/base.partner?source=session-test');
  const applicationOrigin = new URL(page.url()).origin;
  await expect(page).toHaveURL(loginPageUrl);
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/m\/base\.partner\?source=session-test$/u);
  await expect(page.getByRole('heading', { name: 'Partners' })).toBeVisible();

  await page.getByRole('button', { name: 'superadmin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(loginPageUrl);
  await page.evaluate(() => {
    const current = window.history.state as { key?: string; idx?: number } | null;
    window.history.replaceState(
      {
        usr: { from: 'https://attacker.example/steal-session' },
        key: current?.key ?? 'test',
        idx: current?.idx ?? 0,
      },
      '',
      window.location.href
    );
  });
  await page.reload();
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/m\/base\.partner\?source=session-test$/u);
  expect(new URL(page.url()).origin).toBe(applicationOrigin);
  await expect(page.getByRole('heading', { name: 'Partners' })).toBeVisible();

  await page.getByRole('button', { name: 'superadmin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.goto('/login?returnTo=https%3A%2F%2Fattacker.example%2Fsteal-session');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  expect(new URL(page.url()).origin).toBe(applicationOrigin);
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible();
});
