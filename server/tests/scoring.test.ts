import { describe, expect, it } from 'vitest';
import { evidenceConfidence, NON_PROVISIONAL_POLICY, SCORING_VERSION, scoreCompany } from '../../src/lib/scoring';
import { HOT_THRESHOLD } from '../../shared/scoringThresholds';
import type { Company } from '../../src/types';

/**
 * Scoring invariants (replaces the old scripts/smoke.ts, which
 * validated the deleted bundled sample dataset). Fixture companies
 * live only in this test file.
 */

const base: Company = {
  id: 'test-co',
  name: 'Test Fixture Health',
  oneLiner: 'A fixture company used only by this test.',
  vertical: 'health',
  subcategory: 'Personalized care (AI / tech-enabled)',
  stage: 'Seed',
  city: 'Austin',
  state: 'TX',
  foundedYear: 2025,
  teamSize: 8,
  traction: { level: 6, note: 'Fixture traction note for testing.' },
  founders: [
    {
      name: 'A. Fixture',
      role: 'CEO',
      background: 'Fixture background.',
      identity: {
        latinoLed: true,
        basis: 'Self-identified',
        source: 'Fixture verification source (test only)',
      },
    },
  ],
  evidence: [
    { claim: 'Fixture claim', source: 'Fixture source', url: 'https://example.com/fixture', date: '2026-06-01', type: 'News' },
  ],
  flags: [],
};

describe('Vamos Fit scoring invariants', () => {
  it('keeps every score in the 1.0–10.0 range and breakdowns summing to the total', () => {
    const variants: Company[] = [
      base,
      { ...base, vertical: 'frontier', subcategory: 'Humanoid & general-purpose robots', flags: ['hardware-heavy'] },
      { ...base, stage: 'Pre-seed', state: 'FL', founders: [{ name: 'B. Fixture', role: 'CTO', background: 'x' }] },
      { ...base, traction: { level: 0, note: 'Unknown — not yet researched' }, evidence: base.evidence },
    ];
    for (const c of variants) {
      const fit = scoreCompany(c);
      expect(fit.score).toBeGreaterThanOrEqual(1);
      expect(fit.score).toBeLessThanOrEqual(10);
      const sum = fit.components.reduce((s, x) => s + x.points, 0);
      expect(sum).toBe(fit.totalPoints);
    }
  });

  it('uses a repeatable weighted framework: weights sum to 100 and every component is explained', () => {
    const fit = scoreCompany(base);
    expect(fit.components.reduce((s, x) => s + x.max, 0)).toBe(100);
    expect(fit.version).toBe(SCORING_VERSION);
    for (const comp of fit.components) {
      expect(comp.rationale.length).toBeGreaterThan(10); // no unexplained numbers
      expect(comp.points).toBeLessThanOrEqual(comp.max);
    }
    const keys = fit.components.map((x) => x.key);
    for (const k of ['thesis', 'stage', 'mission', 'traction', 'founder', 'geo', 'funding', 'validation', 'evidence', 'recency']) {
      expect(keys).toContain(k);
    }
    expect(fit.explanation).toContain('Vamos Fit Score');
    expect(fit.explanation).toContain(SCORING_VERSION);
  });

  it('keeps evidence confidence separate from the fit score', () => {
    const fit = scoreCompany(base);
    expect(fit.evidenceConfidence).toBeGreaterThanOrEqual(0);
    expect(fit.evidenceConfidence).toBeLessThanOrEqual(1);
    // Same company facts, richer evidence → confidence rises; fit-relevant facts unchanged.
    const richer = scoreCompany({
      ...base,
      evidence: [
        ...base.evidence,
        { claim: 'Form D filed', source: 'SEC EDGAR', url: 'https://example.com/f2', date: new Date().toISOString().slice(0, 10), type: 'Filing' },
        { claim: 'Founder interview', source: 'Podcast', url: 'https://example.com/f3', date: new Date().toISOString().slice(0, 10), type: 'Founder statement' },
      ],
    });
    expect(richer.evidenceConfidence).toBeGreaterThan(fit.evidenceConfidence);
    expect(evidenceConfidence({ ...base, evidence: [] } as typeof base)).toBe(0);
  });

  it('scores funding evidence and institutional validation from recorded facts only', () => {
    const bare = scoreCompany(base);
    const funded = scoreCompany({ ...base, raising: '$3M seed', lastFundingDate: new Date().toISOString().slice(0, 10) });
    const fundingOf = (fit: ReturnType<typeof scoreCompany>) => fit.components.find((x) => x.key === 'funding')!;
    expect(fundingOf(bare).points).toBe(0); // unknown funding is unscored, not guessed
    expect(fundingOf(funded).points).toBe(5);

    const accelerated = scoreCompany({ ...base, accelerator: 'Techstars 2026' });
    const validationOf = (fit: ReturnType<typeof scoreCompany>) => fit.components.find((x) => x.key === 'validation')!;
    expect(validationOf(bare).points).toBe(0);
    expect(validationOf(accelerated).points).toBeGreaterThan(0);
  });

  it('rewards evidence recency without inventing dates', () => {
    const fresh = scoreCompany({
      ...base,
      evidence: [{ claim: 'Fresh claim', source: 'src', url: 'https://example.com/fresh', date: new Date().toISOString().slice(0, 10), type: 'News' }],
    });
    const old = scoreCompany({
      ...base,
      evidence: [{ claim: 'Old claim', source: 'src', url: 'https://example.com/old', date: '2020-01-01', type: 'News' }],
    });
    const recencyOf = (fit: ReturnType<typeof scoreCompany>) => fit.components.find((x) => x.key === 'recency')!.points;
    expect(recencyOf(fresh)).toBe(5);
    expect(recencyOf(old)).toBe(1);
  });

  it('flags policy exceptions without rejecting or zeroing the score', () => {
    const flagged = scoreCompany({ ...base, flags: ['defi-adjacent'] });
    expect(flagged.exceptions.length).toBeGreaterThan(0);
    expect(flagged.score).toBeGreaterThanOrEqual(1);
  });

  it('mission-alignment points come only from verified identity — absent identity earns zero, never inferred', () => {
    const verified = scoreCompany(base);
    const unverified = scoreCompany({
      ...base,
      founders: [{ name: 'A. Fixture', role: 'CEO', background: 'Fixture background.' }],
    });
    const missionOf = (fit: ReturnType<typeof scoreCompany>) =>
      fit.components.find((x) => x.key === 'mission')!.points;
    expect(missionOf(verified)).toBeGreaterThan(0);
    expect(missionOf(unverified)).toBe(0);
  });
});

