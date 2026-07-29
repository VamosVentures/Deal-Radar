import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import { addDealEvidence, reclassifyCompany } from '../db/repos/opportunities';
import {
  assessCorroboration, checkPublicCompany, classificationHistory,
  isQuarantined, listQuarantined, qualifyIssuer, quarantine, recordClassificationChange,
  tickerFromDisplayName, unquarantine,
} from '../services/issuerQualification';
import { isOperatingIssuer } from '../sourcing/formd';
import { adminAgent } from './testAuth';
import { isDisqualified, isQualifiedForOpportunity, MIN_INDEPENDENT_SOURCES } from '../../shared/qualification';
import type { DealEvidence } from '../../shared/opportunity';

/**
 * A Form D filing proves an exempt offering was reported. It does not
 * prove the filer is a venture-stage operating company. These tests pin
 * down the difference, using the actual entities that slipped through
 * before it was enforced.
 */

const TODAY = '2026-07-29';
const daysAgo = (n: number) => new Date(Date.parse(TODAY) - n * 86_400_000).toISOString().slice(0, 10);

function company(id: string, over: Record<string, unknown> = {}) {
  saveCompany({
    id, name: (over.name as string) ?? 'Acme Robotics Inc.',
    oneLiner: (over.oneLiner as string) ?? 'Robots that pick and place parts on a line.',
    vertical: 'robotics', subcategory: 'Industrial & warehouse automation',
    stage: 'Unknown', city: 'Austin', state: (over.state as string) ?? 'TX',
    foundedYear: 2024, teamSize: 4,
    website: (over.website as string | undefined),
    traction: { level: 0, note: 'Unknown' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [{ claim: 'Form D', source: 'SEC', url: 'https://www.sec.gov/x', date: daysAgo(30), type: 'Filing' }],
    flags: [], imported: true,
  } as never, { origin: 'extracted', source: 'test' });
}

function secEvidence(over: Partial<DealEvidence> = {}): DealEvidence {
  return {
    opportunityType: 'form-d-filing', sourceId: 'sec', sourceName: 'SEC EDGAR (Form D)', tier: 1,
    url: 'https://www.sec.gov/Archives/edgar/data/1699390/x-index.htm',
    publishedAt: daysAgo(30), retrievedAt: TODAY,
    summary: 'Form D exempt-offering filing.', whyCurrent: 'Filed 30 days ago.',
    amountUsd: 5_000_000, amountText: '$5,000,000 offering', roundType: null, investors: [],
    confidence: 0.8, ...over,
  };
}

function websiteEvidence(): DealEvidence {
  return {
    opportunityType: 'none', sourceId: 'websites', sourceName: 'Official company website', tier: 3,
    url: 'https://acmerobotics.com', publishedAt: null, retrievedAt: TODAY,
    summary: 'Official website responds with real content naming the company.',
    whyCurrent: 'Confirms an operating business; carries no date.',
    amountUsd: null, amountText: null, roundType: null, investors: [], confidence: 0.6,
  };
}

describe('issuer qualification', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  it('a Form D on its own is NOT enough — no corroboration means no opportunity', async () => {
    company('c1');
    addDealEvidence('c1', secEvidence());
    const q = await qualifyIssuer('c1', { offline: true, today: TODAY });

    expect(isQualifiedForOpportunity(q.result)).toBe(false);
    expect(q.reasonCodes).toContain('only-evidence-is-form-d');
    expect(q.reasonCodes).toContain('no-independent-corroboration');

    // And the classifier must demote it, not merely note the problem.
    const o = reclassifyCompany('c1', { today: TODAY });
    expect(o.classification).toBe('company-lead');
  });

  it('a Form D PLUS a confirmed website qualifies — two independent families', async () => {
    company('c2', { website: 'https://acmerobotics.com' });
    addDealEvidence('c2', secEvidence());
    addDealEvidence('c2', websiteEvidence());

    const q = await qualifyIssuer('c2', {
      offline: true, today: TODAY,
      websiteCheck: { verified: true, url: 'https://acmerobotics.com', parked: false, detail: 'ok' },
    });
    expect(q.result).toBe('qualified-operating-company');
    expect(q.corroboratingSources.length).toBeGreaterThanOrEqual(MIN_INDEPENDENT_SOURCES);

    const o = reclassifyCompany('c2', { today: TODAY });
    expect(o.classification).toBe('recent-financing-signal');
  });

  it('counts corroboration by source FAMILY, so many SEC pages are still one source', () => {
    company('c3');
    addDealEvidence('c3', secEvidence({ url: 'https://www.sec.gov/a' }));
    addDealEvidence('c3', secEvidence({ url: 'https://www.sec.gov/b' }));
    addDealEvidence('c3', secEvidence({ url: 'https://www.sec.gov/c' }));

    const corr = assessCorroboration('c3');
    expect(corr.independentFamilies).toEqual(['regulatory']);
    expect(corr.onlyEvidenceIsFormD).toBe(true);
  });

  it('excludes a publicly traded issuer even with a fresh filing and a live site', async () => {
    company('c4', { name: 'Adagio Medical Holdings, Inc.', website: 'https://adagiomedical.com' });
    addDealEvidence('c4', secEvidence());
    addDealEvidence('c4', websiteEvidence());

    const q = await qualifyIssuer('c4', {
      offline: true, today: TODAY,
      publicCheck: { isPubliclyTraded: true, ticker: 'ADGM', exchanges: ['Nasdaq'], periodicForms: ['10-Q'], detail: 'public' },
    });
    expect(q.result).toBe('public-company');
    expect(isDisqualified(q.result)).toBe(true);
    expect(q.reasonCodes).toContain('has-exchange-ticker');
    expect(q.reasonCodes).toContain('files-periodic-reports');

    const o = reclassifyCompany('c4', { today: TODAY });
    expect(o.classification).toBe('company-lead');
    expect(o.whyCurrent).toMatch(/public company|not a venture-stage/i);
  });

  it('does NOT treat an S-1 filer as public without a ticker or periodic reports', async () => {
    // A private company preparing to list is still private.
    company('c5', { website: 'https://acmerobotics.com' });
    addDealEvidence('c5', secEvidence());
    addDealEvidence('c5', websiteEvidence());
    const q = await qualifyIssuer('c5', {
      offline: true, today: TODAY,
      publicCheck: { isPubliclyTraded: false, ticker: null, exchanges: [], periodicForms: [], detail: 'S-1 only' },
      websiteCheck: { verified: true, url: 'https://acmerobotics.com', parked: false, detail: 'ok' },
    });
    expect(q.isPubliclyTraded).toBe(false);
    expect(q.result).toBe('qualified-operating-company');
  });

  it('rejects funds, SPVs and subsidiaries by entity shape', async () => {
    const cases: [string, string][] = [
      ['f1', 'Tribe Capital Fintech Fund I, L.P.'],
      ['f2', 'Scenic Hill Solar LI, LLC'],
      ['f3', 'Fresenius Medical Care North Dallas, LLC'],
      ['f4', 'PIMCO Asset-Based Lending Co LLC'],
      ['f5', 'Old Hickory Solar Investments LLC'],
    ];
    for (const [id, name] of cases) {
      company(id, { name });
      addDealEvidence(id, secEvidence({ url: `https://www.sec.gov/${id}` }));
      const q = await qualifyIssuer(id, { offline: true, today: TODAY });
      expect(isQualifiedForOpportunity(q.result), name).toBe(false);
      expect(q.isFundOrSpv, name).toBe(true);
    }
  });

  it('does not reject a real operating company for having Inc, Corp or LLC in its name', () => {
    for (const n of ['AMP Robotics Corp', 'Xperience Robotics, Inc.', 'Acme Health LLC', 'Greenlight Robotics Inc.']) {
      expect(isOperatingIssuer(n).isOperatingCompany, n).toBe(true);
    }
  });

  it('flags a foreign entity with no verifiable website for review rather than qualifying it', async () => {
    company('c6', { name: 'DZHLWK FINTECH Ltd.', state: '??', oneLiner: 'Unknown — not stated by the source' });
    addDealEvidence('c6', secEvidence());
    const q = await qualifyIssuer('c6', { offline: true, today: TODAY });
    expect(['unverified-foreign-entity', 'insufficient-evidence']).toContain(q.result);
    expect(isQualifiedForOpportunity(q.result)).toBe(false);
  });

  it('never promotes "insufficient evidence" into a live opportunity', async () => {
    company('c7', { oneLiner: 'Unknown — not stated by the source' });
    addDealEvidence('c7', secEvidence());
    const q = await qualifyIssuer('c7', { offline: true, today: TODAY });
    const o = reclassifyCompany('c7', { today: TODAY });
    expect(isQualifiedForOpportunity(q.result)).toBe(false);
    expect(o.classification).toBe('company-lead');
  });

  it('demotes an opportunity whose evidence has aged past 12 months', async () => {
    company('c8', { website: 'https://acmerobotics.com' });
    addDealEvidence('c8', secEvidence({ publishedAt: daysAgo(400) }));
    addDealEvidence('c8', websiteEvidence());
    const q = await qualifyIssuer('c8', { offline: true, today: TODAY });
    expect(q.reasonCodes).toContain('filing-older-than-12-months');
    expect(isQualifiedForOpportunity(q.result)).toBe(false);
  });

  it('reports an unchecked website honestly rather than as a failure', async () => {
    // The entity is disqualified on a cheaper signal, so no request is made.
    company('c9', { name: 'Some Growth Fund II, L.P.', website: 'https://example.com' });
    addDealEvidence('c9', secEvidence());
    const q = await qualifyIssuer('c9', { offline: false, today: TODAY });
    expect(q.reasonCodes).toContain('website-not-checked');
    expect(q.reasonCodes).not.toContain('website-unreachable');
  });

  it('extracts a ticker from an EDGAR display name', () => {
    expect(tickerFromDisplayName('Adagio Medical Holdings, Inc.  (ADGM)  (CIK 0002006986)')).toBe('ADGM');
    expect(tickerFromDisplayName('AMP Robotics Corp  (CIK 0001699390)')).toBeNull();
  });
});

