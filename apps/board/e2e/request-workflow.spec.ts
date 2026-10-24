import { expect, test } from '@playwright/test';
import { createE2eSuffix, E2E_SUPERADMIN_PASSWORD, loginPageUrl } from './constants.js';

interface BoardSession {
  access_token: string;
}

interface AuthProfile {
  data: { id: number; company_id: number };
}

interface CreatedRecord {
  id: number;
  create_uid: number;
}

interface ApiRecord<T> {
  data: T;
}

test('requester submits a request that superadmin approves or rejects in Board', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const suffix = createE2eSuffix();
  const requesterLogin = `request-e2e-${suffix}`;
  const requesterPassword = `request-e2e-password-${suffix}`;

  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const adminSession = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as BoardSession | null
  );
  expect(adminSession).not.toBeNull();
  const adminHeaders = { authorization: `Bearer ${adminSession!.access_token}` };
  const adminProfileResponse = await page.request.get('/auth/me', { headers: adminHeaders });
  expect(adminProfileResponse.status()).toBe(200);
  const adminProfile = (await adminProfileResponse.json()) as AuthProfile;

  const partnerResponse = await page.request.post('/api/base.partner', {
    headers: adminHeaders,
    data: {
      name: `Request E2E ${suffix}`,
      email: `request-${suffix}@example.test`,
      company_id: adminProfile.data.company_id,
    },
  });
  expect(partnerResponse.status()).toBe(201);
  const partner = (await partnerResponse.json()) as ApiRecord<{ id: number }>;
  const requesterResponse = await page.request.post('/api/base.user', {
    headers: adminHeaders,
    data: {
      login: requesterLogin,
      password: requesterPassword,
      role: 'user',
      partner_id: partner.data.id,
      active: true,
    },
  });
  expect(requesterResponse.status()).toBe(201);

  await page.getByRole('button', { name: 'superadmin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(loginPageUrl);
  await page.getByLabel('Email or Username').fill(requesterLogin);
  await page.getByLabel('Password', { exact: true }).fill(requesterPassword);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page.getByRole('button', { name: requesterLogin })).toBeVisible();

  const requesterSession = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as BoardSession | null
  );
  expect(requesterSession).not.toBeNull();
  const requesterHeaders = { authorization: `Bearer ${requesterSession!.access_token}` };
  const requesterProfileResponse = await page.request.get('/auth/me', {
    headers: requesterHeaders,
  });
  expect(requesterProfileResponse.status()).toBe(200);
  const requesterProfile = (await requesterProfileResponse.json()) as AuthProfile;
  expect(requesterProfile.data.company_id).toBe(adminProfile.data.company_id);

  const currencyResponse = await page.request.get('/api/base.currency', {
    headers: requesterHeaders,
    params: { domain: JSON.stringify([['code', '=', 'USD']]) },
  });
  expect(currencyResponse.status()).toBe(200);
  const currencies = (await currencyResponse.json()) as ApiRecord<Array<{ id: number }>>;
  expect(currencies.data).toHaveLength(1);
  const requestTitle = `Workflow Board E2E ${suffix}`;
  const requestResponse = await page.request.post('/api/request.purchase', {
    headers: requesterHeaders,
    data: {
      title: requestTitle,
      description: 'Verify the request approval journey through the Board UI.',
      amount_minor: 87500,
      currency_id: currencies.data[0]!.id,
      company_id: requesterProfile.data.company_id,
    },
  });
  expect(requestResponse.status()).toBe(201);
  const createdRequest = (await requestResponse.json()) as ApiRecord<CreatedRecord>;
  expect(createdRequest.data.create_uid).toBe(requesterProfile.data.id);

  const rejectionRequestTitle = `Workflow Board rejection E2E ${suffix}`;
  const rejectionRequestResponse = await page.request.post('/api/request.purchase', {
    headers: requesterHeaders,
    data: {
      title: rejectionRequestTitle,
      description: 'Verify the request rejection journey through the Board UI.',
      amount_minor: 42000,
      currency_id: currencies.data[0]!.id,
      company_id: requesterProfile.data.company_id,
    },
  });
  expect(rejectionRequestResponse.status()).toBe(201);
  const rejectionRequest = (await rejectionRequestResponse.json()) as ApiRecord<CreatedRecord>;
  expect(rejectionRequest.data.create_uid).toBe(requesterProfile.data.id);

  await page.goto(`/board/m/request.purchase/${createdRequest.data.id}`);
  const workflow = page.getByRole('region', { name: 'Approval workflow' });
  await expect(workflow).toBeVisible();
  await expect(
    workflow.getByRole('button', { name: 'Start Purchase request approval' })
  ).toBeVisible();
  await workflow.getByRole('button', { name: 'Start Purchase request approval' }).click();
  await expect(workflow.getByText(/Current state: draft · Revision 0/u)).toBeVisible();
  await workflow.getByLabel('Review comment').fill('Please review this purchase request.');
  await workflow.getByRole('button', { name: 'submit', exact: true }).click();
  await expect(workflow.getByText(/Current state: submitted · Revision 1/u)).toBeVisible();
  await expect(workflow.getByRole('list', { name: 'Approval history' })).toContainText(
    'Please review this purchase request.'
  );

  await page.goto(`/board/m/request.purchase/${rejectionRequest.data.id}`);
  const rejectionWorkflow = page.getByRole('region', { name: 'Approval workflow' });
  await rejectionWorkflow.getByRole('button', { name: 'Start Purchase request approval' }).click();
  await rejectionWorkflow.getByLabel('Review comment').fill('Please review this rejection case.');
  await rejectionWorkflow.getByRole('button', { name: 'submit', exact: true }).click();
  await expect(rejectionWorkflow.getByText(/Current state: submitted · Revision 1/u)).toBeVisible();

  await page.getByRole('button', { name: requesterLogin }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(loginPageUrl);
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).not.toHaveURL(loginPageUrl);
  const purchaseRequests = page
    .getByRole('navigation', { name: 'Models' })
    .getByRole('link', { name: 'Purchase Requests' });
  await purchaseRequests.click();
  await page.getByRole('row').filter({ hasText: requestTitle }).click();
  const reviewerSession = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as BoardSession | null
  );
  expect(reviewerSession).not.toBeNull();
  const reviewerHeaders = { authorization: `Bearer ${reviewerSession!.access_token}` };

  const reviewerWorkflow = page.getByRole('region', { name: 'Approval workflow' });
  await expect(reviewerWorkflow.getByText(/Current state: submitted · Revision 1/u)).toBeVisible();
  await reviewerWorkflow.getByLabel('Review comment').fill('Approved in the Board E2E review.');
  await reviewerWorkflow.getByRole('button', { name: 'approve', exact: true }).click();
  await expect(reviewerWorkflow.getByText('completed', { exact: true })).toBeVisible();
  await expect(reviewerWorkflow.getByText(/Current state: approved · Revision 2/u)).toBeVisible();
  await expect(reviewerWorkflow.getByRole('list', { name: 'Approval history' })).toContainText(
    'Approved in the Board E2E review.'
  );

  const instancesResponse = await page.request.get('/workflows/instances', {
    headers: reviewerHeaders,
    params: {
      limit: '10',
      resource_model: 'request.purchase',
      resource_id: String(createdRequest.data.id),
    },
  });
  expect(instancesResponse.status()).toBe(200);
  const instances = (await instancesResponse.json()) as ApiRecord<
    Array<{ id: number; current_state: string; status: string; revision: number }>
  >;
  expect(instances.data).toContainEqual(
    expect.objectContaining({ current_state: 'approved', status: 'completed', revision: 2 })
  );
  const instance = instances.data.find(({ current_state }) => current_state === 'approved');
  expect(instance).toBeDefined();
  const historyResponse = await page.request.get(`/workflows/instances/${instance!.id}`, {
    headers: reviewerHeaders,
  });
  expect(historyResponse.status()).toBe(200);
  const history = (await historyResponse.json()) as ApiRecord<{
    events: Array<{ action: string; from_state: string; to_state: string; comment: string | null }>;
  }>;
  expect(history.data.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'submit', from_state: 'draft', to_state: 'submitted' }),
      expect.objectContaining({ action: 'approve', from_state: 'submitted', to_state: 'approved' }),
    ])
  );

  await page
    .getByRole('navigation', { name: 'Models' })
    .getByRole('link', { name: 'Purchase Requests' })
    .click();
  await page.getByRole('row').filter({ hasText: rejectionRequestTitle }).click();
  const reviewRejectionWorkflow = page.getByRole('region', { name: 'Approval workflow' });
  await expect(
    reviewRejectionWorkflow.getByText(/Current state: submitted · Revision 1/u)
  ).toBeVisible();
  await reviewRejectionWorkflow
    .getByLabel('Review comment')
    .fill('Rejected in the Board E2E review.');
  await reviewRejectionWorkflow.getByRole('button', { name: 'reject', exact: true }).click();
  await expect(
    reviewRejectionWorkflow.getByText('rejected', { exact: true }).first()
  ).toBeVisible();
  await expect(
    reviewRejectionWorkflow.getByText(/Current state: rejected · Revision 2/u)
  ).toBeVisible();
  await expect(
    reviewRejectionWorkflow.getByRole('list', { name: 'Approval history' })
  ).toContainText('Rejected in the Board E2E review.');

  const rejectionInstancesResponse = await page.request.get('/workflows/instances', {
    headers: reviewerHeaders,
    params: {
      limit: '10',
      resource_model: 'request.purchase',
      resource_id: String(rejectionRequest.data.id),
    },
  });
  expect(rejectionInstancesResponse.status()).toBe(200);
  const rejectionInstances = (await rejectionInstancesResponse.json()) as ApiRecord<
    Array<{ id: number; current_state: string; status: string; revision: number }>
  >;
  expect(rejectionInstances.data).toContainEqual(
    expect.objectContaining({ current_state: 'rejected', status: 'rejected', revision: 2 })
  );
  const rejectionInstance = rejectionInstances.data.find(
    ({ current_state }) => current_state === 'rejected'
  );
  expect(rejectionInstance).toBeDefined();
  const rejectionHistoryResponse = await page.request.get(
    `/workflows/instances/${rejectionInstance!.id}`,
    { headers: reviewerHeaders }
  );
  expect(rejectionHistoryResponse.status()).toBe(200);
  const rejectionHistory = (await rejectionHistoryResponse.json()) as ApiRecord<{
    events: Array<{ action: string; from_state: string; to_state: string; comment: string | null }>;
  }>;
  expect(rejectionHistory.data.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'submit', from_state: 'draft', to_state: 'submitted' }),
      expect.objectContaining({
        action: 'reject',
        from_state: 'submitted',
        to_state: 'rejected',
        comment: 'Rejected in the Board E2E review.',
      }),
    ])
  );

  await page.getByRole('button', { name: 'superadmin' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(loginPageUrl);
  await page.getByLabel('Email or Username').fill(requesterLogin);
  await page.getByLabel('Password', { exact: true }).fill(requesterPassword);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page.getByRole('button', { name: requesterLogin })).toBeVisible();

  const finalRequesterSession = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as BoardSession | null
  );
  expect(finalRequesterSession).not.toBeNull();
  const finalRequesterHeaders = {
    authorization: `Bearer ${finalRequesterSession!.access_token}`,
  };
  let approvedNotificationId: number | undefined;
  await expect
    .poll(
      async () => {
        const inboxResponse = await page.request.get('/notifications/inbox', {
          headers: finalRequesterHeaders,
          params: { limit: '50' },
        });
        if (inboxResponse.status() !== 200) return false;
        const inbox = (await inboxResponse.json()) as ApiRecord<{
          notifications: Array<{
            id: number;
            title: string;
            state: string;
            resource_model?: string;
            resource_id?: number;
          }>;
        }>;
        const approvedNotification = inbox.data.notifications.find(
          (notification) =>
            notification.title === 'Request approved' &&
            notification.resource_model === 'request.purchase' &&
            notification.resource_id === createdRequest.data.id
        );
        approvedNotificationId = approvedNotification?.id;
        return approvedNotification !== undefined;
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  expect(approvedNotificationId).toBeDefined();

  await page.reload();
  const notificationBell = page.getByRole('button', { name: /Notifications, \d+ unread/u });
  await expect(notificationBell).toBeVisible();
  await notificationBell.click();
  const approvedNotification = page
    .getByRole('list')
    .locator('li')
    .filter({ has: page.getByText('Request approved', { exact: true }) });
  await expect(approvedNotification).toBeVisible();
  await approvedNotification.getByRole('button', { name: /Mark read/u }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/notification.notification/${approvedNotificationId}`,
        { headers: finalRequesterHeaders }
      );
      if (response.status() !== 200) return null;
      return ((await response.json()) as ApiRecord<{ state: string }>).data.state;
    })
    .toBe('read');
});
