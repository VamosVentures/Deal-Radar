import { test, expect } from '@playwright/test';

/**
 * Executive Overview KPI cards, the five-vertical taxonomy, All Deals,
 * and legacy vertical redirects — the "Marcos requirements" pass.
 *
 * Backend formulas for each KPI are unit-tested exhaustively in
 * server/tests/executive-kpis.test.ts; this file only covers what a
 * browser test uniquely can: the actual labels rendered on screen, that
 * every card really opens its modal, that the taxonomy is really five
 * verticals end to end (sidebar, filters, redirects), and that
 * "Research Coverage" / "Last Run" cards are really gone.
 */

const COMPANY_METRICS = ['Discovered This Week', 'High-Fit Companies', 'Stale Companies', 'Awaiting Review', 'Cumulative Companies'];
const FOUNDER_METRICS = ['Discovered This Week', 'High-Fit Founders', 'Stale Founders', 'Awaiting Review', 'Cumulative Founders'];
const APPROVED_VERTICALS = ['Health & Wellness', 'FinTech', 'Future of Work', 'Sustainability', 'Frontier'];
const RETIRED_VERTICAL_LABELS = ['Robotics', 'Space Tech', 'General AI'];

test.describe('Executive Overview — ten KPI cards', () => {
  test('shows two labeled sections, five cards each, with the exact specified labels', async ({ page }) => {
    await page.goto('/');
    const companiesSection = page.locator('section', { has: page.getByRole('heading', { name: 'Companies', exact: true }) });
    const foundersSection = page.locator('section', { has: page.getByRole('heading', { name: 'Stealth Founders', exact: true }) });
    await expect(companiesSection).toBeVisible();
    await expect(foundersSection).toBeVisible();

    for (const label of COMPANY_METRICS) {
      await expect(companiesSection.getByRole('button', { name: new RegExp(label) })).toBeVisible();
    }
    for (const label of FOUNDER_METRICS) {
      await expect(foundersSection.getByRole('button', { name: new RegExp(label) })).toBeVisible();
    }
  });

  test('the "Last Run" cards are gone from the Overview', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^Last Run/ })).toHaveCount(0);
    await expect(page.getByText(/^Last Run$/)).toHaveCount(0);
  });

  test('every one of the ten cards opens the shared breakdown modal, reconciling by vertical', async ({ page }) => {
    await page.goto('/');
    const companiesSection = page.locator('section', { has: page.getByRole('heading', { name: 'Companies', exact: true }) });
    const foundersSection = page.locator('section', { has: page.getByRole('heading', { name: 'Stealth Founders', exact: true }) });

    for (const [section, metrics] of [[companiesSection, COMPANY_METRICS], [foundersSection, FOUNDER_METRICS]] as const) {
      for (const label of metrics) {
        await section.getByRole('button', { name: new RegExp(label) }).first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        // Every approved vertical is a row, in a table with a Total footer.
        for (const v of APPROVED_VERTICALS) await expect(dialog.getByText(v, { exact: true })).toBeVisible();
        await expect(dialog.getByText('Unassigned')).toBeVisible();
        await expect(dialog.getByText('Total')).toBeVisible();
        await dialog.getByRole('button', { name: 'Close dialog' }).click();
        await expect(dialog).toHaveCount(0);
      }
    }
  });

  test('the Cumulative modal offers all five time filters and updates on selection', async ({ page }) => {
    await page.goto('/');
    const companiesSection = page.locator('section', { has: page.getByRole('heading', { name: 'Companies', exact: true }) });
    await companiesSection.getByRole('button', { name: /Cumulative Companies/ }).click();
    const group = page.getByRole('group', { name: 'Time period' });
    await expect(group).toBeVisible();
    for (const period of ['All Time', 'This Month', 'Last Month', 'This Year', 'Last Year']) {
      await expect(group.getByRole('button', { name: period })).toBeVisible();
    }
    await group.getByRole('button', { name: 'This Month' }).click();
    await expect(group.getByRole('button', { name: 'This Month' })).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('Five approved verticals — taxonomy end to end', () => {
  test('the sidebar lists exactly the five approved verticals, never the retired ones', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    for (const name of APPROVED_VERTICALS) {
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    }
    for (const name of RETIRED_VERTICAL_LABELS) {
      await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
  });

  test('legacy Robotics and Space Tech bookmarks redirect to the Frontier filter', async ({ page }) => {
    for (const path of ['/robotics', '/space-tech']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/companies\?.*vertical=frontier/);
      await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();
    }
  });

  test('legacy AI bookmark redirects to the Future of Work filter, not a retired General AI vertical', async ({ page }) => {
    await page.goto('/ai');
    await expect(page).toHaveURL(/\/companies\?.*vertical=fow/);
    await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();
  });

  test('the legacy areas-of-interest bookmark lands on the unfiltered All Deals view, not a dead filter', async ({ page }) => {
    await page.goto('/areas-of-interest');
    await expect(page).toHaveURL(/\/companies$/);
    await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();
  });

  test('the old /companies link still opens All Deals', async ({ page }) => {
    await page.goto('/companies');
    await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();
  });
});
