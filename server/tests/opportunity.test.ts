import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../db/client';
import { store } from '../lib/store';
import { saveCompany } from '../db/repos/companies';
import { addDealEvidence, getOpportunity, listDealEvidence, reclassifyCompany } from '../db/repos/opportunities';
import {
  assessDiversity, canEstablishFinancing, classifyOpportunity, CURRENT_EVIDENCE_DAYS,
  familyOf, isLiveDeal, MAX_YC_PRIMARY_PER_SECTOR, tierOf,
  type DealEvidence,
} from '../../shared/opportunity';
import { isOperatingIssuer, parseFormD } from '../sourcing/formd';
import { markQualifiedForTests } from './qualifyForTests';

/**
 * The distinction this file protects: a company existing is not the same
 * as a company raising. The dashboard previously presented 35 Y
 * Combinator directory entries as investment opportunities; every one
 * was real, and not one was evidence of a current round.
 */

const TODAY = '2026-07-28';
const daysAgo = (n: number) => new Date(Date.parse(TODAY) - n * 86_400_000).toISOString().slice(0, 10);

function evidence(over: Partial<DealEvidence> = {}): DealEvidence {
  return {
    opportunityType: 'form-d-filing',
    sourceId: 'sec',
    sourceName: 'SEC EDGAR (Form D)',
    tier: 1,
    url: 'https://www.sec.gov/Archives/edgar/data/1/x-index.htm',
    publishedAt: daysAgo(30),
    retrievedAt: TODAY,
    summary: 'Form D exempt-offering filing.',
    whyCurrent: 'Filed 30 days ago.',
    amountUsd: 5_000_000,
    amountText: '$5,000,000 offering',
    roundType: null,
    investors: [],
    confidence: 0.8,
    ...over,
  };
}

describe('opportunity classification', () => {
  it('classifies a company with no evidence as a lead, never a deal', () => {
    const r = classifyOpportunity({ evidence: [], today: TODAY });
    expect(r.classification).toBe('company-lead');
    expect(isLiveDeal(r.classification)).toBe(false);
  });

  it('classifies a YC directory listing alone as a company lead', () => {
    // The exact case that motivated this work.
    const r = classifyOpportunity({
      evidence: [evidence({
        opportunityType: 'accelerator-batch', sourceId: 'yc', sourceName: 'Y Combinator', tier: 1,
        url: 'https://www.ycombinator.com/companies/acme',
        publishedAt: null, // a directory listing carries no publication date
        summary: 'Listed in the public YC directory.',
        amountUsd: null, amountText: null,
      })],
      today: TODAY,
    });
    expect(r.classification).toBe('company-lead');
    expect(r.reason).toMatch(/publication date/i);
  });

  it('treats a recent Form D as a recent financing signal, not a verified open round', () => {
    const r = classifyOpportunity({ evidence: [evidence()], today: TODAY });
    expect(r.classification).toBe('recent-financing-signal');
    expect(isLiveDeal(r.classification)).toBe(true);
    expect(r.reason).toMatch(/does not by itself prove an open round/i);
  });

  it('requires BOTH a financing event and a raising signal for verified-current-opportunity', () => {
    const r = classifyOpportunity({
      evidence: [
        evidence(),
        evidence({
          opportunityType: 'accelerator-batch', sourceId: 'yc', tier: 1,
          url: 'https://www.ycombinator.com/companies/acme',
          publishedAt: daysAgo(20), amountUsd: null, amountText: null,
        }),
        evidence({
          opportunityType: 'none', sourceId: 'websites', tier: 3,
          url: 'https://acme.example.com', publishedAt: null,
          amountUsd: null, amountText: null,
        }),
      ],
      today: TODAY,
    });
    expect(r.classification).toBe('verified-current-opportunity');
  });

  it('treats a recent accelerator batch WITH a verified website as a fundraising signal', () => {
    const r = classifyOpportunity({
      evidence: [
        evidence({
          opportunityType: 'accelerator-batch', sourceId: 'yc', tier: 1,
          publishedAt: daysAgo(15), amountUsd: null, amountText: null,
          // A direct company page, never a search-results URL.
          url: 'https://www.ycombinator.com/companies/acme',
        }),
        evidence({
          opportunityType: 'none', sourceId: 'websites', tier: 3,
          url: 'https://acme.example.com', publishedAt: null,
          amountUsd: null, amountText: null,
        }),
      ],
      today: TODAY,
    });
    expect(r.classification).toBe('credible-fundraising-signal');
  });

  it('refuses to call an accelerator batch a fundraising signal without a verified website', () => {
    // A directory row proves participation in a cohort. On its own it does
    // not establish that the company is an operating business, and a
    // cohort is not a raise — so it is surfaced for judgement, not counted.
    const r = classifyOpportunity({
      evidence: [evidence({
        opportunityType: 'accelerator-batch', sourceId: 'yc', tier: 1,
        publishedAt: daysAgo(15), amountUsd: null, amountText: null,
        url: 'https://www.ycombinator.com/companies/acme',
      })],
      today: TODAY,
    });
    expect(r.classification).toBe('unverified-opportunity');
    expect(isLiveDeal(r.classification)).toBe(false);
  });

  it('treats a government award as commercialization, NOT equity financing', () => {
    const r = classifyOpportunity({
      evidence: [evidence({
        opportunityType: 'government-award', sourceId: 'grants', tier: 1,
        publishedAt: daysAgo(10), url: 'https://www.sbir.gov/awards/1',
      })],
      today: TODAY,
    });
    // Real money, real validation — but not a round.
    expect(r.classification).toBe('unverified-opportunity');
    expect(r.reason).toMatch(/commercialization signal, not a financing event/i);
    expect(isLiveDeal(r.classification)).toBe(false);
  });

  it('demotes evidence older than the currency window back to a lead', () => {
    const r = classifyOpportunity({
      evidence: [evidence({ publishedAt: daysAgo(CURRENT_EVIDENCE_DAYS + 40) })],
      today: TODAY,
    });
    expect(r.classification).toBe('company-lead');
    expect(r.reason).toMatch(/beyond the .* currency window/i);
  });

  it('accepts evidence just inside the window and rejects just outside it', () => {
    const inside = classifyOpportunity({ evidence: [evidence({ publishedAt: daysAgo(CURRENT_EVIDENCE_DAYS - 1) })], today: TODAY });
    const outside = classifyOpportunity({ evidence: [evidence({ publishedAt: daysAgo(CURRENT_EVIDENCE_DAYS + 1) })], today: TODAY });
    expect(inside.classification).toBe('recent-financing-signal');
    expect(outside.classification).toBe('company-lead');
  });

  it('refuses to let a tier-3 source establish a financing event', () => {
    const r = classifyOpportunity({
      evidence: [evidence({
        sourceId: 'github', sourceName: 'GitHub', tier: 3,
        opportunityType: 'funding-announcement',
        url: 'https://github.com/acme', publishedAt: daysAgo(5),
      })],
      today: TODAY,
    });
    // A repository cannot prove a round, however recent it is.
    expect(r.classification).toBe('company-lead');
    expect(isLiveDeal(r.classification)).toBe(false);
  });

  it('undated evidence never establishes currency', () => {
    const r = classifyOpportunity({ evidence: [evidence({ publishedAt: null })], today: TODAY });
    expect(r.classification).toBe('company-lead');
  });
});

