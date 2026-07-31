import { test, expect, type Page } from '@playwright/test';

/**
 * Founder / sector / stage enrichment and the Stealth Founder Radar,
 * from the reviewer's side of the screen.
 *
 * The server suite (server/tests/enrichment.test.ts) already proves the
 * matching rules, the conflict logic, the stage policy, provenance, and
 * idempotency. What can only be checked here is what a person actually
 * sees, and specifically the two ways this feature could quietly go
 * wrong in the browser:
 *
 *   - An unconfirmed candidate rendering as though it were a verified
 *     founder, because a template iterated the wrong list.
 *   - A conflict being flattened to one confident-looking name.
 *
 * Both would put a wrong person in front of a reviewer with no visible
 * sign that anything was uncertain, which is worse than the blank field
 * this whole feature replaced.
 */

const HEALTH = 'E2E Health Fixture Co';
const FINTECH = 'E2E FinTech Fixture Co';

async function openCompany(page: Page, name: string): Promise<void> {
  await page.goto('/companies');
  await page.getByText(name).first().click();
}

test.describe('Company detail — enrichment', () => {
  test('a verified founder is shown with the name, title, and its source', async ({ page }) => {
    await openCompany(page, HEALTH);
    await expect(page.getByText('E2E Verified Founder').first()).toBeVisible();
    await expect(page.getByText('Co-Founder & CEO').first()).toBeVisible();
  });

  test('the canned "identity not on record" placeholder is gone from the page', async ({ page }) => {
    await openCompany(page, HEALTH);
    // The exact string this whole change set exists to remove. It used to
    // render on every company row, telling a reviewer nothing.
    await expect(page.getByText(/Identity not on record/i)).toHaveCount(0);
    await expect(page.getByText(/Unknown founder/i)).toHaveCount(0);
  });

  test('an inferred stage is visibly labelled as inferred, not shown as a fact', async ({ page }) => {
    await openCompany(page, FINTECH);
    await expect(page.getByText('Early-stage — round not publicly disclosed').first()).toBeVisible();
    await expect(page.getByText(/inferred/i).first()).toBeVisible();
  });

  test('the stage explanation says why a Form D did not become a named round', async ({ page }) => {
    await openCompany(page, FINTECH);
    await expect(page.getByText(/never names a venture round/i).first()).toBeVisible();
  });

  test('the sector shows its subvertical and the reason behind it', async ({ page }) => {
    await openCompany(page, HEALTH);
    await expect(page.getByText('virtual care delivery').first()).toBeVisible();
    await expect(page.getByText(/sold to health systems/i).first()).toBeVisible();
  });

  test('the research record lists which source families were attempted', async ({ page }) => {
    await openCompany(page, HEALTH);
    await page.getByText(/Research record \(/).first().click();
    await expect(page.getByText('company-site').first()).toBeVisible();
    // A family with no URL on record is reported as exactly that, rather
    // than as an absence of founders.
    await expect(page.getByText('no-source-url-known').first()).toBeVisible();
  });

  test('a reviewer can correct the sector, and the automated value is preserved', async ({ page }) => {
    await openCompany(page, FINTECH);
    await page.getByTestId('correct-vertical').click();
    await page.getByTestId('correction-value').selectOption('fow');
    await page.getByTestId('correction-reason').fill('E2E correction — reclassified after a call.');
    await page.getByTestId('correction-save').click();

    // The correction becomes the displayed value, attributed to the
    // signed-in reviewer. Asserted on the attribution sentence rather
    // than on the sector label alone — "Future of Work" also appears as
    // a hidden <option> inside the correction form's own <select>.
    await expect(page.getByText(/corrected by Local administrator/i).first())
      .toBeVisible({ timeout: 15_000 });
    // …and the automated classification is still on the record.
    await expect(page.getByText(/Reviewer corrections \(/).first()).toBeVisible();
    await expect(page.getByText(/Automated classification was/i).first()).toBeVisible();
  });

  test('a correction cannot be saved without a stated reason', async ({ page }) => {
    await openCompany(page, HEALTH);
    await page.getByTestId('correct-stage').click();
    await page.getByTestId('correction-value').selectOption('Series A');
    // Reason left empty — the audit trail is the point of the field.
    await expect(page.getByTestId('correction-save')).toBeDisabled();
  });
});

test.describe('Stealth Founder Radar', () => {
  test('the page loads and offers every research-state filter', async ({ page }) => {
    await page.goto('/stealth');
    await expect(page.getByTestId('stealth-radar')).toBeVisible();
    for (const f of ['all', 'verified', 'probable', 'conflicting', 'research-exhausted', 'manual-review']) {
      await expect(page.getByTestId(`radar-filter-${f}`)).toBeVisible();
    }
  });

  test('a company with conflicting founder evidence is listed as a conflict', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await expect(entry.getByText(/Sources disagree/i)).toBeVisible();
  });

  /**
   * The load-bearing rendering rule. Both candidates must be visible,
   * neither may carry the "Verified" chip, and the section must be
   * labelled as unconfirmed — picking one and showing it confidently is
   * how a wrong person reaches an outreach email.
   */
  test('both conflicting people are shown, and neither is presented as verified', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    // Both people stay visible regardless of any review decision another
    // test may have recorded — a rejected candidate is marked, not hidden,
    // so the reasoning survives.
    await expect(entry.getByTestId('radar-person').filter({ hasText: 'E2E Candidate One' })).toBeVisible();
    await expect(entry.getByTestId('radar-person').filter({ hasText: 'E2E Candidate Two' })).toBeVisible();
    await expect(entry.getByText(/Candidates — unconfirmed/)).toBeVisible();
    await expect(entry.getByText('Verified founders')).toHaveCount(0);
  });

  test('every match shows the evidence tying the person to the company', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry.getByText(/statement appears on the company/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(entry.getByText(/match score/).first()).toBeVisible();
  });

  test('research progress, last-checked, and the next action are all displayed', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry.getByText(/sources answered/).first()).toBeVisible({ timeout: 15_000 });
    await expect(entry.getByText(/checked \d{4}-\d{2}-\d{2}/).first()).toBeVisible();
    await expect(entry.getByText(/Next/).first()).toBeVisible();
  });

  test('a verified company is not listed on the radar at all', async ({ page }) => {
    await page.goto('/stealth');
    await expect(page.getByTestId('radar-entry').filter({ hasText: FINTECH })).toBeVisible({ timeout: 15_000 });
    // The health fixture has a verified founder, so it is not a
    // low-profile record and must not appear.
    await expect(page.getByTestId('radar-entry').filter({ hasText: HEALTH })).toHaveCount(0);
  });

  test('the sources-attempted record is reachable from a radar row', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await entry.getByText(/Research record, relationships/).click();
    await expect(entry.getByText('Accelerator / incubator profile').first()).toBeVisible();
  });

  test('a reviewer can reject a candidate, and the decision is attributed', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry).toBeVisible({ timeout: 15_000 });

    // Target ONE named person so this test does not depend on, or
    // disturb, whichever candidates other tests looked at.
    const person = entry.getByTestId('radar-person').filter({ hasText: 'E2E Candidate Two' });
    const open = person.getByTestId('candidate-review-open');
    if (await open.count() === 0) {
      // Already reviewed by an earlier run against this shared database —
      // the assertion below still holds, which is the point.
      await expect(person.getByText(/rejected by|confirmed by/i)).toBeVisible();
      return;
    }
    await open.click();
    await person.getByTestId('candidate-review-reason').fill('E2E rejection — wrong company.');
    await person.getByTestId('candidate-reject').click();

    // The decision is recorded, attributed, and the person stays visible
    // with their automated evidence intact.
    await expect(entry.getByText(/rejected by/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(entry.getByTestId('radar-person').filter({ hasText: 'E2E Candidate Two' })).toBeVisible();
  });

  test('a rejection reason is required before the decision can be submitted', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    const person = entry.getByTestId('radar-person').filter({ hasText: 'E2E Candidate One' });
    const toggle = person.getByTestId('candidate-review-open');
    if (await toggle.count() > 0) {
      await toggle.click();
      await expect(person.getByTestId('candidate-confirm')).toBeDisabled();
    }
  });

  /**
   * A radar row is a company, so it carries a company's actions. Before
   * this, a reviewer who wanted to act on a stealth record had to leave
   * the page and find the same company by name in the deal queue.
   */
  test('a radar row offers the same actions as a normal deal', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await expect(entry.getByTestId('radar-hubspot')).toBeVisible();
    await expect(entry.getByTestId('radar-notes')).toBeVisible();
    await expect(entry.getByTestId('radar-status')).toBeVisible();
    await expect(entry.getByRole('link', { name: /Open full record/ })).toBeVisible();
  });

  /**
   * The load-bearing guard on the new actions. Drafting to an
   * unconfirmed candidate is precisely the mistake this radar exists to
   * prevent, so the control is disabled — and disabled rather than
   * hidden, so it can explain what to do instead.
   */
  test('outreach is blocked until a founder is verified', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    // The fintech fixture has conflicting evidence and no verified founder.
    await expect(entry.getByTestId('radar-outreach')).toBeDisabled();
    await expect(entry.getByTestId('radar-outreach')).toHaveAttribute('title', /No verified founder/i);
  });

  test('a radar row shows the fit score and sector inline', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry.getByText(/Fit/).first()).toBeVisible({ timeout: 15_000 });
    await expect(entry.getByText('FinTech').first()).toBeVisible();
  });

  test('notes open inline on a radar row', async ({ page }) => {
    await page.goto('/stealth');
    const entry = page.getByTestId('radar-entry').filter({ hasText: FINTECH });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.getByTestId('radar-notes').click();
    await expect(entry.getByTestId('company-notes')).toBeVisible();
  });
});
