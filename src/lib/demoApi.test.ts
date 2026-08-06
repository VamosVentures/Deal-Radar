import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoApi } from './demoApi';
import { ApiError } from './apiError';
import { DEMO_MODE, DEMO_BANNER_TEXT } from './demoMode';
import type { Company } from '../types';

async function demoCompanies(): Promise<Company[]> {
  const { companies } = await demoApi.imports.imported();
  return companies as Company[];
}

/**
 * Proves the safety contract VITE_DEMO_MODE is supposed to guarantee —
 * see docs/sourcing-workflow/DEPLOYMENT_READINESS.md and
 * DOCUMENT_ACCURACY_AUDIT.md. Run as part of the normal `npm test` suite
 * (vitest.config.ts includes src/**\/*.test.ts), so a regression here
 * fails the same command the rest of the app's tests fail with.
 */

describe('demo mode — build-time flag', () => {
  it('defaults to false — a normal `npm test`/`npm run build` never sets VITE_DEMO_MODE', () => {
    expect(DEMO_MODE).toBe(false);
  });

  it('the banner text names the two guarantees a screenshot must show', () => {
    expect(DEMO_BANNER_TEXT).toMatch(/Demo/i);
    expect(DEMO_BANNER_TEXT).toMatch(/Synthetic Data/i);
    expect(DEMO_BANNER_TEXT).toMatch(/external actions disabled/i);
  });
});

describe('demoApi — never calls fetch, ever', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => { throw new Error('demoApi must never call fetch()'); });
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  const readCalls: Array<() => Promise<unknown>> = [
    () => demoApi.status(),
    () => demoApi.overview.kpis(),
    () => demoApi.overview.cumulativePeriod('companies', 'all-time'),
    () => demoApi.auth.status(),
    () => demoApi.imports.imported(),
    () => demoApi.discovery.sources(),
    () => demoApi.discovery.candidates(),
    () => demoApi.discovery.runs(),
    () => demoApi.stealth.radar(),
    () => demoApi.stealth.signals(),
    () => demoApi.admin.status(),
    () => demoApi.hubspot.pipelines(),
    () => demoApi.hubspot.getMapping(),
    () => demoApi.outlook.status(),
    () => demoApi.staleSettings.get(),
    () => demoApi.notes.list('demo-copilot-forge'),
    () => demoApi.duplicates.list(),
    () => demoApi.refresh.connectors(),
    () => demoApi.refresh.log(),
    () => demoApi.schedule.get(),
    () => demoApi.admin.backups.list(),
  ];

  it.each(readCalls.map((fn, i) => [i, fn] as const))('read call #%i resolves without calling fetch', async (_i, fn) => {
    await expect(fn()).resolves.toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const mutations: Array<[string, () => Promise<unknown>]> = [
    ['hubspot.connect', () => demoApi.hubspot.connect()],
    ['hubspot.saveMapping', () => demoApi.hubspot.saveMapping({ pipelineId: 'x', pipelineLabel: 'x', stages: {} })],
    ['hubspot.syncCompany', () => demoApi.hubspot.syncCompany({} as never)],
    ['outlook.connect', () => demoApi.outlook.connect()],
    ['outlook.saveDraft', () => demoApi.outlook.saveDraft({ companyId: 'x', to: 'a@b.com', subject: 's', body: 'b', senderName: 'n', tone: 't' })],
    ['discovery.run', () => demoApi.discovery.run({}, 'team')],
    ['discovery.import', () => demoApi.discovery.import(['x'], 'team', 'skip')],
    ['schedule.save', () => demoApi.schedule.save({ cadence: 'weekly', jobType: 'incremental-sourcing', query: null, enabled: false })],
    ['schedule.runNow', () => demoApi.schedule.runNow('x', 'team')],
    ['refresh.run', () => demoApi.refresh.run({})],
    ['refresh.setEnabled', () => demoApi.refresh.setEnabled('yc', false)],
    ['admin.backups.create', () => demoApi.admin.backups.create('team')],
    ['imports.setStatus', () => demoApi.imports.setStatus('demo-ledgerline', 'Passed', 'team')],
    ['imports.bulkStatus', () => demoApi.imports.bulkStatus(['demo-ledgerline'], 'Passed', 'team')],
    ['imports.decidePendingEvidence', () => demoApi.imports.decidePendingEvidence(1, { status: 'accepted', actor: 'team' })],
    ['imports.saveTractionReview', () => demoApi.imports.saveTractionReview('demo-ledgerline', {})],
    ['notes.create', () => demoApi.notes.create('demo-ledgerline', 'hello')],
    ['ai.explainFit', () => demoApi.ai.explainFit({} as never)],
    ['duplicates.resolve', () => demoApi.duplicates.resolve(1, 'not-duplicate', 'team')],
    ['auth.microsoftStart', () => demoApi.auth.microsoftStart()],
  ];

  it.each(mutations)('mutation %s is refused before any network call', async (_label, fn) => {
    await expect(fn()).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).not.toHaveBeenCalled();
    try {
      await fn();
    } catch (e) {
      expect((e as ApiError).message).toMatch(/read-only demo/i);
    }
  });
});

describe('demoApi — synthetic data only', () => {
  it('every company id is a demo id, never a bare/real-looking identifier', async () => {
    const companies = await demoCompanies();
    expect(companies.length).toBeGreaterThan(0);
    for (const c of companies) expect(c.id).toMatch(/^demo-/);
  });

  it('every piece of evidence cites a demo/synthetic source, never a real domain', async () => {
    const companies = await demoCompanies();
    for (const c of companies) {
      for (const e of c.evidence) {
        expect(e.url).toMatch(/^https:\/\/example\.com\/demo\//);
        expect(e.source.toLowerCase()).toContain('synthetic');
      }
    }
  });

  it('no founder carries a real-looking email address', async () => {
    const companies = await demoCompanies();
    for (const c of companies) for (const f of c.founders) expect(f.email).toBeUndefined();
  });

  it('the one illustrative High-Fit example is unambiguously labelled synthetic', async () => {
    const companies = await demoCompanies();
    const solstice = companies.find((c) => c.id === 'demo-solstice-robotics');
    expect(solstice).toBeDefined();
    expect(solstice!.name).toMatch(/Illustrative Example/i);
    expect(solstice!.oneLiner).toMatch(/SYNTHETIC DEMO EXAMPLE/);
  });

  it('defaults to signed in (Vercel Authentication is the real gate in front of this build), and sign-out/sign-in both work locally with no network call', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('must not call fetch'); });
    vi.stubGlobal('fetch', fetchSpy);
    const initial = await demoApi.auth.status();
    expect(initial.authenticated).toBe(true);

    await demoApi.auth.logout();
    const afterLogout = await demoApi.auth.status();
    expect(afterLogout.authenticated).toBe(false);

    await demoApi.auth.login('literally anything — never checked against a real credential');
    const afterLogin = await demoApi.auth.status();
    expect(afterLogin.authenticated).toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
