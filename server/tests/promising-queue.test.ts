import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { acceleratorBatchYear, assessPromising } from '../../src/lib/promisingQueue';
import { scoreCompany } from '../../src/lib/scoring';
import { HOT_THRESHOLD, TRACK_THRESHOLD } from '../../shared/scoringThresholds';
import { resolveCityState } from '../enrichment/companyFacts';
import type { Company } from '../../src/types';

const NOW = new Date('2026-08-06T00:00:00.000Z');

/** Sector + accelerator known, everything else missing — the common real shape. */
function promisingShape(over: Partial<Company> = {}): Company {
  return {
    id: 'pq-1', name: 'Promising Co', oneLiner: 'Warehouse robotics.',
    vertical: 'frontier', subcategory: 'Industrial & warehouse automation',
    stage: 'Unknown', city: 'Unknown', state: '??',
    foundedYear: 2026, teamSize: 2, accelerator: 'Y Combinator (S26)',
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [{ claim: 'YC listing.', source: 'Y Combinator', url: 'https://ycombinator.com/companies/pq', date: '2026-08-01', type: 'Database record' }],
    flags: [], imported: true,
    ...over,
  } as unknown as Company;
}

/** Fully researched: nothing left to find, so nothing for the queue to do. */
function fullyAssessed(): Company {
  return {
    id: 'pq-full', name: 'Assessed Co', oneLiner: 'Grid software.',
    vertical: 'sustainability', subcategory: 'Smart grids', stage: 'Seed',
    city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 5,
    accelerator: 'Y Combinator (S26)', raising: '$4M seed', lastFundingDate: '2026-06-15',
    traction: { level: 7, note: 'Named customer confirmed.' },
    founders: [
      { name: 'A Founder', role: 'CEO', background: 'Former ERCOT engineer who founded a prior company.' },
      { name: 'B Founder', role: 'CTO', background: 'PhD, research scientist.' },
    ],
    evidence: [{ claim: 'Form D.', source: 'SEC', url: 'https://sec.gov/x', date: '2026-07-20', type: 'Filing' }],
    flags: [], imported: true,
  } as unknown as Company;
}

const verdict = (c: Company, over: Parameters<typeof assessPromising>[0] extends infer T ? Partial<T> : never = {}) =>
  assessPromising({ company: c, fit: scoreCompany(c, NOW), today: NOW, ...over });

