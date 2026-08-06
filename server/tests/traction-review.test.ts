import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { getCompany, saveCompany } from '../db/repos/companies';
import { latestScore, saveScore } from '../db/repos/operations';
import { applyTractionReview, currentTractionState, tractionHistory } from '../services/tractionReview';
import { scoreCompany, NON_PROVISIONAL_POLICY } from '../../src/lib/scoring';
import { HOT_THRESHOLD } from '../../shared/scoringThresholds';
import {
  TRACTION_STATE_SPECS, TRACTION_STATES, tractionNoteFor, validateTractionReview,
} from '../../shared/traction';
import type { ImportedCompany } from '../services/imports';
import type { Company } from '../../src/types';

/**
 * Analyst traction review. The load-bearing property is that a human's
 * opinion cannot become points without evidence, and that "we looked and
 * found nothing" is never scored as zero.
 */

beforeEach(() => {
  store.resetForTests();
  resetDbForTests();
});

/** Everything researched EXCEPT traction — so traction alone decides provisional. */
function nearComplete(id = 'tr-1'): ImportedCompany {
  return {
    id, name: `Traction Co ${id}`, oneLiner: 'Grid software for utilities.',
    vertical: 'sustainability', subcategory: 'Smart grids', stage: 'Seed',
    city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 5,
    website: 'https://example.com',
    raising: '$4M seed', lastFundingDate: '2026-06-15', accelerator: 'Y Combinator (S26)',
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'A Founder', role: 'CEO', background: 'Former ERCOT engineer who founded a prior company.' },
      { name: 'B Founder', role: 'CTO', background: 'PhD, research scientist.' },
    ],
    evidence: [{ claim: 'Seed round filed.', source: 'SEC', url: `https://sec.gov/${id}`, date: '2026-07-20', type: 'Filing' }],
    flags: [], imported: true,
  };
}

const seed = (c: ImportedCompany = nearComplete()) => {
  saveCompany(c, { origin: 'extracted', source: 'test' });
  saveScore(c.id, scoreCompany(c as unknown as Company), []);
  return c;
};

const review = (over: Record<string, unknown> = {}) => ({
  companyId: 'tr-1', state: 'pilot', evidenceType: 'company-website',
  verification: 'company-claimed', confidence: 'medium',
  analystNote: 'Company site names a live pilot with a municipal utility.',
  ...over,
});