// ── Normalization over assessable components ──────────────────────

describe('normalized scoring (v4)', () => {
  /** A bare Form D record: real filing, nothing else recorded. */
  const bare: Company = {
    id: 'bare-co',
    name: 'BARE FILER, INC.',
    oneLiner: 'Unknown — not stated by the source',
    vertical: 'health',
    subcategory: 'Unclassified — requires manual review',
    stage: 'Unknown',
    city: 'Unknown',
    state: '??',
    foundedYear: 0,
    teamSize: 0,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [
      { claim: 'Form D', source: 'SEC', url: 'https://www.sec.gov/x', date: '2026-07-01', type: 'Filing' },
    ],
    flags: [],
  };

  it('is arithmetically identical to the absolute model when everything is assessable', () => {
    // Stage, state, classification, traction rating, verified self-ID,
    // dated evidence AND funding — every component can be judged, so
    // normalizing must change nothing at all.
    const fit = scoreCompany({ ...base, raising: '$4M seed', lastFundingDate: '2026-06-15' });
    expect(fit.components.every((x) => x.assessable)).toBe(true);
    expect(fit.assessablePoints).toBe(100);
    expect(fit.completeness).toBe(1);
    expect(fit.score).toBe(Math.max(1, Math.round(fit.totalPoints) / 10));
    expect(fit.provisional).toBe(false);
  });

  it('excludes unmeasured components from the score instead of scoring them zero', () => {
    const fit = scoreCompany(bare);
    const unassessed = fit.components.filter((x) => !x.assessable).map((x) => x.key);

    // These are gaps in our data, not findings about the company.
    expect(unassessed).toEqual(expect.arrayContaining(['thesis', 'stage', 'mission', 'traction', 'founder', 'geo', 'funding']));
    // Excluded from the denominator, so completeness reports the truth.
    expect(fit.assessablePoints).toBeLessThan(100);
    expect(fit.completeness).toBeCloseTo(fit.assessablePoints / 100, 5);
    // And from the numerator — the score never counts an unknown as points.
    const earned = fit.components.filter((x) => x.assessable).reduce((s, x) => s + x.points, 0);
    expect(fit.score).toBeCloseTo(Math.max(1, Math.round((earned / fit.assessablePoints) * 100) / 10), 5);
  });

  it('marks a score provisional when nothing about the COMPANY could be judged', () => {
    // The guard against the failure normalizing introduces: accelerator
    // validation, evidence quality, and evidence recency all measure our
    // own sourcing and are always assessable, so a bare filing would
    // otherwise produce a confident number containing no statement about
    // the company at all.
    const fit = scoreCompany(bare);
    expect(fit.provisional).toBe(true);
    expect(fit.provisionalReason).toMatch(/critical component/i);
    expect(fit.components.filter((x) => x.assessable).every((x) => x.about === 'our-evidence')).toBe(true);
  });

  /**
   * v4.1 replaced "one company fact is enough" with an evidence-backed
   * policy. Recording a single location no longer makes a score
   * assessed — a live preview run produced 7.1/10 records at 35%
   * completeness with no stage, traction, founder or funding, and they
   * were ranking against genuinely researched companies and qualifying
   * for High-Fit. See NON_PROVISIONAL_POLICY.
   */
  it('stays provisional when only one company-descriptive fact is recorded', () => {
    const fit = scoreCompany({ ...bare, state: 'TX' });
    expect(fit.components.find((x) => x.key === 'geo')!.assessable).toBe(true);
    expect(fit.provisional).toBe(true);
    // The reason must NAME what is missing, so the record is actionable.
    expect(fit.provisionalReason).toMatch(/stage/);
    expect(fit.provisionalReason).toMatch(/traction/);
  });

  it('becomes non-provisional only when every critical component is judgeable', () => {
    const fit = scoreCompany(base);
    for (const key of NON_PROVISIONAL_POLICY.requiredComponents) {
      expect(fit.components.find((x) => x.key === key)!.assessable, key).toBe(true);
    }
    expect(fit.completeness).toBeGreaterThanOrEqual(NON_PROVISIONAL_POLICY.minCompleteness);
    expect(fit.provisional).toBe(false);
    expect(fit.provisionalReason).toBeNull();
  });

  it('drops back to provisional when any single critical component is removed', () => {
    // One at a time, so a failure names the component that stopped
    // being enforced rather than just "something changed".
    const removals: { key: string; company: Company }[] = [
      { key: 'thesis', company: { ...base, subcategory: 'Unclassified — requires manual review' } },
      { key: 'stage', company: { ...base, stage: 'Unknown' } },
      { key: 'traction', company: { ...base, traction: { level: 0, note: 'Unknown — not yet researched' } } },
      { key: 'founder', company: { ...base, founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }] } },
      { key: 'geo', company: { ...base, state: '??' } },
    ];
    for (const { key, company } of removals) {
      const fit = scoreCompany(company);
      expect(fit.components.find((x) => x.key === key)!.assessable, `${key} should be unassessable`).toBe(false);
      expect(fit.provisional, `removing ${key} must force provisional`).toBe(true);
    }
  });

  it('does NOT require mission alignment — unknown diversity data is never a penalty', () => {
    // Mission alignment needs voluntary founder self-identification,
    // which this codebase refuses to infer and the approved policy says
    // must not become an automatic rejection. Requiring it would make
    // non-provisional unreachable for every company on file.
    expect(NON_PROVISIONAL_POLICY.requiredComponents).not.toContain('mission');
    const fit = scoreCompany(base);
    expect(fit.components.find((x) => x.key === 'mission')!.assessable).toBe(true);
    // Same company, self-ID withdrawn: mission becomes unassessable, and
    // the score must still be presentable as assessed.
    const withoutSelfId = scoreCompany({
      ...base,
      founders: base.founders.map((f) => ({ ...f, identity: undefined })),
    });
    expect(withoutSelfId.components.find((x) => x.key === 'mission')!.assessable).toBe(false);
    expect(withoutSelfId.provisional).toBe(false);
  });

  it('requires at least one cited source URL', () => {
    const uncited = scoreCompany({ ...base, evidence: [] });
    expect(uncited.provisional).toBe(true);
    expect(uncited.provisionalReason).toMatch(/cited source/i);
  });

  it('can only move a record toward provisional — it never raises a score', () => {
    // The policy is a labelling gate, not a scoring input: the numeric
    // score for a given company is identical whatever the flag says.
    const thin = scoreCompany({ ...bare, state: 'TX' });
    const earned = thin.components.filter((x) => x.assessable).reduce((s, x) => s + x.points, 0);
    expect(thin.score).toBeCloseTo(Math.max(1, Math.round((earned / thin.assessablePoints) * 100) / 10), 5);
  });

  it('never inflates: adding an unmeasured component cannot raise the score', () => {
    const withoutStage = scoreCompany({ ...bare, state: 'TX' });
    // Recording a stage adds an assessable component worth 15, scoring 15
    // for Seed — the best possible. The score may rise, but the point is
    // that leaving it UNRECORDED never quietly helped: an unknown is
    // excluded, so it can neither help nor hurt.
    const unknownStage = scoreCompany({ ...bare, state: 'TX', stage: 'Unknown' });
    expect(unknownStage.score).toBe(withoutStage.score);
    expect(unknownStage.assessablePoints).toBe(withoutStage.assessablePoints);
  });

  it('reports completeness and the gap in the explanation', () => {
    const fit = scoreCompany(bare);
    expect(fit.explanation).toContain('assessable points');
    expect(fit.explanation).toMatch(/completeness/i);
    expect(fit.explanation).toMatch(/never findings against the company/i);
  });

  it('is deterministic: identical input with a pinned clock produces an identical score and explanation', () => {
    const today = new Date('2026-06-15T00:00:00.000Z');
    const first = scoreCompany(base, today);
    const second = scoreCompany({ ...base }, today);
    expect(second.score).toBe(first.score);
    expect(second.explanation).toBe(first.explanation);
    expect(second.components).toEqual(first.components);
  });

  it('is reproducible across calendar days for evidence-recency and funding-recency components once `today` is pinned', () => {
    // Before `today` was injectable, fundingEvidence/evidenceRecency read
    // Date.now() directly, so the same stored record could score
    // differently depending on which day the test (or a real KPI
    // computation) happened to run. Pinning `today` closes that gap.
    const today = new Date('2026-06-15T00:00:00.000Z');
    const c = { ...base, lastFundingDate: '2026-05-01', evidence: [...base.evidence, { claim: 'Funded', source: 'Fixture', url: 'https://example.com/f', date: '2026-06-01', type: 'News' as const }] };
    const runs = Array.from({ length: 5 }, () => scoreCompany(c, today));
    expect(new Set(runs.map((r) => r.score)).size).toBe(1);
    expect(new Set(runs.map((r) => r.explanation)).size).toBe(1);
  });

  describe('Hot threshold boundary (score >= 8.0)', () => {
    // A fully-assessable fixture (assessablePoints === 100) so a 1-unit
    // change in analyst traction rating moves the score by exactly 0.1 —
    // the fine-grained lever used to land precisely either side of 8.0.
    const boundaryBase: Company = {
      ...base,
      founders: [
        {
          name: 'A. Fixture', role: 'CEO', background: 'Founded a startup before; ex-Google engineer.',
          identity: { latinoLed: true, femaleLed: true, basis: 'Self-identified', source: 'Fixture verification source (test only)' },
        },
        { name: 'B. Fixture', role: 'CTO', background: 'Founded a company before; ex-Meta engineer.' },
      ],
      evidence: [{ claim: 'Fixture claim', source: 'Fixture source A', url: 'https://example.com/fixture-a', date: '2026-06-01', type: 'News' }],
      raising: '$2M seed',
      lastFundingDate: '2026-05-01',
    };
    const today = new Date('2026-06-15T00:00:00.000Z');

    it('just below the boundary (7.9) is not Hot', () => {
      const fit = scoreCompany({ ...boundaryBase, traction: { level: 1, note: 'x' } }, today);
      expect(fit.assessablePoints).toBe(100);
      expect(fit.score).toBe(7.9);
      expect(fit.score >= HOT_THRESHOLD).toBe(false);
    });

    it('exactly at the boundary (8.0) IS Hot', () => {
      const fit = scoreCompany({ ...boundaryBase, traction: { level: 2, note: 'x' } }, today);
      expect(fit.assessablePoints).toBe(100);
      expect(fit.score).toBe(8.0);
      expect(fit.score >= HOT_THRESHOLD).toBe(true);
    });

    it('a provisional score never counts as Hot regardless of its numeric value', () => {
      // bare has no company-descriptive component assessable at all, so
      // it is provisional — Overview/CompanyTable/executiveKpis all
      // exclude provisional scores from "Hot" even if the raw number
      // happens to clear the threshold.
      const fit = scoreCompany(bare, today);
      expect(fit.provisional).toBe(true);
    });
  });
});
