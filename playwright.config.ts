import { defineConfig, devices } from '@playwright/test';
import { E2E_BACKEND_ENV, E2E_BACKEND_PORT, E2E_FRONTEND_PORT, E2E_STORAGE_STATE } from './e2e/env';

/**
 * Smallest reasonable Playwright config. Both the backend and the
 * frontend are started fresh for every E2E run (`reuseExistingServer:
 * false`, always) against an isolated SQLite file and test-only
 * credentials — this must never be able to reuse (or write to) a
 * developer's real dev server or real database.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // shared isolated backend/db — specs run one at a time to stay deterministic
  workers: 1, // all specs share one seeded database; concurrent workers would race on company state
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${E2E_FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    // Every spec starts signed in, because the whole application is
    // gated. auth.spec.ts opts out to test the gate itself.
    storageState: E2E_STORAGE_STATE,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'npx tsx server/index.ts',
      port: E2E_BACKEND_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      env: E2E_BACKEND_ENV,
    },
    {
      command: `npx vite --port ${E2E_FRONTEND_PORT} --strictPort`,
      port: E2E_FRONTEND_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { VITE_API_PROXY_TARGET: `http://localhost:${E2E_BACKEND_PORT}` },
    },
  ],
});
