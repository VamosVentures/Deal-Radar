import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Captures the documentation screenshot package against the STATIC demo
 * build (VITE_DEMO_MODE=true — bundled synthetic fixtures, no backend).
 * Run with: npm run build:demo && npx playwright test -c playwright.demo.config.ts
 *
 * Every image lands in docs/sourcing-workflow/screenshots/ under the
 * exact filenames SCREENSHOT_INDEX.md documents. Desktop viewport
 * 1440x900, device scale factor 1 (see playwright.demo.config.ts).
 */

const OUT = 'docs/sourcing-workflow/screenshots';
mkdirSync(OUT, { recursive: true });

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Administrator password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Sourcing radar')).toBeVisible({ timeout: 10_000 });
}

/** Wait for fonts, loading indicators, and hydration to settle before a capture. */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Checking sign-in')).toHaveCount(0);
  await expect(page.getByText('Loading VamosVentures Deal Radar')).toHaveCount(0);
  await page.waitForTimeout(150); // CSS transitions/opacity fades
}

test.describe.configure({ mode: 'serial' });

test('01 — access screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/01-access-screen.png` });
});

test('02 — overview dashboard', async ({ page }) => {
  await signIn(page);
  await settle(page);
  await page.screenshot({ path: `${OUT}/02-overview-dashboard.png` });
});

test('03 — vertical deals page (Frontier)', async ({ page }) => {
  await signIn(page);
  await page.goto('/frontier');
  await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/03-vertical-deals-page.png` });
});

test('04 — All Deals with multi-vertical filters', async ({ page }) => {
  await signIn(page);
  await page.goto('/companies');
  await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();
  // Select two verticals to demonstrate multi-vertical filtering.
  await page.getByRole('button', { name: 'FinTech', exact: true }).click();
  await page.getByRole('button', { name: 'Frontier', exact: true }).click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/04-all-deals-filters.png` });
});

test('05 — company profile', async ({ page }) => {
  await signIn(page);
  await page.goto('/companies');
  await page.getByText('Solstice Robotics (Illustrative Example)').first().click();
  await expect(page.getByRole('heading', { name: 'Company overview' })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/05-company-profile.png` });
});

test('06 — score, founders, evidence', async ({ page }) => {
  await signIn(page);
  await page.goto('/companies');
  await page.getByText('Solstice Robotics (Illustrative Example)').first().click();
  await expect(page.getByRole('heading', { name: 'Company overview' })).toBeVisible();
  const anchor = page.locator('a[href$="-founders"]').first();
  await anchor.click();
  await settle(page);
  await page.screenshot({ path: `${OUT}/06-score-founders-evidence.png` });
});

test('07 — deal discovery configuration', async ({ page }) => {
  await signIn(page);
  await page.goto('/discovery');
  await expect(page.getByText('Search configuration')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/07-deal-discovery-configuration.png` });
});

test('08 — deal discovery results', async ({ page }) => {
  await signIn(page);
  await page.goto('/discovery');
  await expect(page.getByText('Candidate preview')).toBeVisible();
  await page.getByText('Candidate preview').scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${OUT}/08-deal-discovery-results.png` });
});

test('09 — stealth radar', async ({ page }) => {
  await signIn(page);
  await page.goto('/stealth');
  await expect(page.getByText('Stealth Founder Radar')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/09-stealth-radar.png` });
});

test('10 — review actions', async ({ page }) => {
  await signIn(page);
  await page.goto('/companies');
  await page.getByText('Ledgerline', { exact: true }).first().click();
  await expect(page.getByText('Team actions')).toBeVisible();
  await page.getByText('Team actions').scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${OUT}/10-review-actions.png` });
});

test('11 — founder outreach preview', async ({ page }) => {
  await signIn(page);
  await page.goto('/companies');
  await page.getByText('Solstice Robotics (Illustrative Example)').first().click();
  await page.getByRole('button', { name: 'Generate founder outreach' }).click();
  await expect(page.getByText(/draft/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Generate draft from verified facts' }).click();
  await expect(page.getByText(/no ai model called/i).first()).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/11-founder-outreach-preview.png` });
});
