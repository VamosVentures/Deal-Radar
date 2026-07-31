import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import {
  extractInvestorEvent, checkParticipation, trimCompanySpan, matchesAnyRegisteredInvestor,
  INVESTOR_REASON_CODES, INVESTOR_REASON_TEXT,
  type InvestorReasonCode,
} from '../sourcing/investorAnnouncement';
import { INVESTOR_REGISTRY, investorForUrl, registeredFeeds } from '../sourcing/investorRegistry';
import { configuredInvestorFeeds } from '../sourcing/adapters/investorNews';
import {
  extractFundingEvent, mergeFundingEvents, independentPublishers, independentSourceFamilies,
  type FeedItem, type FundingEvent,
} from '../sourcing/fundingEvent';
import { pageDisqualifiedAsOfficialSite, titleIsBareDomain } from '../sourcing/pageSignals';
import { runInvestorNews } from '../services/investorNews';
import { assessCorroboration } from '../services/issuerQualification';
import { markQualifiedForTests } from './qualifyForTests';
import { diversityAnalytics, opportunityTypeForSource } from '../services/shortlist';
import { listDealEvidence } from '../db/repos/opportunities';
import { listCompanies } from '../db/repos/companies';
import { familyOf, tierOf, familyLabel, sourceLabel } from '../../shared/opportunity';
import * as F from './fixtures/investorFeeds';

/**
 * The investor-primary source family.
 *
 * The thing being tested here is not "can we parse a VC blog" — it is the
 * boundary between a first-party record and a press clipping hosted on a
 * VC's server. Nearly every test below is about refusing something that
 * looks close enough to accept.
 */

const TODAY = '2026-07-29';

function event(item: FeedItem): FundingEvent {
  const out = extractInvestorEvent(item, TODAY);
  if (!out.ok) throw new Error(`expected an event, got ${out.rejection!.code}: ${out.rejection!.detail}`);
  return out.event!;
}

function rejection(item: FeedItem): InvestorReasonCode {
  const out = extractInvestorEvent(item, TODAY);
  if (out.ok) throw new Error(`expected a rejection, got an event for "${item.title}"`);
  return out.rejection!.code;
}

// ── 1. A valid investor announcement ──────────────────────────────

describe('a valid investor announcement becomes structured evidence', () => {
  it('captures company, investor, verified domain, URL and date from first-person phrasing', () => {
    const e = event(F.FIRST_PERSON_HEALTH);
    expect(e.companyName).toBe('Karoo Health');
    expect(e.announcedAt).toBe('2026-07-21');
    expect(e.articleUrl).toBe(F.FIRST_PERSON_HEALTH.link);
    expect(e.publisher).toBe('7wireventures.com');
    expect(e.sector).toBe('health');
    expect(e.investors).toContain('7wire Ventures');

    const [source] = e.sources;
    expect(source.sourceId).toBe('investor-news');
    expect(source.investor).toBe('7wire Ventures');
    expect(source.investorDomain).toBe('7wireventures.com');
    // The exact words that establish participation are stored, so a
    // reviewer can check the call without re-reading the page.
    expect(source.participation?.toLowerCase()).toContain('we invested in');
  });

  it('records an amount and round only where the announcement states them', () => {
    const e = event(F.PRESS_RELEASE_ON_INVESTOR_DOMAIN);
    expect(e.companyName).toBe('Optura');
    expect(e.amountUsd).toBe(17_500_000);
    expect(e.amountText).toBe('$17.5M (as stated by Echo Health Ventures)');
    expect(e.roundType).toBe('Series A');
    expect(e.investors).toEqual(expect.arrayContaining(['Echo Health Ventures', 'Salesforce Ventures']));
  });

  it('leaves an undisclosed amount and round null rather than estimating them', () => {
    const e = event(F.FIRST_PERSON_HEALTH);
    // A firm that says "we invested" has stated a financing event it was
    // party to. What it did not disclose stays absent — never filled in
    // from the firm's typical cheque size.
    expect(e.amountUsd).toBeNull();
    expect(e.amountText).toBeNull();
    expect(e.roundType).toBeNull();
    expect(e.hqCity).toBeNull();
    expect(e.hqState).toBeNull();
    expect(e.website).toBeNull();
  });

  it('reads a company named by an <alias>-backed prefix', () => {
    const e = event(F.BACKED_PREFIX);
    expect(e.companyName).toBe('SonoThera');
    expect(e.roundType).toBe('Series B');
    expect(e.sources[0].participation).toContain('ARCH-backed');
  });

  it('produces space-tech evidence, the sector the shortlist is shortest in', () => {
    const e = event(F.SPACE_INVESTMENT);
    expect(e.companyName).toBe('Star Catcher');
    expect(e.sector).toBe('spacetech');
    expect(e.roundType).toBe('Series A');
  });

  it('belongs to the investor-primary family at tier 2, and is labelled for humans', () => {
    expect(familyOf('investor-news')).toBe('investor-primary');
    expect(familyOf('investor-news')).not.toBe(familyOf('funding-news'));
    expect(tierOf('investor-news')).toBe(2);
    expect(opportunityTypeForSource('investor-news')).toBe('funding-announcement');
    expect(familyLabel('investor-primary')).toBe('Investor (primary)');
    expect(sourceLabel('investor-news')).toBe('Investor announcements');
  });
});

