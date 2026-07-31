import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import {
  listFounderCandidates, listResearchAttempts, latestCorrections,
  recordFieldCorrection, recordResearchAttempt, relationshipsFor, reviewFounderCandidate,
  saveFounderResolution, saveStageResolution, saveVerticalClassification,
  upsertFounderCandidate, upsertRelationship,
} from '../db/repos/enrichment';
import { companyEnrichment } from '../services/enrichmentView';
import { deriveFounderStatus } from '../services/enrichment';
import {
  cleanTitle, classifyFormDRelationship, extractPeopleFromHtml, isFounderTitle,
  looksLikePersonName, trimToName,
} from '../enrichment/founderExtraction';
import {
  classifyCompany, classifyFromDirectoryCategories, scoreSectors,
} from '../enrichment/verticalClassifier';
import {
  isExplicitStageClaim, readStatedStage, resolveStage,
  type StageContext, type StageEvidenceItem,
} from '../enrichment/stageResolver';
import { buildResearchPlan, primaryDocFromIndexUrl } from '../enrichment/researchPlan';
import {
  ENRICHMENT_VERSION, meetsMatchThreshold, NON_SECTOR_STATUS, outcomeAnswered,
  outcomeInconclusive, personKey, scoreMatch,
} from '../../shared/enrichment';
import type { Company } from '../../src/types';

/**
 * Founder / vertical / stage enrichment.
 *
 * The behaviour being pinned down here is mostly REFUSAL: what the
 * pipeline declines to assert. A missing founder is a gap a reviewer
 * fills in ten minutes; a wrong founder is a false statement naming a
 * private individual that flows into outreach, a CRM, and a partner
 * conversation. Most of these tests exist to keep the second from
 * happening, and several of them encode bugs that a live dry run
 * actually produced.
 */

const now = '2026-07-30T12:00:00.000Z';

function company(id: string, over: Partial<Company> = {}): Company {
  return {
    id, name: (over.name as string) ?? `Company ${id}`,
    oneLiner: over.oneLiner ?? 'A company.',
    vertical: over.vertical ?? 'health', subcategory: over.subcategory ?? 'Healthcare',
    stage: over.stage ?? 'Unknown', city: over.city ?? 'Austin', state: over.state ?? 'TX',
    foundedYear: over.foundedYear ?? 2024, teamSize: over.teamSize ?? 5,
    traction: over.traction ?? { level: 0, note: 'Not researched' },
    founders: over.founders ?? [],
    evidence: over.evidence ?? [{
      claim: 'Filed a Form D.', source: 'SEC EDGAR (Form D)',
      url: 'https://www.sec.gov/Archives/edgar/data/123/000012325000001/0000123-25-000001-index.htm',
      date: '2026-05-01', type: 'Filing',
    }],
    flags: over.flags ?? [],
    website: over.website,
    accelerator: over.accelerator,
  };
}

function seed(id: string, over: Partial<Company> = {}): Company {
  const c = company(id, over);
  saveCompany({ ...c, imported: true } as never, { origin: 'extracted', source: 'test' });
  return c;
}

// ── Match scoring: a shared name is never a match ─────────────────

describe('identity matching', () => {
  it('scores a name-only agreement at zero, so it can never attach a person to a company', () => {
    expect(scoreMatch(['name-only'])).toBe(0);
    expect(meetsMatchThreshold(['name-only'])).toBe(false);
  });

  it('still refuses a name match stacked with weak circumstantial signals', () => {
    // Geography plus a domain mention plus a shared name is exactly the
    // shape of a coincidence: a person in the same city whose name appears
    // on a page that also mentions the company. It must not add up.
    expect(meetsMatchThreshold(['name-only', 'geography-agrees', 'domain-in-source'])).toBe(false);
  });

  it('accepts a statement on the company’s own domain', () => {
    expect(meetsMatchThreshold(['statement-on-company-domain'])).toBe(true);
  });

  it('accepts a related person on the company’s own SEC filing', () => {
    expect(meetsMatchThreshold(['sec-related-person'])).toBe(true);
  });

  it('deduplicates signals so repeating one cannot inflate the score', () => {
    expect(scoreMatch(['title-stated-in-source', 'title-stated-in-source'])).toBe(2);
  });
});

