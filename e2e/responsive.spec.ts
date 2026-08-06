import { test, expect } from '@playwright/test';

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
      await page.getByText('E2E Health Fixture Co').click();
      await expect(page.getByText(/VamosVentures Fit Score:/)).toBeVisible();
      await page.getByRole('button', { name: 'Monitor' }).click();
      await expect(page.getByText('Monitor', { exact: true }).first()).toBeVisible();
    });
  }
});