describe('Promising — Needs Diligence', () => {
  const SUBSTANTIVE = [
    { key: 'named-customers', direction: 'positive' as const, label: 'Named customers or credible pilots', evidence: 'used by Xcel Energy' },
  ];

  it('includes a provisional record with a substantive signal and a closable gap', () => {
    const v = verdict(promisingShape(), { qualityBand: 'high', qualityPriority: 62, qualitySignals: SUBSTANTIVE });
    expect(v.needsDiligence).toBe(true);
    expect(v.eligible).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/HIGH/);
    expect(v.missingCritical).toEqual(expect.arrayContaining(['Stage', 'Traction', 'Founder & team', 'Geography']));
  });

  /**
   * The precision fix. The first version of this queue held 127 of 172
   * active companies — 74% of everything — because its entry conditions
   * were satisfied by a YC accelerator field and a preliminary score
   * computed over so few components that TRACK_THRESHOLD was trivial.
   */
  describe('Promising is strictly narrower than Needs Diligence', () => {
    it('a record with NO substantive signal needs diligence but is not promising', () => {
      const v = verdict(promisingShape(), { qualityBand: 'high', qualityPriority: 70, qualitySignals: [] });
      expect(v.needsDiligence).toBe(true);
      expect(v.eligible).toBe(false);
      expect(v.exclusions.join(' ')).toMatch(/No substantive signal/);
    });

    it('an accelerator alone is not substantive — most of the corpus has one', () => {
      const v = verdict(promisingShape({ accelerator: 'Y Combinator (S26)' }), {
        qualityBand: 'high', qualityPriority: 70, qualitySignals: [],
      });
      expect(v.eligible).toBe(false);
      expect(v.substantiveSignals).toEqual([]);
    });

    it('sector and geography are not substantive either', () => {
      const v = verdict(promisingShape({ city: 'Austin', state: 'TX' }), {
        qualityBand: 'high',
        qualitySignals: [{ key: 'recent-momentum', direction: 'positive', label: 'Recent momentum', evidence: 'published 10 days ago' }],
      });
      expect(v.eligible).toBe(false);
    });

    it('a LOW quality band is not promising however good the preliminary score', () => {
      const v = verdict(promisingShape(), { qualityBand: 'low', qualityPriority: 10, qualitySignals: SUBSTANTIVE });
      expect(v.needsDiligence).toBe(true);
      expect(v.eligible).toBe(false);
      expect(v.exclusions.join(' ')).toMatch(/below medium/);
    });

    it('below the Track threshold is not promising', () => {
      const weak = promisingShape({ subcategory: 'Unclassified — requires manual review' });
      const v = verdict(weak, { qualityBand: 'high', qualityPriority: 70, qualitySignals: SUBSTANTIVE });
      expect(scoreCompany(weak, NOW).score).toBeLessThan(TRACK_THRESHOLD);
      expect(v.needsDiligence).toBe(true);
      expect(v.eligible).toBe(false);
      expect(v.exclusions.join(' ')).toMatch(/below the Track threshold/);
    });

    /**
     * SEMANTIC CORRECTION, not a relaxed test.
     *
     * This case used to assert that founder rows with any non-"Unknown"
     * `background` string were substantive on their own. That string is
     * machine-written — server/services/enrichment.ts fills it with the
     * pipeline's own `verdict.summary` — so the assertion was pinning a
     * rule that let a company qualify as Promising on the strength of a
     * sentence this codebase generated about it, with no source attached.
     *
     * Meanwhile shared/qualitySignals.ts requires a source URL for
     * exactly the same evidence and skips an uncited biography
     * ("an uncited biography is not evidence"). Two definitions, one of
     * which ignored the citation rule.
     *
     * Founder evidence still qualifies a company — through the cited
     * `founder-market-fit` signal, which is in SUBSTANTIVE_KEYS. Both
     * halves are asserted below so the rule cannot silently flip back.
     */
    const withFounders = () => promisingShape({
      founders: [
        { name: 'Ana Ruiz', role: 'CEO', background: 'Previously a transmission planning engineer at ERCOT.' },
        { name: 'Ben Osei', role: 'CTO', background: 'PhD in power systems.' },
      ],
    } as never);

    it('does NOT count an uncited, machine-written founder background as substantive', () => {
      const v = verdict(withFounders(), { qualityBand: 'medium', qualityPriority: 40, qualitySignals: [] });
      expect(v.substantiveSignals).toHaveLength(0);
      expect(v.eligible).toBe(false);
      expect(v.exclusions.concat(v.reasons).join(' ')).not.toMatch(/founder\(s\) with recorded background/);
    });

    it('DOES count founder evidence when it arrives as the cited founder-market-fit signal', () => {
      const v = verdict(withFounders(), {
        qualityBand: 'medium', qualityPriority: 40,
        qualitySignals: [{
          key: 'founder-market-fit', direction: 'positive' as const,
          label: 'Founder-market fit',
          evidence: 'transmission planning engineer at ERCOT',
        }],
      });
      expect(v.substantiveSignals.join(' ')).toMatch(/Founder-market fit/);
      expect(v.eligible).toBe(true);
    });

    it('excludes a decade-old accelerator batch from the shortlist, but not from Needs Diligence', () => {
      // Found by manual inspection of the first top-20: Tara AI (YC W15)
      // and Checkr (YC S14) were both "promising early-stage leads".
      const old = promisingShape({ accelerator: 'Y Combinator (W15)' });
      const v = verdict(old, { qualityBand: 'high', qualityPriority: 63, qualitySignals: SUBSTANTIVE });
      expect(v.needsDiligence).toBe(true);
      expect(v.eligible).toBe(false);
      expect(v.exclusions.join(' ')).toMatch(/batch .* years old/);
    });

    it('keeps a current batch', () => {
      const current = promisingShape({ accelerator: 'Y Combinator (S26)' });
      expect(verdict(current, { qualityBand: 'high', qualityPriority: 63, qualitySignals: SUBSTANTIVE }).eligible).toBe(true);
    });

    it('keeps a company whose batch cannot be read — an unparseable code is a gap, not age', () => {
      const odd = promisingShape({ accelerator: 'Some Accelerator, cohort unknown' });
      expect(acceleratorBatchYear(odd.accelerator)).toBeNull();
      expect(verdict(odd, { qualityBand: 'high', qualityPriority: 63, qualitySignals: SUBSTANTIVE }).eligible).toBe(true);
    });

    it('excludes a policy exception — that is a partner ruling, not analyst diligence', () => {
      for (const flag of ['outside-thesis', 'defi-adjacent', 'hardware-heavy'] as const) {
        const flagged = promisingShape({ flags: [flag] } as never);
        const v = verdict(flagged, { qualityBand: 'high', qualityPriority: 63, qualitySignals: SUBSTANTIVE });
        expect(v.eligible, flag).toBe(false);
        expect(v.exclusions.join(' '), flag).toMatch(/policy exception/);
        // Still a real record with a real score — never rejected.
        expect(scoreCompany(flagged, NOW).score).toBeGreaterThan(0);
      }
    });

    it('every Promising member is also a Needs Diligence member', () => {
      for (const band of ['high', 'medium'] as const) {
        const v = verdict(promisingShape(), { qualityBand: band, qualityPriority: 50, qualitySignals: SUBSTANTIVE });
        if (v.eligible) expect(v.needsDiligence).toBe(true);
      }
    });
  });

  it('a sparse but signal-rich record still surfaces in NEEDS DILIGENCE', () => {
    // The original purpose survives the precision fix: a company with
    // little public evidence must not vanish. It lands in the broad
    // queue even when it is not yet promising enough for the short one.
    const weak = promisingShape({ subcategory: 'Unclassified — requires manual review' });
    const v = verdict(weak, { qualityBand: 'high', qualityPriority: 70, qualitySignals: SUBSTANTIVE });
    expect(scoreCompany(weak, NOW).score).toBeLessThan(TRACK_THRESHOLD);
    expect(v.needsDiligence).toBe(true);
  });

  it('EXCLUDES a fully assessed record — it ranks normally instead', () => {
    const v = verdict(fullyAssessed(), { qualityBand: 'high', qualityPriority: 80 });
    expect(scoreCompany(fullyAssessed(), NOW).provisional).toBe(false);
    expect(v.eligible).toBe(false);
    expect(v.exclusions.join(' ')).toMatch(/fully assessed/i);
  });

  it('excludes thesis-ineligible, inactive, duplicate, and terminal records', () => {
    const cases: [string, Parameters<typeof assessPromising>[0]][] = [
      ['thesis', { company: promisingShape(), fit: scoreCompany(promisingShape(), NOW), thesisEligible: false }],
      ['inactive', { company: promisingShape(), fit: scoreCompany(promisingShape(), NOW), inactive: true }],
      ['duplicate', { company: promisingShape(), fit: scoreCompany(promisingShape(), NOW), confirmedDuplicate: true }],
      ['terminal', { company: promisingShape(), fit: scoreCompany(promisingShape(), NOW), reviewStatus: 'Passed' }],
    ];
    for (const [label, input] of cases) {
      const v = assessPromising({ ...input, qualityBand: 'high', qualityPriority: 90, qualitySignals: SUBSTANTIVE });
      expect(v.eligible, label).toBe(false);
      expect(v.needsDiligence, label).toBe(false);
      expect(v.exclusions.length, label).toBeGreaterThan(0);
    }
  });

  it('recommends the highest-value next action, traction first', () => {
    expect(verdict(promisingShape(), { qualityBand: 'high', qualitySignals: SUBSTANTIVE }).nextAction).toMatch(/traction review/i);
    // With traction known, founders become the next gap.
    const withTraction = promisingShape({ traction: { level: 6, note: 'Paid pilot confirmed. Source: https://x/y' } });
    expect(verdict(withTraction, { qualityBand: 'high', qualitySignals: SUBSTANTIVE }).nextAction).toMatch(/founder research/i);
  });

  it('states a primary risk drawn from what is actually missing', () => {
    expect(verdict(promisingShape(), { qualityBand: 'high', qualitySignals: SUBSTANTIVE }).primaryRisk)
      .toMatch(/Neither traction nor the founding team/i);
  });

  it('never changes the official score', () => {
    const c = promisingShape();
    const before = scoreCompany(c, NOW);
    assessPromising({ company: c, fit: before, qualityBand: 'high', qualityPriority: 99 });
    expect(scoreCompany(c, NOW)).toEqual(before);
  });

  it('every member is provisional, so membership can never imply High-Fit', () => {
    const c = promisingShape();
    const fit = scoreCompany(c, NOW);
    const v = assessPromising({ company: c, fit, qualityBand: 'high', qualitySignals: SUBSTANTIVE });
    expect(v.eligible).toBe(true);
    expect(fit.provisional).toBe(true);

    // This fixture is the exact case the provisional gate exists for: it
    // scores ABOVE 8.0 on the 35% of the model that could be judged, and
    // is still not High-Fit. The Hot rule is `!provisional && >= 8`, and
    // the first half alone excludes every member of this queue.
    expect(fit.score).toBeGreaterThanOrEqual(HOT_THRESHOLD);
    const isHighFit = !fit.provisional && fit.score >= HOT_THRESHOLD;
    expect(isHighFit).toBe(false);
  });

  it('invents no threshold of its own — it reuses TRACK_THRESHOLD', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'promisingQueue.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toContain('TRACK_THRESHOLD');
    // No hard-coded score literal anywhere in the logic.
    expect(src).not.toMatch(/>=\s*[0-9]+(\.[0-9]+)?\s*\)/);
    expect(src).not.toMatch(/HOT_THRESHOLD/);
  });

  it('adds no Overview KPI card', () => {
    const overview = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'pages', 'Overview.tsx'),
      'utf8',
    );
    expect(overview).not.toMatch(/Promising/i);
  });
});