describe('personKey', () => {
  it('folds case, punctuation, and accents for the same human', () => {
    expect(personKey('Oriana Papin-Zoghbi')).toBe(personKey('oriana papin-zoghbi'));
    expect(personKey('José García')).toBe(personKey('Jose Garcia'));
  });

  it('does NOT merge a nickname with a full name', () => {
    // Two keys that should merge but do not produce a visible duplicate a
    // reviewer resolves in one click. Two that merge but should not fuse
    // two people's identities, which nothing downstream can undo.
    expect(personKey('Rob Smith')).not.toBe(personKey('Robert Smith'));
  });
});

// ── Founder extraction ────────────────────────────────────────────

describe('founder extraction', () => {
  it('rejects marketing phrases that look like names', () => {
    expect(looksLikePersonName('Our Team')).toBe(false);
    expect(looksLikePersonName('Privacy Policy')).toBe(false);
    expect(looksLikePersonName('New York')).toBe(false);
    expect(looksLikePersonName('Book Demo')).toBe(false);
  });

  it('rejects single tokens and over-long runs', () => {
    expect(looksLikePersonName('Alex')).toBe(false);
    expect(looksLikePersonName('One Two Three Four Five')).toBe(false);
  });

  it('accepts ordinary and particled names', () => {
    expect(looksLikePersonName('Oriana Papin-Zoghbi')).toBe(true);
    expect(looksLikePersonName('Maria de la Cruz')).toBe(true);
  });

  it('does not treat an advisor or board member as a founder title', () => {
    expect(isFounderTitle('advisor')).toBe(false);
    expect(isFounderTitle('board member')).toBe(false);
    expect(isFounderTitle('former ceo')).toBe(false);
    expect(isFounderTitle('co-founder & ceo')).toBe(true);
  });

  /**
   * A real extraction from a live team page. The rendered text runs
   * together as "…Alex Fisher Position — Chief Operating Officer &
   * Co-Founder Categories: Leadership Alex…", and the first version of
   * this module returned the NAME "Co-Founder Alex Fisher Position".
   *
   * A malformed name is not cosmetic: it is stored as a person, shown as
   * a founder, and matched against other sources, so it corrupts the
   * identity graph rather than merely looking wrong.
   */
  it('trims a capitalised run down to the person’s name', () => {
    // Role and structure words are never part of a name.
    expect(trimToName('Co-Founder Alex Fisher Position')).toBe(null);
    // The name sits at the END of the captured run, so the tail is taken.
    expect(trimToName('Leadership Alex Fisher')).toBe('Alex Fisher');
    expect(trimToName('Alex Fisher')).toBe('Alex Fisher');
  });

  it('cuts a captured title at the next section boundary', () => {
    expect(cleanTitle('Chief Operating Officer & Co-Founder Categories: Leadership Ale'))
      .toBe('Chief Operating Officer & Co-Founder');
    expect(cleanTitle('Advisor')).toBe(null);
  });

  it('extracts a name and title from a real-shaped team page', () => {
    const html = `<html><body><div>Our Team</div>
      <div>Jane Okonkwo — Co-Founder & CEO</div>
      <div>Priya Raman, Chief Technology Officer</div>
      <div>Sam Delacroix, Advisor</div>
      </body></html>`;
    const people = extractPeopleFromHtml(html);
    const names = people.map((p) => p.fullName);
    expect(names).toContain('Jane Okonkwo');
    expect(names).toContain('Priya Raman');
    // The advisor is deliberately absent — a board or advisory role is
    // not a founder, and returning one would name the wrong person.
    expect(names).not.toContain('Sam Delacroix');
  });

  it('returns nothing from a page that names nobody', () => {
    expect(extractPeopleFromHtml('<html><body><p>We build software for hospitals.</p></body></html>')).toEqual([]);
  });

  it('classifies Form D relationships without conflating a director with an officer', () => {
    expect(classifyFormDRelationship('Executive Officer')).toBe('officer');
    expect(classifyFormDRelationship('Director')).toBe('director');
    expect(classifyFormDRelationship('Promoter')).toBe('promoter');
  });
});

// ── Conflicts ─────────────────────────────────────────────────────

