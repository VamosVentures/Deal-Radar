import { test, expect } from '@playwright/test';
import { E2E_BACKEND_PORT } from './env';
import { bulkSetStatus } from './bulk-status';

test.describe('All Deals (companies review queue)', () => {
  test('loads with the seeded companies and no demo/sample data', async ({ page }) => {
    await page.goto('/companies');
    await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();
    await expect(page.getByText('E2E Health Fixture Co')).toBeVisible();
    await expect(page.getByText('E2E FinTech Fixture Co')).toBeVisible();
    // None of the fictional bundled-sample names from earlier phases should ever appear.
    await expect(page.getByText('Cosecha Labs')).not.toBeVisible();
    await expect(page.getByText('SolCare Health')).not.toBeVisible();
  });

  test('company search filters the list', async ({ page }) => {
    await page.goto('/companies');
    await page.getByLabel('Search companies').fill('FinTech Fixture');
    await expect(page.getByText('E2E FinTech Fixture Co')).toBeVisible();
    await expect(page.getByText('E2E Health Fixture Co')).not.toBeVisible();
  });

  test('vertical, stage, and state filters narrow the list', async ({ page }) => {
    await page.goto('/companies');
    // The vertical filter is multi-select (toggle chips), not a <select>
    // — pick one and confirm it narrows, then re-select "All verticals".
    await page.getByRole('group', { name: 'Filter by vertical — select one or more' }).getByRole('button', { name: 'FinTech' }).click();
    await expect(page.getByText('E2E FinTech Fixture Co')).toBeVisible();
    await expect(page.getByText('E2E Health Fixture Co')).not.toBeVisible();
    await page.getByRole('group', { name: 'Filter by vertical — select one or more' }).getByRole('button', { name: 'All verticals' }).click();

    await page.getByLabel('Filter by stage').selectOption('Pre-seed');
    await expect(page.getByText('E2E FinTech Fixture Co')).toBeVisible();
    await expect(page.getByText('E2E Health Fixture Co')).not.toBeVisible();
    await page.getByLabel('Filter by stage').selectOption('all');

    await page.getByLabel('Filter by state').selectOption('TX');
    await expect(page.getByText('E2E Health Fixture Co')).toBeVisible();
    await expect(page.getByText('E2E FinTech Fixture Co')).not.toBeVisible();
  });

  test('the Claude prompt action copies evidence without notes or contact details', async ({ page, context }) => {
    // Repaired in the Friday audit: the in-app AI actions answer from a
    // local template, so there was no way to get real analysis without
    // credentials. This copies a structured prompt for a person to run
    // themselves — and must not claim a model ran here.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/companies');
    await page.getByText('E2E Health Fixture Co').first().click();

    const copyButton = page.getByRole('button', { name: 'Copy Claude prompt' });
    await expect(copyButton).toBeVisible();
    await copyButton.click();

    await expect(page.getByText('Copied — no AI ran here.')).toBeVisible();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('E2E Health Fixture Co');
    expect(clipboard).toContain('E2E fixture evidence claim');
    // The instruction that stops a model inventing a missing field.
    expect(clipboard).toContain('Do not fill it in, infer it, or assume a value.');
    // Nothing confidential rides along.
    expect(clipboard.toLowerCase()).not.toContain('internal note');
    expect(clipboard).not.toMatch(/@vamosventures\.com/);
  });

  test('a disabled connector explains why its Run sync is unavailable', async ({ page }) => {
    // Repaired in the Friday audit: these four buttons were disabled with
    // no explanation at all — a greyed-out control that told the reader
    // nothing.
    await page.goto('/sources');
    await expect(page.getByText('System status')).toBeVisible();

    const disabledRunSync = page.getByRole('button', { name: 'Run sync', disabled: true }).first();
    await expect(disabledRunSync).toBeVisible();
    await expect(disabledRunSync).toHaveAttribute('title', /is disabled\. Use Enable first/);
  });

  test('the company detail view opens and a status set from the queue lands on it', async ({ page }) => {
    await page.goto('/companies');
    await bulkSetStatus(page, 'E2E Health Fixture Co', 'Monitor');

    // The detail view still opens on a row click, and carries the
    // status the queue just applied — the two halves of the workflow
    // that the removed panel used to combine into one screen.
    await page.getByText('E2E Health Fixture Co').click();
    await expect(page.getByText(/VamosVentures Fit Score:/)).toBeVisible();
    await expect(page.getByText('Monitor', { exact: true }).first()).toBeVisible();
  });

  test('Research Needed is reachable for a company awaiting review', async ({ page }) => {
    await page.goto('/companies');
    await bulkSetStatus(page, 'E2E FinTech Fixture Co', 'Research Needed');
    await page.getByText('E2E FinTech Fixture Co').click();
    await expect(page.getByText('Research Needed').first()).toBeVisible();
  });

  test('Passed moves a company to a terminal status', async ({ page }) => {
    await page.goto('/companies');
    await bulkSetStatus(page, 'E2E FinTech Fixture Co', 'Passed');
    await page.getByText('E2E FinTech Fixture Co').click();
    await expect(page.getByText('Passed', { exact: true }).first()).toBeVisible();
  });

  test('possible-duplicate indicators render and can be resolved', async ({ page }) => {
    // Discover the real seeded company's id via the actual API, then
    // intercept the duplicates endpoint with a fixture entry
    // referencing that real id — deterministic, no real fuzzy-match
    // dependency, and the resolve action still hits the real backend.
    const res = await page.request.get(`http://localhost:${E2E_BACKEND_PORT}/api/companies/imported`);
    const body = await res.json();
    const target = (body.companies as { id: string; name: string }[]).find((c) => c.name === 'E2E Health Fixture Co')!;

    await page.route('**/api/duplicates**', (route) => route.fulfill({
      json: {
        duplicates: [{
          id: 1, companyId: target.id, otherCompanyId: null, matchedBy: 'fuzzy-name', similarity: 0.92,
          detail: 'E2E fixture: possible duplicate for testing.', status: 'pending', createdAt: new Date().toISOString(),
          resolvedBy: null, resolvedAt: null,
          company: { id: target.id, name: target.name }, otherCompany: null,
        }],
      },
    }));

    await page.goto('/companies');
    await expect(page.getByText('Possible duplicate').first()).toBeVisible();

    await page.getByText('E2E Health Fixture Co').click();
    await expect(page.getByText('Possible duplicate — pending review')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not a duplicate' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm duplicate' })).toBeVisible();
  });
});
