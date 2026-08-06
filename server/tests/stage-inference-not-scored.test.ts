import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { saveCompany, setResolvedFounders, listCompanies } from '../db/repos/companies';
import { runEnrichment } from '../services/enrichment';
import { resolveStage } from '../enrichment/stageResolver';
import { clearPolitenessCacheForTests } from '../sourcing/politeness';
import { scoreCompany, NON_PROVISIONAL_POLICY } from '../../src/lib/scoring';
import { SCHEDULING_WIZARD } from './fixtures/ycProfiles';
import type { ImportedCompany } from '../services/imports';
import type { Company } from '../../src/types';

/**
 * An unsourced stage inference must not score itself.
 *
 * THE BUG
 *
 * `stageResolver` has a residual bucket for the case where nothing on
 * record names a round. Its own explanation is explicit that it is not
 * evidence: "Recorded as early-stage with the round undisclosed because
 * the company is in an early-stage pipeline, not because any evidence
 * establishes it."
 *
 * That label was then stamped onto `companies.stage`, which is what the
 * scorer reads. In the rubric it is worth 9/15 AND it is `assessable`, so
 * it also removed `stage` from `missingCritical` and helped a company
 * clear the non-provisional gate. Measured on the development database
 * before the fix: 195 of 209 companies carried the label, every one from
 * an `inferred` resolution and not one from an explicit source — so a
 * founding year, a team size and an accelerator batch were being
 * converted into most of a stage score across 93% of the portfolio.
 *
 * Nothing in the suite caught it, because no test asserted what reaches
 * the company ROW. These do.
 */

const NOW = '2026-08-06T00:00:00.000Z';

beforeEach(() => {
  clearPolitenessCacheForTests();
  store.resetForTests();
  resetDbForTests();
});
afterEach(() => vi.unstubAllGlobals());

const SITE_PAGE = `<!doctype html><html><head><title>Scheduling Wizard</title></head><body><main>
<p>Scheduling Wizard builds the logistics infrastructure to modernize healthcare operations,
beginning with physician scheduling and care coordination for hospitals and academic health
systems. We are based in Washington, DC.</p>
</main></body></html>`;

function stub(pages: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    const body = Object.entries(pages).find(([k]) => url.includes(k))?.[1];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => 'not found', headers: new Headers() } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => body, headers: new Headers() } as unknown as Response;
  }));
}

function company(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: 'sw-1', name: 'Scheduling Wizard', oneLiner: 'Healthcare logistics infrastructure.',
    vertical: 'health', subcategory: 'Healthcare infrastructure',
    stage: 'Unknown', city: 'Washington', state: 'DC', foundedYear: 2024, teamSize: 3,
    accelerator: 'Y Combinator (W26)',
    website: 'https://www.schedulingwiz.com',
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [{
      claim: 'Listed in the Y Combinator public directory',
      source: 'Y Combinator', url: 'https://www.ycombinator.com/companies/scheduling-wizard',
      date: '2026-08-06', type: 'Database record',
    }],
    flags: [], imported: true,
    ...over,
  } as ImportedCompany;
}

describe('stageResolver still reports the residual honestly', () => {
  it('labels an accelerator-and-age-only stage as an INFERENCE, not a stated round', () => {
    const outcome = resolveStage([], {
      companyAgeYears: 2, teamSize: 3, accelerator: 'Y Combinator (W26)',
      hasShippingProduct: true, hasFinancingEvidence: false,
      onlyFinancingIsFormD: false, hasGrantFunding: false,
    });
    expect(outcome.stage).toBe('early-stage-round-not-disclosed');
    // The contract the gate depends on: this is never 'explicit'.
    expect(outcome.basis).toBe('inferred');
    expect(outcome.confidence).toBeLessThan(0.6);
  });
});