describe('founder conflicts', () => {
  const attempts = [
    { family: 'company-site' as const, outcome: 'found-candidate' as const },
    { family: 'sec-form-d' as const, outcome: 'found-candidate' as const },
  ];

  const candidate = (name: string, title: string, family: 'company-site' | 'sec-form-d' = 'company-site') => ({
    personKey: personKey(name), fullName: name, title,
    sourceUrl: `https://example.com/${name.replace(/\s/g, '')}`,
    sourceFamily: family, sourceType: 'Team page', publishedAt: null,
    supportingText: `${name} — ${title}`,
    matchSignals: ['statement-on-company-domain' as const, 'title-stated-in-source' as const],
    matchScore: 7, confidence: 0.8,
  });

  it('reports a conflict when two people are each named to the same singular role', () => {
    const v = deriveFounderStatus('Acme', [
      candidate('Jane Okonkwo', 'CEO'),
      candidate('Priya Raman', 'Chief Executive Officer'),
    ], attempts, now);
    expect(v.status).toBe('conflicting-founder-evidence');
    expect(v.resolvedName).toBe(null);
    expect(v.summary).toContain('Jane Okonkwo');
    expect(v.summary).toContain('Priya Raman');
  });

  it('does NOT report a conflict for two co-founders', () => {
    const v = deriveFounderStatus('Acme', [
      candidate('Jane Okonkwo', 'Co-Founder'),
      candidate('Priya Raman', 'Co-Founder'),
    ], attempts, now);
    expect(v.status).toBe('verified-founder');
  });

  /**
   * The bug this test exists for: a plain substring check read "Director"
   * as "CTO" — d-i-r-e-**c-t-o**-r — so every Form D director became a
   * competing CTO claim, and any company with two directors on its filing
   * was reported as having conflicting founder evidence. A live dry run
   * surfaced exactly that on a real company.
   *
   * A false conflict is not harmless over-caution: it buries a real
   * answer under a warning and sends a reviewer to arbitrate a dispute
   * that does not exist.
   */
  it('does not read "Director" as "CTO"', () => {
    const v = deriveFounderStatus('Acme', [
      candidate('Jane Okonkwo', 'Executive Officer', 'sec-form-d'),
      candidate('Priya Raman', 'Director', 'sec-form-d'),
      candidate('Sam Delacroix', 'Director', 'sec-form-d'),
    ], attempts, now);
    expect(v.status).not.toBe('conflicting-founder-evidence');
    // The officer is the verified person; neither director is.
    expect(v.resolvedName).toBe('Jane Okonkwo');
  });

  it('never verifies a Form D director on its own — a board seat is often an investor’s', () => {
    const v = deriveFounderStatus('Acme', [candidate('Priya Raman', 'Director', 'sec-form-d')], attempts, now);
    expect(v.status).toBe('probable-founder-candidate');
    expect(v.resolvedName).toBe(null);
  });
});

// ── Research exhaustion vs. failure ───────────────────────────────

