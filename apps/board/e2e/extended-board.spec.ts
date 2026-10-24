import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { createE2eSuffix, E2E_SUPERADMIN_PASSWORD } from './constants.js';

interface BoardSession {
  access_token: string;
}

interface CreatedRecord {
  id: number;
}

async function loginSuperadmin(page: Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
  const session = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mw-board-session') ?? 'null') as BoardSession | null
  );
  expect(session).not.toBeNull();
  return session!.access_token;
}

test('CSV import rejects invalid rows, reports partial failures, and exports only the active search scope', async ({
  page,
}) => {
  const suffix = createE2eSuffix();
  const token = await loginSuperadmin(page);
  const authorization = { authorization: `Bearer ${token}` };
  const duplicateEmail = `duplicate-${suffix}@example.test`;
  const duplicate = await page.request.post('/api/base.partner', {
    headers: authorization,
    data: { name: `Duplicate Seed ${suffix}`, email: duplicateEmail },
  });
  expect(duplicate.status()).toBe(201);
  const outsideScope = await page.request.post('/api/base.partner', {
    headers: authorization,
    data: { name: `Outside Export ${suffix}`, email: `outside-${suffix}@example.test` },
  });
  expect(outsideScope.status()).toBe(201);
  const formulaName = `=HYPERLINK("https://example.test","click-${suffix}")`;
  const formulaPartner = await page.request.post('/api/base.partner', {
    headers: authorization,
    data: { name: formulaName, email: `formula-${suffix}@example.test` },
  });
  expect(formulaPartner.status()).toBe(201);

  await page.goto('/board/m/base.partner');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const upload = page.locator('input[type="file"]');
  await upload.setInputFiles({
    name: `missing-required-${suffix}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(`Email\nmissing-name-${suffix}@example.test\n`),
  });
  await expect(page.getByText(/Missing: Name/u)).toBeVisible();
  await page.getByRole('button', { name: 'Preview Data' }).click();
  await expect(page.getByRole('button', { name: /Start Import/u })).toBeDisabled();
  const rejectedRow = await page.request.get('/api/base.partner', {
    headers: authorization,
    params: { domain: JSON.stringify([['email', '=', `missing-name-${suffix}@example.test`]]) },
  });
  expect(((await rejectedRow.json()) as { data: CreatedRecord[] }).data).toHaveLength(0);

  await page.getByRole('button', { name: 'Back to Mapping' }).click();
  await page.getByRole('button', { name: 'Re-upload' }).click();
  await upload.setInputFiles({
    name: `partners-${suffix}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `Name,Email\n"Extended, Imported ${suffix}",imported-${suffix}@example.test\nDuplicate ${suffix},${duplicateEmail}\n`
    ),
  });
  await page.getByRole('button', { name: 'Preview Data' }).click();
  await page.getByRole('button', { name: /Start Import \(2 rows\)/u }).click();
  await expect(page.getByRole('heading', { name: 'Import Finished!' })).toBeVisible();
  await expect(page.getByText('Success').locator('..')).toContainText('1');
  await expect(page.getByText('Failed').locator('..')).toContainText('1');
  await expect(page.getByText(/Row 2:/u)).toBeVisible();

  const importedPartner = await page.request.get('/api/base.partner', {
    headers: authorization,
    params: {
      domain: JSON.stringify([['email', '=', `imported-${suffix}@example.test`]]),
    },
  });
  expect(importedPartner.status()).toBe(200);
  expect(((await importedPartner.json()) as { data: CreatedRecord[] }).data).toHaveLength(1);
  const failedPartner = await page.request.get('/api/base.partner', {
    headers: authorization,
    params: { domain: JSON.stringify([['name', '=', `Duplicate ${suffix}`]]) },
  });
  expect(((await failedPartner.json()) as { data: CreatedRecord[] }).data).toHaveLength(0);

  await page.getByRole('button', { name: 'Close & View Records' }).click();
  const search = page.getByPlaceholder('Search partners...');
  await search.fill(`Extended, Imported ${suffix}`);
  const table = page.getByRole('table');
  await expect(table.getByText(`Extended, Imported ${suffix}`, { exact: true })).toBeVisible();
  const selectedRow = table
    .getByRole('row')
    .filter({ hasText: `Extended, Imported ${suffix}` })
    .getByRole('checkbox');
  await selectedRow.check();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadReady;
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  const csv = await readFile(filePath!, 'utf8');
  expect(csv).toContain(`"Extended, Imported ${suffix}"`);
  expect(csv).not.toContain(`Outside Export ${suffix}`);
  expect(csv).not.toContain(`Duplicate Seed ${suffix}`);

  await page.getByRole('button', { name: 'Clear' }).click();
  await search.fill(formulaName);
  await expect(table.getByText(formulaName, { exact: true })).toBeVisible();
  await table.getByRole('checkbox', { name: /Select record #/u }).check();
  const formulaDownloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const formulaDownload = await formulaDownloadReady;
  const formulaPath = await formulaDownload.path();
  expect(formulaPath).not.toBeNull();
  const formulaCsv = await readFile(formulaPath!, 'utf8');
  expect(formulaCsv).toContain(`'${formulaName.replace(/"/g, '""')}`);
});

test('user password write-only field is absent from list and CSV export', async ({ page }) => {
  const token = await loginSuperadmin(page);
  const response = await page.request.get('/api/base.user/views', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  const metadata = (await response.json()) as {
    fields: { name: string; writeOnly?: boolean }[];
    list: { columns: string[] };
  };
  expect(metadata.fields.find((field) => field.name === 'password')?.writeOnly).toBe(true);
  expect(metadata.list.columns).not.toContain('password');

  await page.goto('/board/m/base.user');
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Password' })).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: /Select record #/u })
    .first()
    .check();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadReady;
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  const csv = await readFile(filePath!, 'utf8');
  expect(csv).not.toContain('Password');
  expect(csv).not.toContain('scrypt$');
});

test('record chatter persists activity and attachment metadata with owner and permission boundaries', async ({
  page,
}) => {
  const suffix = createE2eSuffix();
  const token = await loginSuperadmin(page);
  const authorization = { authorization: `Bearer ${token}` };
  const partnerResponse = await page.request.post('/api/base.partner', {
    headers: authorization,
    data: { name: `Chatter E2E ${suffix}`, email: `chatter-${suffix}@example.test` },
  });
  expect(partnerResponse.status()).toBe(201);
  const partner = (await partnerResponse.json()) as { data: CreatedRecord };

  await page.goto(`/board/m/base.partner/${partner.data.id}`);
  await expect(page.getByText('Record Chatter')).toBeVisible();
  const activitySummary = `Follow up ${suffix}`;
  await page.getByRole('button', { name: 'Schedule Activity' }).click();
  await page.getByLabel(/Summary \/ Task Title/u).fill(activitySummary);
  await page.getByLabel('Optional Notes').fill('E2E activity ownership check');
  await page.getByRole('button', { name: 'Save Activity' }).click();
  await expect(page.getByText(activitySummary, { exact: true })).toBeVisible();

  const activitySearch = await page.request.get('/api/base.activity', {
    headers: authorization,
    params: {
      domain: JSON.stringify([
        ['resource_model', '=', 'base.partner'],
        ['resource_id', '=', partner.data.id],
        ['summary', '=', activitySummary],
      ]),
    },
  });
  expect(activitySearch.status()).toBe(200);
  const activityPayload = (await activitySearch.json()) as {
    data: Array<{ id: number; state: string; create_uid: number }>;
  };
  expect(activityPayload.data).toHaveLength(1);
  expect(activityPayload.data[0].state).toBe('planned');

  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/base.activity/${activityPayload.data[0].id}`, {
        headers: authorization,
      });
      return ((await response.json()) as { data: { state: string } }).data.state;
    })
    .toBe('done');

  const viewerPartnerResponse = await page.request.post('/api/base.partner', {
    headers: authorization,
    data: { name: `Chatter Viewer ${suffix}` },
  });
  expect(viewerPartnerResponse.status()).toBe(201);
  const viewerPartner = (await viewerPartnerResponse.json()) as { data: CreatedRecord };
  const viewerLogin = `chatter-viewer-${suffix}`;
  const viewerPassword = `chatter-viewer-password-${suffix}`;
  const viewer = await page.request.post('/api/base.user', {
    headers: authorization,
    data: {
      login: viewerLogin,
      password: viewerPassword,
      role: 'user',
      partner_id: viewerPartner.data.id,
    },
  });
  expect(viewer.status()).toBe(201);
  const viewerLoginResponse = await page.request.post('/auth/login', {
    data: { login: viewerLogin, password: viewerPassword },
  });
  expect(viewerLoginResponse.status()).toBe(200);
  const viewerSession = (await viewerLoginResponse.json()) as {
    data: { access_token: string };
  };
  const viewerAuthorization = {
    authorization: `Bearer ${viewerSession.data.access_token}`,
  };
  const privateActivities = await page.request.get('/api/base.activity', {
    headers: viewerAuthorization,
    params: {
      domain: JSON.stringify([
        ['resource_model', '=', 'base.partner'],
        ['resource_id', '=', partner.data.id],
        ['summary', '=', activitySummary],
      ]),
    },
  });
  expect(privateActivities.status()).toBe(200);
  expect(((await privateActivities.json()) as { data: CreatedRecord[] }).data).toHaveLength(0);

  await page.getByRole('button', { name: 'Vault' }).click();
  const attachmentName = `note-${suffix}.txt`;
  await page.locator('input[type="file"]').setInputFiles({
    name: attachmentName,
    mimeType: 'text/plain',
    buffer: Buffer.from('sample'),
  });
  await expect(page.getByText(attachmentName, { exact: true })).toBeVisible();
  const attachmentSearch = await page.request.get('/api/base.attachment', {
    headers: authorization,
    params: {
      domain: JSON.stringify([
        ['resource_model', '=', 'base.partner'],
        ['resource_id', '=', partner.data.id],
        ['name', '=', attachmentName],
      ]),
    },
  });
  expect(attachmentSearch.status()).toBe(200);
  const attachmentPayload = (await attachmentSearch.json()) as {
    data: Array<{ id: number; size_bytes: number; name: string; storage_key?: string }>;
  };
  expect(attachmentPayload.data).toHaveLength(1);
  expect(attachmentPayload.data[0].size_bytes).toBe(Buffer.byteLength('sample'));
  expect(attachmentPayload.data[0].storage_key).toBeUndefined();
  const downloadedAttachment = await page.request.get(
    `/api/base.attachment/${attachmentPayload.data[0].id}/download`,
    { headers: authorization }
  );
  expect(downloadedAttachment.status()).toBe(200);
  expect(await downloadedAttachment.body()).toEqual(Buffer.from('sample'));
  expect(downloadedAttachment.headers()['content-disposition']).toContain(attachmentName);
  const browserDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download attachment' }).click();
  expect((await browserDownloadPromise).suggestedFilename()).toBe(attachmentName);

  const privateAttachments = await page.request.get('/api/base.attachment', {
    headers: viewerAuthorization,
    params: {
      domain: JSON.stringify([
        ['resource_model', '=', 'base.partner'],
        ['resource_id', '=', partner.data.id],
        ['name', '=', attachmentName],
      ]),
    },
  });
  expect(privateAttachments.status()).toBe(200);
  expect(((await privateAttachments.json()) as { data: CreatedRecord[] }).data).toHaveLength(0);
  const deniedAttachmentDownload = await page.request.get(
    `/api/base.attachment/${attachmentPayload.data[0].id}/download`,
    { headers: viewerAuthorization }
  );
  expect(deniedAttachmentDownload.status()).toBe(404);
  const deniedAttachmentDelete = await page.request.delete(
    `/api/base.attachment/${attachmentPayload.data[0].id}`,
    { headers: viewerAuthorization }
  );
  expect(deniedAttachmentDelete.status()).toBe(403);
  await page.getByRole('button', { name: 'Delete attachment' }).click();
  await expect(page.getByText(attachmentName, { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Activities', exact: true }).click();
  await page.getByRole('button', { name: 'Delete activity' }).click();
  await expect(page.getByText(activitySummary, { exact: true })).toHaveCount(0);
});