describe('source tiers and families', () => {
  it('puts filings and government data in tier 1 and code/preprints in tier 3', () => {
    expect(tierOf('sec')).toBe(1);
    expect(tierOf('grants')).toBe(1);
    expect(tierOf('funding-news')).toBe(2);
    expect(tierOf('github')).toBe(3);
    expect(tierOf('research')).toBe(3);
  });

  it('treats an unknown source as tier 3 — unknown provenance is weak provenance', () => {
    expect(tierOf('some-new-source')).toBe(3);
  });

  it('only allows tier 1 and 2 to establish financing', () => {
    expect(canEstablishFinancing('sec')).toBe(true);
    expect(canEstablishFinancing('funding-news')).toBe(true);
    expect(canEstablishFinancing('github')).toBe(false);
    expect(canEstablishFinancing('research')).toBe(false);
  });

  it('separates source families so three flavours of one thing is not "diverse"', () => {
    expect(familyOf('sec')).toBe('regulatory');
    expect(familyOf('yc')).toBe('accelerator');
    expect(familyOf('funding-news')).toBe('press');
    expect(familyOf('github')).not.toBe(familyOf('sec'));
  });
});

describe('source diversity assessment', () => {
  it('warns when one source supplies more than 40% of a shortlist', () => {
    const items = Array.from({ length: 5 }, () => ({ primarySourceId: 'yc' as const, primaryTier: 1 as const }));
    const d = assessDiversity(items, 'Robotics');
    expect(d.ycShare).toBe(1);
    expect(d.warnings.some((w) => /single source/i.test(w))).toBe(true);
  });

  it('warns when a sector draws on fewer than three source families', () => {
    const d = assessDiversity([
      { primarySourceId: 'sec', primaryTier: 1 },
      { primarySourceId: 'sec', primaryTier: 1 },
    ], 'FinTech');
    expect(d.distinctFamilies).toBe(1);
    expect(d.warnings.some((w) => /source famil/i.test(w))).toBe(true);
  });

  it('is quiet on a genuinely diverse shortlist', () => {
    const d = assessDiversity([
      { primarySourceId: 'sec', primaryTier: 1 },
      { primarySourceId: 'grants', primaryTier: 1 },
      { primarySourceId: 'funding-news', primaryTier: 2 },
      { primarySourceId: 'yc', primaryTier: 1 },
      { primarySourceId: 'producthunt', primaryTier: 2 },
    ], 'Robotics');
    expect(d.distinctFamilies).toBeGreaterThanOrEqual(3);
    expect(d.ycShare).toBeLessThanOrEqual(0.4);
    expect(d.warnings).toEqual([]);
  });

  it('caps YC-primary opportunities at two per sector', () => {
    expect(MAX_YC_PRIMARY_PER_SECTOR).toBe(2);
  });
});