describe('research outcomes', () => {
  it('separates an answered source from an attempted one', () => {
    expect(outcomeAnswered('reached-no-founder-stated')).toBe(true);
    expect(outcomeAnswered('source-not-applicable')).toBe(true);
    expect(outcomeAnswered('source-unreachable')).toBe(false);
    expect(outcomeAnswered('source-unreadable')).toBe(false);
    expect(outcomeInconclusive('source-unreadable')).toBe(true);
  });

  it('calls research exhausted only when every source actually answered', () => {
    const v = deriveFounderStatus('Acme', [], [
      { family: 'company-site', outcome: 'reached-no-founder-stated' },
      { family: 'sec-form-d', outcome: 'reached-no-founder-stated' },
      { family: 'accelerator', outcome: 'source-not-applicable' },
    ], now);
    expect(v.status).toBe('research-exhausted');
    expect(v.summary).toContain('Founder research completed July 30, 2026');
    expect(v.summary).toContain('Manual review queued');
    expect(v.nextAction.length).toBeGreaterThan(10);
  });

  /**
   * A timeout is an attempt, not a finding. Reporting a network failure
   * as "we looked everywhere and there is no founder" would state
   * something about a real company that we did not learn — and
   * "exhausted" is the one claim in this pipeline that has to be
   * trustworthy.
   */
  it('does not claim exhaustion when a source did not respond', () => {
    const v = deriveFounderStatus('Acme', [], [
      { family: 'company-site', outcome: 'source-unreachable' },
      { family: 'sec-form-d', outcome: 'reached-no-founder-stated' },
    ], now);
    expect(v.status).toBe('manual-review-required');
    expect(v.summary).toContain('did not respond');
    expect(v.summary).toContain('incomplete rather than exhausted');
  });

  it('treats a browser-rendered page as unanswered rather than as an empty profile', () => {
    const v = deriveFounderStatus('Acme', [], [
      { family: 'accelerator', outcome: 'source-unreadable' },
      { family: 'company-site', outcome: 'reached-no-founder-stated' },
    ], now);
    expect(v.status).toBe('manual-review-required');
  });

  it('never returns an empty next action in any state', () => {
    const states = [
      [{ family: 'company-site' as const, outcome: 'reached-no-founder-stated' as const }],
      [{ family: 'company-site' as const, outcome: 'source-unreachable' as const }],
    ];
    for (const attempts of states) {
      expect(deriveFounderStatus('Acme', [], attempts, now).nextAction.trim().length).toBeGreaterThan(0);
    }
  });
});

// ── Stage ─────────────────────────────────────────────────────────

describe('stage resolution', () => {
  const ctx = (over: Partial<StageContext> = {}): StageContext => ({
    companyAgeYears: 2, teamSize: 6, accelerator: null, hasShippingProduct: false,
    hasFinancingEvidence: true, onlyFinancingIsFormD: false, hasGrantFunding: false, ...over,
  });

  const item = (over: Partial<StageEvidenceItem> = {}): StageEvidenceItem => ({
    sourceFamily: 'funding-press', url: 'https://techcrunch.com/x', date: '2026-06-01',
    statedStage: null, supportingText: 'text', ...over,
  });

  it('reads a stated round out of source text', () => {
    expect(readStatedStage('Acme raises $12M Series A led by Menlo')).toBe('Series A');
    expect(readStatedStage('Acme closes a pre-seed round')).toBe('Pre-seed');
    expect(readStatedStage('Acme announces its Series C')).toBe('Series B+');
    expect(readStatedStage('Acme launched a new product')).toBe(null);
  });

  /**
   * The rule this whole module exists for. A Form D proves an exempt
   * offering was reported; it does not name a venture round. Translating
   * every filing into "Seed" would clear 200 blank stages in one line and
   * assert a financing event no source states.
   */
  it('refuses to let an SEC Form D name a round, even when its text says "seed"', () => {
    const formD = item({ sourceFamily: 'sec-form-d', statedStage: 'Seed', supportingText: 'seed capital' });
    expect(isExplicitStageClaim(formD)).toBe(false);

    const out = resolveStage([formD], ctx({ onlyFinancingIsFormD: true }));
    expect(out.stage).toBe('early-stage-round-not-disclosed');
    expect(out.basis).toBe('inferred');
    expect(out.explanation).toContain('never names a venture round');
  });

  it('does not infer a round from offering size', () => {
    const out = resolveStage(
      [item({ sourceFamily: 'sec-form-d', amountUsd: 3_000_000 })],
      ctx({ onlyFinancingIsFormD: true }),
    );
    expect(out.stage).toBe('early-stage-round-not-disclosed');
    expect(out.explanation).toContain('offering size does not map onto stage');
  });

  it('accepts a named round from a source that can name one', () => {
    const out = resolveStage([item({ statedStage: 'Series A' })], ctx());
    expect(out.stage).toBe('Series A');
    expect(out.basis).toBe('explicit');
    expect(out.confidence).toBeGreaterThan(0.6);
  });

  it('reports disagreeing sources as a conflict rather than taking the newest', () => {
    const out = resolveStage([
      item({ statedStage: 'Seed', date: '2025-01-01', url: 'https://a.example/1' }),
      item({ statedStage: 'Series A', date: '2026-06-01', url: 'https://b.example/2' }),
    ], ctx());
    expect(out.stage).toBe('stage-conflict-manual-review');
    expect(out.conflicts).toHaveLength(2);
  });

  it('bounds an unsourced stage and says what the bound rests on', () => {
    const out = resolveStage([], ctx({ accelerator: 'Y Combinator (W24)', hasShippingProduct: true }));
    expect(out.stage).toBe('early-stage-round-not-disclosed');
    expect(out.basis).toBe('inferred');
    expect(out.explanation).toContain('Y Combinator (W24)');
    expect(out.explanation).toContain('shipping product');
    // An inference must never look as certain as a sourced claim.
    expect(out.confidence).toBeLessThanOrEqual(0.55);
  });

  it('never returns the literal string "unknown" for any input', () => {
    const outs = [
      resolveStage([], ctx({ companyAgeYears: null, teamSize: null, hasFinancingEvidence: false })),
      resolveStage([item({ statedStage: 'Bootstrapped' })], ctx()),
      resolveStage([], ctx({ hasGrantFunding: true, hasFinancingEvidence: false })),
    ];
    for (const o of outs) expect(o.stage.toLowerCase()).not.toContain('unknown');
  });
});

