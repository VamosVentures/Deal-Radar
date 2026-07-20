import { test, expect } from '@playwright/test';
import { E2E_ADMIN_PASSWORD, E2E_BACKEND_PORT } from './env';

test.describe('Authentication', () => {
  test('Settings shows the administrator login gate when unauthenticated', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByText('Administrator sign-in required')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    // The gated admin panels must not render before sign-in.
    await expect(page.getByText('System status')).not.toBeVisible();
  });

  test('an incorrect password is rejected', async ({ page }) => {
    await page.goto('/sources');
    await page.getByLabel('Password').fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Incorrect password.')).toBeVisible();
    await expect(page.getByText('System status')).not.toBeVisible();
  });

  test('the correct password unlocks Settings', async ({ page }) => {
    await page.goto('/sources');
    await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('System status')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('logout re-locks Settings', async ({ page }) => {
    await page.goto('/sources');
    await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByText('Administrator sign-in required')).toBeVisible();
    await expect(page.getByText('System status')).not.toBeVisible();
  });

  test('protected administrative API routes reject an unauthenticated request', async ({ request }) => {
    const base = `http://localhost:${E2E_BACKEND_PORT}`;
    const status = await request.get(`${base}/api/admin/status`);
    expect(status.status()).toBe(401);

    const schedule = await request.get(`${base}/api/schedule`);
    expect(schedule.status()).toBe(401);

    const backups = await request.get(`${base}/api/admin/backups`);
    expect(backups.status()).toBe(401);
  });
});