// ── 2. An investor page that does not describe financing ──────────

describe('investor pages that are not financing events are refused by name', () => {
  it.each([
    ['a hire at the firm', F.FIRM_HIRE, 'not-a-financing-announcement'],
    ['an annual report', F.FIRM_REPORT, 'not-a-financing-announcement'],
  ])('rejects %s', (_label, item, code) => {
    expect(rejection(item as FeedItem)).toBe(code);
  });

  it('rejects a round the host firm had nothing to do with', () => {
    // F-Prime republishing coverage of AvenCell's Series B. Real article,
    // real round, hosted on an investor's domain — and F-Prime never says
    // it was in it. Counting this would fabricate a relationship.
    expect(rejection(F.THIRD_PARTY_ROUND)).toBe('investor-not-participant');
  });

  it('has reason text for every reason code', () => {
    for (const code of INVESTOR_REASON_CODES) {
      expect(INVESTOR_REASON_TEXT[code], code).toBeTruthy();
    }
  });
});

// ── 3. A portfolio listing with no dated event ────────────────────

describe('a portfolio listing is membership, not a financing event', () => {
  it('rejects "welcoming X to our portfolio" when no round is stated', () => {
    expect(rejection(F.PORTFOLIO_LISTING)).toBe('portfolio-listing-no-event');
  });

  it('rejects a portfolio spotlight', () => {
    expect(rejection(F.PORTFOLIO_SPOTLIGHT)).toBe('portfolio-listing-no-event');
  });

  it('accepts a portfolio welcome that DOES state the round', () => {
    const e = event(F.investorItem({
      title: 'Welcoming Cheiron to our portfolio: we led their $12M Seed',
      link: 'https://menlovc.com/perspective/cheiron/',
      description: 'Cheiron is building a unified OS for clinical drug development.',
      publishedAt: '2026-07-22T00:00:00.000Z',
    }));
    expect(e.companyName).toBe('Cheiron');
    expect(e.roundType).toBe('Seed');
  });
});

// ── 4. The same event reported by press AND investor ──────────────

describe('press and investor coverage of one round is one event, two families', () => {
  const pressItem: FeedItem = {
    title: 'Karoo Health raises $12M Series A for cardiovascular care',
    link: 'https://techcrunch.com/2026/07/21/karoo-health/',
    publishedAt: '2026-07-21T00:00:00.000Z',
    description: 'Karoo Health builds cardiovascular care management for health systems.',
    author: null, guid: null, categories: [], outboundLinks: [],
  };

  it('merges them into one event that keeps both URLs and both attributions', () => {
    const press = extractFundingEvent(pressItem, TODAY);
    expect(press.ok).toBe(true);
    const merged = mergeFundingEvents([press.ok ? press.event : ({} as FundingEvent), event(F.FIRST_PERSON_HEALTH)]);

    expect(merged.events).toHaveLength(1);
    expect(merged.mergedArticles).toBe(1);
    const [e] = merged.events;
    expect(e.sources.map((s) => s.url).sort()).toEqual([
      'https://techcrunch.com/2026/07/21/karoo-health/',
      'https://www.7wireventures.com/news/why-we-invested-in-karoo-health/',
    ]);
    // This is the whole point of the phase: a company the press told us
    // about now has evidence from a genuinely different kind of source.
    expect(independentSourceFamilies(e).sort()).toEqual(['investor-primary', 'press']);
    expect(independentPublishers(e)).toHaveLength(2);
    expect(e.conflicts).toHaveLength(0);
  });

  it('keeps each source\'s own attribution rather than restating one as the other', () => {
    const press = extractFundingEvent(pressItem, TODAY);
    const [e] = mergeFundingEvents([press.ok ? press.event : ({} as FundingEvent), event(F.FIRST_PERSON_HEALTH)]).events;
    const investorSource = e.sources.find((s) => s.sourceId === 'investor-news')!;
    const pressSource = e.sources.find((s) => s.sourceId === 'funding-news')!;
    // TechCrunch stated the amount; 7wire did not. Neither figure may be
    // written onto the other's row.
    expect(pressSource.amountUsd).toBe(12_000_000);
    expect(investorSource.amountUsd).toBeNull();
    expect(investorSource.investor).toBe('7wire Ventures');
    expect(pressSource.investor).toBeUndefined();
  });
});