// ── Vertical ──────────────────────────────────────────────────────

describe('vertical classification', () => {
  const base = { identityResolved: true, selfDescribed: true, sourceUrl: 'https://acme.example' };

  it('requires a product signal, not just buyer words', () => {
    const scores = scoreSectors('We work with hospitals and health systems.');
    expect(scores.find((s) => s.sector === 'health')!.score).toBe(0);
  });

  it('classifies from what the product does and who pays', () => {
    const out = classifyCompany({
      ...base,
      text: 'Our platform automates claims and electronic health record workflows sold to health systems and payers.',
    });
    expect(out.primarySector).toBe('health');
    expect(out.basis).toBe('explicit');
    expect(out.reason).toContain('Health & Wellness');
  });

  /**
   * A diagnostics company that mentions its machine-learning model is a
   * health company. "AI" appears on essentially every startup home page,
   * and classifying on the token alone would put most of the portfolio in
   * General AI.
   */
  it('does not put a health company in General AI because it mentions machine learning', () => {
    const out = classifyCompany({
      ...base,
      text: 'Our diagnostic uses machine learning on biomarker data. Sold to hospitals and health systems.',
    });
    expect(out.primarySector).toBe('health');
  });

  it('uses the accelerator directory’s own category when the text is too thin, and labels it inferred', () => {
    const out = classifyCompany({
      ...base,
      selfDescribed: false,
      text: 'People infrastructure.',
      directoryCategories: 'B2B, Human Resources, Artificial Intelligence',
      directorySourceUrl: 'https://www.ycombinator.com/companies?q=Acme',
    });
    // Human Resources beats the Artificial Intelligence tag: a domain
    // sector outranks a technique label.
    expect(out.primarySector).toBe('fow');
    expect(out.basis).toBe('inferred');
    expect(out.reason).toContain('Human Resources');
  });

  it('ignores the importer’s placeholder subcategory', () => {
    expect(classifyFromDirectoryCategories('Unclassified — requires manual review')).toBe(null);
    expect(classifyFromDirectoryCategories(null)).toBe(null);
  });

  it('uses the explicit non-sector status when identity is unresolved, never a sector', () => {
    const out = classifyCompany({
      ...base,
      identityResolved: false,
      identityGap: 'The record is quarantined.',
      text: 'Our platform automates claims for health systems and payers.',
    });
    expect(out.primarySector).toBe(NON_SECTOR_STATUS);
    expect(out.evidenceGap).toContain('quarantined');
  });

  it('never produces the literal string "unknown"', () => {
    const out = classifyCompany({ ...base, text: '', identityResolved: true });
    expect(String(out.primarySector).toLowerCase()).not.toContain('unknown');
    expect(out.reason.toLowerCase()).not.toContain('unknown');
  });

  it('records a genuine second sector rather than discarding it', () => {
    const out = classifyCompany({
      ...base,
      text: 'Payments and lending infrastructure for clinical providers and health systems; '
        + 'used by hospitals, payers, and banks for patient billing.',
    });
    expect(out.secondarySector).not.toBe(null);
  });
});

// ── Research plan ─────────────────────────────────────────────────