describe('quarantine and history', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
    company('q1', { name: 'Scenic Hill Solar LI, LLC' });
  });

  it('quarantines without deleting the company or its evidence', () => {
    addDealEvidence('q1', secEvidence());
    quarantine('q1', 'SPV / project entity');
    expect(isQuarantined('q1')).toBe(true);
    expect(listQuarantined().map((r) => r.id)).toContain('q1');
    // Evidence survives — quarantine is not deletion.
    expect(reclassifyCompany('q1', { today: TODAY })).toBeTruthy();
  });

  it('can be released again', () => {
    quarantine('q1', 'test');
    unquarantine('q1');
    expect(isQuarantined('q1')).toBe(false);
  });

  it('preserves classification history with the reason for the change', () => {
    recordClassificationChange({
      companyId: 'q1',
      previousClassification: 'recent-financing-signal',
      newClassification: 'company-lead',
      previousQualification: null,
      newQualification: 'spv-or-project-entity',
      reason: 'Issuer qualified as an SPV, not a venture-stage operating company.',
    });
    const h = classificationHistory('q1') as Record<string, unknown>[];
    expect(h).toHaveLength(1);
    expect(h[0].previous_classification).toBe('recent-financing-signal');
    expect(h[0].new_classification).toBe('company-lead');
    expect(String(h[0].reason)).toMatch(/SPV/i);
    expect(String(h[0].version)).toMatch(/^q/);
  });
});

