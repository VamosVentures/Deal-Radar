import { defineConfig, devices } from '@playwright/test';

/**
 * Dedicated Playwright config for the documentation screenshot package
 * (docs/sourcing-workflow/screenshots/). Separate from playwright.config.ts
 * on purpose: this suite drives the STATIC demo build (`npm run
 * build:demo` + `npm run preview:demo`) — no backend, no database, no
 * real credentials anywhere in the process. It captures images; it does
 * not assert application behavior (that is what e2e/ is for).
 */
export default defineConfig({
  testDir: './e2e-demo',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'npm run preview:demo',
    port: 4173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