describe('research plan', () => {
  beforeEach(() => { resetDbForTests(); });

  it('derives the machine-readable Form D document from a filing index URL', () => {
    expect(primaryDocFromIndexUrl(
      'https://www.sec.gov/Archives/edgar/data/1869920/000186992025000002/0001869920-25-000002-index.htm',
    )).toBe('https://www.sec.gov/Archives/edgar/data/1869920/000186992025000002/primary_doc.xml');
    expect(primaryDocFromIndexUrl('https://example.com/not-a-filing')).toBe(null);
  });

  it('orders confirming sources before suggesting ones', () => {
    const plan = buildResearchPlan({
      id: 'c1', name: 'Acme', website: 'https://acme.example', accelerator: null,
      city: 'Austin', state: 'TX',
      evidence: [{
        claim: 'Form D', source: 'SEC',
        url: 'https://www.sec.gov/Archives/edgar/data/1/000000125000001/0000001-25-000001-index.htm',
        date: '2026-05-01', type: 'Filing',
      }],
      dealEvidence: [],
    });
    const families = plan.map((p) => p.family);
    expect(families.indexOf('company-site')).toBeLessThan(families.indexOf('funding-press'));
    expect(families.indexOf('sec-form-d')).toBeLessThan(families.indexOf('professional-profile'));
  });

  it('reports a family with no URL on record rather than guessing an address', () => {
    const plan = buildResearchPlan({
      id: 'c1', name: 'Acme', website: null, accelerator: null, city: null, state: null,
      evidence: [], dealEvidence: [],
    });
    const registry = plan.find((p) => p.family === 'corporate-registry')!;
    expect(registry.fetches).toHaveLength(0);
    expect(registry.unavailableReason).toBe('no-source-url-known');
  });
});

// ── Persistence, provenance, idempotency ──────────────────────────

describe('enrichment persistence', () => {
  beforeEach(() => { resetDbForTests(); });

  const candidateInput = (over: Record<string, unknown> = {}) => ({
    companyId: 'c1', personKey: personKey('Jane Okonkwo'), fullName: 'Jane Okonkwo',
    title: 'Co-Founder & CEO', sourceUrl: 'https://acme.example/team',
    sourceFamily: 'company-site' as const, sourceType: 'Company team page',
    publishedAt: null, supportingText: 'Jane Okonkwo — Co-Founder & CEO',
    matchSignals: ['statement-on-company-domain' as const, 'title-stated-in-source' as const],
    matchScore: 7, confidence: 0.85, status: 'verified-founder' as const, ...over,
  });

  it('stores full provenance for every candidate', () => {
    seed('c1');
    upsertFounderCandidate(candidateInput());
    const [c] = listFounderCandidates('c1');
    expect(c.fullName).toBe('Jane Okonkwo');
    expect(c.title).toBe('Co-Founder & CEO');
    expect(c.sourceUrl).toBe('https://acme.example/team');
    expect(c.sourceFamily).toBe('company-site');
    expect(c.sourceType).toBe('Company team page');
    expect(c.supportingText).toContain('Jane Okonkwo');
    expect(c.matchSignals).toContain('statement-on-company-domain');
    expect(c.retrievedAt).toBeTruthy();
    expect(c.lastCheckedAt).toBeTruthy();
  });

  it('re-running does not duplicate a person, an attempt, or an edge', () => {
    seed('c1');
    for (let i = 0; i < 3; i++) {
      upsertFounderCandidate(candidateInput());
      recordResearchAttempt({
        companyId: 'c1', runId: `r${i}`, sourceFamily: 'company-site',
        url: 'https://acme.example/team', outcome: 'found-candidate', detail: 'read', candidatesFound: 1,
      });
      upsertRelationship({
        fromType: 'person', fromId: personKey('Jane Okonkwo'), toType: 'company', toId: 'c1',
        relation: 'stated-ceo', sourceFamily: 'company-site',
        evidenceUrl: 'https://acme.example/team', detail: 'team page', confidence: 0.85,
      });
    }
    expect(listFounderCandidates('c1')).toHaveLength(1);
    expect(listResearchAttempts('c1')).toHaveLength(1);
    expect(relationshipsFor('company', 'c1')).toHaveLength(1);
  });

  it('preserves first_seen_at across re-runs while last_checked_at moves', async () => {
    seed('c1');
    upsertFounderCandidate(candidateInput());
    const first = listFounderCandidates('c1')[0];
    await new Promise((r) => setTimeout(r, 5));
    upsertFounderCandidate(candidateInput({ confidence: 0.9 }));
    const second = listFounderCandidates('c1')[0];
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.confidence).toBe(0.9);
  });

  /**
   * A reviewer's decision must survive automated re-research. Confirming a
   * candidate and then having the next nightly run silently un-confirm it
   * would make the review button meaningless.
   */
  it('does not clear a reviewer decision when research re-runs', () => {
    seed('c1');
    const id = upsertFounderCandidate(candidateInput());
    reviewFounderCandidate(id, 'confirmed', { id: 'local-admin', label: 'Local administrator' }, 'Checked the team page.');
    upsertFounderCandidate(candidateInput({ confidence: 0.5 }));
    const c = listFounderCandidates('c1')[0];
    expect(c.reviewDecision).toBe('confirmed');
    expect(c.reviewedBy).toBe('Local administrator');
    expect(c.reviewReason).toBe('Checked the team page.');
  });

  it('keeps the automated evidence intact after a reviewer confirms', () => {
    seed('c1');
    const id = upsertFounderCandidate(candidateInput());
    reviewFounderCandidate(id, 'rejected', { id: 'local-admin', label: 'Local administrator' }, 'Wrong company.');
    const c = listFounderCandidates('c1')[0];
    expect(c.matchSignals).toContain('statement-on-company-domain');
    expect(c.supportingText).toContain('Jane Okonkwo');
    expect(c.sourceUrl).toBe('https://acme.example/team');
  });
});

