import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { discoveryCandidateSchema, type DiscoveryCandidate } from '../../shared/discovery';
import { assessQuality, countIndependentSources } from '../sourcing/qualitySignals';
import { scoreCompany, SCORING_VERSION } from '../../src/lib/scoring';
import { HOT_THRESHOLD, TRACK_THRESHOLD } from '../../shared/scoringThresholds';
import type { Company } from '../../src/types';

const NOW = new Date('2026-08-05T00:00:00.000Z');

function candidate(over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return discoveryCandidateSchema.parse({
    id: 'cand-1', runId: 'run-1', discoveredAt: '2026-08-01T00:00:00.000Z',
    sourceId: 'yc', simulated: false, companyName: 'Testco', confidence: 0.7,
    evidence: [{
      claim: 'Listed in the public YC directory.',
      source: 'Y Combinator', url: 'https://www.ycombinator.com/companies/testco',
      dateAccessed: '2026-08-01', publishedAt: '2026-07-01',
    }],
    ...over,
  });
}

/** A candidate with real, citable commercial evidence. */
const STRONG = candidate({
  id: 'strong',
  companyName: 'Gridline',
  pitch: 'Our customers include Xcel Energy and two other utilities. Deployed with grid operators to '
    + 'cut interconnection study time. Built on a proprietary dataset of 40 years of interconnection '
    + 'filings that improves with every use. Founded by former ERCOT engineers; PhD in power systems.',
  accelerator: 'Y Combinator (S26)',
  tractionSignals: ['$400k in contracts signed across 3 utilities'],
});

/** A candidate with nothing but adjectives. */
const HYPE = candidate({
  id: 'hype',
  companyName: 'Synergyx',
  pitch: 'We are building a revolutionary, next-generation platform to disrupt the energy industry '
    + 'with cutting-edge, world-class AI.',
});

const WRAPPER = candidate({
  id: 'wrapper',
  companyName: 'Promptly',
  pitch: 'A thin wrapper around GPT-4 that writes emails.',
});

const CONSULTANCY = candidate({
  id: 'consultancy',
  companyName: 'Northbridge',
  pitch: 'We provide consulting and managed services to help enterprises adopt machine learning, '
    + 'with white-glove implementation for every client.',
});

const MATURE = candidate({
  id: 'mature',
  companyName: 'Bigco',
  pitch: 'Bigco raised a $300M Series D at unicorn valuation.',
});

