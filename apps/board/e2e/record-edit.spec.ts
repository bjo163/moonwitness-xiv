import { expect, test } from '@playwright/test';
import { createE2eSuffix, E2E_SUPERADMIN_PASSWORD } from './constants.js';

interface BoardSession {
  access_token: string;
}

interface CreatedRecord {
  id: number;
}

test('record forms validate, edit relations, scope state by country, archive, restore, and delete', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const suffix = createE2eSuffix();
  const partnerName = `Record E2E ${suffix}`;
  const partnerEmail = `record-${suffix}@example.test`;

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
  const addressViewsResponse = await page.request.get('/api/base.partner_address/views', {
    headers: authorization,
  });
  expect(addressViewsResponse.status()).toBe(200);
  const addressViews = (await addressViewsResponse.json()) as {
    fields: Array<{ name: string; default?: unknown }>;
  };
  expect(addressViews.fields.find((field) => field.name === 'address_type')?.default).toBe('other');

  await page.goto('/board/m/base.partner/new');
  await expect(page.getByRole('heading', { name: 'New Partner' })).toBeVisible();
  await page.getByLabel('Name').fill('Temporary value');
  await page.getByLabel('Name').clear();
  await page.getByRole('button', { name: 'Save Record' }).click();
  await expect(page.getByText("Field 'Name' is required.")).toBeVisible();
  const rejectedPartner = await page.request.get('/api/base.partner', {
    headers: authorization,
    params: { domain: JSON.stringify([['name', '=', 'Temporary value']]) },
  });
  expect(rejectedPartner.status()).toBe(200);
  expect(((await rejectedPartner.json()) as { data: CreatedRecord[] }).data).toHaveLength(0);
  await page.getByLabel('Name').fill(partnerName);
  await page.getByLabel('Email', { exact: true }).fill(partnerEmail);
  await page.getByRole('button', { name: 'Save Record' }).click();
  await expect(page).toHaveURL(/\/m\/base\.partner\/\d+$/u);

  const createdPartner = await page.request.get('/api/base.partner', {
    headers: authorization,
    params: { domain: JSON.stringify([['email', '=', partnerEmail]]) },
  });
  expect(createdPartner.status()).toBe(200);
  const partnerList = (await createdPartner.json()) as { data: CreatedRecord[] };
  expect(partnerList.data).toHaveLength(1);
  const partnerId = partnerList.data[0].id;

  const nameField = page.getByLabel('Name');
  await expect(nameField).toHaveValue(partnerName);
  await nameField.fill(`${partnerName} Updated`);
  const saveButton = page.getByRole('button', { name: 'Save Record' });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(page.getByText('Record saved successfully!')).toBeVisible();

  const duplicatePartner = await page.request.post('/api/base.partner', {
    headers: authorization,
    data: { name: `Duplicate ${suffix}`, email: partnerEmail },
  });
  expect(duplicatePartner.status()).toBe(409);

  await page.goto(`/board/m/base.partner/${partnerId}`);
  const tagName = `Board tag ${suffix}`;
  await page.getByRole('button', { name: 'Tag', exact: true }).click();
  await page.getByPlaceholder('New tag...').fill(tagName);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(tagName, { exact: true })).toBeVisible();

  const createdTagResponse = await page.request.get('/api/base.tag', {
    headers: authorization,
    params: { domain: JSON.stringify([['name', '=', tagName]]) },
  });
  expect(createdTagResponse.status()).toBe(200);
  const createdTags = (await createdTagResponse.json()) as { data: CreatedRecord[] };
  expect(createdTags.data).toHaveLength(1);
  const tagLinkParams = {
    headers: authorization,
    params: {
      domain: JSON.stringify([
        ['resource_model', '=', 'base.partner'],
        ['resource_id', '=', partnerId],
        ['tag_id', '=', createdTags.data[0]!.id],
      ]),
    },
  };
  const attachedTagLinkResponse = await page.request.get('/api/base.tag_link', tagLinkParams);
  expect(attachedTagLinkResponse.status()).toBe(200);
  expect(((await attachedTagLinkResponse.json()) as { data: CreatedRecord[] }).data).toHaveLength(
    1
  );

  await page.getByRole('button', { name: 'Remove tag' }).click();
  await expect(page.getByText(tagName, { exact: true })).toHaveCount(0);
  const removedTagLinkResponse = await page.request.get('/api/base.tag_link', tagLinkParams);
  expect(removedTagLinkResponse.status()).toBe(200);
  expect(((await removedTagLinkResponse.json()) as { data: CreatedRecord[] }).data).toHaveLength(0);

  await expect(page.getByRole('heading', { name: 'Addresses' })).toBeVisible();
  await page.getByRole('link', { name: 'Add New' }).click();
  await expect(page.getByRole('heading', { name: 'New Partner Address' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Address Type' })).toContainText('Other');
  await expect(page.getByLabel('Partner')).toContainText(`#${partnerId}`);
  await page.getByLabel('Label').fill(`Primary ${suffix}`);
  await page.getByRole('textbox', { name: 'Street *', exact: true }).fill('1 Example Street');
  await page.getByRole('textbox', { name: 'City *', exact: true }).fill('Jakarta');

  await page.getByLabel('Country').click();
  await page.getByPlaceholder('Search country…').fill('Indonesia');
  await page.getByRole('option', { name: /Indonesia/u }).click();
  await page.getByLabel('State / Province').click();
  await page.getByPlaceholder('Search state / province…').fill('DKI Jakarta');
  await page.getByRole('option', { name: /DKI Jakarta/u }).click();

  await page.getByLabel('Country').click();
  await page.getByPlaceholder('Search country…').fill('United States');
  await page.getByRole('option', { name: /United States/u }).click();
  const statePicker = page.getByLabel('State / Province');
  await expect(statePicker).toContainText('Pick a state / province…');
  await statePicker.click();
  await page.getByPlaceholder('Search state / province…').fill('California');
  await expect(page.getByRole('option', { name: /California/u })).toBeVisible();
  await expect(page.getByRole('option', { name: /DKI Jakarta/u })).toHaveCount(0);
  await page.getByRole('option', { name: /California/u }).click();

  await page.getByRole('button', { name: 'Save Record' }).click();
  await expect(page).toHaveURL(new RegExp(`/board/m/base\\.partner/${partnerId}$`, 'u'));
  await expect(page.getByRole('cell', { name: `Primary ${suffix}` })).toBeVisible();
  const savedAddressList = await page.request.get('/api/base.partner_address', {
    headers: authorization,
    params: { domain: JSON.stringify([['label', '=', `Primary ${suffix}`]]) },
  });
  expect(savedAddressList.status()).toBe(200);
  const createdAddresses = (await savedAddressList.json()) as {
    data: Array<CreatedRecord & { partner_id: number }>;
  };
  expect(createdAddresses.data).toHaveLength(1);
  const addressId = createdAddresses.data[0].id;
  expect(createdAddresses.data[0].partner_id).toBe(partnerId);
  const savedAddressResponse = await page.request.get(`/api/base.partner_address/${addressId}`, {
    headers: authorization,
    params: { with: 'partner,country,state' },
  });
  expect(savedAddressResponse.status()).toBe(200);
  const savedAddress = (await savedAddressResponse.json()) as {
    data: {
      partner_id: number;
      country_id: number;
      country: { name: string };
      state: { name: string; country_id: number };
    };
  };
  expect(savedAddress.data.partner_id).toBe(partnerId);
  expect(savedAddress.data.country.name).toBe('United States');
  expect(savedAddress.data.state.name).toBe('California');
  expect(savedAddress.data.state.country_id).toBe(savedAddress.data.country_id);

  const viewerPartnerResponse = await page.request.post('/api/base.partner', {
    headers: authorization,
    data: { name: `Record E2E Viewer ${suffix}` },
  });
  expect(viewerPartnerResponse.status()).toBe(201);
  const viewerPartner = (await viewerPartnerResponse.json()) as { data: CreatedRecord };
  const viewerLogin = `record-viewer-${suffix}`;
  const viewerPassword = `record-viewer-password-${suffix}`;
  const viewerResponse = await page.request.post('/api/base.user', {
    headers: authorization,
    data: {
      login: viewerLogin,
      password: viewerPassword,
      role: 'user',
      partner_id: viewerPartner.data.id,
    },
  });
  expect(viewerResponse.status()).toBe(201);
  const viewerLoginResponse = await page.request.post('/auth/login', {
    data: { login: viewerLogin, password: viewerPassword },
  });
  expect(viewerLoginResponse.status()).toBe(200);
  const viewerSession = (await viewerLoginResponse.json()) as {
    data: { access_token: string };
  };
  const deniedDelete = await page.request.delete(`/api/base.partner_address/${addressId}`, {
    headers: { authorization: `Bearer ${viewerSession.data.access_token}` },
  });
  expect(deniedDelete.status()).toBe(403);

  await page.goto(`/board/m/base.partner/${partnerId}`);
  let addressRow = page.getByRole('row').filter({ hasText: `Primary ${suffix}` });
  await expect(addressRow).toBeVisible();
  await addressRow.getByTitle('Open record in full view').click();
  await expect(page).toHaveURL(new RegExp(`/board/m/base\\.partner_address/${addressId}$`, 'u'));
  await page.getByLabel('Label').fill(`Primary Updated ${suffix}`);
  await page.getByRole('button', { name: 'Save Record' }).click();
  await expect(page.getByText('Record saved successfully!')).toBeVisible();
  const updatedAddressResponse = await page.request.get(`/api/base.partner_address/${addressId}`, {
    headers: authorization,
  });
  expect(updatedAddressResponse.status()).toBe(200);
  expect(((await updatedAddressResponse.json()) as { data: { label: string } }).data.label).toBe(
    `Primary Updated ${suffix}`
  );

  await page.goto(`/board/m/base.partner/${partnerId}`);
  addressRow = page.getByRole('row').filter({ hasText: `Primary Updated ${suffix}` });
  await expect(addressRow).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await addressRow.getByTitle('Archive item').click();
  await expect(addressRow).toHaveCount(0);
  const archivedThroughRelation = await page.request.get(`/api/base.partner_address/${addressId}`, {
    headers: authorization,
  });
  expect(archivedThroughRelation.status()).toBe(200);
  expect(
    ((await archivedThroughRelation.json()) as { data: { active: boolean } }).data.active
  ).toBe(false);

  const standaloneAddressResponse = await page.request.post('/api/base.partner_address', {
    headers: authorization,
    data: {
      partner_id: partnerId,
      label: `Standalone ${suffix}`,
      street: '2 Example Street',
      city: 'Jakarta',
    },
  });
  expect(standaloneAddressResponse.status()).toBe(201);
  const standaloneAddress = (await standaloneAddressResponse.json()) as { data: CreatedRecord };

  await page.goto(`/board/m/base.partner_address/${standaloneAddress.data.id}`);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page).toHaveURL(/\/m\/base\.partner_address$/u);
  const archivedAddress = await page.request.get(
    `/api/base.partner_address/${standaloneAddress.data.id}`,
    {
      headers: authorization,
    }
  );
  expect(archivedAddress.status()).toBe(200);
  expect(((await archivedAddress.json()) as { data: { active: boolean } }).data.active).toBe(false);

  await page.goto(`/board/m/base.partner_address/${addressId}`);
  await expect(page.getByRole('button', { name: 'Unarchive' })).toBeVisible();
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await expect(page.getByText('Action executed successfully.')).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page).toHaveURL(/\/m\/base\.partner_address$/u);
  expect(
    (
      await page.request.get(`/api/base.partner_address/${addressId}`, {
        headers: authorization,
      })
    ).status()
  ).toBe(404);
});