// ── Form D parsing ────────────────────────────────────────────────

/** Trimmed from a real AMP Robotics Corp filing (CIK 0001699390). */
const OPERATING_FILING = `<?xml version="1.0"?>
<edgarSubmission>
  <primaryIssuer>
    <entityName>AMP Robotics Corp</entityName>
    <issuerAddress><street1>1875 TAYLOR AVENUE</street1><city>LOUISVILLE</city><stateOrCountry>CO</stateOrCountry></issuerAddress>
  </primaryIssuer>
  <relatedPersonsList>
    <relatedPersonInfo><relatedPersonName><firstName>Matanya</firstName><lastName>Horowitz</lastName></relatedPersonName>
      <relatedPersonRelationshipList><relationship>Executive Officer</relationship></relatedPersonRelationshipList></relatedPersonInfo>
    <relatedPersonInfo><relatedPersonName><firstName>Shaun</firstName><lastName>Maguire</lastName></relatedPersonName>
      <relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList></relatedPersonInfo>
  </relatedPersonsList>
  <offeringData>
    <industryGroup><industryGroupType>Other Technology</industryGroupType></industryGroup>
    <typeOfFiling><newOrAmendment><isAmendment>false</isAmendment></newOrAmendment>
      <dateOfFirstSale><value>2026-06-03</value></dateOfFirstSale></typeOfFiling>
    <offeringSalesAmounts>
      <totalOfferingAmount>75000000</totalOfferingAmount>
      <totalAmountSold>52500000</totalAmountSold>
      <totalRemaining>22500000</totalRemaining>
    </offeringSalesAmounts>
  </offeringData>
</edgarSubmission>`;

/** A pooled investment vehicle — the issuer says so itself. */
const FUND_FILING = `<?xml version="1.0"?>
<edgarSubmission>
  <primaryIssuer><entityName>Tribe Capital Fintech Fund I, L.P.</entityName>
    <issuerAddress><city>San Francisco</city><stateOrCountry>CA</stateOrCountry></issuerAddress></primaryIssuer>
  <offeringData>
    <industryGroup><industryGroupType>Pooled Investment Fund</industryGroupType></industryGroup>
    <offeringSalesAmounts><totalOfferingAmount>100000000</totalOfferingAmount><totalAmountSold>40000000</totalAmountSold></offeringSalesAmounts>
  </offeringData>
</edgarSubmission>`;

/** A fund whose NAME looks operational — only the industry group betrays it. */
const DISGUISED_FUND = `<?xml version="1.0"?>
<edgarSubmission>
  <primaryIssuer><entityName>Northstar Technology Holdings</entityName></primaryIssuer>
  <offeringData><industryGroup><industryGroupType>Pooled Investment Fund</industryGroupType></industryGroup></offeringData>
</edgarSubmission>`;

