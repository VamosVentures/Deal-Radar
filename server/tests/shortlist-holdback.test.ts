import { describe, expect, it } from 'vitest';
import {
  selectSectorShortlist, DEFAULT_PER_SECTOR,
  type ShortlistCandidate,
} from '../services/shortlist';
import { isLiveDeal, type Opportunity, type OpportunityClass } from '../../shared/opportunity';

/**
 * The shortlist accounting invariant.
 *
 * Selection removes companies for four separate reasons — evidence rank,
 * a per-source cap, the size of the sector, and corroboration — and it
 * used to record only two of them. Anything that merely ranked below the
 * cutoff was dropped with no trace, so the product could not distinguish
 * "considered and ranked sixth" from "never had it". Sila and General
 * Intuition were both real, both live deals, and both invisible.
 *
 * These tests protect the one property that makes the shortlist
 * reviewable: every eligible candidate is either selected or held back
 * with a specific reason, exactly once.
 */

function opportunity(over: Partial<Opportunity> = {}): Opportunity {
  return {
    companyId: 'x',
    classification: 'recent-financing-signal',
    primarySourceId: 'funding-news',
    primaryTier: 2,
    opportunityType: 'funding-announcement',
    evidenceUrl: 'https://example.test/evidence',
    evidencePublishedAt: '2026-07-01',
    evidenceRetrievedAt: '2026-07-20',
    evidenceSummary: 'Raised a round.',
    whyCurrent: 'Reported 2026-07-01.',
    amountUsd: null,
    amountText: null,
    roundType: null,
    investors: [],
    evidenceConfidence: 0.8,
    conflicts: [],
    missingInformation: [],
    classifiedAt: '2026-07-20T00:00:00.000Z',
    ...over,
  };
}

function candidate(
  name: string,
  over: Partial<Opportunity> = {},
  extra: Partial<ShortlistCandidate> = {},
): ShortlistCandidate {
  return {
    companyId: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    opportunity: opportunity({ companyId: name, ...over }),
    fitScore: 5,
    // A candidate that clears the corroboration bar by default, so each
    // test states the ONE thing it is about. Clearing the bar now takes
    // two facts rather than a source count: an independent financing
    // source, and the issuer describing a real business.
    independentSources: 1,
    operatingEvidence: 'substantive',
    quarantined: false,
    ...extra,
  };
}

/** selected + heldBack must equal the number of live deals in the pool. */
function expectFullyAccounted(pool: ShortlistCandidate[], result: ReturnType<typeof selectSectorShortlist>) {
  const eligible = pool.filter((c) => isLiveDeal(c.opportunity.classification));
  expect(result.eligible).toBe(eligible.length);
  expect(result.selected.length + result.heldBack.length).toBe(eligible.length);

  // Exactly once — never both, never twice.
  const ids = [...result.selected.map((s) => s.companyId), ...result.heldBack.map((h) => h.companyId)];
  expect(new Set(ids).size).toBe(ids.length);
  for (const c of eligible) expect(ids).toContain(c.companyId);

  // Every held-back entry carries a real sentence, not a bare category.
  for (const h of result.heldBack) {
    expect(h.reason.length).toBeGreaterThan(30);
    expect(h.reasonCode).toBeTruthy();
  }
}

