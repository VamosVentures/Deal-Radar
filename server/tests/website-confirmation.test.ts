import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbForTests } from '../db/client';
import { getCompany, getProvenance, saveCompany } from '../db/repos/companies';
import { addDealEvidence, listDealEvidence, reclassifyCompany } from '../db/repos/opportunities';
import { classificationHistory, qualifyIssuer } from '../services/issuerQualification';
import {
  confirmWebsite, previewWebsiteConfirmation, websiteConfirmationSchema,
} from '../services/websiteConfirmation';
import { discoverOfficialWebsite } from '../services/corroborate';
import { isAmbiguousCompanyName } from '../sourcing/classify';
import { adminAgent } from './testAuth';
import { createApp } from '../app';
import { store } from '../lib/store';
import type { DealEvidence } from '../../shared/opportunity';

/**
 * The manual website-confirmation path.
 *
 * The thing these tests are really protecting is the boundary: a human
 * with a cited source may record a website that the automatic
 * discoverer refuses to guess, and recording it that way must not make
 * the automatic guess legal. Both halves are asserted.
 */

const TODAY = '2026-07-29';

function pressEvidence(over: Partial<DealEvidence> = {}): DealEvidence {
  return {
    opportunityType: 'funding-announcement', sourceId: 'funding-news',
    sourceName: 'techcrunch.com (public RSS)', tier: 2,
    url: 'https://techcrunch.com/2026/07/20/natural-raises-30m/',
    publishedAt: '2026-07-20', retrievedAt: TODAY,
    summary: 'Natural raises $30M to reinvent payments for AI agents.',
    whyCurrent: 'Published 9 days ago.',
    amountUsd: 30_000_000, amountText: '$30M', roundType: null, investors: [],
    confidence: 0.65, ...over,
  };
}

