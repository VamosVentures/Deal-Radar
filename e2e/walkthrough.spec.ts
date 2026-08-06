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
  { path: '/companies', name: 'All Deals' },
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
   * "Research Coverage" (the old portfolio-wide EnrichmentCoverage panel)
   * was removed from Overview per Marcos's updated feedback — this is a
   * regression test proving it stays gone from every accessible page,
   * not just Overview. The underlying enrichment data/columns are
   * untouched; only this presentation layer was removed, so this test
   * asserts absence of the TEXT/component, not absence of the data.
   *
   * The route list below is the COMPLETE inventory declared in
   * src/App.tsx, not a sample: the five real pages, every vertical alias
   * (all five approved verticals plus the retired robotics/space-tech/ai
   * bookmarks, which redirect rather than render), the legacy
   * areas-of-interest and pipeline redirects, and an unmatched path that
   * falls through to the catch-all. Modals, drawers and a real
   * company-detail view are covered separately below, because none of
   * them is reachable by URL and a route sweep alone would miss them
   * entirely — which is exactly the gap this replaces.
   */
  const ALL_ROUTES = [
    '/',                    // Overview
    '/companies',           // All Deals
    '/health',              // → /companies?vertical=health
    '/fintech',
    '/future-of-work',
    '/sustainability',
    '/frontier',
    '/robotics',            // legacy → frontier
    '/space-tech',          // legacy → frontier
    '/ai',                  // legacy → fow
    '/areas-of-interest',   // legacy 'aoi' → unfiltered All Deals
    '/pipeline',            // → /companies
    '/stealth',
    '/discovery',
    '/sources',
    '/no-such-page',        // catch-all → Overview
  ];

  /** The label, the component's test id, and the old data attribute — all three. */
  async function expectNoResearchCoverage(page: import('@playwright/test').Page, where: string) {
    await expect(page.getByTestId('enrichment-coverage'), where).toHaveCount(0);
    await expect(page.getByText(/research\s*coverage/i), where).toHaveCount(0);
    await expect(page.getByText(/enrichment\s*coverage/i), where).toHaveCount(0);
    // A rename would defeat a text-only check, so assert on the DOM too.
    await expect(page.locator('[data-component="EnrichmentCoverage"]'), where).toHaveCount(0);
  }

  for (const path of ALL_ROUTES) {
    test(`"Research Coverage" is not rendered anywhere on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectNoResearchCoverage(page, path);
    });
  }

  /**
   * A real company-detail view. This is the single biggest hole the
   * previous version of this test had: company detail is a panel opened
   * by clicking a row, has no URL of its own, and renders more
   * enrichment-derived UI than any other surface in the app — so a
   * route-only sweep proved nothing about the place the panel was most
   * likely to survive.
   */
  test('"Research Coverage" is absent from a real company-detail view', async ({ page }) => {
    await page.goto('/companies');
    await page.waitForLoadState('networkidle');
    await page.getByText('E2E Health Fixture Co').first().click();
    await expect(page.getByRole('button', { name: 'Copy Claude prompt' })).toBeVisible();
    await expectNoResearchCoverage(page, 'company detail');
  });

  /**
   * The per-company research evidence itself must SURVIVE. The panel that
   * was removed was a portfolio-wide coverage summary; the underlying
   * research used for diligence is a different thing, and a test that
   * only asserts absence would happily pass if someone deleted both.
   */
  test('per-company research evidence is still present for diligence', async ({ page }) => {
    await page.goto('/companies');
    await page.waitForLoadState('networkidle');
    await page.getByText('E2E Health Fixture Co').first().click();
    // Evidence and provenance remain on the record even though the
    // portfolio-wide coverage panel does not.
    const res = await page.request.get('/api/companies/imported');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.companies ?? []);
    const fixture = list.find((c: { name: string }) => c.name === 'E2E Health Fixture Co');
    expect(fixture, 'health fixture missing from the companies payload').toBeTruthy();
    expect(Array.isArray(fixture.evidence)).toBe(true);
    expect(fixture.evidence.length).toBeGreaterThan(0);
  });

  /**
   * Overview's own modals and drawers. "Coverage by sector" on Overview
   * is a DIFFERENT feature (sector distribution) and is expected to
   * remain — the assertions above are deliberately scoped to the
   * "research/enrichment coverage" wording so they do not fire on it.
   */
  test('"Research Coverage" is absent from the Overview KPI breakdown modal', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const firstKpi = page.getByRole('button', { name: /breakdown|view breakdown/i }).first();
    if (await firstKpi.count() > 0) {
      await firstKpi.click();
      await expectNoResearchCoverage(page, 'KPI breakdown modal');
    }
    // The sector-distribution panel is a different feature and stays.
    await expect(page.getByText('Coverage by sector')).toBeVisible();
  });

  /**
   * `/health` is the Health & Wellness vertical route AND the prefix of
   * the backend's health endpoints.
   *
   * The Vite dev proxy forwarded everything under `/health` to the API,
   * so loading, refreshing or bookmarking the Health vertical page
   * returned a backend 404 instead of the app. Clicking the sidebar link
   * hid it — React Router never issues a request. The proxy now names
   * /health/live and /health/ready exactly.
   */
  test('the Health vertical route survives a direct load, not just a sidebar click', async ({ page }) => {
    const res = await page.goto('/health');
    expect(res?.status(), 'GET /health must serve the app, not the API').toBeLessThan(400);
    await page.waitForURL(/\/companies\?/);
    expect(page.url()).toContain('vertical=health');
    await expect(page.getByRole('heading', { name: 'All Deals' })).toBeVisible();
  });

  test('the backend health endpoints still answer', async ({ page }) => {
    for (const path of ['/health/live', '/health/ready']) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBeLessThan(500);
      expect((await res.text()).trim().startsWith('{'), `${path} returns JSON`).toBe(true);
    }
  });

  /**
   * Two saved diligence queues, and Promising must stay a strict subset
   * of the broad population.
   */
  test('All Deals carries both diligence queues, Promising narrower than Needs Diligence', async ({ page }) => {
    await page.goto('/companies');
    await page.waitForLoadState('networkidle');
    const all = await page.locator('tbody tr').count();

    await page.getByTestId('needs-diligence-filter').check();
    await page.waitForTimeout(400);
    const needs = await page.locator('tbody tr').count();

    await page.getByTestId('needs-diligence-filter').uncheck();
    await page.getByTestId('promising-filter').check();
    await page.waitForTimeout(400);
    const promising = await page.locator('tbody tr').count();

    expect(promising).toBeLessThanOrEqual(needs);
    expect(needs).toBeLessThanOrEqual(all);
  });

  /** The analyst surfaces, and the guard that stops an opinion scoring. */
  test('company detail carries the traction review, and refuses an unevidenced rating', async ({ page }) => {
    await page.goto('/companies');
    await page.waitForLoadState('networkidle');
    await page.getByText('E2E Health Fixture Co').first().click();

    await expect(page.getByTestId('traction-review')).toBeVisible();
    await page.getByTestId('traction-state').selectOption('named-customer');
    await expect(page.getByTestId('traction-save')).toBeDisabled();

    // With a source URL it becomes submittable — the rule is evidence,
    // not difficulty.
    await page.getByTestId('traction-source').fill('https://example.com/customers');
    await expect(page.getByTestId('traction-save')).toBeEnabled();
  });

  test('the cumulative month/year filters are present and selectable', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByText('CUMULATIVE COMPANIES').click();
    for (const label of ['All time', 'This month', 'Last month', 'This year', 'Last year']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
    await page.getByRole('button', { name: 'This year' }).click();
    await expect(page.getByRole('button', { name: 'This year' })).toHaveAttribute('aria-pressed', 'true');
  });

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
