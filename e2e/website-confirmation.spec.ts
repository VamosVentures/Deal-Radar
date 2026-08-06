import { test, expect } from '@playwright/test';
import { E2E_BACKEND_PORT } from './env';

/**
 * The manual website-confirmation workflow, from the reviewer's side.
 *
 * The rule this is protecting is procedural rather than visual: a person
 * must be shown what the change replaces before it is written, and a
 * preview must never write. So these tests check the panel asks for both
 * URLs and a reason, that previewing renders the previous → proposed
 * diff, and that nothing has changed on the server afterwards.
 *
 * The confirm step itself is covered by the server tests
 * (server/tests/website-confirmation.test.ts), because confirming makes
 * real outbound requests to whatever domain is entered and an E2E run is
 * the wrong place to do that.
 */

async function openFixtureDetail(page: import('@playwright/test').Page) {
  await page.goto('/companies');
  await page.getByText('E2E Health Fixture Co').click();
  await expect(page.getByText(/VamosVentures Fit Score:/)).toBeVisible();
}

test.describe('Manual website confirmation', () => {
  test('the panel asks for a website, supporting evidence, and a reason', async ({ page }) => {
    await openFixtureDetail(page);

    await expect(page.getByTestId('confirm-website-open')).toBeVisible();
    await page.getByTestId('confirm-website-open').click();

    await expect(page.getByTestId('confirm-website-url')).toBeVisible();
    await expect(page.getByTestId('confirm-website-evidence')).toBeVisible();
    await expect(page.getByTestId('confirm-website-reason')).toBeVisible();

    // Preview stays unavailable until all three are supplied — the
    // evidence URL and the reason are not optional extras.
    await expect(page.getByTestId('confirm-website-preview-btn')).toBeDisabled();
    await page.getByTestId('confirm-website-url').fill('https://example.com');
    await expect(page.getByTestId('confirm-website-preview-btn')).toBeDisabled();
    await page.getByTestId('confirm-website-evidence').fill('https://example.org/announcement');
    await expect(page.getByTestId('confirm-website-preview-btn')).toBeDisabled();
    await page.getByTestId('confirm-website-reason').fill('The announcement names this domain as the company site.');
    await expect(page.getByTestId('confirm-website-preview-btn')).toBeEnabled();
  });

  test('previewing shows the previous and proposed values and writes nothing', async ({ page }) => {
    const before = await (await page.request.get(`http://localhost:${E2E_BACKEND_PORT}/api/companies/imported`)).json();
    const target = (before.companies as { id: string; name: string; website?: string }[])
      .find((c) => c.name === 'E2E Health Fixture Co')!;

    await openFixtureDetail(page);
    await page.getByTestId('confirm-website-open').click();
    await page.getByTestId('confirm-website-url').fill('https://example.com');
    await page.getByTestId('confirm-website-evidence').fill('https://example.org/announcement');
    await page.getByTestId('confirm-website-reason').fill('The announcement names this domain as the company site.');
    await page.getByTestId('confirm-website-preview-btn').click();

    const preview = page.getByTestId('confirm-website-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Previous → proposed');
    await expect(preview).toContainText('(none on record)');
    await expect(preview).toContainText('https://example.com');
    await expect(preview).toContainText('https://example.org/announcement');

    // Only now does a confirm button exist at all.
    await expect(page.getByTestId('confirm-website-confirm-btn')).toBeVisible();

    // And the preview must have been a pure read.
    const after = await (await page.request.get(`http://localhost:${E2E_BACKEND_PORT}/api/companies/imported`)).json();
    const same = (after.companies as { id: string; website?: string }[]).find((c) => c.id === target.id)!;
    expect(same.website ?? null).toEqual(target.website ?? null);
  });

  test('a page offered as evidence for itself is blocked before any confirm button appears', async ({ page }) => {
    await openFixtureDetail(page);
    await page.getByTestId('confirm-website-open').click();
    await page.getByTestId('confirm-website-url').fill('https://example.com');
    await page.getByTestId('confirm-website-evidence').fill('https://example.com');
    await page.getByTestId('confirm-website-reason').fill('Trying to use the site as its own evidence.');
    await page.getByTestId('confirm-website-preview-btn').click();

    await expect(page.getByTestId('confirm-website-blocker')).toContainText('cannot be the evidence for itself');
    await expect(page.getByTestId('confirm-website-confirm-btn')).toHaveCount(0);
  });
});