describe('Form D parsing', () => {
  it('extracts issuer, amounts, first-sale date, location and officers from a real filing', () => {
    const f = parseFormD(OPERATING_FILING);
    expect(f.entityName).toBe('AMP Robotics Corp');
    expect(f.totalOfferingAmountUsd).toBe(75_000_000);
    expect(f.totalAmountSoldUsd).toBe(52_500_000);
    expect(f.totalRemainingUsd).toBe(22_500_000);
    expect(f.dateOfFirstSale).toBe('2026-06-03');
    expect(f.city).toBe('LOUISVILLE');
    expect(f.stateOrCountry).toBe('CO');
    expect(f.industryGroupType).toBe('Other Technology');
    expect(f.isPooledInvestmentFund).toBe(false);
    expect(f.relatedPersons).toEqual([
      { name: 'Matanya Horowitz', relationship: 'Executive Officer' },
      { name: 'Shaun Maguire', relationship: 'Director' },
    ]);
  });

  it('accepts a legitimate operating company despite an Inc/Corp/LLC suffix', () => {
    const f = parseFormD(OPERATING_FILING);
    expect(isOperatingIssuer('AMP Robotics Corp', f).isOperatingCompany).toBe(true);
    expect(isOperatingIssuer('Xperience Robotics, Inc.').isOperatingCompany).toBe(true);
    expect(isOperatingIssuer('Greenlight Robotics Inc.').isOperatingCompany).toBe(true);
    expect(isOperatingIssuer('Acme Health LLC').isOperatingCompany).toBe(true);
  });

  it('rejects an investment fund on its own filed industry group', () => {
    const f = parseFormD(FUND_FILING);
    expect(f.isPooledInvestmentFund).toBe(true);
    const v = isOperatingIssuer('Tribe Capital Fintech Fund I, L.P.', f);
    expect(v.isOperatingCompany).toBe(false);
    expect(v.reason).toMatch(/Pooled Investment Fund|pooled investment vehicle/i);
  });

  it('catches a fund whose NAME looks like an operating company', () => {
    const f = parseFormD(DISGUISED_FUND);
    // The name alone passes...
    expect(isOperatingIssuer('Northstar Technology Holdings').isOperatingCompany).toBe(true);
    // ...but the issuer's own answer to the SEC does not.
    expect(isOperatingIssuer('Northstar Technology Holdings', f).isOperatingCompany).toBe(false);
  });

  it('rejects fund-shaped names without needing the filing document', () => {
    for (const name of [
      'Saluda Grade Alternative Lending & Fintech Growth Fund III LP',
      'DigitalBridge AI Infrastructure U-A, LP',
      'AI INFRASTRUCTURE FUND V a Series of FOG Ventures Fund III LLC',
      'Coatue Climate Tech Offshore Feeder Fund II LP',
      'Unique Investments & Fintech - Limited Partnership',
    ]) {
      expect(isOperatingIssuer(name).isOperatingCompany, name).toBe(false);
    }
  });

  it('rejects project-finance SPVs found in real solar Form D results', () => {
    // A real "solar" search returned these. They file genuine Form Ds
    // with real amounts, and the SEC's own industry group says "Other
    // Energy" rather than a fund — so neither the industry check nor the
    // fund-name patterns catch them. They are Roman-numeral-series
    // single-project financing vehicles, not startups.
    for (const name of [
      'Scenic Hill Solar LI, LLC',
      'Scenic Hill Solar L, LLC',
      'Sunrise Project 12, LLC',
      'Wind Holdings VII, LLC',
      'Solar Project III LLC',
    ]) {
      expect(isOperatingIssuer(name).isOperatingCompany, name).toBe(false);
    }
  });

  it('does not mistake a legal suffix for a Roman numeral', () => {
    // "LLC" is made of Roman-numeral letters (L, L, C). An earlier version
    // of the project-vehicle pattern matched "Moda Solar" + numeral "LLC"
    // and rejected a plausible operating company.
    for (const name of ['Moda Solar LLC', 'Susquehanna Solar, LLC', 'Solar Simplified, LLC', 'Company X Inc']) {
      expect(isOperatingIssuer(name).isOperatingCompany, name).toBe(true);
    }
  });

  it('handles a filing with no amounts without inventing any', () => {
    const f = parseFormD('<edgarSubmission><primaryIssuer><entityName>Sparse Co</entityName></primaryIssuer></edgarSubmission>');
    expect(f.totalOfferingAmountUsd).toBeNull();
    expect(f.totalAmountSoldUsd).toBeNull();
    expect(f.dateOfFirstSale).toBeNull();
    expect(f.relatedPersons).toEqual([]);
  });
});

// ── Persistence ───────────────────────────────────────────────────