describe('traction states', () => {
  it('covers every state the rubric needs, each with a level and a scoring flag', () => {
    expect(TRACTION_STATES).toEqual([
      'unknown', 'no-public-traction', 'pre-launch', 'design-partner', 'pilot',
      'paid-pilot', 'named-customer', 'recurring-revenue', 'multiple-deployments', 'scaled-adoption',
    ]);
    for (const s of TRACTION_STATES) {
      const spec = TRACTION_STATE_SPECS[s];
      expect(spec.level).toBeGreaterThanOrEqual(0);
      expect(spec.level).toBeLessThanOrEqual(10);
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });

  it('leaves exactly two states unscored — unknown, and no public evidence', () => {
    const unscored = TRACTION_STATES.filter((s) => !TRACTION_STATE_SPECS[s].scores);
    expect(unscored).toEqual(['unknown', 'no-public-traction']);
  });

  it('escalates monotonically from pre-launch to scaled adoption', () => {
    const scoring = TRACTION_STATES.filter((s) => TRACTION_STATE_SPECS[s].scores);
    const levels = scoring.map((s) => TRACTION_STATE_SPECS[s].level);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(new Set(levels).size).toBe(levels.length);
  });
});

describe('"no publicly disclosed traction" is not zero traction', () => {
  it('writes a note the scorer still reads as unresearched', () => {
    const note = tractionNoteFor(review({ state: 'no-public-traction' }) as never);
    // The existing tractionSignal() tests /^unknown|not yet researched/.
    expect(note).toMatch(/^Unknown/);
    expect(note).toMatch(/not evidence of absence/i);
  });

  it('keeps the traction component UNASSESSABLE, so the record stays provisional', () => {
    seed();
    const res = applyTractionReview(review({
      state: 'no-public-traction',
      analystNote: 'Searched site, press, and the YC profile. Nothing disclosed.',
    }));
    expect(res.ok).toBe(true);

    const after = scoreCompany(getCompany('tr-1') as unknown as Company);
    expect(after.components.find((x) => x.key === 'traction')!.assessable).toBe(false);
    expect(after.provisional).toBe(true);
    expect(after.provisionalReason).toMatch(/traction/);
  });

  it('records the finding anyway, so the next analyst does not repeat the search', () => {
    seed();
    applyTractionReview(review({ state: 'no-public-traction', analystNote: 'Searched everywhere; nothing public.' }));
    const history = tractionHistory('tr-1');
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe('no-public-traction');
    expect(history[0].analystNote).toMatch(/nothing public/i);
  });

  it('unknown traction alone keeps a fully-researched company provisional', () => {
    const c = seed();
    const fit = scoreCompany(c as unknown as Company);
    // Every OTHER critical component is assessable...
    for (const k of NON_PROVISIONAL_POLICY.requiredComponents.filter((x) => x !== 'traction')) {
      expect(fit.components.find((x) => x.key === k)!.assessable, k).toBe(true);
    }
    // ...and traction alone is enough to keep it out of High-Fit.
    expect(fit.provisional).toBe(true);
  });
});

describe('an opinion cannot silently become a score', () => {
  it('refuses a scoring state with no source URL and no substantive note', () => {
    seed();
    const res = applyTractionReview(review({ state: 'named-customer', analystNote: null, sourceUrl: null }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(' ')).toMatch(/source URL|analyst note/i);
    // Nothing was written.
    expect(tractionHistory('tr-1')).toHaveLength(0);
    expect(getCompany('tr-1')!.traction.level).toBe(0);
  });

  it('refuses a note too short to be an explanation', () => {
    expect(validateTractionReview(review({ state: 'pilot', analystNote: 'yes' }) as never).ok).toBe(false);
  });

  it('refuses a revenue figure without a source URL, even with a long note', () => {
    seed();
    const res = applyTractionReview(review({
      state: 'recurring-revenue', metricValue: '$40k ARR',
      analystNote: 'Founder mentioned this on a call last week, no public source.',
      sourceUrl: null,
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join(' ')).toMatch(/figure may only be recorded with a source URL/i);
  });

  it('refuses "independently confirmed" without the third-party URL', () => {
    seed();
    const res = applyTractionReview(review({
      state: 'pilot', verification: 'independently-confirmed', sourceUrl: null,
      analystNote: 'A long enough note, but no third-party source is cited here.',
    }));
    expect(res.ok).toBe(false);
  });

  it('ACCEPTS a scoring state backed by a source URL', () => {
    seed();
    const res = applyTractionReview(review({
      state: 'named-customer', sourceUrl: 'https://example.com/customers', analystNote: null,
      verification: 'independently-confirmed',
    }));
    expect(res.ok).toBe(true);
    expect(getCompany('tr-1')!.traction.level).toBe(TRACTION_STATE_SPECS['named-customer'].level);
  });

  it('distinguishes an analyst assessment from a published fact in the stored note', () => {
    seed();
    applyTractionReview(review({
      state: 'design-partner', verification: 'analyst-assessment',
      analystNote: 'Inferred from a founder conversation; nothing published.',
    }));
    expect(getCompany('tr-1')!.traction.note).toMatch(/Analyst assessment/i);
  });
});

describe('history and scoring behaviour', () => {
  it('is append-only and preserves the state it replaced', () => {
    seed();
    applyTractionReview(review({ state: 'pilot' }));
    applyTractionReview(review({ state: 'paid-pilot', analystNote: 'Contract signed; company site now says paid pilot.' }));

    const history = tractionHistory('tr-1');
    expect(history).toHaveLength(2);
    expect(history[0].state).toBe('paid-pilot');
    expect(history[0].previousState).toBe('pilot');
    expect(history[1].state).toBe('pilot');
    expect(history[1].previousState).toBe('unknown');
    expect(currentTractionState('tr-1')).toBe('paid-pilot');
  });

  it('appends a scoring row and never rewrites an earlier one', () => {
    seed();
    const before = getDb().prepare('SELECT id, score, version FROM scoring_results WHERE company_id = ? ORDER BY id')
      .all('tr-1') as { id: number; score: number; version: string }[];

    applyTractionReview(review({ state: 'named-customer', sourceUrl: 'https://example.com/customers' }));

    const after = getDb().prepare('SELECT id, score, version FROM scoring_results WHERE company_id = ? ORDER BY id')
      .all('tr-1') as { id: number; score: number; version: string }[];
    expect(after.length).toBe(before.length + 1);
    expect(after[0]).toEqual(before[0]);            // untouched
    expect(after[after.length - 1].version).toMatch(/^v4\.1/);
  });

  it('stamps the traction-review timestamp separately from generic review', () => {
    seed();
    applyTractionReview(review({ state: 'pilot' }));
    const row = getDb().prepare('SELECT traction_reviewed_at, last_reviewed_at FROM companies WHERE id = ?')
      .get('tr-1') as { traction_reviewed_at: string | null; last_reviewed_at: string | null };
    expect(row.traction_reviewed_at).toBeTruthy();
    expect(row.last_reviewed_at).toBeTruthy();
  });

  it('writes no scoring row when nothing score-relevant changed', () => {
    seed();
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results WHERE company_id = ?').get('tr-1') as { n: number }).n;
    const res = applyTractionReview(review({ state: 'unknown' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scoreRowAppended).toBe(false);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results WHERE company_id = ?').get('tr-1') as { n: number }).n).toBe(before);
  });

  it('turns the record fully assessed once traction is known', () => {
    seed();
    const before = scoreCompany(getCompany('tr-1') as unknown as Company);
    expect(before.provisional).toBe(true);

    applyTractionReview(review({
      state: 'multiple-deployments', sourceUrl: 'https://example.com/customers',
      verification: 'independently-confirmed', confidence: 'high',
    }));

    const after = scoreCompany(getCompany('tr-1') as unknown as Company);
    expect(after.components.find((x) => x.key === 'traction')!.assessable).toBe(true);
    expect(after.provisional).toBe(false);
    // Note the score does NOT necessarily rise. The model normalizes over
    // assessable components, so adding one pulls the result toward that
    // component's own ratio: 9/10 on a company already averaging higher
    // nudges it DOWN. That is the arithmetic working, not a regression —
    // which is exactly why the two directional cases below use fixtures
    // whose averages make the direction unambiguous.
    expect(after.completeness).toBeGreaterThan(before.completeness);
  });

  it('supported evidence moves a WEAK record UP', () => {
    // Everything else scores modestly, so strong traction clearly helps.
    const weak = nearComplete('tr-weak');
    seed({
      ...weak,
      stage: 'Series A',                  //  9/15
      state: 'FL',                        //  4/10 (outside preferred)
      raising: undefined, lastFundingDate: undefined, accelerator: undefined,
      founders: [{ name: 'Solo Founder', role: 'CEO', background: 'Engineer.' }],
    });
    const before = scoreCompany(getCompany('tr-weak') as unknown as Company);
    applyTractionReview(review({
      companyId: 'tr-weak', state: 'scaled-adoption',   // 10/10
      sourceUrl: 'https://example.com/customers', verification: 'independently-confirmed',
    }));
    const after = scoreCompany(getCompany('tr-weak') as unknown as Company);
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.provisional).toBe(false);
  });

  it('supported evidence can also move a score DOWN — pre-launch is a real, low finding', () => {
    seed();
    const before = scoreCompany(getCompany('tr-1') as unknown as Company).score;
    applyTractionReview(review({
      state: 'pre-launch', sourceUrl: 'https://example.com/', verification: 'company-claimed',
    }));
    const after = scoreCompany(getCompany('tr-1') as unknown as Company);
    expect(after.components.find((x) => x.key === 'traction')!.points).toBe(1);
    expect(after.score).toBeLessThan(before);
    // And it is now fully assessed, because traction IS known — a low
    // score with full evidence is a better answer than a high provisional one.
    expect(after.provisional).toBe(false);
  });

  it('never marks a company High-Fit by itself', () => {
    seed();
    applyTractionReview(review({
      state: 'scaled-adoption', sourceUrl: 'https://example.com/customers',
      verification: 'independently-confirmed', confidence: 'high',
    }));
    const s = latestScore('tr-1')!;
    // It may legitimately clear 8.0 on the rubric — that is the rubric's
    // decision, not the review's — but nothing here sets a status, a CRM
    // stage, or a Hot flag.
    const statusRow = getDb().prepare('SELECT review_status FROM companies WHERE id = ?').get('tr-1') as { review_status: string | null };
    expect(statusRow.review_status).toBeNull();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM hubspot_sync_history').get() as { n: number }).n).toBe(0);
    expect(s.version).toMatch(/^v4\.1/);
  });

  it('leaves the rubric itself untouched', () => {
    expect(HOT_THRESHOLD).toBe(8);
    seed();
    applyTractionReview(review({ state: 'pilot', sourceUrl: 'https://example.com/' }));
    const fit = scoreCompany(getCompany('tr-1') as unknown as Company);
    expect(fit.components.reduce((s, x) => s + x.max, 0)).toBe(100);
    expect(fit.components.find((x) => x.key === 'traction')!.max).toBe(10);
  });

  it('rejects a review for a company that does not exist', () => {
    const res = applyTractionReview(review({ companyId: 'nope' }));
    expect(res.ok).toBe(false);
  });
});