// ── Corrections layer over automated evidence ─────────────────────

describe('reviewer corrections', () => {
  beforeEach(() => { resetDbForTests(); });

  it('layers a correction over the automated verdict without erasing it', () => {
    seed('c1');
    saveFounderResolution({
      companyId: 'c1', status: 'research-exhausted', resolvedPersonKey: null,
      resolvedName: null, resolvedTitle: null,
      summary: 'Founder research completed July 30, 2026. No attributable founder was confirmed.',
      nextAction: 'Resolve manually.', sourcesAttempted: ['company-site', 'sec-form-d'],
      researchedAt: now, version: ENRICHMENT_VERSION,
    });
    recordFieldCorrection({
      companyId: 'c1', field: 'founder', previousValue: 'research-exhausted',
      newValue: 'Jane Okonkwo', reason: 'Confirmed by phone.',
      sourceUrl: 'https://acme.example/about',
      reviewer: { id: 'local-admin', label: 'Local administrator', source: 'local-admin' },
    });

    const view = companyEnrichment('c1');
    expect(view.founder.state).toBe('confirmed');
    expect(view.founder.value?.name).toBe('Jane Okonkwo');
    expect(view.founder.summary).toContain('Local administrator');
    // The automated conclusion is still on the record.
    expect(view.founder.summary).toContain('research-exhausted');
    expect(view.corrections).toHaveLength(1);
    expect(view.corrections[0].previousValue).toBe('research-exhausted');
  });

  it('keeps every correction, using the newest as current', () => {
    seed('c1');
    const mk = (v: string) => recordFieldCorrection({
      companyId: 'c1', field: 'stage', previousValue: null, newValue: v, reason: 'r',
      sourceUrl: null, reviewer: { id: 'a', label: 'A', source: 'local-admin' },
    });
    mk('Seed');
    mk('Series A');
    expect(latestCorrections('c1').stage?.newValue).toBe('Series A');
    expect(companyEnrichment('c1').corrections).toHaveLength(2);
  });
});

// ── The served view never says "unknown" ──────────────────────────