// ── 5. Several investors announcing ONE round ─────────────────────

describe('a syndicate is still one source family', () => {
  const menlo = F.investorItem({
    title: 'Our Investment in Assort Health',
    link: 'https://menlovc.com/perspective/assort-health/',
    description: 'Assort Health automates the front door of healthcare. We co-led the $26M Series B.',
    publishedAt: '2026-06-24T00:00:00.000Z',
  });
  const bcapital = F.investorItem({
    title: 'Why We Invested in Assort Health',
    link: 'https://b.capital/why-we-invested-in-assort-health/',
    description: 'Assort Health automates the front door of healthcare. We co-led the $26M Series B.',
    publishedAt: '2026-06-25T00:00:00.000Z',
  });

  it('merges two investors\' announcements of the same round into one event', () => {
    const merged = mergeFundingEvents([event(menlo), event(bcapital)]);
    expect(merged.events).toHaveLength(1);
    expect(merged.mergedArticles).toBe(1);
    expect(merged.events[0].sources).toHaveLength(2);
  });

  it('counts the syndicate as ONE independent family, not two', () => {
    const [e] = mergeFundingEvents([event(menlo), event(bcapital)]).events;
    // Two firms, two websites, one side of one transaction. Splitting
    // them would let a five-investor syndicate manufacture five
    // "independent sources" for a single round.
    expect(independentSourceFamilies(e)).toEqual(['investor-primary']);
    expect(independentPublishers(e)).toHaveLength(2);
  });
});

// ── 6. Conflicting amounts or stages ──────────────────────────────

describe('sources that disagree are held, never reconciled', () => {
  it('records an amount conflict and flags it for a human', () => {
    const a = event(F.investorItem({
      title: 'Acme Health secures $20M Series B from Menlo Ventures',
      link: 'https://menlovc.com/perspective/acme-health/',
      description: 'Menlo Ventures led the round. Acme Health is a clinical platform.',
      publishedAt: '2026-07-10T00:00:00.000Z',
    }));
    const b = event(F.investorItem({
      title: 'Acme Health secures $22M Series B from B Capital',
      link: 'https://b.capital/acme-health/',
      description: 'B Capital led the round. Acme Health is a clinical platform.',
      publishedAt: '2026-07-11T00:00:00.000Z',
    }));
    const merged = mergeFundingEvents([a, b]);
    expect(merged.conflicted).toHaveLength(1);
    const [e] = merged.events;
    expect(e.needsHumanReview).toBe(true);
    expect(e.conflicts[0].field).toBe('amount');
    expect(e.conflicts[0].values.join(' ')).toMatch(/\$20M/);
    expect(e.conflicts[0].values.join(' ')).toMatch(/\$22M/);
    // Both original numbers survive; neither is averaged or overwritten.
    expect(e.sources.map((s) => s.amountUsd).sort((x, y) => (x ?? 0) - (y ?? 0)))
      .toEqual([20_000_000, 22_000_000]);
  });

  it('records a stage conflict between a press report and an investor', () => {
    const investor = event(F.investorItem({
      title: 'Acme Health secures $20M Series B from Menlo Ventures',
      link: 'https://menlovc.com/perspective/acme-health-b/',
      description: 'Menlo Ventures led the Series B.',
      publishedAt: '2026-07-10T00:00:00.000Z',
    }));
    const press = extractFundingEvent({
      title: 'Acme Health raises $20M Series C',
      link: 'https://techcrunch.com/2026/07/12/acme-health/',
      publishedAt: '2026-07-12T00:00:00.000Z',
      description: 'Acme Health is a clinical platform.',
      author: null, guid: null, categories: [], outboundLinks: [],
    }, TODAY);
    const [e] = mergeFundingEvents([investor, press.ok ? press.event : ({} as FundingEvent)]).events;
    expect(e.conflicts.some((c) => c.field === 'round')).toBe(true);
    expect(e.needsHumanReview).toBe(true);
  });
});

