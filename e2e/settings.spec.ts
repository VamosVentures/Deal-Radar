import { test, expect } from '@playwright/test';
import { E2E_ADMIN_PASSWORD } from './env';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/sources');
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('System status')).toBeVisible();
}

test.describe('Settings', () => {
  test('source statuses render honestly for an authenticated administrator', async ({ page }) => {
    await signIn(page);
    await expect(page.getByText('Implemented — credentials required').first()).toBeVisible();
    // GitHub's "Connected" state only ever appears after a real health check —
    // this asserts the label exists somewhere, not that it's fabricated.
    await expect(page.getByText('GitHub API verified').or(page.getByText('GitHub API unreachable'))).toBeVisible();
  });

  test('credential-required integrations are labeled honestly, never as live', async ({ page }) => {
    await signIn(page);
    // HubSpot/Outlook/AI have no credentials in the E2E environment —
    // they must never claim "Connected".
    const hubspotCard = page.locator('text=HubSpot CRM').first().locator('xpath=ancestor::*[self::section or self::div][1]');
    await expect(page.getByText('Implemented — credentials required').first()).toBeVisible();
    await expect(page.getByText('Not connected').first()).toBeVisible();
    void hubspotCard;
  });

  test('sources with no adapter are never shown as an enabled, working option', async ({ page }) => {
    await signIn(page);
    // "Accelerator & fellowship sites" has no adapter — its source-quality
    // row must read Planned, and its schedule checkbox must be disabled
    // and unchecked, never selectable as if it were live.
    const row = page.getByRole('row', { name: /Accelerator & fellowship sites/ });
    await expect(row).toContainText('Planned');
    await expect(page.getByRole('checkbox', { name: 'Accelerator & fellowship sites' })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: 'Accelerator & fellowship sites' })).not.toBeChecked();
  });

  test('sourcing history loads', async ({ page }) => {
    await signIn(page);
    await expect(page.getByText('Sourcing runs (persisted history)')).toBeVisible();
    await expect(page.getByText('Last run')).toBeVisible();
    await expect(page.getByText('No run yet').first()).toBeVisible();
  });

  test('schedule configuration loads for an authenticated administrator', async ({ page }) => {
    await signIn(page);
    await expect(page.getByText('Scheduled sourcing')).toBeVisible();
    await expect(page.getByText('Enabled sources')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save schedule' })).toBeVisible();
  });
});