function company(id: string, name: string, website?: string) {
  saveCompany({
    id, name, oneLiner: `${name} builds payments infrastructure for AI agents.`,
    vertical: 'fintech', subcategory: 'Unclassified — requires manual review',
    stage: 'Unknown', city: 'Unknown', state: '??', foundedYear: 2026, teamSize: 4,
    website, traction: { level: 0, note: 'Unknown' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [{ claim: 'Funding article', source: 'techcrunch.com', url: 'https://techcrunch.com/2026/07/20/natural-raises-30m/', date: '2026-07-20', type: 'Press' }],
    flags: [], imported: true,
  } as never, { origin: 'extracted', source: 'test', discoverySource: 'funding-news' });
}

const input = websiteConfirmationSchema.parse({
  website: 'https://www.natural.com',
  evidenceUrl: 'https://www.prnewswire.com/news-releases/natural-raises-30m-series-a-302829855.html',
  reason: 'The company\'s own press release names www.natural.com as its website.',
  actor: 'tester',
});

beforeEach(() => {
  resetDbForTests();
  vi.restoreAllMocks();
});

describe('manual website confirmation', () => {
  it('shows the previous and proposed values and writes nothing', async () => {
    company('c1', 'Natural');
    addDealEvidence('c1', pressEvidence());
    await qualifyIssuer('c1', {
      today: TODAY,
      publicCheck: { isPubliclyTraded: false, ticker: null, exchanges: [], periodicForms: [], detail: 'private' },
      websiteCheck: { verified: false, url: null, parked: false, detail: 'No website on record.' },
    });
    reclassifyCompany('c1', { today: TODAY });

    const preview = await previewWebsiteConfirmation('c1', input);
    expect(preview).not.toBeNull();
    expect(preview!.previous.website).toBeNull();
    expect(preview!.previous.classification).toBe('company-lead');
    expect(preview!.proposed.website).toBe('https://www.natural.com');
    expect(preview!.proposed.evidenceUrl).toBe(input.evidenceUrl);
    expect(preview!.proposed.websiteOrigin).toBe('verified');

    // The preview must be a read. Nothing on the record may have moved.
    expect(getCompany('c1')!.website).toBeUndefined();
    expect(listDealEvidence('c1')).toHaveLength(1);
    expect(classificationHistory('c1')).toHaveLength(0);
    expect(preview!.previous.qualification).toBe('company-lead-requires-corroboration');
  });

  it('warns that a common single-word name needs the evidence checked against the right company', async () => {
    company('c1', 'Natural');
    const preview = await previewWebsiteConfirmation('c1', input);
    expect(preview!.warnings.join(' ')).toMatch(/common single word/i);
  });

  it('refuses to write without an explicit confirmation', async () => {
    company('c1', 'Natural');
    addDealEvidence('c1', pressEvidence());

    const result = await confirmWebsite('c1', input, false);
    expect(result!.ok).toBe(false);
    expect(getCompany('c1')!.website).toBeUndefined();
    expect(classificationHistory('c1')).toHaveLength(0);
  });

  it('refuses a page offered as evidence for itself', async () => {
    company('c1', 'Natural');
    const same = websiteConfirmationSchema.parse({
      ...input, evidenceUrl: input.website,
    });
    const preview = await previewWebsiteConfirmation('c1', same);
    expect(preview!.blockers.join(' ')).toMatch(/cannot be the evidence for itself/i);

    const result = await confirmWebsite('c1', same, true);
    expect(result!.ok).toBe(false);
    expect(getCompany('c1')!.website).toBeUndefined();
  });

  it('rejects a URL that is not a real external http(s) address', () => {
    for (const bad of ['natural.com', 'javascript:alert(1)', 'https://user:pw@natural.com', 'https://127.0.0.1/x', 'https://localhost']) {
      expect(websiteConfirmationSchema.safeParse({ ...input, website: bad }).success).toBe(false);
    }
  });

  it('requires a reason long enough to be an audit trail', () => {
    expect(websiteConfirmationSchema.safeParse({ ...input, reason: 'looks ok' }).success).toBe(false);
  });

  it('records the website as verified, keeps existing evidence, and writes classification history', async () => {
    company('c1', 'Natural');
    addDealEvidence('c1', pressEvidence());
    reclassifyCompany('c1', { today: TODAY });
    const evidenceBefore = listDealEvidence('c1');

    const result = await confirmWebsite('c1', input, true);
    expect(result!.ok).toBe(true);

    expect(getCompany('c1')!.website).toBe('https://www.natural.com');
    expect(getProvenance('c1', 'website')?.origin).toBe('verified');

    // Append-only: the press row is still there, untouched, plus one web row.
    const after = listDealEvidence('c1');
    expect(after).toHaveLength(evidenceBefore.length + 1);
    expect(after.find((e) => e.url === evidenceBefore[0].url)).toEqual(evidenceBefore[0]);
    const web = after.find((e) => e.sourceId === 'websites')!;
    expect(web.publishedAt).toBeNull();      // a website has no publication date
    expect(web.opportunityType).toBe('none'); // and is not a financing event
    expect(web.summary).toContain(input.evidenceUrl);

    const history = classificationHistory('c1') as { reason: string }[];
    expect(history).toHaveLength(1);
    expect(history[0].reason).toContain(input.evidenceUrl);
    expect(history[0].reason).toContain('(none on record) → https://www.natural.com');
    expect(history[0].reason).toContain(input.reason);
  });

  it('leaves the automatic single-word guard exactly as it was', async () => {
    company('c1', 'Natural');
    await confirmWebsite('c1', input, true);

    // The word list is unchanged, and the discoverer still refuses to
    // derive a domain from it — a human confirmation is evidence about
    // ONE company, never a licence to guess for the rest.
    expect(isAmbiguousCompanyName('Natural')).toBe(true);
    const discovery = await discoverOfficialWebsite('Natural');
    expect(discovery.url).toBeNull();
    expect(discovery.tried).toHaveLength(0);
    expect(discovery.detail).toMatch(/common English word/i);
  });

  it('promotes a corroborated press record once its website verifies', async () => {
    company('c1', 'Natural');
    addDealEvidence('c1', pressEvidence());
    // Offline-equivalent: inject the answers the network would give, so
    // the promotion path is exercised without a live request.
    await qualifyIssuer('c1', {
      today: TODAY,
      publicCheck: { isPubliclyTraded: false, ticker: null, exchanges: [], periodicForms: [], detail: 'private' },
      websiteCheck: { verified: false, url: null, parked: false, detail: 'No website on record.' },
    });
    expect(reclassifyCompany('c1', { today: TODAY }).classification).toBe('company-lead');

    addDealEvidence('c1', {
      opportunityType: 'none', sourceId: 'websites', sourceName: 'Official company website (human-confirmed)',
      tier: 3, url: 'https://www.natural.com', publishedAt: null, retrievedAt: TODAY,
      summary: 'Human-confirmed official website.', whyCurrent: 'Operating business; undated.',
      amountUsd: null, amountText: null, roundType: null, investors: [], confidence: 0.6,
    });
    await qualifyIssuer('c1', {
      today: TODAY,
      publicCheck: { isPubliclyTraded: false, ticker: null, exchanges: [], periodicForms: [], detail: 'private' },
      websiteCheck: { verified: true, url: 'https://www.natural.com', parked: false, detail: 'Real content.' },
    });
    expect(reclassifyCompany('c1', { today: TODAY }).classification).toBe('recent-financing-signal');
  });

  it('exposes preview and confirm as separate authenticated routes', async () => {
    store.resetForTests();
    resetDbForTests();
    company('c1', 'Natural');
    addDealEvidence('c1', pressEvidence());
    const app = createApp();
    const agent = await adminAgent(app);

    const preview = await agent.post('/api/companies/c1/website-confirmation/preview').send(input);
    expect(preview.status).toBe(200);
    expect(preview.body.previous.website).toBeNull();
    expect(getCompany('c1')!.website).toBeUndefined();

    // confirmed:true is mandatory on the write route.
    const unconfirmed = await agent.post('/api/companies/c1/website-confirmation/confirm').send(input);
    expect(unconfirmed.status).toBe(400);
    expect(getCompany('c1')!.website).toBeUndefined();

    const missing = await agent.post('/api/companies/nope/website-confirmation/preview').send(input);
    expect(missing.status).toBe(404);
  });
});

describe('a website that cannot be verified', () => {
  it('says "client-rendered", not "parked", when a real site serves no readable text', async () => {
    company('c1', 'Infinity', 'https://infinity.inc');
    addDealEvidence('c1', pressEvidence({ url: 'https://siliconangle.com/2026/07/20/infinity-raises-15m/' }));
    addDealEvidence('c1', {
      opportunityType: 'none', sourceId: 'websites', sourceName: 'Official company website (human-confirmed)',
      tier: 3, url: 'https://infinity.inc', publishedAt: null, retrievedAt: TODAY,
      summary: 'Human-confirmed official website.', whyCurrent: 'Operating business; undated.',
      amountUsd: null, amountText: null, roundType: null, investors: [], confidence: 0.6,
    });

    const q = await qualifyIssuer('c1', {
      today: TODAY,
      publicCheck: { isPubliclyTraded: false, ticker: null, exchanges: [], periodicForms: [], detail: 'private' },
      // What politeFetch reports for infinity.inc: HTTP 200, eight
      // characters of text, because the page renders in the browser.
      websiteCheck: { verified: false, url: 'https://infinity.inc', parked: false, thin: true, detail: 'Almost no readable text.' },
    });

    expect(q.reasonCodes).toContain('website-thin-or-client-rendered');
    expect(q.reasonCodes).not.toContain('website-parked-or-placeholder');
    // The verdict is unchanged — unverifiable is unverifiable. Only the
    // stated reason had to stop being an accusation.
    expect(q.result).toBe('human-review-required');
    expect(reclassifyCompany('c1', { today: TODAY }).classification).toBe('unverified-opportunity');
  });
});

describe('deal-evidence publication dates', () => {
  it('fills a missing publication date on re-write and never changes one already on record', () => {
    company('c1', 'Natural');

    // The shape the pre-Phase-14 parser produced: a real article, no date.
    expect(addDealEvidence('c1', pressEvidence({ publishedAt: null }))).toEqual({ added: true, dateBackfilled: false });
    expect(listDealEvidence('c1')[0].publishedAt).toBeNull();

    // The same article, read again by a parser that works.
    expect(addDealEvidence('c1', pressEvidence({ publishedAt: '2026-07-20' })))
      .toEqual({ added: false, dateBackfilled: true });
    expect(listDealEvidence('c1')).toHaveLength(1);
    expect(listDealEvidence('c1')[0].publishedAt).toBe('2026-07-20');

    // A later source must NOT be able to move a dated event in time.
    expect(addDealEvidence('c1', pressEvidence({ publishedAt: '2020-01-01' })))
      .toEqual({ added: false, dateBackfilled: false });
    expect(listDealEvidence('c1')[0].publishedAt).toBe('2026-07-20');
  });

  it('does not resurrect a date when the re-read also has none', () => {
    company('c1', 'Natural');
    addDealEvidence('c1', pressEvidence({ publishedAt: null }));
    expect(addDealEvidence('c1', pressEvidence({ publishedAt: null })))
      .toEqual({ added: false, dateBackfilled: false });
    expect(listDealEvidence('c1')[0].publishedAt).toBeNull();
  });
});
