import { test, expect, type ConsoleMessage } from '@playwright/test';

/**
 * A fresh-browser walkthrough of every page, asserting that none of them
 * logs an unexplained console error or fails a network request.
 *
 * This exists because the rest of the suite asserts on what IS on screen,
 * and a React page can render its content perfectly while throwing in an
 * effect, requesting a route that 404s, or warning about a key it will
 * silently mis-reconcile later. None of that fails an assertion about
 * visible text, and all of it is the kind of thing that turns into a
 * support question a week later.
 *
 * Each page gets a fresh context, so nothing carries over between them.
 */

const PAGES = [
  { path: '/', name: 'Overview' },
  { path: '/companies', name: 'Companies' },
  { path: '/discovery', name: 'Discovery' },
  { path: '/stealth', name: 'Stealth Founder Radar' },
  { path: '/sources', name: 'Data sources' },
];

/**
 * Console noise that is expected and explained, so a genuine error still
 * stands out. Kept deliberately short — every entry here is a decision to
 * stop looking at something, and a long list makes the check worthless.
 */
const EXPECTED = [
  // React Router emits future-flag notices in v7 dev builds.
  /React Router Future Flag/i,
  // Vite's dev client logs its own connection lifecycle.
  /\[vite\]/i,
  // Downloading the React DevTools is a suggestion, not a fault.
  /Download the React DevTools/i,
];

function isUnexplained(msg: ConsoleMessage): boolean {
  if (msg.type() !== 'error') return false;
  return !EXPECTED.some((p) => p.test(msg.text()));
}

test.describe('Fresh-browser walkthrough', () => {
  for (const { path, name } of PAGES) {
    test(`${name} loads with no unexplained console errors`, async ({ page }) => {
      const errors: string[] = [];
      const failedRequests: string[] = [];
      const pageErrors: string[] = [];

      page.on('console', (msg) => { if (isUnexplained(msg)) errors.push(msg.text()); });
      // An uncaught exception never reaches the console listener above.
      page.on('pageerror', (err) => pageErrors.push(err.message));
      page.on('requestfailed', (req) => {
        failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'failed'}`);
      });
      page.on('response', (res) => {
        if (res.status() >= 500) failedRequests.push(`${res.status()} ${res.url()}`);
      });

      await page.goto(path);
      // Let deferred data loads and lazy route chunks settle before judging.
      await page.waitForLoadState('networkidle');

      expect(pageErrors, `Uncaught exceptions on ${path}`).toEqual([]);
      expect(errors, `Console errors on ${path}`).toEqual([]);
      expect(failedRequests, `Failed or 5xx requests on ${path}`).toEqual([]);
    });
  }

  /**
   * The enrichment payload is the largest addition to the companies
   * request. A page that renders while its data request quietly 500s
   * would pass every other test in this file.
   */
  test('the companies payload returns enrichment without error', async ({ page }) => {
    await page.goto('/companies');
    const res = await page.request.get('/api/companies/imported');
    expect(res.status()).toBe(200);
    const body = await res.json() as { enrichment?: Record<string, unknown> };
    expect(body.enrichment, 'enrichment map is present in the bulk payload').toBeTruthy();
  });

  test('the radar endpoint returns entries and counts without error', async ({ page }) => {
    await page.goto('/stealth');
    const res = await page.request.get('/api/stealth/radar?filter=all');
    expect(res.status()).toBe(200);
    const body = await res.json() as { entries: unknown[]; counts: Record<string, number> };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.counts).toBeTruthy();
  });

  /**
   * The literal strings this whole change set exists to remove, checked
   * across every page rather than on one company's detail panel.
   */
  test('no page renders the canned placeholder or a literal "Unknown" founder', async ({ page }) => {
    for (const { path } of PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const text = await page.locator('body').innerText();
      expect(text, `${path} still shows the canned identity placeholder`)
        .not.toMatch(/Identity not on record/i);
      expect(text, `${path} still shows an Unknown founder`).not.toMatch(/Unknown founder/i);
    }
  });
});