/**
 * Displayed geography must never contradict the geography component's
 * assessability.
 *
 * The bug: the YC adapter had its own location parser that kept
 * `parts[0]` as the city and required a two-letter uppercase token for
 * the state. The directory returns a bare `["Los Angeles"]`, so a record
 * displayed "Los Angeles" while its geography component read
 * "not assessable" — two parsers disagreeing, presented as a
 * contradiction. Everything now goes through the one curated resolver.
 */
describe('displayed geography agrees with scoring assessability', () => {
  const displayed = (c: Company) => (c.city !== 'Unknown' ? c.city : '') + (c.state !== '??' ? `, ${c.state}` : '');

  it('a bare US city known to the curated resolver yields a scoring state', () => {
    for (const city of ['Los Angeles', 'San Francisco', 'New York City', 'Washington, DC, USA']) {
      const r = resolveCityState(city);
      expect(r, city).not.toBeNull();
      expect(r!.state, `${city} must resolve to a state`).toBeTruthy();
    }
  });

  it('a company showing a city AND a state is assessable on geography', () => {
    const c = promisingShape({ city: 'Los Angeles', state: 'CA' });
    const fit = scoreCompany(c, NOW);
    expect(fit.components.find((x) => x.key === 'geo')!.assessable).toBe(true);
    expect(displayed(c)).toBe('Los Angeles, CA');
  });

  it('an unresolvable foreign city keeps its city and stays UNassessable — never an invented state', () => {
    expect(resolveCityState('London')).toEqual({ city: 'London', state: null });
    const c = promisingShape({ city: 'London', state: '??' });
    const fit = scoreCompany(c, NOW);
    expect(fit.components.find((x) => x.key === 'geo')!.assessable).toBe(false);
    // And the display says so rather than implying a scored location.
    expect(displayed(c)).toBe('London');
  });

  it('geography assessability is decided by the STATE, and the display must not imply otherwise', () => {
    // The invariant, stated directly: for every combination, "we show a
    // state" and "geography scores" must agree.
    const combos: { city: string; state: string }[] = [
      { city: 'Austin', state: 'TX' },
      { city: 'Unknown', state: '??' },
      { city: 'London', state: '??' },
      { city: 'Los Angeles', state: 'CA' },
    ];
    for (const { city, state } of combos) {
      const c = promisingShape({ city, state });
      const assessable = scoreCompany(c, NOW).components.find((x) => x.key === 'geo')!.assessable;
      const showsState = state !== '??';
      expect(showsState, `${city}/${state}`).toBe(assessable);
    }
  });

  it('the YC adapter no longer carries a second location parser', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sourcing', 'adapters', 'ycombinator.ts'),
      'utf8',
    );
    expect(src).toContain('resolveCityState');
    // The old hand-rolled two-letter scan is gone.
    expect(src).not.toMatch(/parts\.find\(\(p\) => \/\^\[A-Z\]\{2\}\$\/\.test\(p\)\)/);
  });
});