describe('stage 2 — evidence-backed quality prioritization', () => {
  it('ranks strong, citable evidence above hype', () => {
    const strong = assessQuality(STRONG, NOW);
    const hype = assessQuality(HYPE, NOW);
    expect(strong.priority).toBeGreaterThan(hype.priority);
    expect(strong.band).toBe('high');
    expect(hype.band).toBe('low');
  });

  it('deprioritizes thin AI wrappers', () => {
    const wrapper = assessQuality(WRAPPER, NOW);
    expect(wrapper.priority).toBeLessThan(assessQuality(STRONG, NOW).priority);
    expect(wrapper.signals.map((s) => s.key)).toContain('thin-wrapper');
  });

  it('deprioritizes consulting businesses presented as software', () => {
    const consultancy = assessQuality(CONSULTANCY, NOW);
    expect(consultancy.priority).toBeLessThan(assessQuality(STRONG, NOW).priority);
    expect(consultancy.signals.map((s) => s.key)).toContain('services-business');
  });

  it('deprioritizes companies past the target stage', () => {
    expect(assessQuality(MATURE, NOW).signals.map((s) => s.key)).toContain('mature-signal');
  });

  it('flags the absence of any identifiable buyer as a negative, not a neutral', () => {
    const s = assessQuality(HYPE, NOW).signals.find((x) => x.key === 'no-buyer');
    expect(s).toBeDefined();
    expect(s!.points).toBeLessThan(0);
  });

  it('never awards points merely for being an AI company', () => {
    const plainAi = assessQuality(candidate({ pitch: 'We use AI and machine learning and LLMs and neural networks.' }), NOW);
    const nothing = assessQuality(candidate({ pitch: 'A company.' }), NOW);
    expect(plainAi.priority).toBe(nothing.priority);
  });

  it('cites the exact published text behind every signal', () => {
    for (const s of assessQuality(STRONG, NOW).signals) {
      expect(s.evidence.length, s.key).toBeGreaterThan(0);
      // A signal fired from published text must quote a substring of it;
      // the two computed signals state their own basis instead.
      if (!['recent-momentum', 'corroborated', 'no-buyer'].includes(s.key)) {
        const haystack = `${STRONG.pitch} ${STRONG.accelerator} ${STRONG.tractionSignals.join(' ')} `
          + STRONG.evidence.map((e) => e.claim).join(' ');
        expect(haystack, s.key).toContain(s.evidence);
      }
    }
  });

  it('keeps the scale spread out instead of collapsing thin candidates onto one value', () => {
    // Calibration against live sources found 36 of 37 real candidates
    // tied on 0 when the scale started there, which made the value
    // useless for the one thing it exists to do. A neutral anchor keeps
    // "we know nothing", "we know something bad" and "we know something
    // good" distinguishable from each other.
    const nothingKnown = assessQuality(candidate({ pitch: 'A company.' }), NOW).priority;
    const somethingBad = assessQuality(WRAPPER, NOW).priority;
    const somethingGood = assessQuality(STRONG, NOW).priority;
    expect(somethingBad).toBeLessThan(nothingKnown);
    expect(nothingKnown).toBeLessThan(somethingGood);
    expect(nothingKnown).toBeGreaterThan(0);
    expect(new Set([somethingBad, nothingKnown, somethingGood]).size).toBe(3);
  });

  it('clamps the priority into 0–100 in both directions', () => {
    const awful = assessQuality(candidate({
      pitch: 'A thin wrapper around GPT-4. We provide consulting and managed services. '
        + 'Reportedly raised a $500M Series E. Revolutionary and cutting-edge.',
    }), NOW);
    expect(awful.priority).toBe(0);
    expect(assessQuality(STRONG, NOW).priority).toBeLessThanOrEqual(100);
  });

  describe('independent-source counting', () => {
    it('counts distinct sources', () => {
      expect(countIndependentSources([
        { claim: 'A raised $2M.', source: 'TechCrunch', url: 'https://techcrunch.com/a', dateAccessed: '2026-08-01', publishedAt: null, verificationStatus: 'Not verified', confidence: 0.5, notes: '', assertionType: 'fact' },
        { claim: 'A signed Xcel Energy.', source: 'Utility Dive', url: 'https://utilitydive.com/b', dateAccessed: '2026-08-01', publishedAt: null, verificationStatus: 'Not verified', confidence: 0.5, notes: '', assertionType: 'fact' },
      ])).toBe(2);
    });

    it('collapses one press release syndicated across many outlets to a single source', () => {
      const release = 'Acme today announced a $4M seed round led by Example Ventures.';
      expect(countIndependentSources([
        { claim: release, source: 'Outlet A', url: 'https://a.com/1', dateAccessed: '2026-08-01', publishedAt: null, verificationStatus: 'Not verified', confidence: 0.5, notes: '', assertionType: 'fact' },
        { claim: release, source: 'Outlet B', url: 'https://b.com/1', dateAccessed: '2026-08-01', publishedAt: null, verificationStatus: 'Not verified', confidence: 0.5, notes: '', assertionType: 'fact' },
        { claim: release, source: 'Outlet C', url: 'https://c.com/1', dateAccessed: '2026-08-01', publishedAt: null, verificationStatus: 'Not verified', confidence: 0.5, notes: '', assertionType: 'fact' },
      ])).toBe(1);
    });

    it('counts two articles from the same publisher as one source', () => {
      expect(countIndependentSources([
        { claim: 'Acme raised a seed round.', source: 'TechCrunch', url: 'https://techcrunch.com/1', dateAccessed: '2026-08-01', publishedAt: null, verificationStatus: 'Not verified', confidence: 0.5, notes: '', assertionType: 'fact' },
        { claim: 'Acme hired a new CTO.', source: 'TechCrunch', url: 'https://www.techcrunch.com/2', dateAccessed: '2026-08-01', publishedAt: null, verificationStatus: 'Not verified', confidence: 0.5, notes: '', assertionType: 'fact' },
      ])).toBe(1);
    });
  });
});

