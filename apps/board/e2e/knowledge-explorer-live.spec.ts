import { expect, test } from '@playwright/test';
import { E2E_SUPERADMIN_PASSWORD } from './constants.js';

type GraphSearchWireResult = {
  id: string;
  kind: 'assertion' | 'evidence' | 'relation';
  title: string;
  summary: string;
  assertion_id?: string;
  source_id?: string;
  edition_id?: string;
  locator?: string;
};

type GraphSearchWireResponse = {
  success: boolean;
  data: { release_digest: string; results: GraphSearchWireResult[] };
};

type RelationExplanationWireResponse = {
  success: boolean;
  data: {
    release_digest: string;
    explanation: {
      id: string;
      predicate: string;
      review_status: string;
      epistemic_status: string;
      supporting_evidence: Array<{
        evidence: { id: string; assertion_id: string };
        source_id: string;
        edition_id: string;
        locator: string;
        citation: string;
        excerpt: string;
      }>;
    };
  };
};

type PassageWireResponse = {
  success: boolean;
  data: {
    sourceId: string;
    editionId: string;
    locator: string;
    sha256: string;
    text: string;
  };
};

test('superadmin searches live PostgreSQL knowledge and opens its pinned passage', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill('superadmin');
  await page.getByLabel('Password', { exact: true }).fill(E2E_SUPERADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);

  const companySwitcher = page.getByRole('button', {
    name: 'Switch company. Current scope: Global Scope',
  });
  await companySwitcher.click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  const knowledgeLink = page.getByRole('link', { name: 'Knowledge explorer' });
  await expect(knowledgeLink).toBeVisible();
  const passageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.includes('/api/corpus/passages/') && response.status() === 200;
  });
  await knowledgeLink.click();
  await expect(page.getByRole('heading', { name: 'Knowledge explorer' })).toBeVisible();
  const livePassage = await passageResponse;
  const livePassageBody: PassageWireResponse = await livePassage.json();
  expect(livePassageBody).toMatchObject({
    success: true,
    data: {
      sourceId: 'mw:source:tanzil-quran-text',
      editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
      locator: 'Q7:46',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    },
  });
  expect(livePassageBody.data.text).toEqual(expect.any(String));
  await expect(page.getByText(livePassageBody.data.text, { exact: true })).toBeVisible();

  const claim = 'Synthetic local PostgreSQL Board E2E assertion.';
  const searchInput = page.getByLabel('Search graph records');
  await searchInput.fill(claim);
  const assertionResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/research/graph/search' && url.searchParams.get('q') === claim;
  });
  await page.getByRole('button', { name: 'Search graph' }).click();
  const liveAssertionSearch = await assertionResponse;
  expect(liveAssertionSearch.status(), await liveAssertionSearch.text()).toBe(200);
  const liveAssertionBody: GraphSearchWireResponse = await liveAssertionSearch.json();
  expect(liveAssertionBody.success).toBe(true);
  expect(liveAssertionBody.data.release_digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    liveAssertionBody.data.results.some(
      (result) =>
        result.id === 'mw:assertion:e2e-live-knowledge' &&
        result.kind === 'assertion' &&
        result.title === claim
    )
  ).toBe(true);
  await expect(page.getByText(claim, { exact: true })).toBeVisible();

  const evidenceResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/research/graph/search';
  });
  await page.getByRole('button', { name: 'Find linked evidence' }).click();
  const liveEvidenceSearch = await evidenceResponse;
  expect(new URL(liveEvidenceSearch.url()).searchParams.get('q')).toBe(
    'mw:assertion:e2e-live-knowledge'
  );
  expect(liveEvidenceSearch.status()).toBe(200);
  const liveEvidenceBody: GraphSearchWireResponse = await liveEvidenceSearch.json();
  expect(liveEvidenceBody.success).toBe(true);
  expect(
    liveEvidenceBody.data.results.some(
      (result) =>
        result.id === 'mw:evidence:e2e-live-knowledge' &&
        result.kind === 'evidence' &&
        result.assertion_id === 'mw:assertion:e2e-live-knowledge' &&
        result.source_id === 'mw:source:tanzil-quran-text' &&
        result.edition_id === 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2' &&
        result.locator === 'Q7:46'
    )
  ).toBe(true);

  await page.getByRole('button', { name: 'Open pinned passage Q7:46' }).click();
  await expect(page.getByText(livePassageBody.data.text, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Q7:46' })).toBeVisible();

  const relationId = 'mw:relation:e2e-live-knowledge';
  const relationInput = page.getByLabel('Research relation ID');
  await page.getByLabel('Search graph records').fill(relationId);
  const relationSearchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/research/graph/search' && url.searchParams.get('q') === relationId
    );
  });
  await page.getByRole('button', { name: 'Search graph' }).click();
  const relationSearch = await relationSearchResponse;
  expect(relationSearch.status()).toBe(200);
  const relationSearchBody: GraphSearchWireResponse = await relationSearch.json();
  expect(
    relationSearchBody.data.results.some(
      (result) => result.id === relationId && result.kind === 'relation'
    )
  ).toBe(true);
  const explanationResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/research/relations/${encodeURIComponent(relationId)}/explanation` &&
      response.request().method() === 'GET'
    );
  });
  await page.getByRole('button', { name: 'Explain relation' }).click();
  const liveExplanation = await explanationResponse;
  expect(liveExplanation.status(), await liveExplanation.text()).toBe(200);
  const liveExplanationBody: RelationExplanationWireResponse = await liveExplanation.json();
  expect(liveExplanationBody.success).toBe(true);
  expect(liveExplanationBody.data.release_digest).toBe(relationSearchBody.data.release_digest);
  expect(liveExplanationBody.data.explanation).toMatchObject({
    id: relationId,
    predicate: 'related_to',
    review_status: 'pending',
    epistemic_status: 'unreviewed',
  });
  expect(
    liveExplanationBody.data.explanation.supporting_evidence.map((row) => row.evidence.id)
  ).toContain('mw:evidence:e2e-live-knowledge');
  await expect(relationInput).toHaveValue(relationId);
  await expect(page.getByRole('heading', { name: 'Explain a relation' })).toBeVisible();
  await expect(page.getByText('related_to', { exact: true })).toBeVisible();
  await expect(page.getByText('pending · unreviewed', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Supporting evidence' })).toContainText(
    'mw:assertion:e2e-live-knowledge'
  );
});
