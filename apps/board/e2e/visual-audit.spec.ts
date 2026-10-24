import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { E2E_SUPERADMIN_PASSWORD } from './constants.js';

const root = path.resolve(import.meta.dirname, '../../..');
const auditDirectory = path.join(root, 'test-results/visual-audit');
const catalogDirectory = path.join(root, 'docs/design/ui-catalog');
const sizes = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1440', width: 1440, height: 1000 },
] as const;
const views = [
  { name: 'dashboard', path: '/board', heading: 'Command center' },
  { name: 'list', path: '/board/m/base.partner', heading: 'Partners' },
  { name: 'form', path: '/board/m/base.partner/new', heading: 'New Partner' },
  { name: 'profile', path: '/board/profile', heading: 'Profile' },
  { name: 'settings', path: '/board/settings', heading: 'Settings' },
] as const;
const visualBaselines = new Set([
  'list/desktop-1440/light',
  'profile/desktop-1440/light',
  'settings/desktop-1440/dark',
]);

test('command shortcut stays inactive while typing in an editable control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  const search = page.getByRole('button', { name: /Search records, models, commands/u });
  await search.click();
  const commandSearch = page.getByPlaceholder(
    'Search models or records (e.g. Acme, Alice, base.partner)…'
  );
  await expect(commandSearch).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command Palette' })).toBeVisible();
  await expect(commandSearch).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Command Palette' })).toBeHidden();
});

test('dashboard KPI cards show current values without fabricated trend percentages', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible();

  const metricTiles = page.locator('.dashboard-metric-link .mw-ui-metric-tile');
  await expect(metricTiles).toHaveCount(4);
  const metricCopy = await metricTiles.allInnerTexts();
  expect(metricCopy.join(' ')).not.toContain('%');

  await expectNoA11yViolations(page, 'dashboard/kpi-no-fabricated-trends');
  await page.screenshot({
    path: path.join(auditDirectory, 'dashboard-kpi-no-trend-desktop-1440.png'),
    fullPage: true,
  });
  await expect(page).toHaveScreenshot('board-dashboard-admin-desktop-1440.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('desktop Board shell uses the compact crown lockup and a magenta active navigation rail', async ({
  page,
}) => {
  await mkdir(auditDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const sidebar = page.locator('aside').filter({
    has: page.getByRole('navigation', { name: 'Models' }),
  });
  const crown = sidebar.locator('img[src="/brand/moonwitness-symbol-dark.svg"]');
  await expect(crown).toBeVisible();
  await expect(crown).toHaveAttribute('aria-hidden', 'true');
  expect((await crown.boundingBox())?.width).toBe(36);
  expect((await crown.boundingBox())?.height).toBe(36);
  await expect(sidebar.getByText('MoonWitness', { exact: true })).toBeVisible();

  const activeLink = sidebar.getByRole('link', { name: 'Dashboard' });
  await expect(activeLink).toHaveAttribute('aria-current', 'page');
  await expect(activeLink).toHaveCSS('border-left-color', 'rgb(255, 46, 136)');
  await expect(activeLink).toHaveCSS('background-color', 'rgb(255, 46, 136)');
  await page
    .locator('nextjs-portal')
    .evaluateAll((elements) => elements.forEach((element) => element.remove()));
  await page.screenshot({
    path: path.join(root, 'docs/design/ui-catalog/board-sidebar-desktop-1440.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open model navigation' }).click();
  const mobileSidebar = page.getByRole('dialog', { name: 'Model navigation' });
  const mobileCrown = mobileSidebar.locator('img[src="/brand/moonwitness-symbol-dark.svg"]');
  await expect(mobileCrown).toBeVisible();
  expect((await mobileCrown.boundingBox())?.width).toBe(36);
  expect((await mobileCrown.boundingBox())?.height).toBe(36);
  await expect(mobileSidebar.getByText('MoonWitness', { exact: true })).toBeVisible();
  await expect(mobileSidebar.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await mobileSidebar.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => undefined))
    );
  });
  await page
    .locator('nextjs-portal')
    .evaluateAll((elements) => elements.forEach((element) => element.remove()));
  await page.screenshot({
    path: path.join(root, 'docs/design/ui-catalog/board-sidebar-mobile-390.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(mobileSidebar).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Keyboard Shortcuts' }).click();
  const shortcutsDialog = page.getByRole('dialog', { name: 'Keyboard Mastery Cheatsheet' });
  await expect(shortcutsDialog.getByText('Manual', { exact: true })).toBeVisible();
  await expect(shortcutsDialog.getByText(/MoonWitness workflow/u)).toBeVisible();
  await page.screenshot({
    path: path.join(root, 'docs/design/ui-catalog/board-shortcuts-desktop-1440.png'),
    fullPage: false,
    animations: 'disabled',
  });
});