describe('opportunity persistence', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
    saveCompany({
      id: 'co-1', name: 'AMP Robotics Corp', oneLiner: 'Recycling robotics.',
      vertical: 'robotics', subcategory: 'Industrial & warehouse automation', stage: 'Unknown',
      city: 'Louisville', state: 'CO', foundedYear: 2015, teamSize: 5,
      traction: { level: 0, note: 'Unknown' },
      founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
      evidence: [{ claim: 'Form D', source: 'SEC', url: 'https://www.sec.gov/x', date: '2026-06-17', type: 'Filing' }],
      flags: [], imported: true,
    }, { origin: 'extracted', source: 'test' });
  });

  it('stores deal evidence and derives a classification from it', () => {
    addDealEvidence('co-1', evidence());
    // The issuer has to have passed qualification before its evidence may
    // produce a live-deal classification. Without a verdict on file the
    // record is surfaced for review instead — see the test below.
    markQualifiedForTests('co-1');
    const o = reclassifyCompany('co-1', { today: TODAY });
    expect(o.classification).toBe('recent-financing-signal');
    expect(o.primarySourceId).toBe('sec');
    expect(o.primaryTier).toBe(1);
    expect(o.amountUsd).toBe(5_000_000);
    expect(o.evidenceUrl).toContain('sec.gov');
    expect(getOpportunity('co-1')!.classification).toBe('recent-financing-signal');
  });

  it('never presents a company with NO qualification verdict as a live deal', () => {
    // Regression guard. The qualification gate used to be written
    // `if (qual && isLiveDeal(...))`, so a company with no verdict row
    // skipped the gate completely and kept whatever its evidence implied.
    // That is how 18 freshly imported records sat in the shortlist as live
    // deals while nothing had checked whether they were operating
    // companies at all. An absent verdict is not a pass.
    addDealEvidence('co-1', evidence());
    const o = reclassifyCompany('co-1', { today: TODAY });

    expect(o.classification).toBe('unverified-opportunity');
    expect(isLiveDeal(o.classification)).toBe(false);
    expect(o.whyCurrent).toMatch(/no issuer qualification verdict/i);
    // The evidence itself is still reported honestly — it is the verdict
    // that is missing, not the filing.
    expect(o.primarySourceId).toBe('sec');
    expect(o.evidenceUrl).toContain('sec.gov');
  });

  it('deduplicates identical evidence rather than double-counting it', () => {
    expect(addDealEvidence('co-1', evidence()).added).toBe(true);
    expect(addDealEvidence('co-1', evidence()).added).toBe(false);
    expect(listDealEvidence('co-1')).toHaveLength(1);
  });

  it('surfaces conflicting amounts for human review instead of picking one', () => {
    addDealEvidence('co-1', evidence({ roundType: 'Series B', amountUsd: 50_000_000, url: 'https://www.sec.gov/a' }));
    addDealEvidence('co-1', evidence({
      roundType: 'Series B', amountUsd: 75_000_000, url: 'https://techcrunch.com/b',
      sourceId: 'funding-news', sourceName: 'TechCrunch', tier: 2, opportunityType: 'funding-announcement',
    }));
    const o = reclassifyCompany('co-1', { today: TODAY });
    expect(o.conflicts).toHaveLength(1);
    expect(o.conflicts[0]).toMatch(/disagree on the amount for Series B/i);
    expect(o.conflicts[0]).toMatch(/human review/i);
  });

  it('records missing information honestly rather than filling it in', () => {
    addDealEvidence('co-1', evidence({ amountUsd: null, amountText: null, roundType: null }));
    const o = reclassifyCompany('co-1', { today: TODAY });
    expect(o.missingInformation.some((m) => /amount not stated/i.test(m))).toBe(true);
    expect(o.missingInformation.some((m) => /Round type not stated/i.test(m))).toBe(true);
  });

  it('an unclassified company is a lead by default, never a deal', () => {
    expect(getOpportunity('co-1')).toBeNull();
    const o = reclassifyCompany('co-1', { today: TODAY });
    expect(o.classification).toBe('company-lead');
    expect(isLiveDeal(o.classification)).toBe(false);
  });

  it('re-running classification on unchanged evidence is idempotent', () => {
    addDealEvidence('co-1', evidence());
    const a = reclassifyCompany('co-1', { today: TODAY });
    const b = reclassifyCompany('co-1', { today: TODAY });
    expect(b.classification).toBe(a.classification);
    expect(b.amountUsd).toBe(a.amountUsd);
    expect(listDealEvidence('co-1')).toHaveLength(1);
  });

  it('stronger tier-1 evidence is preferred as primary over weaker tier-3 evidence', () => {
    addDealEvidence('co-1', evidence({
      sourceId: 'github', sourceName: 'GitHub', tier: 3, url: 'https://github.com/amp',
      opportunityType: 'product-launch', amountUsd: null, amountText: null,
    }));
    addDealEvidence('co-1', evidence()); // tier 1 SEC
    const o = reclassifyCompany('co-1', { today: TODAY });
    expect(o.primaryTier).toBe(1);
    expect(o.primarySourceId).toBe('sec');
    // The weaker evidence is retained, not discarded.
    expect(listDealEvidence('co-1')).toHaveLength(2);
  });
});
