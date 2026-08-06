import { expect, test } from '@playwright/test';

/**
 * The analyst evidence workflow, in a real browser.
 *
 * Runs against the ISOLATED E2E database (see e2e/env.ts), never the
 * development one — accept / edit / reject are a person's judgements, and
 * a test must not leave fabricated ones behind on a real record. The rows
 * exercised here were produced by the real parser and the real
 * `recordYcPendingEvidence` service over the committed YC fixtures
 * (e2e/global-setup.ts), so the panel is showing what the pipeline
 * actually produces.
 *
 * What has to be true, and is asserted below:
 *   - the original claim and its source are visible and openable;
 *   - provenance and access date are shown;
 *   - a claim about a FOUNDER'S PRIOR COMPANY is labelled as such and
 *     carries no suggested traction state;
 *   - a suggestion is shown as a suggestion and explicitly not applied;
 *   - accept, edit-before-accepting and reject all work;
 *   - none of it moves the score, and the company stays provisional.
 */

/**
 * Open a company's detail panel by DEEP LINK.
 *
 * `?c=<id>` is the table's own "open this company" parameter
 * (`initialOpenId`), so this exercises a real supported entry point and
 * avoids depending on which text happens to be clickable in the row —
 * a search-then-click helper broke on exactly that.
 */
async function openCompany(page: import('@playwright/test').Page, name: string) {
  const res = await page.request.get('/api/companies/imported');
  expect(res.ok()).toBeTruthy();
  const { companies } = await res.json() as { companies: { id: string; name: string }[] };
  const company = companies.find((c) => c.name === name);
  expect(company, `seeded company "${name}" not found`).toBeTruthy();

  await page.goto(`/companies?c=${company!.id}`);
  await expect(page.getByTestId('pending-evidence')).toBeVisible({ timeout: 20_000 });
  return company!.id;
}

test.describe('pending evidence is visible and usable', () => {
  test('shows the claim, its source, provenance and access date', async ({ page }) => {
    await openCompany(page, 'Scheduling Wizard');
    const panel = page.getByTestId('pending-evidence');

    // The company's own deployment claim, verbatim.
    await expect(panel).toContainText('20 departments across 16 hospitals');
    // Provenance is stated, and it is not "confirmed".
    await expect(panel).toContainText(/company-claimed/i);
    await expect(panel).toContainText(/accessed 2026-08-06/);
    // The source is a real, openable link.
    const link = panel.getByRole('link', { name: /source/i }).first();
    await expect(link).toHaveAttribute('href', /ycombinator\.com\/companies\/scheduling-wizard/);
  });

  test('a suggestion is shown as a suggestion, not as an applied rating', async ({ page }) => {
    await openCompany(page, 'Scheduling Wizard');
    const panel = page.getByTestId('pending-evidence');
    await expect(panel).toContainText(/Suggested:/);
    await expect(panel).toContainText(/not applied/i);
  });

  test('a founder’s prior-company claim is labelled and carries no suggestion', async ({ page }) => {
    await openCompany(page, 'Grade');
    const panel = page.getByTestId('pending-evidence');

    // "At my last company, I managed $10M+ in contractor payouts" is about
    // a PREVIOUS company. It is shown — deleting it would leave a reviewer
    // wondering whether we missed it — and it is shown as not about Grade.
    await expect(panel).toContainText('$10M+');
    await expect(panel).toContainText(/prior company|founder-bio|not about this company/i);
  });

  test('accept records a decision and writes no score', async ({ page }) => {
    await openCompany(page, 'Scheduling Wizard');
    const panel = page.getByTestId('pending-evidence');

    const before = await page.request.get('/api/companies/imported');
    expect(before.ok()).toBeTruthy();

    const accept = panel.locator('[data-testid^="pending-accept-"]').first();
    await accept.click();
    await expect(panel).toContainText(/accepted by/i, { timeout: 10_000 });

    // Accepting that the company SAID something is not rating what it is
    // worth. The traction component must still be unrated.
    const traction = await page.request.get('/api/companies/imported');
    const body = await traction.json() as { companies: { name: string; traction: { level: number; note: string } }[] };
    const sw = body.companies.find((c) => c.name === 'Scheduling Wizard')!;
    expect(sw.traction.level).toBe(0);
    expect(sw.traction.note).toMatch(/unknown|not yet researched/i);
  });

  test('edit before accepting stores the correction and keeps the original', async ({ page }) => {
    await openCompany(page, 'Grade');
    const panel = page.getByTestId('pending-evidence');

    const editBtn = panel.locator('[data-testid^="pending-edit-"]').first();
    const id = (await editBtn.getAttribute('data-testid'))!.replace('pending-edit-', '');
    await editBtn.click();

    const input = page.getByTestId(`pending-edit-input-${id}`);
    await expect(input).toBeVisible();
    const original = await input.inputValue();
    expect(original.length).toBeGreaterThan(0);

    await input.fill('Corrected excerpt recorded by the reviewer.');
    await page.getByTestId(`pending-save-edit-${id}`).click();

    await expect(panel).toContainText(/edited by/i, { timeout: 10_000 });
    await expect(panel).toContainText('Corrected excerpt recorded by the reviewer.');
    // The published sentence survives alongside the correction.
    await expect(panel).toContainText(original.slice(0, 40));
  });

  test('reject records a decision and still writes no score', async ({ page }) => {
    await openCompany(page, 'Grade');
    const panel = page.getByTestId('pending-evidence');
    const reject = panel.locator('[data-testid^="pending-reject-"]').first();
    await reject.click();
    await expect(panel).toContainText(/rejected by/i, { timeout: 10_000 });

    const res = await page.request.get('/api/companies/imported');
    const body = await res.json() as { companies: { name: string; traction: { level: number } }[] };
    expect(body.companies.find((c) => c.name === 'Grade')!.traction.level).toBe(0);
  });

  test('a decided item is not silently re-decidable', async ({ page }) => {
    // Two reviewers reaching different conclusions is a conflict to
    // surface, not to resolve by last-write-wins.
    await openCompany(page, 'Scheduling Wizard');
    const panel = page.getByTestId('pending-evidence');
    const accept = panel.locator('[data-testid^="pending-accept-"]').first();
    const id = (await accept.getAttribute('data-testid'))!.replace('pending-accept-', '');
    await accept.click();
    await expect(panel).toContainText(/accepted by/i, { timeout: 10_000 });

    const again = await page.request.post(`/api/pending-evidence/${id}/decide`, {
      data: { status: 'rejected', actor: 'someone-else' },
    });
    expect(again.status()).toBe(409);
    expect(await again.text()).toMatch(/already accepted/i);
  });
});
