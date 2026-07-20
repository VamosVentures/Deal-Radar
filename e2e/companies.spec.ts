import { test, expect } from '@playwright/test';
import { E2E_BACKEND_PORT } from './env';

test.describe('Companies and review queue', () => {
  test('loads with the seeded companies and no demo/sample data', async ({ page }) => {
    await page.goto('/companies');
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
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
    await page.getByLabel('Filter by vertical').selectOption('fintech');
    await expect(page.getByText('E2E FinTech Fixture Co')).toBeVisible();
    await expect(page.getByText('E2E Health Fixture Co')).not.toBeVisible();
    await page.getByLabel('Filter by vertical').selectOption('all');

    await page.getByLabel('Filter by stage').selectOption('Pre-seed');
    await expect(page.getByText('E2E FinTech Fixture Co')).toBeVisible();
    await expect(page.getByText('E2E Health Fixture Co')).not.toBeVisible();
    await page.getByLabel('Filter by stage').selectOption('all');

    await page.getByLabel('Filter by state').selectOption('TX');
    await expect(page.getByText('E2E Health Fixture Co')).toBeVisible();
    await expect(page.getByText('E2E FinTech Fixture Co')).not.toBeVisible();
  });

  test('the company detail view opens and review-status actions work', async ({ page }) => {
    await page.goto('/companies');
    await page.getByText('E2E Health Fixture Co').click();
    await expect(page.getByText(/Vamos Fit Score:/)).toBeVisible();

    await page.getByRole('button', { name: 'Monitor' }).click();
    await expect(page.getByText('Monitor', { exact: true }).first()).toBeVisible();
  });

  test('Research Needed and Awaiting Review actions work from the detail view', async ({ page }) => {
    await page.goto('/companies');
    await page.getByText('E2E FinTech Fixture Co').click();
    await page.getByRole('button', { name: 'Send for research' }).click();
    await expect(page.getByText('Research Needed').first()).toBeVisible();
  });

  test('Pass moves a company to a terminal status', async ({ page }) => {
    await page.goto('/companies');
    await page.getByText('E2E FinTech Fixture Co').click();
    await page.getByRole('button', { name: 'Pass', exact: true }).click();
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
