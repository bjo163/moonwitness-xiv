import { expect, test } from '@playwright/test';
import { E2E_SUPERADMIN_PASSWORD, loginPageUrl } from './constants.js';

test('login form renders and rejects invalid credentials', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Enter the Shadow' })).toBeVisible();
  await expect(page.getByLabel('Email or Username')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();

  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill('incorrect-e2e-password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();

  await expect(page.getByRole('alert').filter({ hasText: 'Invalid credentials' })).toBeVisible();
  await expect(page).toHaveURL(loginPageUrl);
  await page.screenshot({
    path: '../../docs/design/ui-catalog/auth-login-error-mobile-390.png',
    fullPage: true,
  });
});

test('login submit shows the shared spinner and keeps an explicit busy label', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/auth/login', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Invalid credentials' }),
    });
  });

  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('visual-audit-user');
  await page.getByLabel('Password', { exact: true }).fill('invalid-visual-audit-password');

  const submit = page.getByRole('button', { name: 'Enter the Shadow' });
  const idleBox = await submit.boundingBox();
  await submit.click();

  const busyButton = page.getByRole('button', { name: 'Entering the shadow…' });
  await expect(busyButton).toHaveAttribute('aria-busy', 'true');
  await expect(busyButton).toBeDisabled();
  await expect(busyButton.locator('.mw-ui-loading-spinner')).toBeVisible();
  const busyBox = await busyButton.boundingBox();
  expect(idleBox && busyBox ? Math.abs(idleBox.width - busyBox.width) : 1).toBeLessThan(1);

  await page.screenshot({
    path: '../../docs/design/ui-catalog/auth-login-loading-mobile-390.png',
    fullPage: true,
  });
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid credentials' })).toBeVisible();
});

test('superadmin can log in, open dashboard, and log out', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();

  await expect(page).toHaveURL(/\/board$/u);
  await expect(page.getByRole('heading', { name: 'Command center', exact: false })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Background job status distribution' })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Background job status distribution' })
  ).toBeAttached();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('img', { name: 'Background job status distribution' })).toBeVisible();
  const mobileOverflow = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const elements = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }))
      .filter(
        ({ right, scrollWidth: elementScrollWidth, clientWidth: elementClientWidth }) =>
          right > clientWidth || elementScrollWidth > elementClientWidth
      )
      .slice(0, 12);
    return { hasHorizontalOverflow: scrollWidth > clientWidth, clientWidth, scrollWidth, elements };
  });
  expect(mobileOverflow.hasHorizontalOverflow, JSON.stringify(mobileOverflow)).toBe(false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'superadmin' }).click();
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(loginPageUrl);
  await expect(page.getByRole('heading', { name: 'Enter the Shadow' })).toBeVisible();
});

test('login layout fits a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');

  await expect(page.getByRole('heading', { name: 'Enter the Shadow' })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(hasHorizontalOverflow).toBe(false);
});

test('shared select works with keyboard and profile feedback is announced', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await expect(page.getByRole('heading', { name: 'Command center', exact: false })).toBeVisible();

  await page.goto('/board/settings');
  const language = page.getByRole('combobox').first();
  await language.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(language).toBeFocused();

  await page.goto('/board/profile');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile updated')).toBeVisible();
});