/**
 * The load-bearing separation in this whole pass. The triage priority is
 * allowed to influence which candidates get researched; it is not allowed
 * to influence, contaminate, or stand in for the official VamosVentures Fit
 * Score. These tests fail loudly if that ever stops being true.
 */
describe('the triage priority is isolated from the official VamosVentures Fit Score', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  /**
   * Comments are stripped before matching: both files DISCUSS the
   * separation at length in prose, and a test that cannot tell an import
   * from a sentence about imports would fail on its own documentation.
   */
  const codeOnly = (p: string) =>
    readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const qualitySrc = codeOnly(path.join(here, '..', 'sourcing', 'qualitySignals.ts'));
  const scoringSrc = codeOnly(path.join(here, '..', '..', 'src', 'lib', 'scoring.ts'));

  it('the quality module imports nothing from the scoring module', () => {
    expect(qualitySrc).not.toMatch(/from\s+['"].*lib\/scoring['"]/);
    expect(qualitySrc).not.toMatch(/\bscoreCompany\b/);
    expect(qualitySrc).not.toMatch(/\bsaveScore\b/);
  });

  it('the scoring module knows nothing about quality signals or candidate priority', () => {
    expect(scoringSrc).not.toMatch(/qualitySignals|qualityPriority|assessQuality|thesisFilter/);
  });

  it('the Vamos score of a company is unaffected by any candidate-side priority', () => {
    const company: Company = {
      id: 'iso-1', name: 'Isolation Co', oneLiner: 'Grid software.',
      vertical: 'sustainability', subcategory: 'Smart grids', stage: 'Seed',
      city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 4,
      traction: { level: 6, note: 'Three signed utility pilots.' },
      founders: [
        { name: 'A Founder', role: 'CEO', background: 'Former ERCOT engineer who founded a prior company.' },
        { name: 'B Founder', role: 'CTO', background: 'PhD, research scientist.' },
      ],
      evidence: [{ claim: 'Seed round filed.', source: 'SEC', url: 'https://sec.gov/x', date: '2026-07-20', type: 'Filing' }],
      flags: [], imported: true,
    } as unknown as Company;

    const before = scoreCompany(company, NOW);
    // Run the triage assessor over a maximally-strong candidate: it must
    // be a pure function with no side effects reaching the score.
    assessQuality(STRONG, NOW);
    assessQuality(HYPE, NOW);
    const after = scoreCompany(company, NOW);
    expect(after).toEqual(before);
  });
});

/**
 * Guards on the official rubric itself. This pass was explicitly not
 * allowed to inflate scores, and these are the specific numbers a
 * well-meaning "improvement" would drift.
 */
describe('the official Vamos rubric is unchanged', () => {
  it('keeps the 8.0 High-Fit threshold and the 6.5 track threshold', () => {
    expect(HOT_THRESHOLD).toBe(8);
    expect(TRACK_THRESHOLD).toBe(6.5);
  });

  it('keeps the ten components and their exact weights, summing to 100', () => {
    const company: Company = {
      id: 'w-1', name: 'Weights Co', oneLiner: 'x', vertical: 'health', subcategory: 'Cancer',
      stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 3,
      traction: { level: 5, note: 'Rated.' },
      founders: [{ name: 'F', role: 'CEO', background: 'Engineer who founded a prior company.' }],
      evidence: [{ claim: 'c', source: 's', url: 'https://example.com/1', date: '2026-07-20', type: 'Filing' }],
      flags: [], imported: true,
    } as unknown as Company;

    const weights = Object.fromEntries(scoreCompany(company, NOW).components.map((c) => [c.key, c.max]));
    expect(weights).toEqual({
      thesis: 20, stage: 15, mission: 15, traction: 10, founder: 10,
      geo: 10, funding: 5, validation: 5, evidence: 5, recency: 5,
    });
    expect(Object.values(weights).reduce((s, n) => s + n, 0)).toBe(100);
  });

  it('keeps the scoring model version — a rubric change must be a deliberate version bump', () => {
    // v4.0 → v4.1 is exactly the bump this test exists to force. The
    // WEIGHTS and the 8.0 threshold above are unchanged; what changed is
    // the provisional gate (NON_PROVISIONAL_POLICY), which only ever
    // moves a record from "assessed" to "provisional" and so only ever
    // removes companies from High-Fit. The stored-score re-scoring
    // workflow keys off this string, so it has to move when behaviour
    // does.
    expect(SCORING_VERSION).toBe('v4.1 (2026-08, evidence-gated provisional)');
  });

  it('the provisional gate can only demote, never promote', () => {
    // The specific inflation risk: a policy that flipped records TO
    // assessed would silently add companies to High-Fit. Every required
    // component is an additional condition on non-provisional, so the
    // set of assessed records under v4.1 is a strict subset of v4.0's
    // ("no company-descriptive component at all" is implied by "some
    // critical component is missing").
    const thin: Company = {
      id: 'thin-1', name: 'Thin Co', oneLiner: 'x', vertical: 'health', subcategory: 'Cancer',
      stage: 'Unknown', city: 'Unknown', state: 'TX', foundedYear: 2025, teamSize: 1,
      traction: { level: 0, note: 'Unknown — not yet researched' },
      founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
      evidence: [{ claim: 'c', source: 's', url: 'https://example.com/1', date: '2026-07-20', type: 'News' }],
      flags: [], imported: true,
    } as unknown as Company;
    const fit = scoreCompany(thin, NOW);
    // v4.0 would have called this assessed (thesis and geo are judgeable).
    expect(fit.components.find((x) => x.key === 'geo')!.assessable).toBe(true);
    // v4.1 does not.
    expect(fit.provisional).toBe(true);
  });
});

/**
 * Post-enrichment recomputation.
 *
 * The defect: `assessQuality` ran once at discovery time and nothing
 * recomputed it afterwards, so a stale value decided queue membership.
 * Grade came back LOW while carrying two cited founder backgrounds and a
 * published payment-volume claim, neither of which existed when the
 * number was first calculated.
 */
describe('quality priority is recomputed from the latest evidence', () => {
  /** Nothing but a one-liner: no accelerator, no dated evidence. */
  const bare = candidate({
    id: 'recompute',
    companyName: 'Gradelike',
    pitch: 'The API for performance-based payroll.',
    evidence: [{
      claim: 'Directory listing.', source: 'Directory',
      url: 'https://www.ycombinator.com/companies/gradelike', dateAccessed: '2026-08-01',
    }] as DiscoveryCandidate['evidence'],
  });

  it('a bare candidate scores low, as it should', () => {
    const q = assessQuality(bare, NOW);
    expect(q.band).toBe('low');
  });

  it('cited founder biographies move it UP', () => {
    const before = assessQuality(bare, NOW).priority;
    const after = assessQuality(bare, NOW, {
      founderBios: [{
        text: 'Lotanna Ezeike — CEO. 2x VC-backed founder. Previously at Barclays leading digital payments.',
        sourceUrl: 'https://www.ycombinator.com/companies/gradelike',
      }],
    });
    expect(after.priority).toBeGreaterThan(before);
    const fmf = after.signals.find((s) => s.key === 'founder-market-fit')!;
    expect(fmf).toBeDefined();
    expect(fmf.sourceUrl).toMatch(/ycombinator/);
    expect(fmf.provenance).toBe('company-claimed');
  });

  it('an UNCITED biography contributes nothing — missing citation stays neutral', () => {
    const before = assessQuality(bare, NOW).priority;
    const after = assessQuality(bare, NOW, {
      founderBios: [{ text: 'Previously product lead at Barclays.' }], // no sourceUrl
    });
    expect(after.priority).toBe(before);
    expect(after.signals.some((s) => s.key === 'founder-market-fit')).toBe(false);
  });

  it('company-claimed evidence counts, but at a discount', () => {
    const q = assessQuality(bare, NOW, {
      companyClaimed: [{
        text: 'Our customers include Acme Corp and two other payroll platforms.',
        sourceUrl: 'https://www.ycombinator.com/companies/gradelike',
      }],
    });
    const sig = q.signals.find((s) => s.direction === 'positive' && s.weight < 1);
    expect(sig).toBeDefined();
    expect(sig!.provenance).toBe('company-claimed');
    expect(sig!.points).toBeLessThan(sig!.fullPoints);
  });

  it('the same claim from published discovery text is worth MORE than a company-claimed one', () => {
    const claim = 'Our customers include Xcel Energy.';
    const asPublished = assessQuality(candidate({ pitch: claim }), NOW);
    const asClaimed = assessQuality(candidate({ pitch: 'A product.' }), NOW, {
      companyClaimed: [{ text: claim, sourceUrl: 'https://example.com/yc' }],
    });
    const p = asPublished.signals.find((s) => s.key === 'named-customers')!;
    const c = asClaimed.signals.find((s) => s.key === 'named-customers')!;
    expect(p.points).toBeGreaterThan(c.points);
    expect(p.provenance).toBe('published');
    expect(c.provenance).toBe('company-claimed');
  });

  it('a company-claimed WEAKNESS is not discounted', () => {
    // A company admitting a problem about itself is the most credible
    // version of that claim, so negatives keep full weight.
    const q = assessQuality(bare, NOW, {
      companyClaimed: [{ text: 'We are a consulting firm delivering managed services.', sourceUrl: 'https://example.com/yc' }],
    });
    const neg = q.signals.find((s) => s.key === 'services-business')!;
    expect(neg.weight).toBe(1);
    expect(neg.points).toBe(neg.fullPoints);
  });

  it('a founder biography can never fire a TRACTION signal', () => {
    // "At my last company, I managed $10M+ in contractor payouts" is
    // about a PREVIOUS company. It is founder-market-fit, never this
    // company's commercial proof.
    const q = assessQuality(bare, NOW, {
      founderBios: [{
        text: 'At my last company, I managed $10M+ in contractor payouts and 40,000 active users.',
        sourceUrl: 'https://example.com/yc',
      }],
    });
    expect(q.signals.some((s) => s.key === 'commercial-proof')).toBe(false);
    expect(q.signals.some((s) => s.key === 'named-customers')).toBe(false);
  });

  it('enrichment can move priority DOWN as well as up', () => {
    const before = assessQuality(bare, NOW).priority;
    const after = assessQuality(bare, NOW, {
      companyClaimed: [{ text: 'We were acquired by a larger firm after our Series C.', sourceUrl: 'https://example.com/yc' }],
    });
    expect(after.priority).toBeLessThan(before);
  });

  it('recomputation never touches the official score', () => {
    const company: Company = {
      id: 'rq-1', name: 'Recompute Co', oneLiner: 'x', vertical: 'health', subcategory: 'Cancer',
      stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 3,
      traction: { level: 5, note: 'Rated.' },
      founders: [{ name: 'F', role: 'CEO', background: 'Engineer who founded a prior company.' }],
      evidence: [{ claim: 'c', source: 's', url: 'https://example.com/1', date: '2026-07-20', type: 'Filing' }],
      flags: [], imported: true,
    } as unknown as Company;
    const before = scoreCompany(company, NOW);
    assessQuality(bare, NOW, {
      founderBios: [{ text: 'Previously at Stripe.', sourceUrl: 'https://example.com/x' }],
      companyClaimed: [{ text: 'Our customers include Acme Corp.', sourceUrl: 'https://example.com/y' }],
    });
    expect(scoreCompany(company, NOW)).toEqual(before);
    expect(before.components.map((x) => x.max)).toEqual([20, 15, 15, 10, 10, 10, 5, 5, 5, 5]);
  });
});

/**
 * Buyer clarity, not the word "enterprise".
 *
 * A manual review of the shortlist found four companies qualifying on a
 * bare "Enterprise" tag alone.
 */
describe('the enterprise-buyer signal requires a real buyer', () => {
  const fires = (text: string) =>
    assessQuality(candidate({ pitch: text }), NOW).signals.some((s) => s.key === 'enterprise-buyer');

  it('does NOT fire on a standalone tag or generic marketing language', () => {
    for (const t of [
      'Enterprise',
      'B2B, Enterprise, SaaS',
      'We build enterprise software.',
      'A platform for enterprises.',
      'Enterprise-grade security.',
      'Enterprise ready from day one.',
    ]) {
      expect(fires(t), t).toBe(false);
    }
  });

  it('fires on a concrete institution type', () => {
    for (const t of [
      'Scheduling software for hospitals and health systems.',
      'Underwriting for credit unions.',
      'Interconnection studies for grid operators.',
      'Permitting software for municipalities.',
      'Robotic labor for warehouses.',
    ]) {
      expect(fires(t), t).toBe(true);
    }
  });

  it('fires on a buyer role or department', () => {
    for (const t of ['Built for CISOs.', 'Sold to procurement.', 'For engineering leaders.', 'For GTM teams.']) {
      expect(fires(t), t).toBe(true);
    }
  });

  it('fires on "enterprise" only when bound to a buyer noun', () => {
    expect(fires('We serve enterprise customers.')).toBe(true);
    expect(fires('Two enterprise contracts signed.')).toBe(true);
    expect(fires('Fortune 500 deployments.')).toBe(true);
    expect(fires('An enterprise platform.')).toBe(false);
  });

  it('sector, geography and an accelerator alone never fire it', () => {
    expect(fires('A FinTech company in San Francisco.')).toBe(false);
    expect(assessQuality(candidate({ pitch: 'A product.', accelerator: 'Y Combinator (S26)' }), NOW)
      .signals.some((s) => s.key === 'enterprise-buyer')).toBe(false);
  });
});

/**
 * Two misattributions found by running the assessor against the four
 * real YC profiles. Both are about reading a sentence as evidence of
 * the wrong thing.
 */
describe('founder-market fit reads real biography prose', () => {
  const bio = (text: string) => assessQuality(
    candidate({ pitch: 'A product.' }), NOW,
    { founderBios: [{ text, sourceUrl: 'https://example.com/yc' }] },
  ).signals.some((s) => s.key === 'founder-market-fit');

  it('fires on "Previously, I …" — the comma broke it before', () => {
    // Grade's two founders and Unifold's co-founder all write it this
    // way, and all three produced no signal at all.
    expect(bio('Previously, I built and exited my first cryptography startup.')).toBe(true);
    expect(bio('Previously, I co-founded Streambird, a wallet-as-a-service company.')).toBe(true);
    expect(bio('Previously at Barclays leading digital payments.')).toBe(true);
  });

  it('fires on the other shapes real bios use', () => {
    expect(bio('Most recently spent 2.5 years at MoonPay building consumer apps.')).toBe(true);
    expect(bio('A full-stack engineer with 15+ years of experience across fintech.')).toBe(true);
    expect(bio('PhD in Applied Mathematics from Caltech.')).toBe(true);
    expect(bio('Ex-Anduril and Applied Intuition.')).toBe(true);
  });

  it('does not fire on a bare education line', () => {
    // Where someone studied is not operating or research experience.
    expect(bio('Graduated from Cornell Tech.')).toBe(false);
  });
});

describe('a prior company’s exit does not make THIS company mature', () => {
  const claimed = (text: string) => assessQuality(
    candidate({ pitch: 'A product.' }), NOW,
    { companyClaimed: [{ text, sourceUrl: 'https://example.com/yc' }] },
  );

  it('ignores a maturity phrase framed as history', () => {
    // Unifold's own launch post. It was costing a current W26 company 20
    // points and pushing it off the shortlist.
    const q = claimed('Before Unifold, we built wallet-as-a-service infrastructure and were acquired by a leading crypto payments company.');
    expect(q.signals.some((s) => s.key === 'mature-signal')).toBe(false);
  });

  it('still catches a maturity claim about the company itself', () => {
    expect(claimed('We raised a $300M Series D last year.').signals.some((s) => s.key === 'mature-signal')).toBe(true);
    expect(claimed('The company was acquired by Oracle.').signals.some((s) => s.key === 'mature-signal')).toBe(true);
  });

  it('covers the other ways a bio frames the past', () => {
    for (const t of [
      'At my last company, we IPO’d on the NASDAQ.',
      'My previous startup was acquired by Google.',
      'Prior to founding this, I ran a unicorn.',
    ]) {
      expect(claimed(t).signals.some((s) => s.key === 'mature-signal'), t).toBe(false);
    }
  });
});
