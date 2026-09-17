import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import { runEnrichment } from '../services/enrichment';
import { clearPolitenessCacheForTests } from '../sourcing/politeness';
import { markQualifiedForTests } from './qualifyForTests';
import type { ImportedCompany } from '../services/imports';

/**
 * THE BUG
 *
 * The subcategory guard validated (and picked) a new subcategory against
 * whichever sector THIS ENRICHMENT PASS happened to compute, not against
 * the vertical already on the company's row. Podium is stored under
 * `fintech`; its own site text reads as `fow` (Future of Work) to the
 * classifier. That produced `subcategory: 'learning and development'` —
 * a real `fow` subvertical — written underneath the untouched `fintech`
 * bucket: internally consistent with the classifier's own opinion, and
 * inconsistent with everything else on the record. Nobody had decided
 * "FinTech → learning and development" was correct; the pipeline just
 * asserted it.
 *
 * `vertical` (the row's top-level bucket) must never be auto-corrected
 * by this pipeline, so a disagreement between the classifier and the
 * stored vertical has to be surfaced for a human, not resolved by
 * picking a subcategory from whichever sector the classifier prefers.
 */

beforeEach(() => {
  clearPolitenessCacheForTests();
  store.resetForTests();
  resetDbForTests();
});
afterEach(() => vi.unstubAllGlobals());

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
    id: 'vc-1', name: 'Vertical Conflict Co', oneLiner: 'Placeholder one-liner.',
    vertical: 'fintech', subcategory: 'consumer wellness',
    stage: 'Unknown', city: 'Lehi', state: 'UT', foundedYear: 2016, teamSize: 1,
    website: 'https://verticalconflict.example.com',
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [{
      claim: 'Listed in the public directory.', source: 'Test directory',
      url: 'https://example.com/vc-1', date: '2026-07-28', type: 'Database record',
    }],
    flags: [], imported: true,
    ...over,
  } as ImportedCompany;
}

const FOW_FLAVORED_SITE = `<!doctype html><html><head><title>Vertical Conflict Co</title></head><body><main>
<p>We are the workforce management platform built for HR teams. We help employers streamline
hiring, onboarding, and employee training across their enterprise. Our learning and development
tools support workforce growth for every employer and their people team.</p>
</main></body></html>`;

const FINTECH_FLAVORED_SITE = `<!doctype html><html><head><title>Vertical Conflict Co</title></head><body><main>
<p>We provide payments infrastructure and card issuing for banks and financial institutions.
Our platform helps merchants accept payments, manage treasury, and reconcile transactions
for their financial institution partners.</p>
</main></body></html>`;

describe('a classifier/vertical disagreement is never auto-corrected', () => {
  it('leaves the stored vertical AND subcategory untouched when the classifier disagrees', async () => {
    saveCompany(company(), { origin: 'extracted', source: 'test' });
    markQualifiedForTests('vc-1');
    stub({ 'verticalconflict.example.com': FOW_FLAVORED_SITE });

    await runEnrichment({ apply: true, companyIds: ['vc-1'], initiatedBy: 'test', maxRequests: 40 });

    const row = getDb().prepare('SELECT vertical, subcategory FROM companies WHERE id = ?')
      .get('vc-1') as { vertical: string; subcategory: string };
    expect(row.vertical).toBe('fintech');
    // Still the ORIGINAL mismatched value — not overwritten with a
    // DIFFERENT wrong-but-plausible one from the classifier's own sector.
    expect(row.subcategory).toBe('consumer wellness');

    const cls = getDb().prepare('SELECT primary_sector, reason FROM company_vertical_classification WHERE company_id = ?')
      .get('vc-1') as { primary_sector: string; reason: string };
    // The classifier really did land on a different sector — this proves
    // the test exercises a genuine conflict, not a no-op.
    expect(cls.primary_sector).toBe('fow');
    expect(cls.reason).toMatch(/disagrees with the vertical already on record/i);
  });

  it('still corrects a placeholder subcategory when the classifier agrees with the stored vertical', async () => {
    saveCompany(company({ subcategory: 'Unclassified — requires manual review' }), { origin: 'extracted', source: 'test' });
    markQualifiedForTests('vc-1');
    stub({ 'verticalconflict.example.com': FINTECH_FLAVORED_SITE });

    await runEnrichment({ apply: true, companyIds: ['vc-1'], initiatedBy: 'test', maxRequests: 40 });

    const row = getDb().prepare('SELECT vertical, subcategory FROM companies WHERE id = ?')
      .get('vc-1') as { vertical: string; subcategory: string };
    expect(row.vertical).toBe('fintech');
    expect(row.subcategory).toBe('payments infrastructure');
  });
});