describe('shortlist hold-back accounting', () => {
  it('accounts for every live deal when more candidates exist than slots', () => {
    // Nine live deals from one family, five slots. Four must be held back
    // with a reason; none may vanish.
    const pool = Array.from({ length: 9 }, (_, i) =>
      candidate(`Company ${i + 1}`, { evidencePublishedAt: `2026-07-${String(20 - i).padStart(2, '0')}` }));

    const result = selectSectorShortlist('fow', pool);

    expect(result.selected).toHaveLength(DEFAULT_PER_SECTOR);
    expect(result.heldBack).toHaveLength(4);
    expectFullyAccounted(pool, result);
    for (const h of result.heldBack) {
      expect(h.reasonCode).toBe('ranked-below-cutoff');
      expect(h.reason).toMatch(/only 5 slots exist/i);
      expect(h.rank).toBeGreaterThan(DEFAULT_PER_SECTOR);
    }
  });

  it('holds back a lower-ranked live deal instead of dropping it silently', () => {
    // The Sila / General Intuition case: a genuine live deal that simply
    // ranked below the cutoff. It must be visible AND must keep its
    // qualification — being held back is a display decision.
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => candidate(`Stronger ${i + 1}`, { primaryTier: 1 })),
      candidate('General Intuition', { primaryTier: 2, evidencePublishedAt: '2026-06-01' }),
    ];

    const result = selectSectorShortlist('fow', pool);

    const held = result.heldBack.find((h) => h.name === 'General Intuition');
    expect(held).toBeDefined();
    expect(held!.classification).toBe('recent-financing-signal');
    expect(isLiveDeal(held!.classification)).toBe(true);
    expect(held!.evidenceUrl).toBe('https://example.test/evidence');
    expectFullyAccounted(pool, result);
  });

  it('names the source-family cap as the reason when SEC fills up', () => {
    const pool = Array.from({ length: 5 }, (_, i) =>
      candidate(`Filer ${i + 1}`, { primarySourceId: 'sec', primaryTier: 1 }));

    const result = selectSectorShortlist('health', pool);

    const capped = result.heldBack.filter((h) => h.reasonCode === 'source-family-cap');
    expect(capped.length).toBeGreaterThan(0);
    for (const h of capped) expect(h.reason).toMatch(/already has 2 SEC-primary/i);
    expectFullyAccounted(pool, result);
  });

  it('holds back an uncorroborated live deal rather than showing it', () => {
    const pool = [
      candidate('Well Sourced', {}, { independentSources: 2, operatingEvidence: 'substantive' }),
      candidate('No Financing Source', {}, { independentSources: 0, operatingEvidence: 'substantive' }),
    ];

    const result = selectSectorShortlist('fow', pool);

    expect(result.selected.map((s) => s.name)).toEqual(['Well Sourced']);
    const held = result.heldBack.find((h) => h.name === 'No Financing Source');
    expect(held!.reasonCode).toBe('insufficient-corroboration');
    expect(held!.reason).toMatch(/0 independent financing source/i);
    expectFullyAccounted(pool, result);
  });

  /**
   * The other half of the same bar, and the reason this file changed.
   *
   * A live deal whose website proves only that it owns a domain is held
   * back for a DIFFERENT reason than one with no independent source, and
   * the held-back entry has to say which — otherwise a reviewer goes
   * looking for a second news article when what is actually missing is
   * somebody confirming there is a business.
   */
  it('holds back a live deal whose website is identity evidence only, and says so', () => {
    const pool = [
      candidate('Real Product Site', {}, { independentSources: 1, operatingEvidence: 'substantive' }),
      candidate('Bare Domain', {}, { independentSources: 1, operatingEvidence: 'identity-only' }),
      candidate('Parked Domain', {}, { independentSources: 1, operatingEvidence: 'parked' }),
    ];

    const result = selectSectorShortlist('fow', pool);

    expect(result.selected.map((s) => s.name)).toEqual(['Real Product Site']);
    for (const name of ['Bare Domain', 'Parked Domain']) {
      const held = result.heldBack.find((h) => h.name === name);
      expect(held!.reasonCode).toBe('insufficient-corroboration');
      // Names the operating gap, and does NOT ask for a second source.
      expect(held!.reason).toMatch(/operating evidence is not/i);
      expect(held!.reason).not.toMatch(/needs 2 from different source families/i);
    }
    expectFullyAccounted(pool, result);
  });

  it('holds back a quarantined company instead of shortlisting it', () => {
    const pool = [
      candidate('Clean', {}, {}),
      candidate('Quarantined Co', {}, { quarantined: true }),
    ];

    const result = selectSectorShortlist('fow', pool);

    expect(result.selected.map((s) => s.name)).toEqual(['Clean']);
    expect(result.heldBack.find((h) => h.name === 'Quarantined Co')!.reasonCode).toBe('quarantined');
    expectFullyAccounted(pool, result);
  });

  it('leaves a sector short rather than padding it, and explains the shortage', () => {
    const pool = [
      candidate('Only Deal'),
      candidate('A Lead', { classification: 'company-lead' as OpportunityClass }),
      candidate('Another Lead', { classification: 'company-lead' as OpportunityClass }),
    ];

    const result = selectSectorShortlist('frontier', pool);

    expect(result.selected).toHaveLength(1);
    expect(result.shortfall).toBe(4);
    expect(result.leads).toBe(2);
    expect(result.shortageExplanation).toMatch(/1 of 5 slots filled/i);
    expect(result.shortageExplanation).toMatch(/remain company leads/i);
    // Leads are not eligible, so they are not "held back" — they never
    // competed. Conflating the two would overstate the pipeline.
    expectFullyAccounted(pool, result);
    expect(result.heldBack).toHaveLength(0);
  });

  it('reports an empty sector honestly', () => {
    const result = selectSectorShortlist('fow', []);
    expect(result.selected).toHaveLength(0);
    expect(result.heldBack).toHaveLength(0);
    expect(result.eligible).toBe(0);
    expect(result.shortfall).toBe(DEFAULT_PER_SECTOR);
  });
});
