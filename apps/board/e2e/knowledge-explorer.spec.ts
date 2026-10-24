import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { E2E_SUPERADMIN_PASSWORD } from './constants.js';

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
    `${label} should have no WCAG 2.1 A/AA violations`
  ).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${label} has unintended horizontal overflow (${dimensions.scrollWidth}px > ${dimensions.clientWidth}px)`
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function signIn(page: Page, login: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill(login);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Enter the Shadow' }).click();
  await expect(page).toHaveURL(/\/board$/u);
}

test('superadmin research access follows company context and source locators', async ({
  page,
}, testInfo) => {
  let unavailablePassageRequested = false;
  await signIn(page, 'superadmin', E2E_SUPERADMIN_PASSWORD);
  const companySwitcher = page.getByRole('button', {
    name: 'Switch company. Current scope: Global Scope',
  });
  await expect(companySwitcher).toBeVisible();
  await expect(page.getByRole('link', { name: 'Knowledge explorer' })).toHaveCount(0);
  await companySwitcher.click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await expect(page.getByRole('link', { name: 'Knowledge explorer' })).toBeVisible();

  await page.route('**/api/corpus/sources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          publication: 'source_bytes',
          sourceId: 'mw:source:tanzil-quran-text',
          editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
          locale: 'ar',
          citation: 'Tanzil Quran Text, CC BY 3.0.',
          references: [],
          availablePassages: ['Q7:46'],
        },
      }),
    })
  );
  await page.route('**/api/corpus/passages/**', (route) => {
    const locator = decodeURIComponent(
      new URL(route.request().url()).pathname.split('/').at(-1) ?? ''
    );
    if (locator === 'Q7:47') unavailablePassageRequested = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          sourceId: 'mw:source:tanzil-quran-text',
          editionId: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
          locator: 'Q7:46',
          text: 'A verified local passage excerpt.',
          sha256: 'a'.repeat(64),
          citation: 'Tanzil Quran Text, CC BY 3.0.',
        },
      }),
    });
  });
  await page.route('**/api/research/graph/search**', (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    const unavailableAssertion = query === 'unavailable';
    const linkedEvidence = query === 'mw:assertion:e2e' || query === 'mw:assertion:unavailable';
    const relationMatch = query === 'mw:relation:e2e';
    const noMatches = query === 'no-match';
    const unavailableLocator = query === 'mw:assertion:unavailable';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          release_digest: 'b'.repeat(64),
          truncated: false,
          results: noMatches
            ? []
            : relationMatch
              ? [
                  {
                    id: 'mw:relation:e2e',
                    kind: 'relation',
                    title: 'describes · mw:assertion:e2e → mw:entity:e2e',
                    summary: 'candidate · pending',
                  },
                ]
              : linkedEvidence
                ? [
                    {
                      id: unavailableLocator ? 'mw:evidence:unavailable' : 'mw:evidence:e2e',
                      kind: 'evidence',
                      title: unavailableLocator ? 'supporting · Q7:47' : 'supporting · Q7:46',
                      summary: 'mw:source:tanzil-quran-text',
                      assertion_id: unavailableLocator
                        ? 'mw:assertion:unavailable'
                        : 'mw:assertion:e2e',
                      source_id: 'mw:source:tanzil-quran-text',
                      edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
                      locator: unavailableLocator ? 'Q7:47' : 'Q7:46',
                    },
                  ]
                : [
                    {
                      id: unavailableAssertion ? 'mw:assertion:unavailable' : 'mw:assertion:e2e',
                      kind: 'assertion',
                      title: 'Synthetic graph-search assertion.',
                      summary: unavailableAssertion
                        ? 'missing-passage · pending'
                        : 'positive · pending',
                    },
                  ],
        },
      }),
    });
  });
  await page.route('**/api/research/relations/**/explanation', (route) => {
    const requestedRelationId = decodeURIComponent(
      new URL(route.request().url()).pathname.split('/').at(-2) ?? ''
    );
    const isAlternative = requestedRelationId === 'mw:relation:alternative';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          release_digest: 'b'.repeat(64),
          explanation: {
            id: requestedRelationId,
            kind: 'ResearchRelation',
            schema_version: 1,
            content_revision: 1,
            predicate: isAlternative ? 'possibly_describes' : 'describes',
            subject_id: 'mw:assertion:e2e',
            object_id: isAlternative ? 'mw:entity:alternative' : 'mw:entity:e2e',
            scope: { kind: 'passage', reference_id: 'mw:passage:e2e' },
            epistemic_status: 'candidate',
            review_status: 'pending',
            interpretation_boundary: 'linked_evidence_only',
            supporting_evidence: [
              {
                evidence: {
                  id: 'mw:evidence:e2e',
                  assertion_id: 'mw:assertion:e2e',
                  direction: 'supporting',
                  selector: {
                    source_id: 'mw:source:tanzil-quran-text',
                    edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
                    locator: 'Q7:46',
                    content_sha256: 'c'.repeat(64),
                  },
                },
                direction: 'supporting',
                source_id: 'mw:source:tanzil-quran-text',
                edition_id: 'mw:edition:tanzil-quran-text-v1.1-uthmani-txt2',
                locator: 'Q7:46',
                content_sha256: 'c'.repeat(64),
                citation: 'Tanzil Quran Text, CC BY 3.0.',
                excerpt: 'A cited excerpt.',
              },
            ],
            counterevidence: [],
            alternatives: isAlternative
              ? []
              : [
                  {
                    relation: {
                      id: 'mw:relation:alternative',
                      kind: 'ResearchRelation',
                      schema_version: 1,
                      content_revision: 1,
                      predicate: 'possibly_describes',
                      subject_id: 'mw:assertion:e2e',
                      object_id: 'mw:entity:alternative',
                      scope: { kind: 'passage', reference_id: 'mw:passage:e2e' },
                      epistemic_status: 'candidate',
                      review_status: 'pending',
                      interpretation_boundary: 'linked_evidence_only',
                    },
                    supporting_evidence: [],
                    counterevidence: [],
                  },
                ],
          },
        },
      }),
    });
  });

  const knowledgeLink = page.getByRole('link', { name: 'Knowledge explorer' });
  await knowledgeLink.focus();
  await expect(knowledgeLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Knowledge explorer' })).toBeVisible();
  await expect(page.getByText('A verified local passage excerpt.')).toBeVisible();
  await page.getByLabel('Search graph records').fill('synthetic');
  await page.getByRole('button', { name: 'Search graph' }).click();
  await expect(page.getByText('Synthetic graph-search assertion.')).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Search for “synthetic” found 1 readable graph result.'
  );
  await expect(page.getByText(`Active release SHA-256: ${'b'.repeat(64)}`)).toBeVisible();
  await page.getByRole('button', { name: 'Find linked evidence' }).click();
  await expect(page.getByText('supporting · Q7:46')).toBeVisible();
  await page.getByRole('button', { name: 'Open pinned passage Q7:46' }).click();
  await expect(page.getByRole('heading', { name: 'Q7:46' })).toBeVisible();
  const graphSearch = page.getByLabel('Search graph records');
  await graphSearch.fill('mw:relation:e2e');
  await page.getByRole('button', { name: 'Search graph' }).click();
  await expect(page.getByText('describes · mw:assertion:e2e → mw:entity:e2e')).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Search for “mw:relation:e2e” found 1 readable graph result.'
  );
  await page.getByRole('button', { name: 'Explain relation' }).click();
  const relationInput = page.getByLabel('Research relation ID');
  await expect(relationInput).toHaveValue('mw:relation:e2e');
  await expect(page.getByText('describes', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Interpretation boundary: linked evidence only. This view does not infer causation.'
    )
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open pinned source passage Q7:46' }).click();
  await expect(page.getByRole('heading', { name: 'Q7:46' })).toBeVisible();
  await expect(page.getByText('A verified local passage excerpt.')).toBeVisible();
  await page.getByRole('button', { name: 'possibly_describes' }).click();
  await expect(page.getByLabel('Research relation ID')).toHaveValue('mw:relation:alternative');
  await expect(page.getByText('possibly_describes', { exact: true })).toBeVisible();
  await expect(page.getByText('mw:entity:alternative', { exact: true })).toBeVisible();

  await page.getByLabel('Search graph records').fill('unavailable');
  await page.getByRole('button', { name: 'Search graph' }).click();
  await page.getByRole('button', { name: 'Find linked evidence' }).click();
  await expect(page.getByText('supporting · Q7:47')).toBeVisible();
  await page.getByRole('button', { name: 'Open pinned passage Q7:47' }).click();
  await expect(
    page.getByText('The selected evidence passage is not available in this pinned source edition.')
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Q7:46' })).toHaveCount(0);
  expect(unavailablePassageRequested).toBe(false);

  await page.getByRole('button', { name: 'Switch company. Current scope: MoonWitness' }).click();
  await page.getByRole('menuitem', { name: 'Global (All Companies)' }).click();
  await expect(page.getByRole('link', { name: 'Knowledge explorer' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Knowledge explorer unavailable' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch company. Current scope: Global Scope' }).click();
  await page.getByRole('menuitem', { name: 'MoonWitness' }).click();
  await expect(page.getByRole('link', { name: 'Knowledge explorer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Knowledge explorer' })).toBeVisible();
  await page.getByLabel('Search graph records').fill('no-match');
  await page.getByRole('button', { name: 'Search graph' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'No readable graph records matched “no-match”.'
  );
  await expect(page.getByText('Try another claim, relation ID, source, or passage.')).toBeVisible();

  const visualSizes = [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
  ] as const;
  for (const size of visualSizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const theme of ['light', 'dark'] as const) {
      const isDark = await page
        .locator('html')
        .evaluate((element) => element.classList.contains('dark'));
      if (isDark !== (theme === 'dark')) {
        if (size.width < 640) {
          await page.getByRole('button', { name: /^User menu for/u }).click();
          await page.getByRole('menuitem', { name: 'Toggle theme' }).click();
        } else {
          await page.getByRole('button', { name: 'Toggle theme' }).click();
        }
        // Button colors flip instantly while their background-color transitions,
        // so axe can sample a light surface with dark text mid-theme-change.
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation instanceof CSSTransition)
              .map((animation) => animation.finished.catch(() => undefined))
          )
        );
      }
      await expect(page.getByRole('heading', { name: 'Knowledge explorer' })).toBeVisible();
      const label = `knowledge/${size.name}/${theme}`;
      await expectNoHorizontalOverflow(page, label);
      await expectNoA11yViolations(page, label);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath(`${size.name}-${theme}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
});