// ── 7. Common-name company safeguards ─────────────────────────────

describe('a common-word company name blocks domain guessing, not the event', () => {
  it('keeps the event but marks the name ambiguous', () => {
    const e = event(F.COMMON_WORD_NAME);
    expect(e.companyName).toBe('Cadence');
    // The financing stands on the investor's own statement. What is
    // blocked is inferring cadence.com belongs to them — that domain is
    // a public EDA company's. A matching domain for a common word is a
    // coincidence, not an identity.
    expect(e.nameAmbiguous).toBe(true);
    expect(e.website).toBeNull();
  });

  it('does not mark a distinctive name ambiguous', () => {
    expect(event(F.BACKED_PREFIX).nameAmbiguous).toBe(false);
    expect(event(F.SPACE_INVESTMENT).nameAmbiguous).toBe(false);
  });

  it('refuses an investment firm masquerading as the company that raised', () => {
    expect(matchesAnyRegisteredInvestor('Menlo Ventures')).toBe('Menlo Ventures');
    expect(matchesAnyRegisteredInvestor('Karoo Health')).toBeNull();
    expect(rejection(F.investorItem({
      title: 'Why We Invested in Mayfield',
      link: 'https://b.capital/why-we-invested-in-mayfield/',
      description: 'A note on our commitment.',
      publishedAt: '2026-07-05T00:00:00.000Z',
    }))).toBe('fund-launch');
  });

  it('trims an investor\'s editorial phrasing down to the company name', () => {
    expect(trimCompanySpan('Pangram to Stop AI Slop on the Internet')).toBe('Pangram');
    expect(trimCompanySpan('Bespoke Labs: Building the Infrastructure for AI Agents')).toBe('Bespoke Labs');
    expect(trimCompanySpan('Suno, the Platform for Creative Entertainment')).toBe('Suno');
    expect(trimCompanySpan('AI Fabrik From Inception')).toBe('AI Fabrik');
    // Title Case press releases give capitalisation no discriminating
    // power, so the verb has to end the name: this produced a company
    // called "TytoCare Names Adam Pellegrini".
    expect(trimCompanySpan('TytoCare Names Adam Pellegrini as CEO and')).toBe('TytoCare');
    // A match that ran past the headline into the summary produced
    // "Cheiron. Drug".
    expect(trimCompanySpan('Cheiron. Drug development is slow.')).toBe('Cheiron');
  });
});

// ── 7b. A domain that responds is not thereby a company's site ────