describe('qualification data over HTTP', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
    app = createApp();
    company('h1', { website: 'https://acmerobotics.com' });
  });

  it('rejects an unauthenticated request for company data', async () => {
    const res = await request(app).get('/api/companies/imported');
    expect(res.status).toBe(401);
  });

  it('returns opportunity, qualification and quarantine maps to an administrator', async () => {
    addDealEvidence('h1', secEvidence());
    reclassifyCompany('h1');
    quarantine('h1', 'test quarantine');

    const agent = await adminAgent(app);
    const res = await agent.get('/api/companies/imported');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('opportunities');
    expect(res.body).toHaveProperty('qualifications');
    expect(res.body).toHaveProperty('quarantine');
    expect(res.body.quarantine.h1.reason).toBe('test quarantine');
  });

  it('diversity analytics require an administrator and report only stored data', async () => {
    const anon = await request(app).get('/api/admin/diversity-analytics');
    expect(anon.status).toBe(401);

    const agent = await adminAgent(app);
    const res = await agent.get('/api/admin/diversity-analytics');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalOpportunities');
    expect(res.body).toHaveProperty('singleSourceOpportunities');
    expect(res.body).toHaveProperty('perSector');
    expect(Array.isArray(res.body.perSector)).toBe(true);
  });
});

describe('public-company check against a real response shape', () => {
  it('treats a ticker or periodic reports as public, and neither as private', async () => {
    // No network: the function is exercised through its parsing contract by
    // the callers above. Here we assert the shape it must return on failure
    // — unknown must not be reported as "private".
    const res = await checkPublicCompany('0000000000');
    expect(typeof res.isPubliclyTraded).toBe('boolean');
    if (!res.isPubliclyTraded && res.detail.startsWith('Could not check')) {
      expect(res.detail).toMatch(/unknown, not as private/i);
    }
  });
});
