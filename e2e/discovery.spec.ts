import { test, expect } from '@playwright/test';

/**
 * Real external sourcing calls (GitHub, SEC, YC, ...) must never run
 * during automated browser tests — this file intercepts every
 * discovery-related network call at the page level and fulfills it
 * with a deterministic, clearly-fictional fixture response. The
 * isolated E2E backend never talks to a real third-party API here.
 */

const MOCK_CANDIDATE = {
  id: 'e2e-mock-candidate-1',
  runId: 'e2e-mock-run-1',
  discoveredAt: new Date().toISOString(),
  sourceId: 'github',
  simulated: false,
  externalId: null,
  companyName: 'E2E Mock Discovery Co',
  website: 'https://example.com/e2e-mock',
  pitch: 'E2E fixture pitch — intercepted, never a real GitHub call.',
  vertical: 'health',
  subcategory: 'Care',
  stage: 'Seed',
  hqCity: 'Austin',
  hqState: 'TX',
  foundingYear: 2025,
  founderNames: ['E2E Fixture Founder'],
  founderCount: 1,
  accelerator: 'Unknown',
  publicFunding: 'Unknown',
  mostRecentRound: 'Unknown',
  fundingDate: null,
  tractionSignals: [],
  evidence: [{
    claim: 'E2E fixture evidence claim', source: 'E2E Fixture', url: 'https://example.com/e2e-mock-evidence',
    dateAccessed: new Date().toISOString().slice(0, 10), verificationStatus: 'Not verified', confidence: 0.5, notes: 'Intercepted — no real network call was made.',
  }],
  confidence: 0.5,
  verificationStatus: 'Not verified',
  duplicateStatus: 'none',
  duplicateOfId: null,
  duplicateOfName: null,
  policyExceptionFlags: [],
  suggestedNextStep: 'Requires manual review',
  status: 'pending',
};

const MOCK_RUN = {
  id: 'e2e-mock-run-1',
  at: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  runType: 'manual',
  mode: 'live',
  query: { sources: ['github'], maxResults: 25, maxApiCalls: 10 },
  sourceResults: [{ sourceId: 'github', mode: 'live', found: 1, detail: 'E2E fixture: 1 mock candidate.' }],
  discovered: 1,
  updatedExisting: 0,
  duplicatesSkipped: 0,
  duplicatesIdentified: 0,
  filteredByPolicy: 0,
  rejectedByValidation: 0,
  imported: 0,
  errors: [],
  apiCalls: 1,
  modelCalls: 0,
  estimatedTokens: 0,
  estimatedCostUsd: 0,
  durationMs: 42,
  status: 'Completed',
  initiatedBy: 'e2e-test',
};

test.describe('Deal Discovery', () => {
  test('loads successfully', async ({ page }) => {
    await page.goto('/discovery');
    await expect(page.getByRole('heading', { name: 'Deal Discovery' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run discovery' })).toBeVisible();
  });

  test('empty results display an honest state', async ({ page }) => {
    await page.route('**/api/discovery/candidates**', (route) => route.fulfill({ json: { candidates: [] } }));
    await page.goto('/discovery');
    await expect(page.getByText('No pending candidates. Run a discovery search above')).toBeVisible();
  });

  test('a search can be submitted, results reviewed/selected, and imported — no real network call is made', async ({ page }) => {
    let runCalled = false;
    await page.route('**/api/discovery/run', (route) => {
      runCalled = true;
      route.fulfill({ json: MOCK_RUN });
    });
    await page.route('**/api/discovery/candidates**', (route) => route.fulfill({ json: { candidates: [MOCK_CANDIDATE] } }));
    await page.route('**/api/discovery/import', (route) => route.fulfill({
      json: { imported: [MOCK_CANDIDATE.id], merged: [], skipped: [] },
    }));

    await page.goto('/discovery');
    await page.getByRole('button', { name: 'Run discovery' }).click();
    expect(runCalled).toBe(true);

    await expect(page.getByText('E2E Mock Discovery Co')).toBeVisible();

    await page.getByRole('row', { name: /E2E Mock Discovery Co/ }).getByRole('checkbox').check();
    await page.getByRole('button', { name: /selected → Awaiting Review/ }).click();

    await expect(page.getByText(/1 imported into Awaiting Review/)).toBeVisible();
  });
});