describe('a page that merely responds is not evidence of a website', () => {
  it('refuses a for-sale listing even though it contains the company word', () => {
    // Real page: bespoke.com serves "BESPOKE.COM - For Sale", which
    // contains "bespoke", so a name-on-page test alone confirmed it as
    // Bespoke Labs' official website during a live dry run.
    expect(pageDisqualifiedAsOfficialSite('<html><title>BESPOKE.COM - For Sale</title><body>'
      + `${'Bespoke premium domain. '.repeat(20)}This domain is for sale. Make an offer.</body></html>`))
      .toMatch(/parked, placeholder, or for-sale/);
  });

  it('refuses a "Coming Soon" placeholder', () => {
    expect(pageDisqualifiedAsOfficialSite(`<html><body>${'Fervo Energy coming soon. '.repeat(20)}</body></html>`))
      .toMatch(/parked, placeholder, or for-sale/);
  });

  it('refuses a page whose title is only its own domain', () => {
    expect(titleIsBareDomain('<html><title>lantern.com</title></html>')).toBe(true);
    expect(titleIsBareDomain('<html><title>Lantern | Specialty care</title></html>')).toBe(false);
  });

  it('accepts a real company page', () => {
    expect(pageDisqualifiedAsOfficialSite(
      '<html><title>Lunar Energy | Endless clean energy for your home</title><body>'
      + `${'Lunar Energy builds home batteries and heat pumps. '.repeat(10)}</body></html>`,
    )).toBeNull();
  });

  it('never derives a domain for investor-primary evidence, only follows a published link', async () => {
    const { resolveCompanyWebsite } = await import('../services/fundingNews');
    const out = await resolveCompanyWebsite(event(F.SPACE_INVESTMENT), [], { allowDerivedDomain: false });
    expect(out.url).toBeNull();
    expect(out.method).toBeNull();
    expect(out.code).toBe('website-unresolved');
    expect(out.detail).toMatch(/Domain guessing is not used for investor-primary/);
  });

  it('will not guess a domain from a name that reduces to a common word', async () => {
    // "Cascade Labs" is two words and so passes the name-level guard, but
    // the stem a domain would be built from is "cascade" — and cascade.com
    // belongs to somebody else. The guard has to look at the string the
    // guess is actually made from.
    const { discoverOfficialWebsite } = await import('../services/corroborate');
    const out = await discoverOfficialWebsite('Cascade Labs');
    expect(out.url).toBeNull();
    expect(out.tried).toHaveLength(0);   // no request was spent
    expect(out.detail).toMatch(/reduces to the common word "cascade"/);
  });
});

// ── 8. Missing or stale date ──────────────────────────────────────

describe('an announcement without a usable date is not a current opportunity', () => {
  it('rejects an undated announcement rather than dating it today', () => {
    expect(rejection(F.NO_DATE)).toBe('no-announcement-date');
  });

  it('rejects an announcement older than the twelve-month window', () => {
    expect(rejection(F.STALE_DATE)).toBe('event-too-old');
  });

  it('propagates the publication date, not the retrieval date', () => {
    const e = event(F.PRESS_RELEASE_ON_INVESTOR_DOMAIN);
    expect(e.announcedAt).toBe('2026-05-14');
    expect(e.retrievedAt).toBe(TODAY);
    expect(e.sources[0].announcedAt).toBe('2026-05-14');
  });
});

// ── 9. Failed or redirected domain ────────────────────────────────

describe('only a page on the investor\'s own verified domain is investor-primary', () => {
  it('rejects an item that links to a publication instead of the firm', () => {
    // M12's feed is entirely off-domain, which is why it is not
    // registered: those pages are press and belong to the press family.
    expect(rejection(F.OFF_DOMAIN_LINK)).toBe('investor-page-off-domain');
  });

  it('does not accept a host that merely ends with a registered name', () => {
    expect(investorForUrl('https://notarchventure.com/x')).toBeNull();
    expect(rejection(F.LOOKALIKE_DOMAIN)).toBe('investor-page-off-domain');
  });

  it('accepts a subdomain of a registered domain', () => {
    expect(investorForUrl('https://news.menlovc.com/x')?.name).toBe('Menlo Ventures');
  });

  it('drops a configured feed that is not on a registered domain', () => {
    const original = process.env.INVESTOR_NEWS_FEEDS;
    try {
      expect(configuredInvestorFeeds()).toEqual(registeredFeeds());
    } finally {
      if (original === undefined) delete process.env.INVESTOR_NEWS_FEEDS;
    }
  });

  it('registers every feed on the domain it claims', () => {
    for (const investor of INVESTOR_REGISTRY) {
      expect(investorForUrl(investor.feed)?.domain, investor.name).toBe(investor.domain);
    }
  });
});

// ── 10. A government grant is not an equity round ─────────────────

describe('non-equity events are never recorded as venture financing', () => {
  it('rejects an NIH grant announced by a participating investor', () => {
    // Real money, real validation, non-dilutive. A commercialization
    // signal is not a round, and the host firm having invested earlier
    // does not make the grant one.
    expect(rejection(F.GOVERNMENT_GRANT)).toBe('grant-or-public-award');
  });

  it('rejects an IPO', () => {
    expect(rejection(F.PUBLIC_OFFERING)).toBe('public-offering');
  });

  it('rejects the firm closing its own fund', () => {
    expect(rejection(F.FIRM_FUND_CLOSE)).toBe('fund-launch');
  });
});

