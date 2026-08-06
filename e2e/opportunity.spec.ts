import { test, expect } from '@playwright/test';

/**
 * The deal/lead distinction has to be visible, not merely stored.
 *
 * The backend could classify perfectly and the dashboard would still be
 * misleading if every row looked identical. These tests assert that a
 * reviewer can see what a record IS before deciding anything about it.
 *
 * The E2E database is seeded with two CSV-imported companies that carry
 * no deal evidence, so the expected state is: both visible, both labelled
 * as company leads, neither presented as a deal.
 */

test.describe('Opportunity classification in the UI', () => {
  test('every company row carries an opportunity classification badge', async ({ page }) => {
    await page.goto('/companies');
    await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();

    // Seeded companies have no deal evidence, so they must read as leads —
    // never as deals by omission.
    const badges = page.getByText('Company Lead', { exact: true });
    await expect(badges.first()).toBeVisible();
    expect(await badges.count()).toBeGreaterThan(0);
  });

  test('a company with no deal evidence is never labelled a live opportunity', async ({ page }) => {
    await page.goto('/companies');
    for (const label of ['Verified Opportunity', 'Recent Financing', 'Fundraising Signal']) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
  });

  test('the opportunity filter section is present with its controls', async ({ page }) => {
    await page.goto('/companies');
    await expect(page.getByText('Opportunity & evidence')).toBeVisible();
    await expect(page.getByRole('combobox', { name: /All classifications/i }).or(
      page.locator('select').filter({ hasText: 'All classifications' }),
    ).first()).toBeVisible();
    await expect(page.getByLabel('Live opportunities only')).toBeVisible();
    await expect(page.getByLabel('Company leads only')).toBeVisible();
    await expect(page.getByLabel('Missing corroboration')).toBeVisible();
    await expect(page.getByLabel('Public-company warning')).toBeVisible();
    await expect(page.getByLabel('Fund/SPV warning')).toBeVisible();
  });

  test('"Live opportunities only" empties the list when nothing qualifies', async ({ page }) => {
    await page.goto('/companies');
    const countText = page.locator('text=/\\d+ compan(y|ies)/').first();
    await expect(countText).toBeVisible();

    await page.getByLabel('Live opportunities only').check();
    // Seed data has no qualifying opportunities, so the honest result is zero.
    await expect(page.getByText('0 companies')).toBeVisible();
  });

  test('"Company leads only" keeps the seeded companies visible', async ({ page }) => {
    await page.goto('/companies');
    await page.getByLabel('Company leads only').check();
    await expect(page.getByText('E2E Health Fixture Co')).toBeVisible();
  });

  test('the two filters are mutually exclusive', async ({ page }) => {
    await page.goto('/companies');
    const live = page.getByLabel('Live opportunities only');
    const leads = page.getByLabel('Company leads only');

    await live.check();
    await expect(live).toBeChecked();
    await leads.check();
    // Checking one must clear the other — they are contradictory.
    await expect(live).not.toBeChecked();
    await expect(leads).toBeChecked();
  });

  test('the company detail view explains why a record is not a live deal', async ({ page }) => {
    await page.goto('/companies');
    await page.getByText('E2E Health Fixture Co').click();
    await expect(page.getByText('Opportunity status')).toBeVisible();
    // The explainer must state the reason rather than leaving it blank.
    await expect(
      page.getByText(/not been classified yet|no evidence|not a live deal|treated as a lead/i).first(),
    ).toBeVisible();
  });
});

test.describe('Source-diversity analytics', () => {
  test('the diversity panel renders for an authenticated administrator', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByText('System status')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Source diversity' })).toBeVisible();
    await expect(page.getByText('Live opportunities').first()).toBeVisible();
    await expect(page.getByText('Company leads').first()).toBeVisible();
    await expect(page.getByText('≥2 sources')).toBeVisible();
    await expect(page.getByText('Public excluded')).toBeVisible();
    await expect(page.getByText('Funds/SPVs excluded')).toBeVisible();
  });

  test('the panel states that its numbers come from persisted evidence', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByText(/never estimated/i)).toBeVisible();
  });

  test('concentration is reported by source family, not only by source id', async ({ page }) => {
    await page.goto('/sources');
    // Family is the level at which concentration means anything: adding
    // publishers must not be able to make a press-only pipeline look
    // diversified, and the panel has to show the number that cannot be
    // gamed that way.
    await expect(page.getByRole('heading', { name: 'Opportunities by source family' })).toBeVisible();
    await expect(page.getByText(/Four newspapers are still one family/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'By primary source' })).toBeVisible();
  });

  test('the investor-primary source is listed honestly on the settings page', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByText('Investor funding announcements (official newsrooms)').first()).toBeVisible();
  });
});
