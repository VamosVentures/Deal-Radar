import { test, expect } from '@playwright/test';
import { bulkSetStatus } from './bulk-status';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  smallLaptop: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

test.describe('Responsive layout', () => {
  for (const [name, size] of Object.entries(VIEWPORTS)) {
    test(`navigation is usable at ${name} width`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/companies');
      await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'All Deals' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Discovery' })).toBeVisible();
      await page.getByRole('link', { name: 'Discovery' }).click();
      await expect(page.getByRole('heading', { name: 'Deal Discovery' })).toBeVisible();
    });

    test(`a company review action works at ${name} width`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/companies');

      // The select-then-bulk-action bar is now the ONLY route to a
      // review status, so it has to stay usable at every width — the
      // row checkbox is the first column and the action bar wraps.
      // At 390px this is the assertion that would catch either one
      // becoming unreachable.
      await bulkSetStatus(page, 'E2E Health Fixture Co', 'Monitor');

      await page.getByText('E2E Health Fixture Co').click();
      await expect(page.getByText(/VamosVentures Fit Score:/)).toBeVisible();
    });
  }
});
