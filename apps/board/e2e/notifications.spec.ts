import { expect, test } from '@playwright/test';
import { createE2eSuffix, E2E_SUPERADMIN_PASSWORD } from './constants.js';

test('notification inbox displays a delivered message, marks it read, and exposes channel preferences', async ({
  page,
}) => {
  const suffix = createE2eSuffix();
  const title = `Board notification ${suffix}`;

  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const session = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as {
        access_token: string;
      } | null
  );
  expect(session).not.toBeNull();
  const headers = { authorization: `Bearer ${session!.access_token}` };
  const profileResponse = await page.request.get('/auth/me', { headers });
  expect(profileResponse.status()).toBe(200);
  const profile = (await profileResponse.json()) as {
    data: { id: number; company_id: number };
  };
  expect(Number.isSafeInteger(profile.data.id)).toBe(true);
  expect(Number.isSafeInteger(profile.data.company_id)).toBe(true);
  const templatesResponse = await page.request.get('/api/notification.template', {
    headers,
    params: { domain: JSON.stringify([['code', '=', 'example.in_app']]) },
  });
  expect(templatesResponse.status()).toBe(200);
  const templates = (await templatesResponse.json()) as { data: Array<{ id: number }> };
  expect(templates.data).toHaveLength(1);
  const deliveredAt = new Date().toISOString();
  const created = await page.request.post('/api/notification.notification', {
    headers,
    data: {
      recipient_id: profile.data.id,
      company_id: profile.data.company_id,
      template_id: templates.data[0]!.id,
      channel: 'in_app',
      title,
      body: 'A browser test notification. No external message is sent.',
      delivery_status: 'delivered',
      state: 'unread',
      idempotency_key: `e2e:${suffix}`,
      delivered_at: deliveredAt,
    },
  });
  expect(created.status()).toBe(201);
  const createdRecord = (await created.json()) as { data: { id: number } };
  const apiInbox = await page.request.get('/notifications/inbox', { headers });
  expect(apiInbox.status()).toBe(200);
  const inboxPayload = (await apiInbox.json()) as {
    data: { notifications: Array<{ id: number; title: string }>; unreadCount: number };
  };
  expect(inboxPayload.data.unreadCount).toBeGreaterThan(0);
  expect(inboxPayload.data.notifications).toContainEqual(
    expect.objectContaining({ id: createdRecord.data.id, title })
  );

  await page.reload();
  const inboxButton = page.getByRole('button', { name: /Notifications, \d+ unread/u });
  await expect(inboxButton).toBeVisible();
  await inboxButton.click();
  await expect(page.getByRole('heading', { name: 'Notifications' }).last()).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Mark read' }).click();
  await expect(page.locator('#notification-inbox-btn')).toHaveAttribute(
    'aria-label',
    'Notifications'
  );

  const read = await page.request.get(`/api/notification.notification/${createdRecord.data.id}`, {
    headers,
  });
  expect(read.status()).toBe(200);
  expect((await read.json()).data).toMatchObject({ state: 'read' });

  await page.goto('/board/settings');
  await expect(page.getByRole('heading', { name: 'Notifications' }).last()).toBeVisible();
  await expect(page.getByText('In-app inbox', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Demo channel only. Delivery is suppressed; no email is sent.')
  ).toBeVisible();
});