describe('enrichment view', () => {
  beforeEach(() => { resetDbForTests(); });

  it('distinguishes never-researched from researched-and-not-public', () => {
    seed('c1');
    seed('c2');
    saveFounderResolution({
      companyId: 'c2', status: 'research-exhausted', resolvedPersonKey: null,
      resolvedName: null, resolvedTitle: null,
      summary: 'Founder research completed July 30, 2026. No attributable founder was confirmed across '
        + 'Company website, SEC Form D. Manual review queued.',
      nextAction: 'Resolve manually.', sourcesAttempted: ['company-site', 'sec-form-d'],
      researchedAt: now, version: ENRICHMENT_VERSION,
    });

    const never = companyEnrichment('c1');
    const done = companyEnrichment('c2');
    expect(never.founder.state).toBe('manual-review');
    expect(never.founder.summary).toContain('has not been through founder research');
    expect(done.founder.state).toBe('research-exhausted');
    expect(done.founder.summary).toContain('Manual review queued');
    // The two must not read the same — that conflation is the whole bug.
    expect(never.founder.summary).not.toBe(done.founder.summary);
  });

  it('never returns a candidate as the founder value', () => {
    seed('c1');
    upsertFounderCandidate({
      companyId: 'c1', personKey: personKey('Jane Okonkwo'), fullName: 'Jane Okonkwo',
      title: null, sourceUrl: 'https://news.example/x', sourceFamily: 'funding-press',
      sourceType: 'Press', publishedAt: '2026-06-01', supportingText: 'text',
      matchSignals: ['investor-announcement-names-company', 'company-name-in-source-text'],
      matchScore: 5, confidence: 0.4, status: 'probable-founder-candidate',
    });
    saveFounderResolution({
      companyId: 'c1', status: 'probable-founder-candidate', resolvedPersonKey: null,
      resolvedName: null, resolvedTitle: null, summary: '1 probable candidate found; none is confirmed.',
      nextAction: 'Review and confirm.', sourcesAttempted: ['funding-press'],
      researchedAt: now, version: ENRICHMENT_VERSION,
    });

    const view = companyEnrichment('c1');
    expect(view.founder.state).toBe('candidate');
    expect(view.founder.value).toBe(null);
    expect(view.founder.candidates).toHaveLength(1);
  });

  it('labels an inferred sector and stage as inferred', () => {
    seed('c1');
    saveVerticalClassification({
      companyId: 'c1', primarySector: 'health', secondarySector: null,
      subvertical: 'virtual care delivery', reason: 'Health & Wellness: …',
      sourceUrl: null, confidence: 0.4, basis: 'inferred', evidenceGap: null,
      classifiedAt: now, version: ENRICHMENT_VERSION,
    });
    saveStageResolution({
      companyId: 'c1', stage: 'early-stage-round-not-disclosed', basis: 'inferred',
      confidence: 0.4, evidenceUrl: null, evidenceDate: null,
      explanation: 'No source names a round.', conflicts: [],
      lastCheckedAt: now, version: ENRICHMENT_VERSION,
    });
    const view = companyEnrichment('c1');
    expect(view.vertical.inferred).toBe(true);
    expect(view.vertical.state).toBe('bounded-inference');
    expect(view.stage.inferred).toBe(true);
    expect(view.stage.value?.label).toBe('Early-stage — round not publicly disclosed');
  });

  it('marks an unclassifiable record as excluded from sector rankings', () => {
    seed('c1');
    saveVerticalClassification({
      companyId: 'c1', primarySector: NON_SECTOR_STATUS, secondarySector: null,
      subvertical: null, reason: 'Not classified.', sourceUrl: null, confidence: 0,
      basis: 'inferred', evidenceGap: 'Company identity is unresolved.',
      classifiedAt: now, version: ENRICHMENT_VERSION,
    });
    const view = companyEnrichment('c1');
    expect(view.vertical.value?.countsTowardRanking).toBe(false);
    expect(view.vertical.value?.evidenceGap).toContain('identity is unresolved');
  });

  it('emits no literal "unknown" and no canned placeholder in any field', () => {
    seed('c1');
    const view = companyEnrichment('c1');
    const text = JSON.stringify(view).toLowerCase();
    expect(text).not.toContain('identity not on record');
    expect(text).not.toContain('unknown founder');
    expect(text).not.toMatch(/"unknown"/);
  });

  it('always supplies a next action for every field', () => {
    seed('c1');
    const view = companyEnrichment('c1');
    for (const f of [view.founder, view.vertical, view.stage]) {
      expect(f.nextAction.trim().length).toBeGreaterThan(0);
    }
  });
});