describe('an inferred residual stage never reaches the company row', () => {
  it('leaves companies.stage Unknown when no source names a round', async () => {
    saveCompany(company(), { origin: 'extracted', source: 'test' });
    stub({
      'ycombinator.com/companies/scheduling-wizard': SCHEDULING_WIZARD,
      'schedulingwiz.com': SITE_PAGE,
    });

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    const row = getDb().prepare('SELECT stage FROM companies WHERE id = ?').get('sw-1') as { stage: string };
    expect(row.stage).toBe('Unknown');
  });

  it('still records the inference, with its confidence and reasoning', async () => {
    saveCompany(company(), { origin: 'extracted', source: 'test' });
    stub({
      'ycombinator.com/companies/scheduling-wizard': SCHEDULING_WIZARD,
      'schedulingwiz.com': SITE_PAGE,
    });

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    // Withheld from the SCORE, not withheld from the analyst.
    const res = getDb().prepare('SELECT stage, basis, confidence, explanation FROM company_stage_resolution WHERE company_id = ?')
      .get('sw-1') as { stage: string; basis: string; confidence: number; explanation: string };
    expect(res.stage).toBe('early-stage-round-not-disclosed');
    expect(res.basis).toBe('inferred');
    expect(res.explanation.length).toBeGreaterThan(40);
  });

  it('keeps the stage component unassessable, so the score stays provisional', async () => {
    saveCompany(company(), { origin: 'extracted', source: 'test' });
    stub({
      'ycombinator.com/companies/scheduling-wizard': SCHEDULING_WIZARD,
      'schedulingwiz.com': SITE_PAGE,
    });

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    const stored = listCompanies().find((c) => c.id === 'sw-1')!;
    const fit = scoreCompany(stored as unknown as Company, new Date(NOW));
    const stage = fit.components.find((x) => x.key === 'stage')!;
    expect(stage.assessable).toBe(false);
    // The consequence that matters: it cannot be called High-Fit on the
    // strength of a stage nobody stated.
    expect(NON_PROVISIONAL_POLICY.requiredComponents).toContain('stage');
    expect(fit.provisional).toBe(true);
  });

  it('does apply a stage a source actually states', async () => {
    // The gate is narrow. An explicitly stated stage is unaffected — the
    // fix must not turn into "never record a stage".
    saveCompany(company({ id: 'sw-2', stage: 'Seed' }), { origin: 'user-entered', source: 'test' });
    stub({
      'ycombinator.com/companies/scheduling-wizard': SCHEDULING_WIZARD,
      'schedulingwiz.com': SITE_PAGE,
    });

    await runEnrichment({ apply: true, companyIds: ['sw-2'], initiatedBy: 'test', maxRequests: 40 });

    const row = getDb().prepare('SELECT stage FROM companies WHERE id = ?').get('sw-2') as { stage: string };
    // A human-entered value is never downgraded by an automated pass.
    expect(row.stage).toBe('Seed');
  });
});

describe('every verified founder reaches the founders table', () => {
  it('writes all three co-founders, not just the primary', async () => {
    saveCompany(company(), { origin: 'extracted', source: 'test' });
    stub({
      'ycombinator.com/companies/scheduling-wizard': SCHEDULING_WIZARD,
      'schedulingwiz.com': SITE_PAGE,
    });

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    const names = (getDb().prepare('SELECT name FROM founders WHERE company_id = ? ORDER BY position')
      .all('sw-1') as { name: string }[]).map((r) => r.name);
    expect(names).toContain('Samuel Oberly');
    expect(names).toContain('Zachary Dermody');
    expect(names).toContain('Abdelrahman Hamimi');
    // The non-founder employee on the same page is still excluded.
    expect(names).not.toContain('Dana Example');
  });

  it('does not overwrite a real founder already on record', () => {
    saveCompany(company({ id: 'keep', founders: [{ name: 'Ana Ruiz', role: 'CEO', background: 'Analyst-entered.' }] }),
      { origin: 'user-entered', source: 'test' });
    const replaced = setResolvedFounders('keep', [{ name: 'Someone Else', role: 'Founder', background: 'x' }]);
    expect(replaced).toBe(false);
    const names = (getDb().prepare('SELECT name FROM founders WHERE company_id = ?').all('keep') as { name: string }[])
      .map((r) => r.name);
    expect(names).toEqual(['Ana Ruiz']);
  });

  it('stores a person named twice only once', () => {
    saveCompany(company({ id: 'dedup' }), { origin: 'extracted', source: 'test' });
    setResolvedFounders('dedup', [
      { name: 'Samuel Oberly', role: 'Founder', background: 'a' },
      { name: 'samuel  oberly', role: 'Co-Founder', background: 'b' },
      { name: 'Zachary Dermody', role: 'Founder', background: 'c' },
    ]);
    const names = (getDb().prepare('SELECT name FROM founders WHERE company_id = ? ORDER BY position')
      .all('dedup') as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(['Samuel Oberly', 'Zachary Dermody']);
  });

  it('rolls back completely if the replacement fails partway', () => {
    saveCompany(company({ id: 'rb' }), { origin: 'extracted', source: 'test' });
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM founders WHERE company_id = ?').get('rb') as { n: number };
    expect(before.n).toBe(1); // the placeholder

    // A role of the wrong type fails the INSERT after the DELETE has run.
    expect(() => setResolvedFounders('rb', [
      { name: 'Real Person', role: 'Founder', background: 'ok' },
      { name: 'Bad Row', role: {} as unknown as string, background: 'x' },
    ])).toThrow();

    // Destroying rows to add rows is only safe if the pair is atomic.
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM founders WHERE company_id = ?').get('rb') as { n: number };
    expect(after.n).toBe(before.n);
  });
});