// ── 11. Participation detection, directly ─────────────────────────

describe('participation is read from the page, never assumed from the host', () => {
  const menlo = INVESTOR_REGISTRY.find((i) => i.domain === 'menlovc.com')!;

  it('accepts first-person investment language', () => {
    for (const text of [
      'Investing in Pangram to Stop AI Slop',
      'Our Investment in Cheiron',
      'Why We Invested in Karoo Health',
      'Backing Bespoke Labs',
      'Doubling Down on Suno',
      "Menlo's Investment in Fireworks",
    ]) {
      expect(checkParticipation(text, menlo).participated, text).toBe(true);
    }
  });

  it('accepts the firm naming itself inside financing language', () => {
    const p = checkParticipation('Optura secures $17.5M Series A from Salesforce Ventures and Menlo Ventures', menlo);
    expect(p.participated).toBe(true);
    expect(p.how).toBe('named-as-participant');
  });

  it('refuses a bare mention with no financing context around it', () => {
    // A boilerplate "About Menlo Ventures" footer says nothing about who
    // funded this particular round.
    expect(checkParticipation('Acme raises $10M. About Menlo Ventures: we are a venture firm.', menlo).participated)
      .toBe(false);
  });

  it('refuses another firm\'s investment republished on this firm\'s site', () => {
    expect(checkParticipation("Sequoia's investment in Acme is a big vote of confidence", menlo).participated)
      .toBe(false);
  });
});

// ── 12. Storage: analytics, corroboration and idempotency ─────────

describe('a run with nothing to read reports zero rather than inventing a result', () => {
  beforeEach(() => store.resetForTests());

  it('spends no requests and imports nothing when no feed is configured', async () => {
    const run = await runInvestorNews({ today: TODAY, offline: true, feeds: [] });
    expect(run.imported).toHaveLength(0);
    expect(run.report.itemsRetrieved).toBe(0);
    expect(run.requests).toBe(0);
  });

  it('refuses a feed on an unregistered domain before spending a request on it', async () => {
    const run = await runInvestorNews({
      today: TODAY, offline: true,
      feeds: ['https://example.com/feed/'],
    });
    expect(run.requests).toBe(0);
    expect(run.report.rejections['investor-domain-unverified']).toBe(1);
    expect(run.report.feeds[0].status).toBe('failed');
  });

  it('reports no concentration for an empty database instead of 0% of something', () => {
    const analytics = diversityAnalytics(['health'], { today: TODAY });
    expect(analytics.totalOpportunities).toBe(0);
    expect(Object.keys(analytics.byFamily)).toHaveLength(0);
    expect(Object.keys(analytics.familySharePct)).toHaveLength(0);
  });
});

// ── Storage integration, with real writes ─────────────────────────

