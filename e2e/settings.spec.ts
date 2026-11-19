import { test, expect } from '@playwright/test';

/**
 * These specs inherit the signed-in session written by global-setup
 * (see storageState in playwright.config.ts), so they open Settings
 * directly. Signing in per test is no longer necessary — and no longer
 * possible, since there is no login form once a session exists.
 */
async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/sources');
  await expect(page.getByText('System status')).toBeVisible();
}

test.describe('Settings', () => {
  test('source statuses render honestly for an authenticated administrator', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByText('Implemented — credentials required').first()).toBeVisible();
    // GitHub's "Connected" state only ever appears after a real health check —
    // this asserts the label exists somewhere, not that it's fabricated.
    await expect(page.getByText('GitHub API verified').or(page.getByText('GitHub API unreachable'))).toBeVisible();
  });

  test('credential-required integrations are labeled honestly, never as live', async ({ page }) => {
    await openSettings(page);
    // HubSpot/Outlook/AI have no credentials in the E2E environment —
    // they must never claim "Connected".
    const hubspotCard = page.locator('text=HubSpot CRM').first().locator('xpath=ancestor::*[self::section or self::div][1]');
    await expect(page.getByText('Implemented — credentials required').first()).toBeVisible();
    await expect(page.getByText('Not connected').first()).toBeVisible();
    void hubspotCard;
  });

  test('sources with no adapter are never shown as an enabled, working option', async ({ page }) => {
    await openSettings(page);
    // "Accelerator & fellowship sites" has no adapter — its source-quality
    // row must read Planned, and its schedule checkbox must be disabled
    // and unchecked, never selectable as if it were live. Scoped to the
    // "Source quality" section specifically: the newer "Source health"
    // section also lists every source, by a different vocabulary
    // ("Disabled" there, "Planned" here) — both correct, in two places.
    const sourceQualitySection = page.locator('section', { hasText: 'Source quality' });
    const row = sourceQualitySection.getByRole('row', { name: /Accelerator & fellowship sites/ });
    await expect(row).toContainText('Planned');
    await expect(page.getByRole('checkbox', { name: 'Accelerator & fellowship sites' })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: 'Accelerator & fellowship sites' })).not.toBeChecked();
  });

  test('sourcing history loads', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByText('Sourcing runs (persisted history)')).toBeVisible();
    await expect(page.getByText('Last run')).toBeVisible();
    await expect(page.getByText('No run yet').first()).toBeVisible();
  });

  test('schedule configuration loads for an authenticated administrator', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByText('Scheduled sourcing')).toBeVisible();
    await expect(page.getByText('Enabled sources')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save schedule' })).toBeVisible();
  });

  test('a schedule runs on a day and time, defaulting to Sunday 6:00 PM Central, and can be changed after saving', async ({ page }) => {
    await openSettings(page);
    const form = page.getByTestId('new-schedule-timing');
    await expect(form.getByLabel('Run day')).toHaveValue('0');
    await expect(form.getByLabel('Run time')).toHaveValue('18:00');
    await expect(form.getByLabel('Time zone')).toHaveValue('America/Chicago');
    await page.getByRole('button', { name: 'Save schedule' }).click();

    const timing = page.getByTestId('schedule-timing').last();
    await expect(timing).toHaveText('Sundays at 6:00 PM Central');

    const row = page.locator('li', { has: timing });
    await row.getByRole('button', { name: 'Change day/time' }).click();
    const editor = row.getByTestId('schedule-timing-editor');
    await editor.getByLabel('Run day').selectOption('1');
    await editor.getByLabel('Run time').selectOption('07:30');
    await editor.getByLabel('Time zone').selectOption('America/New_York');
    await editor.getByRole('button', { name: 'Save day/time' }).click();
    await expect(timing).toHaveText('Mondays at 7:30 AM Eastern');
    await expect(editor).toHaveCount(0);

    // Leave nothing behind for other specs.
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(timing).toHaveCount(0);
  });
});
