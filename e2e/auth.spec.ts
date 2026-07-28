import { test, expect } from '@playwright/test';
import { E2E_ADMIN_PASSWORD, E2E_BACKEND_PORT } from './env';

// This file tests the gate itself, so it must start SIGNED OUT — it
// opts out of the shared signed-in session every other spec inherits.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Authentication', () => {
  test('the WHOLE application is gated when unauthenticated, not just Settings', async ({ page }) => {
    // Every route must land on the sign-in screen. Overview and
    // Companies are the important ones: they used to render every
    // persisted company to an anonymous visitor.
    for (const route of ['/', '/companies', '/discovery', '/stealth', '/sources']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByLabel('Password')).toBeVisible();
      // No application content leaks behind the gate.
      await expect(page.getByText('System status')).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'Companies' })).not.toBeVisible();
    }
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