describe('an investor announcement becomes a second source family on an existing company', () => {
  beforeEach(() => store.resetForTests());

  it('attaches to a company the press already gave us, and does not duplicate it', async () => {
    const { saveCompany } = await import('../db/repos/companies');
    const { addDealEvidence } = await import('../db/repos/opportunities');
    const { importedCompanySchema } = await import('../services/imports');

    const pressCompany = importedCompanySchema.parse({
      id: 'news-karoo-health',
      name: 'Karoo Health',
      oneLiner: 'Karoo Health raises $12M Series A for cardiovascular care',
      vertical: 'health',
      subcategory: 'Unclassified — requires manual review',
      stage: 'Series A',
      city: 'Unknown', state: '??',
      foundedYear: 2026, teamSize: 1,
      traction: { level: 0, note: 'Unknown — not yet researched' },
      founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown — requires manual research' }],
      evidence: [{
        claim: 'Karoo Health raises $12M Series A', source: 'techcrunch.com (public RSS)',
        url: 'https://techcrunch.com/2026/07/21/karoo-health/', date: '2026-07-21', type: 'News',
      }],
      flags: [], imported: true,
    });
    saveCompany(pressCompany, {
      origin: 'extracted', source: 'funding-news:techcrunch.com',
      reviewStatus: 'Awaiting Review', discoverySource: 'funding-news', discoveredAt: TODAY,
    });
    addDealEvidence('news-karoo-health', {
      opportunityType: 'funding-announcement',
      sourceId: 'funding-news', sourceName: 'techcrunch.com (public RSS)', tier: 2,
      url: 'https://techcrunch.com/2026/07/21/karoo-health/',
      publishedAt: '2026-07-21', retrievedAt: TODAY,
      summary: 'Karoo Health raises $12M Series A', whyCurrent: 'Funding reported 2026-07-21 by techcrunch.com.',
      amountUsd: 12_000_000, amountText: '$12M', roundType: 'Series A', investors: [],
    });

    expect(assessCorroboration('news-karoo-health').independentFamilies).toEqual(['press:techcrunch.com']);

    // Now the investor's own announcement of the same round arrives.
    const { __importInvestorEventForTests } = await import('../services/investorNews');
    const first = __importInvestorEventForTests(event(F.FIRST_PERSON_HEALTH), TODAY);

    expect(listCompanies()).toHaveLength(1);          // no duplicate company
    expect(first!.attachedToExisting).toBe(true);
    expect(first!.companyId).toBe('news-karoo-health');
    expect(first!.evidenceRows).toBe(1);
    expect(first!.familiesAfter.sort()).toEqual(['investor-primary', 'press']);

    const families = assessCorroboration('news-karoo-health').independentFamilies.sort();
    expect(families).toEqual(['investor-primary', 'press:techcrunch.com']);

    // Idempotent: the same announcement a second time changes nothing.
    const second = __importInvestorEventForTests(event(F.FIRST_PERSON_HEALTH), TODAY);
    expect(second!.evidenceRows).toBe(0);
    expect(listCompanies()).toHaveLength(1);
    expect(listDealEvidence('news-karoo-health')).toHaveLength(2);
  });

  it('creates a company when the investor announcement is the only thing we have', async () => {
    const { __importInvestorEventForTests } = await import('../services/investorNews');
    const out = __importInvestorEventForTests(event(F.SPACE_INVESTMENT), TODAY);

    expect(out!.attachedToExisting).toBe(false);
    expect(listCompanies()).toHaveLength(1);
    const [company] = listCompanies();
    expect(company.name).toBe('Star Catcher');
    expect(company.vertical).toBe('spacetech');

    const [evidence] = listDealEvidence(company.id);
    expect(evidence.sourceId).toBe('investor-news');
    expect(evidence.tier).toBe(2);
    expect(evidence.publishedAt).toBe('2026-06-09');
    expect(evidence.sourceName).toContain('b.capital');
    expect(evidence.whyCurrent).toContain('b.capital');
    expect(evidence.whyCurrent).toContain('first-party');

    // One family alone is not corroboration, and the analytics must say so.
    expect(assessCorroboration(company.id).independentFamilies).toEqual(['investor-primary']);
  });

  it('does not count an uncorroborated investor announcement as an opportunity', async () => {
    // A single investor announcement is one account of one event from one
    // side of the table. On its own it makes a company lead, not a deal —
    // and until qualification has run at all, nothing may count it.
    const { __importInvestorEventForTests } = await import('../services/investorNews');
    __importInvestorEventForTests(event(F.SPACE_INVESTMENT), TODAY);

    const analytics = diversityAnalytics(['spacetech'], { today: TODAY });
    expect(analytics.totalOpportunities).toBe(0);
  });

  it('counts an investor-primary opportunity in the family analytics', async () => {
    const { __importInvestorEventForTests } = await import('../services/investorNews');
    const out = __importInvestorEventForTests(event(F.SPACE_INVESTMENT), TODAY);

    // Attribute the opportunity to the investor-primary family only once
    // the issuer has actually passed qualification. Before this fixture
    // existed the assertion passed because a missing verdict silently
    // skipped the gate.
    markQualifiedForTests(out!.companyId);

    const analytics = diversityAnalytics(['spacetech'], { today: TODAY });
    expect(analytics.totalOpportunities).toBe(1);
    expect(analytics.byFamily).toEqual({ 'investor-primary': 1 });
    expect(analytics.familySharePct).toEqual({ 'investor-primary': 100 });
    expect(analytics.warnings.join(' ')).toContain('Investor (primary)');
  });
});
