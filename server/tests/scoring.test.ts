import { describe, expect, it } from 'vitest';
import { evidenceConfidence, SCORING_VERSION, scoreCompany } from '../../src/lib/scoring';
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
      { ...base, vertical: 'aoi', subcategory: 'Robotics', flags: ['hardware-heavy'] },
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