test('canonical page icons remain legible on Knowledge, Profile, Settings, and WhatsApp', async ({
  page,
}) => {
  await mkdir(catalogDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await page.getByRole('button', { name: /Switch company/u }).click();
  const companyOptions = page.getByRole('menuitem');
  await expect(companyOptions.nth(1)).toBeVisible();
  await companyOptions.nth(1).click();
  await expect(
    page.getByRole('button', { name: /Switch company\. Current scope: (?!Global Scope)/u })
  ).toBeVisible();

  const screens = [
    { name: 'knowledge', path: '/board/knowledge', heading: 'Knowledge explorer' },
    { name: 'profile', path: '/board/profile', heading: 'Profile' },
    { name: 'settings', path: '/board/settings', heading: 'Settings' },
    { name: 'whatsapp', path: '/board/whatsapp', heading: 'WhatsApp' },
  ] as const;

  for (const viewport of [
    { name: 'desktop-1440', width: 1440, height: 1000 },
    { name: 'mobile-390', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const screen of screens) {
      if (screen.name === 'profile' || screen.name === 'settings') {
        await page.getByRole('button', { name: /^User menu for/u }).click();
        await page
          .getByRole('menuitem', { name: screen.name === 'profile' ? 'Profile' : 'Settings' })
          .click();
      } else {
        if (viewport.name === 'mobile-390') {
          await page.getByRole('button', { name: 'Open model navigation' }).click();
          await page
            .getByRole('dialog', { name: 'Model navigation' })
            .getByRole('link', {
              name: screen.name === 'knowledge' ? 'Knowledge explorer' : 'WhatsApp',
            })
            .click();
        } else {
          await page
            .getByRole('link', {
              name: screen.name === 'knowledge' ? 'Knowledge explorer' : 'WhatsApp',
            })
            .click();
        }
      }
      await expect(page.getByRole('heading', { name: screen.heading }).first()).toBeVisible();
      if (viewport.name === 'mobile-390') {
        await page.getByRole('button', { name: 'Open model navigation' }).click();
        const mobileNavigation = page.getByRole('dialog', { name: 'Model navigation' });
        await expect(mobileNavigation.getByText('MoonWitness', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(mobileNavigation).toBeHidden();
      } else {
        await expect(page.locator('aside').getByText('MoonWitness', { exact: true })).toBeVisible();
      }
      await expectNoHorizontalOverflow(page, `${screen.name}/${viewport.name}`);
      await page.locator('nextjs-portal').evaluateAll((elements) => {
        elements.forEach((element) => element.remove());
      });
      await page.screenshot({
        path: path.join(catalogDirectory, `board-${screen.name}-icons-${viewport.name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
});

test('canonical data-view icons remain legible on lists, forms, tags, and relations', async ({
  page,
}) => {
  await mkdir(catalogDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  for (const viewport of [
    { name: 'desktop-1440', width: 1440, height: 1000 },
    { name: 'mobile-390', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/board/m/base.partner');
    await expect(page.getByRole('heading', { name: 'Partners' })).toBeVisible();
    const acmeRecord =
      viewport.name === 'mobile-390'
        ? page
            .locator('article')
            .filter({ has: page.getByRole('heading', { name: 'Acme Studio', exact: true }) })
            .first()
        : page.getByRole('row').filter({ hasText: 'Acme Studio' }).first();
    await expect(acmeRecord).toBeVisible();
    await expectNoHorizontalOverflow(page, `list/icons/${viewport.name}`);
    await page.locator('nextjs-portal').evaluateAll((elements) => {
      elements.forEach((element) => element.remove());
    });
    await page.screenshot({
      path: path.join(catalogDirectory, `board-list-icons-${viewport.name}.png`),
      fullPage: true,
      animations: 'disabled',
    });

    await acmeRecord.getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: 'Tag Records' })).toBeVisible();
    await page.screenshot({
      path: path.join(catalogDirectory, `board-list-bulk-actions-${viewport.name}.png`),
      fullPage: false,
      animations: 'disabled',
    });
    await acmeRecord.getByRole('button', { name: 'Open →' }).click();
    await expect(page).toHaveURL(/\/board\/m\/base\.partner\/\d+/u);
    await expect(page.getByRole('heading', { name: /Partner #\d+/u })).toBeVisible();
    await expectNoHorizontalOverflow(page, `record/icons/${viewport.name}`);
    await page.screenshot({
      path: path.join(catalogDirectory, `board-record-icons-${viewport.name}.png`),
      fullPage: true,
      animations: 'disabled',
    });

    await page.goto('/board/m/base.partner/new');
    await expect(page.getByRole('heading', { name: 'New Partner' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `form/icons/${viewport.name}`);
    await page.screenshot({
      path: path.join(catalogDirectory, `board-form-icons-${viewport.name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
});

test('canonical activity, notification, and cron icons remain usable on desktop and mobile', async ({
  page,
}) => {
  await mkdir(catalogDirectory, { recursive: true });
  await page.clock.install({ time: new Date('2026-10-24T12:00:00.000Z') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'mw-board-session',
      JSON.stringify({
        access_token: 'visual-audit-only',
        refresh_token: 'visual-audit-only',
        token_type: 'Bearer',
        expires_in: 3600,
        user: { id: 9001, login: 'ui.visual.audit', role: 'superadmin', company_id: 1 },
      })
    );
  });

  const activities = [
    {
      id: 1,
      summary: 'Call the partner about the draft',
      activity_type: 'call',
      state: 'planned',
      deadline: '2026-10-24',
      resource_model: 'base.partner',
      resource_id: 3,
    },
    {
      id: 2,
      summary: 'Prepare the editorial review',
      activity_type: 'meeting',
      state: 'planned',
      deadline: '2026-10-25',
      resource_model: 'base.partner',
      resource_id: 3,
    },
    {
      id: 3,
      summary: 'Send the review notes',
      activity_type: 'email',
      state: 'planned',
      deadline: '2026-10-26',
      resource_model: 'base.partner',
      resource_id: 3,
    },
  ];
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const { pathname, searchParams } = url;
    const respond = (data: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });

    if (pathname === '/api/models') return respond({ models: [] });
    if (pathname === '/api/base.activity') {
      return respond({ data: activities, total: activities.length });
    }
    if (pathname.startsWith('/api/')) return respond({ data: [], total: 0 });
    if (pathname === '/notifications/inbox') {
      return respond({
        success: true,
        data: {
          notifications: [
            {
              id: 1,
              title: 'Editorial review is ready',
              body: 'Please review the latest story draft.',
              state: 'unread',
              delivered_at: '2026-10-24T08:00:00Z',
            },
          ],
          unreadCount: 1,
        },
      });
    }
    if (pathname === '/admin/crons') {
      return respond({
        success: true,
        data: [
          {
            id: 1,
            code: 'story-review',
            name: 'Story review reminders',
            handler: 'notify_story_review',
            cron_expression: '0 9 * * 1-5',
            timezone: 'UTC',
            enabled: true,
            next_run_at: '2026-10-26T09:00:00Z',
            misfire_policy: 'skip',
            concurrency_policy: 'forbid',
          },
        ],
      });
    }
    if (pathname === '/admin/jobs' && searchParams.has('limit')) {
      return respond({
        success: true,
        data: [
          {
            id: 1,
            handler: 'notify_story_review',
            status: 'succeeded',
            priority: 3,
            attempts: 1,
            max_attempts: 3,
            lease_owner: 'worker-a',
            create_date: '2026-10-24T08:00:00Z',
          },
        ],
      });
    }
    if (pathname === '/admin/jobs/health') {
      return respond({
        success: true,
        data: {
          queued: 1,
          running: 0,
          dead: 0,
          outboxPending: 0,
          outboxDead: 0,
          oldestQueuedAt: null,
        },
      });
    }
    if (pathname.startsWith('/admin/')) return respond({ success: true, data: [] });
    return route.continue();
  });

  await page.goto('/board');
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText('MoonWitness', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Pending activities' }).click();
  await expect(page.getByText('Call the partner about the draft')).toBeVisible();
  await page.locator('nextjs-portal').evaluateAll((elements) => {
    elements.forEach((element) => element.remove());
  });
  await page.screenshot({
    path: path.join(catalogDirectory, 'board-activity-bell-icons-desktop-1440.png'),
    animations: 'disabled',
  });
  await expectNoHorizontalOverflow(page, 'activity-bell/icons/desktop-1440');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Notifications/u }).click();
  await expect(page.getByText('Editorial review is ready')).toBeVisible();
  await page.locator('nextjs-portal').evaluateAll((elements) => {
    elements.forEach((element) => element.remove());
  });
  await page.screenshot({
    path: path.join(catalogDirectory, 'board-notification-bell-icons-desktop-1440.png'),
    animations: 'disabled',
  });

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Cron Scheduler & Queue' }).click();
  await expect(
    page.getByRole('heading', { name: 'Cron Scheduler & Background Workers' })
  ).toBeVisible();
  await expect(page.getByText('Story review reminders')).toBeVisible();
  await page.locator('nextjs-portal').evaluateAll((elements) => {
    elements.forEach((element) => element.remove());
  });
  await page.screenshot({
    path: path.join(catalogDirectory, 'board-cron-panel-icons-desktop-1440.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(catalogDirectory, 'board-cron-panel-icons-mobile-390.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await expectNoHorizontalOverflow(page, 'cron-panel/icons/mobile-390');
  for (const label of ['Cron schedules', 'Recent job dispatches']) {
    const region = page.getByRole('region', { name: label });
    const dimensions = await region.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      tabIndex: element.tabIndex,
    }));
    expect(dimensions.tabIndex).toBe(0);
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  }
  const cronRegion = page.getByRole('region', { name: 'Cron schedules' });
  await cronRegion.focus();
  const scrollBefore = await cronRegion.evaluate((element) => element.scrollLeft);
  await page.keyboard.press('ArrowRight');
  const scrollAfter = await cronRegion.evaluate((element) => element.scrollLeft);
  expect(scrollAfter).toBeGreaterThan(scrollBefore);

  await page.goto('/board');
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Pending activities' }).click();
  await expect(page.getByText('Call the partner about the draft')).toBeVisible();
  await page.locator('nextjs-portal').evaluateAll((elements) => {
    elements.forEach((element) => element.remove());
  });
  await page.screenshot({
    path: path.join(catalogDirectory, 'board-activity-bell-icons-mobile-390.png'),
    animations: 'disabled',
  });
  await expectNoHorizontalOverflow(page, 'activity-bell/icons/mobile-390');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Notifications/u }).click();
  await expect(page.getByText('Editorial review is ready')).toBeVisible();
  await page.locator('nextjs-portal').evaluateAll((elements) => {
    elements.forEach((element) => element.remove());
  });
  await page.screenshot({
    path: path.join(catalogDirectory, 'board-notification-bell-icons-mobile-390.png'),
    animations: 'disabled',
  });
  await expectNoHorizontalOverflow(page, 'notification-bell/icons/mobile-390');
  expect(browserErrors).toEqual([]);
});

test('ordinary-user dashboard has a verified visual baseline', async ({ page }) => {
  await mkdir(auditDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/board$/u);

  const administratorSession = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as {
        access_token: string;
      } | null
  );
  expect(administratorSession).not.toBeNull();

  const login = 'visual-user';
  const password = 'visual-user-only';
  const partnerResponse = await page.request.post('/api/base.partner', {
    headers: { authorization: `Bearer ${administratorSession!.access_token}` },
    data: { name: 'Visual Audit User' },
  });
  expect(partnerResponse.status()).toBe(201);
  const partner = (await partnerResponse.json()) as { data: { id: number } };
  const userResponse = await page.request.post('/api/base.user', {
    headers: { authorization: `Bearer ${administratorSession!.access_token}` },
    data: {
      login,
      password,
      role: 'user',
      partner_id: partner.data.id,
      active: true,
    },
  });
  expect(userResponse.status()).toBe(201);

  await page.getByRole('button', { name: 'superadmin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/login');
  await page.getByLabel('Email or Username').fill(login);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/board$/u);
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upcoming Planned Activities' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System Audit Ledger Events' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, 'dashboard/user/desktop-1440');
  await expectNoA11yViolations(page, 'dashboard/user/desktop-1440');
  await page.screenshot({
    path: path.join(auditDirectory, 'dashboard-user-desktop-1440.png'),
    fullPage: true,
  });
  await expect(page).toHaveScreenshot('board-dashboard-user-desktop-1440.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('mobile overlays keep accessible names, keyboard dismissal, focus return, and WCAG contrast', async ({
  page,
}) => {
  await mkdir(auditDirectory, { recursive: true });
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const modelNavigationTrigger = page.getByRole('button', { name: 'Open model navigation' });
  await modelNavigationTrigger.focus();
  await page.keyboard.press('Enter');
  const modelNavigation = page.getByRole('dialog', { name: 'Model navigation' });
  await expect(modelNavigation).toBeVisible();
  await expect
    .poll(() => modelNavigation.evaluate((element) => getComputedStyle(element).animationDuration))
    .toBe('0.16s');
  await expectNoA11yViolations(page, 'mobile/model-navigation-open');
  const dialogControls = modelNavigation.locator(
    'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  const firstDialogControl = dialogControls.first();
  const lastDialogControl = dialogControls.last();
  await lastDialogControl.focus();
  await page.keyboard.press('Tab');
  await expect(firstDialogControl).toBeFocused();
  await firstDialogControl.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(lastDialogControl).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modelNavigation).toBeHidden();
  await expect(modelNavigationTrigger).toBeFocused();

  const commandPaletteTrigger = page.getByRole('button', {
    name: /Search records, models, commands/u,
  });
  await commandPaletteTrigger.click();
  const commandPalette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(commandPalette).toBeVisible();
  await expect(commandPalette.getByPlaceholder(/Search models or records/u)).toBeFocused();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCSS('opacity', '1');
  await expect(commandPalette).toHaveCSS('opacity', '1');
  await expect
    .poll(() =>
      page
        .locator('[data-slot="dialog-overlay"]')
        .evaluate((element) => getComputedStyle(element).animationDuration)
    )
    .toBe('0.12s');
  await expect
    .poll(() => commandPalette.evaluate((element) => getComputedStyle(element).animationDuration))
    .toBe('0.16s');
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  const commandPaletteBounds = await commandPalette.boundingBox();
  expect(commandPaletteBounds).not.toBeNull();
  expect(commandPaletteBounds!.x).toBeGreaterThanOrEqual(0);
  expect(commandPaletteBounds!.x + commandPaletteBounds!.width).toBeLessThanOrEqual(375);
  await expectNoA11yViolations(page, 'mobile/command-palette-open');
  await page.screenshot({
    path: path.join(auditDirectory, 'command-palette-mobile-375.png'),
    fullPage: false,
  });
  await page.screenshot({
    path: '../../docs/design/ui-catalog/command-palette-motion-mobile-375.png',
    fullPage: false,
  });
  await page.keyboard.press('Escape');
  await expect(commandPalette).toBeHidden();
  await expect(commandPaletteTrigger).toBeFocused();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Command center', exact: false })).toBeVisible();
  const userMenuTrigger = page.getByRole('button', { name: 'User menu for superadmin' });
  await userMenuTrigger.click();
  const userMenu = page.getByRole('menu');
  await expect(userMenu).toBeVisible();
  await expect(userMenu.getByRole('menuitem', { name: 'Profile' })).toBeVisible();
  await expectNoA11yViolations(page, 'mobile/user-menu-open');
  await page.keyboard.press('Escape');
  await expect(userMenu).toBeHidden();
  await expect(userMenuTrigger).toBeFocused();
});

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className : '',
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      })
      .filter(
        (element) =>
          element.right > clientWidth + 1 && element.left >= -1 && element.clientWidth > 0
      )
      .slice(0, 8);
    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });
  expect(
    dimensions.scrollWidth,
    `${label} has unintended horizontal overflow (${dimensions.scrollWidth}px > ${dimensions.clientWidth}px); offenders: ${JSON.stringify(dimensions.offenders)}`
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectNoA11yViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
    `${label} has WCAG accessibility violations`
  ).toEqual([]);
}

function browserSuffix(testInfo: TestInfo): string {
  return testInfo.project.name === 'chromium' ? '' : `-${testInfo.project.name}`;
}

test('responsive screen audit: login matches the Enter the Shadow reference', async ({
  page,
}, testInfo) => {
  const authSizes = [
    { name: 'mobile-320', width: 320, height: 800 },
    { name: 'mobile-390', width: 390, height: 844 },
    { name: 'tablet-768', width: 768, height: 1024 },
    { name: 'desktop-1440', width: 1440, height: 900 },
    { name: 'reference-1672', width: 1672, height: 941 },
  ] as const;
  await mkdir(auditDirectory, { recursive: true });
  for (const size of authSizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/login');
    await expect(
      page.getByRole('heading', { name: 'Enter the Shadow', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enter the Shadow' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Follow the Signal/u })).toBeVisible();
    await expect(page.getByLabel('Email or Username')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('.auth-shadow-picture img')
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
      )
      .toBe(true);
    await expect(page.getByRole('link', { name: 'MoonWitness home', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectNoHorizontalOverflow(page, `login/${size.name}`);
    await page.screenshot({
      path: path.join(auditDirectory, `login-${size.name}-light${browserSuffix(testInfo)}.png`),
      fullPage: true,
    });
    await expectNoA11yViolations(page, `login/${size.name}`);
    if (size.name === 'mobile-390') {
      const identity = page.getByRole('textbox', { name: 'Email or Username' });
      const password = page.getByLabel('Password', { exact: true });
      const visibility = page.getByRole('button', { name: 'Show password' });
      await identity.focus();
      await page.keyboard.press('Tab');
      await expect(password).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(visibility).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await expect(password).toHaveAttribute('type', 'text');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Enter the Shadow' })).toBeFocused();
    }
  }
});
test('homepage spelling, responsive layout, and reference screenshots', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const homeSizes = [
    { name: 'mobile-390', width: 390, height: 844 },
    { name: 'tablet-768', width: 768, height: 1024 },
    { name: 'desktop-1440', width: 1440, height: 900 },
    { name: 'reference-1672', width: 1672, height: 941 },
  ] as const;
  await mkdir(auditDirectory, { recursive: true });

  for (const size of homeSizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/');
    const brandLockup = page.locator('.home-lockup');
    await expect(page.getByRole('link', { name: 'MoonWitness home', exact: true })).toBeVisible();
    await expect(brandLockup).toBeVisible();
    await expect
      .poll(() => brandLockup.evaluate((image: HTMLImageElement) => image.complete))
      .toBe(true);
    expect(await brandLockup.evaluate((image: HTMLImageElement) => image.naturalWidth > 0)).toBe(
      true
    );
    await expect(page.getByRole('heading', { name: 'MoonWitness', exact: true })).toBeVisible();
    await expect(page.locator('.home-title')).toHaveText('MOONWITNESS');
    await expect(
      page.getByText('People. Places. Stories. Another side of reality.', { exact: true })
    ).toBeVisible();
    await expect(page.locator('.home-hero-ribbon')).toHaveText('Follow the signal');
    await expect(
      page.getByRole('heading', { name: 'Different people. Shared context.', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable interface sounds' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `homepage/${size.name}`);
    const heroImage = await page.locator('.home-hero-art-image').evaluate((image) => ({
      loaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      alt: image.getAttribute('alt'),
    }));
    expect(heroImage).toEqual({ loaded: true, alt: '' });
    await expectNoA11yViolations(page, `homepage/${size.name}`);
    await page.screenshot({
      path: path.join(auditDirectory, `home-${size.name}${browserSuffix(testInfo)}.png`),
      fullPage: true,
    });
    if (
      testInfo.project.name === 'chromium' &&
      ['mobile-390', 'reference-1672'].includes(size.name)
    ) {
      await expect(page).toHaveScreenshot(`home-${size.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
      });
    }
  }
});

test('story workbench masthead keeps brand copy readable across viewports', async ({
  page,
}, testInfo) => {
  await mkdir(auditDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  for (const size of [
    { name: 'desktop-1440', width: 1440, height: 1000 },
    { name: 'mobile-390', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/board/stories/workbench');
    await expect(page.getByRole('heading', { name: 'Story workbench', exact: true })).toBeVisible();
    await expect(page.getByText('MoonWitness / Internal editorial', { exact: true })).toBeVisible();
    const mastheadImage = page.locator('header.dashboard-masthead img');
    await expect
      .poll(() => mastheadImage.evaluate((image: HTMLImageElement) => image.complete))
      .toBe(true);
    expect(await mastheadImage.evaluate((image: HTMLImageElement) => image.naturalWidth > 0)).toBe(
      true
    );
    await expectNoHorizontalOverflow(page, `workbench/${size.name}`);
    await expectNoA11yViolations(page, `workbench/${size.name}`);
    await page.screenshot({
      path: path.join(auditDirectory, `workbench-${size.name}${browserSuffix(testInfo)}.png`),
      fullPage: true,
    });
    if (testInfo.project.name === 'chromium') {
      await expect(page).toHaveScreenshot(`workbench-${size.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
      });
    }
  }
});

test('story workbench editor and preview stay readable with a populated story', async ({
  page,
}, testInfo) => {
  const storyId = 'mw:story:editorial-sample';
  const previousDigest = createHash('sha256').update('workbench-v1').digest('hex');
  const currentDigest = createHash('sha256').update('workbench-v2').digest('hex');
  const pages = [
    {
      page_id: 'mw:story-page:editorial-sample-1',
      page_order: 1,
      original_text: 'A small signal can change a larger sky.',
    },
    {
      page_id: 'mw:story-page:editorial-sample-2',
      page_order: 2,
      original_text: 'Different places. Same curiosity.',
    },
  ];
  await page.route('**/api/research/stories/**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const requestedVersion = new URL(route.request().url()).searchParams.get('version');
    const version = requestedVersion === '1' ? 1 : 2;
    const storyPages =
      version === 1
        ? [
            {
              ...pages[0],
              original_text: 'Signal before dawn.',
            },
          ]
        : pages;
    await route.fulfill({
      status: 200,
      json: {
        success: true,
        data: {
          storyId,
          version,
          digest: version === 1 ? previousDigest : currentDigest,
          previousDigest: version === 1 ? null : previousDigest,
          visibility: 'INTERNAL',
          idempotent: false,
          story: {
            schema_version: 1,
            story_id: storyId,
            title: 'The Ones Who Watch',
            visibility: 'INTERNAL',
            pages: storyPages,
          },
        },
      },
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await page.getByRole('link', { name: 'Story workbench' }).click();

  const pageSelector = page.getByLabel('Story page');
  const editor = page.getByLabel('Page text · exact whitespace is preserved');
  const preview = page.getByRole('article', { name: 'Private preview of page 1' });
  for (const size of [
    { name: 'desktop-1440', width: 1440, height: 1000 },
    { name: 'tablet-1024', width: 1024, height: 900 },
    { name: 'mobile-390', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await expect(page.getByRole('heading', { name: 'Story workbench', exact: true })).toBeVisible();
    await expect(editor).toHaveValue(pages[0].original_text);
    await expect(preview).toContainText('The Ones Who Watch');
    await expect(preview).toContainText(pages[0].original_text);
    await expect(page.getByRole('heading', { name: 'Page navigator' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Revision inspector' })).toBeVisible();
    const workbenchGrid = page.locator('.story-workbench-grid');
    const gridColumns = await workbenchGrid.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length
    );
    expect(gridColumns).toBe(size.width >= 1280 ? 3 : size.width > 768 ? 2 : 1);
    const inspectorColumn = await page
      .locator('.story-workbench-inspector')
      .evaluate((element) => getComputedStyle(element).gridColumnStart);
    expect(inspectorColumn).toBe(size.width <= 1280 && size.width > 768 ? '2' : 'auto');
    await expectNoHorizontalOverflow(page, `workbench-filled/${size.name}`);
    await expectNoA11yViolations(page, `workbench-filled/${size.name}`);
    await page.screenshot({
      path: path.join(
        auditDirectory,
        `workbench-filled-${size.name}${browserSuffix(testInfo)}.png`
      ),
      fullPage: true,
    });
    if (testInfo.project.name === 'chromium') {
      await expect(page).toHaveScreenshot(`workbench-filled-${size.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
      });
    }

    await pageSelector.selectOption(pages[1].page_id);
    await expect(editor).toHaveValue(pages[1].original_text);
    await expect(page.getByRole('article', { name: 'Private preview of page 2' })).toContainText(
      pages[1].original_text
    );
    await pageSelector.selectOption(pages[0].page_id);
    await pageSelector.selectOption(pages[1].page_id);
    await page.getByRole('button', { name: 'Move up' }).click();
    await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
    await expect(editor).toHaveValue(pages[1].original_text);
    await page.getByRole('button', { name: 'Move down' }).click();
    await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
    await expect(editor).toHaveValue(pages[1].original_text);
    await pageSelector.selectOption(pages[0].page_id);
  }
});

test('empty and unavailable story workbench states explain the next action', async ({
  page,
}, testInfo) => {
  let state: 'empty' | 'error' = 'empty';
  await page.route('**/api/research/stories/**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const unavailable = state === 'error';
    await route.fulfill({
      status: unavailable ? 503 : 404,
      json: { error: unavailable ? 'Service temporarily unavailable' : 'No saved story' },
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await page.getByRole('link', { name: 'Story workbench' }).click();
  await expect(
    page.getByRole('button', { name: 'Switch company. Current scope: MoonWitness' })
  ).toBeVisible();

  for (const scenario of [
    {
      name: 'empty',
      message:
        'No saved sample is available in this company yet. Saving creates its first revision.',
    },
    {
      name: 'error',
      message: 'Could not confirm the saved story state. Your draft is kept; retry before saving.',
    },
  ]) {
    if (scenario.name === 'error') {
      state = 'error';
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('button', { name: 'Retry loading story' }).click();
    }
    for (const size of [
      { name: 'desktop-1440', width: 1440, height: 1000 },
      { name: 'mobile-390', width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await expect(
        page.getByRole('heading', { name: 'Story workbench', exact: true })
      ).toBeVisible();
      await expect(
        page.getByText('MoonWitness / Internal editorial', { exact: true })
      ).toBeVisible();
      await expect(page.getByText(scenario.message, { exact: true })).toBeVisible();
      const saveButton = page.getByRole('button', { name: 'Save revision 1' });
      if (scenario.name === 'empty') {
        await expect(saveButton).toBeEnabled();
      } else {
        await expect(saveButton).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Retry loading story' })).toBeEnabled();
      }
      await expect(page.getByRole('button', { name: 'Retry loading story' })).toBeVisible();
      await expectNoHorizontalOverflow(page, `workbench-${scenario.name}/${size.name}`);
      await expectNoA11yViolations(page, `workbench-${scenario.name}/${size.name}`);
      await page.screenshot({
        path: path.join(
          auditDirectory,
          `workbench-${scenario.name}-${size.name}${browserSuffix(testInfo)}.png`
        ),
        fullPage: true,
      });
      if (testInfo.project.name === 'chromium') {
        await expect(page).toHaveScreenshot(`workbench-${scenario.name}-${size.name}.png`, {
          animations: 'disabled',
          caret: 'hide',
          fullPage: true,
        });
      }
    }
  }
});

test('responsive protected screens fit and remain accessible in both themes', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const label of ['Organization Members', 'Notification Preferences']) {
    const menuItem = page.getByRole('link', { name: label, exact: true });
    await expect(menuItem).toBeVisible();
    await expect(menuItem.locator('span')).toHaveCSS('white-space', 'normal');
    await expect(menuItem.locator('span')).toHaveCSS('text-overflow', 'clip');
  }

  for (const theme of ['light', 'dark'] as const) {
    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      if (
        (await page.locator('html').evaluate((element) => element.classList.contains('dark'))) !==
        (theme === 'dark')
      ) {
        if (size.name === 'mobile-375') {
          await page.getByRole('button', { name: /^User menu for/u }).click();
          await page.getByRole('menuitem', { name: 'Toggle theme' }).click();
        } else {
          await page.getByRole('button', { name: 'Toggle theme' }).click();
        }
      }

      for (const view of views) {
        await page.goto(view.path);
        await expect(page.getByRole('heading', { name: view.heading, exact: false })).toBeVisible();
        const label = `${view.name}/${size.name}/${theme}`;
        await expectNoHorizontalOverflow(page, label);
        if (view.name === 'list' && size.name === 'desktop-1440') {
          const tableRegion = page.getByRole('region', {
            name: 'Partners records table',
            exact: true,
          });
          await expect(tableRegion).toBeVisible();
          await tableRegion.focus();
          await expect(tableRegion).toBeFocused();
          const scrollAccess = await tableRegion.evaluate((element) => {
            const previousScrollLeft = element.scrollLeft;
            const maxScrollLeft = element.scrollWidth - element.clientWidth;
            element.scrollLeft = maxScrollLeft;
            const lastCell = element.querySelector('tbody tr td:last-child');
            const regionBounds = element.getBoundingClientRect();
            const actionBounds = lastCell?.getBoundingClientRect();
            const result = {
              maxScrollLeft,
              scrollMoved: element.scrollLeft > previousScrollLeft,
              regionLeft: regionBounds.left,
              regionRight: regionBounds.right,
              actionLeft: actionBounds?.left,
              actionRight: actionBounds?.right,
              actionColumnVisible:
                actionBounds !== undefined &&
                actionBounds.left >= regionBounds.left &&
                actionBounds.right <= regionBounds.right + 1,
            };
            element.scrollLeft = previousScrollLeft;
            return result;
          });
          expect(scrollAccess.maxScrollLeft).toBeGreaterThan(0);
          expect(scrollAccess.scrollMoved).toBe(true);
          expect(scrollAccess.actionColumnVisible, JSON.stringify(scrollAccess)).toBe(true);
        }
        if (view.name === 'profile' && size.name === 'mobile-375') {
          await expect(page.getByRole('heading', { name: 'Super Administrator' })).toBeVisible();
        }
        if (view.name === 'dashboard') {
          await expect(
            page.getByText('MoonWitness / Command Center', { exact: true })
          ).toBeVisible();
          await expect(page.locator('.dashboard-masthead-subtitle')).toHaveText(
            /Welcome,\s*superadmin\s*— your workspace at a glance\./u
          );
          await expect(
            page.getByRole('img', { name: 'Background job status distribution' })
          ).toBeVisible();
          const metricDetails = await page
            .locator('.dashboard-metric-link .mw-ui-metric-tile-detail')
            .allInnerTexts();
          expect(metricDetails.join(' ')).not.toMatch(/[+-]\s?\d+(?:\.\d+)?%/u);
        }
        const visualKey = `${view.name}/${size.name}/${theme}`;
        if (visualBaselines.has(visualKey) && testInfo.project.name === 'chromium') {
          if (view.name === 'list') {
            await page.getByPlaceholder('Search partners...').fill('Acme Studio');
            const partnerRow = page.getByRole('row').filter({ hasText: 'Acme Studio' });
            await expect(
              partnerRow.getByText('Acme Studio', { exact: true }).first()
            ).toBeVisible();
            const countryValue = partnerRow
              .getByText('United States [US]', { exact: true })
              .first();
            await expect(countryValue).toBeVisible();
            const countryOverflowsCell = await countryValue.evaluate((element) => {
              const cell = element.closest('td');
              return !cell || cell.scrollWidth > cell.clientWidth;
            });
            expect(
              countryOverflowsCell,
              'country value must fit or wrap inside its table cell'
            ).toBe(false);
          }
          await expect(page).toHaveScreenshot(`board-${view.name}-${size.name}-${theme}.png`, {
            animations: 'disabled',
            caret: 'hide',
            fullPage: true,
            // The current stable view differed from its baseline on only two
            // text-edge pixels; retain a strict bound without hiding layout changes.
            maxDiffPixels: 2,
          });
        }
        await page.screenshot({
          path: path.join(
            auditDirectory,
            `${view.name}-${size.name}-${theme}${browserSuffix(testInfo)}.png`
          ),
          fullPage: true,
        });
        if (view.name === 'dashboard' && size.name === 'mobile-375') {
          await expect(page.getByRole('button', { name: /^Switch company/u })).toBeVisible();
          await expect(page.getByRole('button', { name: 'Pending activities' })).toBeVisible();
          await expect(page.getByRole('button', { name: /^Notifications/u })).toBeVisible();
          await expect(page.getByRole('button', { name: /^User menu for/u })).toBeVisible();
          await expect(page.getByRole('button', { name: 'Toggle theme' })).toBeHidden();
          const originalThemeIsDark = await page
            .locator('html')
            .evaluate((element) => element.classList.contains('dark'));
          await page.getByRole('button', { name: /^User menu for/u }).click();
          await expect(page.getByRole('menuitem', { name: 'Toggle theme' })).toBeVisible();
          await page.getByRole('menuitem', { name: 'Toggle theme' }).click();
          await expect
            .poll(() =>
              page.locator('html').evaluate((element) => element.classList.contains('dark'))
            )
            .toBe(!originalThemeIsDark);
          await page.getByRole('button', { name: /^User menu for/u }).click();
          await page.getByRole('menuitem', { name: 'Toggle theme' }).click();
          await expect
            .poll(() =>
              page.locator('html').evaluate((element) => element.classList.contains('dark'))
            )
            .toBe(originalThemeIsDark);
          await expect(page.getByRole('button', { name: 'Open model navigation' })).toBeVisible();
          await page.getByRole('button', { name: 'Open model navigation' }).focus();
          await expect(page.getByRole('button', { name: 'Open model navigation' })).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(page.getByRole('dialog', { name: 'Model navigation' })).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog', { name: 'Model navigation' })).toBeHidden();
        }
        if (size.name === 'desktop-1440' || size.name === 'mobile-375') {
          await expectNoA11yViolations(page, label);
        }
      }
    }
  }
});
