import { describe, it, expect } from 'vitest';
import {
  parseFeed, extractFundingEvent, mergeFundingEvents, eventIdentity, independentPublishers,
  checkCompanyName, checkArticleUrl, extractRound, extractInvestors, extractHq,
  parseStatedAmount, parseFeedDate, publisherOf,
  RSS_REASON_CODES, RSS_REASON_TEXT,
  type FeedItem, type FundingEvent,
} from '../sourcing/fundingEvent';
import { isAmbiguousCompanyName, checkEntityType } from '../sourcing/classify';
import { leadToEvidence, toIsoDate } from '../sourcing/normalize';
import { candidateToDealEvidence } from '../services/shortlist';
import { classifyOpportunity } from '../../shared/opportunity';

/**
 * The funding-news pipeline, tested at the point where it used to fail
 * silently.
 *
 * Context for anyone reading this later: this source retrieved 77
 * candidates and produced zero opportunities, and the run report said
 * nothing about why. Five separate defects were responsible. Each one now
 * has a test named after the real article that exposed it, so a
 * regression is recognisable rather than merely red.
 */

const TODAY = '2026-07-29';

function item(over: Partial<FeedItem> & { title: string }): FeedItem {
  return {
    link: 'https://techcrunch.com/2026/07/28/story/',
    publishedAt: '2026-07-28T12:00:00.000Z',
    description: '',
    author: null,
    guid: null,
    categories: [],
    outboundLinks: [],
    ...over,
  };
}

function eventFrom(over: Partial<FeedItem> & { title: string }): FundingEvent {
  const out = extractFundingEvent(item(over), TODAY);
  if (!out.ok) throw new Error(`expected an event, got ${out.rejection.code}: ${out.rejection.detail}`);
  return out.event;
}

function rejectionFrom(over: Partial<FeedItem> & { title: string }): string {
  const out = extractFundingEvent(item(over), TODAY);
  if (out.ok) throw new Error(`expected a rejection, got an event for "${over.title}"`);
  return out.rejection.code;
}

// ── The root cause: a lost publication date ───────────────────────

describe('publication dates survive the whole pipeline', () => {
  it('normalizes an ISO timestamp to a date, and refuses to invent one', () => {
    expect(toIsoDate('2026-07-23T15:00:00.000Z')).toBe('2026-07-23');
    expect(toIsoDate('2026-07-23')).toBe('2026-07-23');
    expect(toIsoDate('Wed, 23 Jul 2026 15:00:00 +0000')).toBe('2026-07-23');
    expect(toIsoDate('not a date')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
  });

  it('carries publishedAt as a structured field, not buried in notes', () => {
    const evidence = leadToEvidence({
      sourceId: 'funding-news', sourceName: 'techcrunch.com (public RSS)', sourceType: 'rss',
      sourceUrl: 'https://techcrunch.com/a', evidenceText: 'Headline',
      publishedAt: '2026-07-23T15:00:00.000Z', discoveredAt: '2026-07-29T09:00:00.000Z', founderNames: [], founderProfiles: [], tractionSignals: [],
      investors: [], corroboratingUrls: [], conflictNotes: [], nameAmbiguous: false, confidence: 0.6,
    });
    // The bug: dateAccessed is the RUN time and must never stand in for
    // the publication date.
    expect(evidence.dateAccessed).toBe('2026-07-29');
    expect(evidence.publishedAt).toBe('2026-07-23');
  });

  it('classifies a dated RSS event as a financing signal, not a company lead', () => {
    const [evidence] = candidateToDealEvidence({
      sourceId: 'funding-news',
      evidence: [{
        claim: 'Acme Robotics raises $5M Seed', source: 'techcrunch.com (public RSS)',
        url: 'https://techcrunch.com/a', dateAccessed: TODAY, publishedAt: '2026-07-23',
      }],
      publicFunding: '$5M', mostRecentRound: 'Seed', investors: ['Index Ventures'],
      discoveredAt: `${TODAY}T00:00:00.000Z`,
    });
    expect(evidence.publishedAt).toBe('2026-07-23');
    expect(evidence.amountUsd).toBe(5_000_000);
    expect(evidence.investors).toEqual(['Index Ventures']);

    const classified = classifyOpportunity({ evidence: [evidence], today: TODAY });
    // Before the fix this was 'company-lead' with "No evidence carries a
    // publication date" — for every single RSS candidate.
    expect(classified.classification).toBe('recent-financing-signal');
  });

  it('does not treat the retrieval date as a publication date', () => {
    const [evidence] = candidateToDealEvidence({
      sourceId: 'funding-news',
      evidence: [{
        claim: 'Undated mention', source: 'x', url: 'https://x.example.com/a',
        dateAccessed: TODAY, publishedAt: null,
      }],
      discoveredAt: `${TODAY}T00:00:00.000Z`,
    });
    expect(evidence.publishedAt).toBeNull();
    expect(classifyOpportunity({ evidence: [evidence], today: TODAY }).classification).toBe('company-lead');
  });
});

// ── Feed parsing, per format (§4) ─────────────────────────────────

describe('feed parsing uses each format\'s own fields', () => {
  it('parses RSS 2.0 title, link, pubDate, description, creator and categories', () => {
    const parsed = parseFeed(`<rss version="2.0"><channel><item>
      <title><![CDATA[Acme raises $5M]]></title>
      <link>https://news.example.com/acme</link>
      <pubDate>Wed, 23 Jul 2026 15:00:00 +0000</pubDate>
      <description><![CDATA[<p>Acme, a robotics firm, raised a seed round.</p>]]></description>
      <dc:creator>A. Reporter</dc:creator>
      <category>Robotics</category><category>Venture</category>
      <guid>https://news.example.com/?p=1</guid>
    </item></channel></rss>`);
    expect(parsed.format).toBe('rss');
    expect(parsed.items).toHaveLength(1);
    const [i] = parsed.items;
    expect(i.title).toBe('Acme raises $5M');
    expect(i.publishedAt).toBe('2026-07-23T15:00:00.000Z');
    expect(i.description).toContain('robotics firm');
    expect(i.description).not.toContain('<p>');
    expect(i.author).toBe('A. Reporter');
    expect(i.categories).toEqual(['Robotics', 'Venture']);
  });

  it('parses Atom, where the link is an attribute and there is no pubDate', () => {
    const parsed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Verde lands $2.5 million</title>
      <link rel="alternate" href="https://atom.example.com/verde"/>
      <link rel="edit" href="https://atom.example.com/edit"/>
      <published>2026-07-22T09:00:00Z</published>
      <summary>Verde, a solar company, closed a seed round.</summary>
      <author><name>B. Writer</name></author>
      <category term="Climate"/>
      <id>tag:atom.example.com,2026:1</id>
    </entry></feed>`);
    expect(parsed.format).toBe('atom');
    expect(parsed.items[0].link).toBe('https://atom.example.com/verde');
    expect(parsed.items[0].publishedAt).toBe('2026-07-22T09:00:00.000Z');
    expect(parsed.items[0].author).toBe('B. Writer');
    expect(parsed.items[0].categories).toEqual(['Climate']);
  });

  it('prefers content:encoded over a truncated description', () => {
    const parsed = parseFeed(`<rss><channel><item>
      <title>T</title><link>https://a.example.com/x</link>
      <description>Short teaser…</description>
      <content:encoded><![CDATA[The full article body, which is considerably longer than the teaser and carries the round details.]]></content:encoded>
    </item></channel></rss>`);
    expect(parsed.items[0].description).toContain('carries the round details');
  });

  it('reports a body that is not a feed instead of returning zero items silently', () => {
    const parsed = parseFeed('<html><body>Access denied</body></html>');
    expect(parsed.format).toBe('unknown');
    expect(parsed.rejected[0].code).toBe('feed-not-a-feed');
  });

  it('rejects malformed and suspicious links with named reasons', () => {
    expect(checkArticleUrl('https://news.example.com/a')).toBeNull();
    expect(checkArticleUrl('not-a-url')?.code).toBe('item-link-malformed');
    expect(checkArticleUrl('javascript:alert(1)')?.code).toBe('item-link-suspicious');
    expect(checkArticleUrl('https://user:pw@news.example.com/a')?.code).toBe('item-link-suspicious');
    expect(checkArticleUrl('http://169.254.169.254/latest/meta-data/')?.code).toBe('item-link-suspicious');
    expect(checkArticleUrl('https://localhost/a')?.code).toBe('item-link-malformed');
  });

  it('extracts outbound article links but never the publisher\'s own or a restricted host', () => {
    const parsed = parseFeed(`<rss><channel><item>
      <title>T</title><link>https://techcrunch.com/2026/07/28/x/</link>
      <description><![CDATA[
        <a href="https://acmerobotics.com">Acme Robotics</a>
        <a href="https://techcrunch.com/other">related</a>
        <a href="https://www.crunchbase.com/organization/acme">profile</a>
        <a href="https://x.com/acme">follow</a>
      ]]></description>
    </item></channel></rss>`);
    expect(parsed.items[0].outboundLinks).toEqual(['https://acmerobotics.com']);
  });

  it('parses feed dates in both RFC 822 and ISO form, and refuses garbage', () => {
    expect(parseFeedDate('Tue, 21 Jul 2026 13:20:00 +0000')).toBe('2026-07-21T13:20:00.000Z');
    expect(parseFeedDate('2026-07-21T13:20:00Z')).toBe('2026-07-21T13:20:00.000Z');
    expect(parseFeedDate('last Tuesday')).toBeNull();
    expect(parseFeedDate(undefined)).toBeNull();
  });
});

// ── What is and is not a funding event (§3) ───────────────────────

describe('only an explicit raise by an operating company qualifies', () => {
  it('accepts a stated raise and records amount, round, investors and date', () => {
    const event = eventFrom({
      title: 'Acme Robotics raises $5M Seed round to build warehouse robots',
      description: 'The round was led by Index Ventures, with participation from Slauson & Co. Acme Robotics is based in Austin, TX.',
      publishedAt: '2026-07-27T10:00:00.000Z',
    });
    expect(event.companyName).toBe('Acme Robotics');
    expect(event.amountUsd).toBe(5_000_000);
    expect(event.amountText).toContain('$5M');
    expect(event.roundType).toBe('Seed');
    expect(event.investors).toContain('Index Ventures');
    expect(event.announcedAt).toBe('2026-07-27');
    expect(event.hqCity).toBe('Austin');
    expect(event.hqState).toBe('TX');
    expect(event.publisher).toBe('techcrunch.com');
    expect(event.sector).toBe('robotics');
  });

  it('records a raise with an undisclosed amount without inventing one', () => {
    const event = eventFrom({ title: 'Acme Robotics raises an undisclosed Seed round' });
    expect(event.amountUsd).toBeNull();
    expect(event.amountText).toBeNull();
    expect(event.roundType).toBe('Seed');
  });

  it('never infers an amount, round, investor or location that is not stated', () => {
    const event = eventFrom({ title: 'Acme Robotics raises $5M for warehouse robots' });
    expect(event.roundType).toBeNull();
    expect(event.investors).toEqual([]);
    expect(event.hqCity).toBeNull();
    expect(event.hqState).toBeNull();
  });

  it.each([
    ['fund launch (numbered fund)', 'Greylock closes $1.5B Fund III to back AI startups', 'fund-launch'],
    ['fund launch (debut fund)', 'Dimension Capital raises $800M debut fund', 'fund-launch'],
    ['public offering', 'Chinese memory maker CXMT raises $2B in its initial public offering', 'public-offering'],
    ['debt facility', 'Solaris secures a $200M credit facility from a bank syndicate', 'debt-or-project-finance'],
    ['project finance', 'Northwind closes $400M in project financing for a wind farm', 'debt-or-project-finance'],
    ['government award', 'Cocina Solar is awarded $1.5M in an SBIR Phase II award', 'grant-or-public-award'],
    ['university grant', 'Foshan University receives $4M for battery research', 'grant-or-public-award'],
    ['acquisition', 'Cyera acquires Oasis Security for a reported $250M', 'acquisition-without-financing'],
    ['investor profile', 'Menlo Ventures names a new partner as its limited partners double down', 'investor-or-fund-profile'],
    ['market commentary', 'Q2 2026 funding data shows venture funding fell 12%', 'market-commentary'],
    ['rumoured raise', 'Boring Company reportedly raising funding at a $20B valuation', 'financing-rumored-or-pending'],
    ['pending raise', 'Valar Atomics in talks to raise $200M at a $6B valuation', 'financing-rumored-or-pending'],
    ['no financing at all', 'Perplexity brings its AI agent to Windows', 'no-financing-language'],
  ])('rejects %s', (_label, title, code) => {
    expect(rejectionFrom({ title })).toBe(code);
  });

  it('keeps a round that mixes equity and debt', () => {
    const event = eventFrom({
      title: 'Antares raises $470M Series C',
      description: 'The Series C combines equity and a debt facility, led by Founders Fund.',
    });
    expect(event.roundType).toBe('Series C');
  });

  it('rejects an event older than the twelve-month window', () => {
    expect(rejectionFrom({
      title: 'Acme Robotics raises $5M Seed',
      publishedAt: '2025-01-01T00:00:00.000Z',
    })).toBe('event-too-old');
  });

  it('rejects an event with no publication date rather than dating it today', () => {
    expect(rejectionFrom({ title: 'Acme Robotics raises $5M Seed', publishedAt: null })).toBe('no-announcement-date');
  });

  it('has reason text for every reason code', () => {
    for (const code of RSS_REASON_CODES) {
      expect(RSS_REASON_TEXT[code], code).toBeTruthy();
    }
  });
});

// ── Company resolution (§5) ───────────────────────────────────────

describe('company-name extraction refuses to invent a company', () => {
  it('rejects a category description with no company in it', () => {
    // Real headline. The old extractor produced a company called
    // "Edtech platform" and put it on the dashboard.
    expect(rejectionFrom({ title: 'Edtech platform raises $4.5M to help teach students how to vibe code' }))
      .toBe('company-name-is-descriptor');
  });

  it('rejects a company attributed only to a person', () => {
    expect(rejectionFrom({ title: 'Travis Kalanick’s robotics company raises $1.7B, led by a16z' }))
      .toBe('company-name-is-person');
    expect(rejectionFrom({ title: 'Chamath Palihapitiya raises $135M Series A for his AI coding startup' }))
      .toBe('company-name-is-person');
  });

  it('strips a reporter\'s description to find the real name', () => {
    expect(eventFrom({ title: 'Inference startup Infinity raises $15M from Touring Capital' }).companyName).toBe('Infinity');
    expect(eventFrom({ title: 'Bot-detection startup Spur nabs $200M from Insight' }).companyName).toBe('Spur');
    expect(eventFrom({ title: 'AI-powered travel agency Fora hits unicorn status, raises $60M' }).companyName).toBe('Fora');
    expect(eventFrom({ title: 'London-based Greyparrot raises $27M Series B' }).companyName).toBe('Greyparrot');
    expect(eventFrom({ title: 'ETH Zurich spinout ZuriQ gets $25.5M seed' }).companyName).toBe('ZuriQ');
  });

  it('finds the subject after a subordinate clause, and after an appositive', () => {
    expect(eventFrom({ title: 'As AI content floods the internet, Pangram raises $9M to detect it' }).companyName).toBe('Pangram');
    expect(eventFrom({ title: 'AegisAI, founded by former Google security execs, lands $36M' }).companyName).toBe('AegisAI');
    // A leading gerund is a clause, not a name.
    expect(rejectionFrom({ title: 'Bucking EV headwinds, raises $300M' })).toBe('company-name-is-descriptor');
  });

  it('flags an ambiguous single-word company so no domain is guessed for it', () => {
    const event = eventFrom({ title: 'Natural raises $30M to reinvent payments for AI agents' });
    expect(event.companyName).toBe('Natural');
    // The event is real and kept — only domain guessing is blocked.
    expect(event.nameAmbiguous).toBe(true);
    expect(event.amountUsd).toBe(30_000_000);

    const distinctive = eventFrom({ title: 'Greyparrot raises $27M Series B' });
    expect(distinctive.nameAmbiguous).toBe(false);
  });

  it('knows which single words are too common to identify a company', () => {
    for (const name of ['Natural', 'Cascade', 'Enigma', 'Infinity', 'Multiverse', 'Ramp']) {
      expect(isAmbiguousCompanyName(name), name).toBe(true);
    }
    for (const name of ['Greyparrot', 'Theker', 'ZuriQ', 'AegisAI', 'Bluecore Energy', 'Pine Park Health']) {
      expect(isAmbiguousCompanyName(name), name).toBe(false);
    }
  });

  it('takes the company, not the investor, when both appear in the headline', () => {
    const event = eventFrom({
      title: 'Enigma raises $71M led by Index Ventures and Ribbit Capital',
      description: 'Enigma makes robot control software.',
    });
    expect(event.companyName).toBe('Enigma');
    expect(event.investors).toContain('Index Ventures');
    expect(event.investors).toContain('Ribbit Capital');
    expect(event.investors).not.toContain('Enigma');
  });

  it('takes only the subject when several companies appear in one article', () => {
    const event = eventFrom({
      title: 'Freehand raises $75M to take on Stripe and Adyen',
      description: 'Freehand competes with Stripe, Adyen and Checkout.com in payments.',
    });
    expect(event.companyName).toBe('Freehand');
  });

  it('takes the portfolio company, not the fund, when an article mentions both', () => {
    const event = eventFrom({
      title: 'Bluecore Energy raises $10M pre-seed',
      description: 'The round was led by Slauson & Co, which closed its own $100M Fund II last year.',
    });
    expect(event.companyName).toBe('Bluecore Energy');
    expect(checkEntityType(event.companyName).isOperatingCompany).toBe(true);
    // The fund in the body must never become the subject.
    expect(event.companyName).not.toMatch(/fund/i);
  });

  it('rejects a fund or university that reaches the entity check', () => {
    expect(checkEntityType('Tribe Capital Fintech Fund I, L.P.').isOperatingCompany).toBe(false);
    expect(checkEntityType('School of Management, Foshan University').isOperatingCompany).toBe(false);
    expect(checkEntityType('Acme Robotics Inc').isOperatingCompany).toBe(true);
  });

  it('keeps a foreign company but never guesses a country-code domain for it', () => {
    const event = eventFrom({
      title: 'Theker raises €4M seed',
      description: 'Theker, based in Barcelona, builds humanoid robot arms.',
    });
    expect(event.companyName).toBe('Theker');
    // A euro figure is not a dollar figure and is not converted.
    expect(event.amountUsd).toBeNull();
    expect(event.website).toBeNull();
  });

  it('never fills in a website at extraction time', () => {
    const event = eventFrom({ title: 'Acme Robotics raises $5M Seed' });
    expect(event.website).toBeNull();
    expect(event.websiteConfirmedBy).toBeNull();
  });

  it('rejects a bare legal suffix or abbreviation as a name', () => {
    expect(checkCompanyName('Inc.').ok).toBe(false);
    expect(checkCompanyName('AI').ok).toBe(false);
    expect(checkCompanyName('Acme Robotics').ok).toBe(true);
  });
});

// ── Field parsing ────────────────────────────────────────────────

describe('stated-fact parsing', () => {
  it('parses amounts with their unit and refuses a unitless fragment', () => {
    expect(parseStatedAmount('4.5', 'm')).toEqual({ usd: 4_500_000, text: '$4.5M' });
    expect(parseStatedAmount('1.7', 'B')).toEqual({ usd: 1_700_000_000, text: '$1.7B' });
    expect(parseStatedAmount('500', 'thousand')).toEqual({ usd: 500_000, text: '$500T' });
    expect(parseStatedAmount('4.5', undefined)).toBeNull();
    expect(parseStatedAmount('0', 'm')).toBeNull();
    // A euro figure is recorded as written and never converted.
    expect(parseStatedAmount('4', 'M', '€')).toEqual({ usd: null, text: '€4M' });
  });

  it('reads the round only when it is named', () => {
    expect(extractRound('raises $5M pre-seed round')).toBe('Pre-seed');
    expect(extractRound('raises $5M Series b funding')).toBe('Series B');
    expect(extractRound('raises $5M to grow')).toBeNull();
  });

  it('reads leads and participants without letting the lead capture swallow the clause', () => {
    const investors = extractInvestors('led by Index Ventures and Ribbit Capital, with participation from Conviction');
    expect(investors).toEqual(['Index Ventures', 'Ribbit Capital', 'Conviction']);
    // The bug this guards: the lead capture used to run to the end of the
    // sentence, producing a firm called "with participation from Conviction".
    expect(investors.some((i) => /participation/i.test(i))).toBe(false);
  });

  it('does not split a firm name on its own legal suffix', () => {
    expect(extractInvestors('led by Slauson & Co.')).toEqual(['Slauson Co']);
  });

  it('ignores an unnamed investor', () => {
    expect(extractInvestors('backed by existing investors')).toEqual([]);
    expect(extractInvestors('backed by several angel investors')).toEqual([]);
  });

  it('reads HQ only when stated, and only a real state code', () => {
    expect(extractHq('Acme, based in Austin, TX, builds robots')).toEqual({ city: 'Austin', state: 'TX' });
    expect(extractHq('Acme, based in Barcelona, builds robots').state).toBeNull();
    expect(extractHq('Acme builds robots')).toEqual({ city: null, state: null });
  });

  it('derives the publisher from the article URL', () => {
    expect(publisherOf('https://www.techcrunch.com/2026/07/28/x/')).toBe('techcrunch.com');
    expect(publisherOf('nonsense')).toBe('unknown');
  });
});

// ── Deduplication and conflicts (§7) ─────────────────────────────

describe('one financing event is counted once', () => {
  const base = { title: 'Greyparrot raises $27M Series B', description: 'Waste-sorting AI.' };

  it('merges two identical syndicated copies of the same article', () => {
    const a = eventFrom({ ...base, link: 'https://techcrunch.com/a' });
    const b = eventFrom({ ...base, link: 'https://techcrunch.com/a' });
    const merged = mergeFundingEvents([a, b]);
    expect(merged.events).toHaveLength(1);
    expect(merged.mergedArticles).toBe(1);
    // Same publisher twice is ONE independent source.
    expect(independentPublishers(merged.events[0])).toEqual(['techcrunch.com']);
  });

  it('merges different articles about the same round and keeps every URL', () => {
    const a = eventFrom({ ...base, link: 'https://techcrunch.com/greyparrot', publishedAt: '2026-07-28T00:00:00.000Z' });
    const b = eventFrom({ ...base, link: 'https://siliconangle.com/greyparrot', publishedAt: '2026-07-29T00:00:00.000Z' });
    const merged = mergeFundingEvents([a, b]);
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0].sources.map((s) => s.url).sort()).toEqual([
      'https://siliconangle.com/greyparrot', 'https://techcrunch.com/greyparrot',
    ]);
    // Two newsrooms is real corroboration.
    expect(independentPublishers(merged.events[0])).toHaveLength(2);
    expect(merged.conflicted).toHaveLength(0);
  });

  it('matches the same company written two ways', () => {
    const a = eventFrom({ title: 'Spur raises $200M', link: 'https://techcrunch.com/spur' });
    const b = eventFrom({ title: 'Spur Intelligence raises $200M', link: 'https://techfundingnews.com/spur' });
    expect(mergeFundingEvents([a, b]).events).toHaveLength(1);
  });

  it('keeps separate rounds for the same company separate', () => {
    const seed = eventFrom({
      title: 'Acme Robotics raises $5M Seed', link: 'https://techcrunch.com/seed',
      publishedAt: '2026-02-01T00:00:00.000Z',
    });
    const seriesA = eventFrom({
      title: 'Acme Robotics raises $25M Series A', link: 'https://techcrunch.com/a',
      publishedAt: '2026-07-01T00:00:00.000Z',
    });
    const merged = mergeFundingEvents([seed, seriesA]);
    expect(merged.events).toHaveLength(2);
    expect(merged.events.map((e) => e.roundType).sort()).toEqual(['Seed', 'Series A']);
  });

  it('folds an updated version of an article into the same event', () => {
    const original = eventFrom({
      ...base, link: 'https://techcrunch.com/greyparrot', publishedAt: '2026-07-28T08:00:00.000Z',
    });
    const updated = eventFrom({
      title: 'Greyparrot raises $27M Series B led by Index Ventures',
      description: 'Updated: the round was led by Index Ventures.',
      link: 'https://techcrunch.com/greyparrot', publishedAt: '2026-07-28T18:00:00.000Z',
    });
    const merged = mergeFundingEvents([original, updated]);
    expect(merged.events).toHaveLength(1);
    // The update ADDS detail without overwriting the event.
    expect(merged.events[0].investors).toContain('Index Ventures');
    expect(merged.events[0].needsHumanReview).toBe(false);
  });

  it('flags an amount discrepancy for human review instead of picking one', () => {
    const a = eventFrom({ title: 'Enigma raises $71M Seed', link: 'https://techcrunch.com/enigma' });
    const b = eventFrom({ title: 'Enigma raises $70M Seed', link: 'https://siliconangle.com/enigma' });
    const merged = mergeFundingEvents([a, b]);
    expect(merged.events).toHaveLength(1);
    expect(merged.conflicted).toHaveLength(1);
    const [conflict] = merged.events[0].conflicts;
    expect(conflict.field).toBe('amount');
    expect(conflict.values.join(' ')).toMatch(/\$71M/);
    expect(conflict.values.join(' ')).toMatch(/\$70M/);
    expect(merged.events[0].needsHumanReview).toBe(true);
    // Neither figure is silently adopted as the truth.
    expect(merged.events[0].amountUsd).toBe(71_000_000);
  });

  it('flags a round discrepancy for human review', () => {
    const a = eventFrom({ title: 'Dwelly raises $170M Series B', link: 'https://sifted.eu/dwelly' });
    const b = eventFrom({ title: 'Dwelly raises $170M Series C', link: 'https://techcrunch.com/dwelly' });
    const merged = mergeFundingEvents([a, b]);
    expect(merged.events[0].conflicts.some((c) => c.field === 'round')).toBe(true);
    expect(merged.events[0].needsHumanReview).toBe(true);
  });

  it('fills a missing amount from a later article without calling it a conflict', () => {
    const noAmount = eventFrom({
      title: 'Acme Robotics raises an undisclosed Seed round', link: 'https://techcrunch.com/acme',
    });
    const withAmount = eventFrom({
      title: 'Acme Robotics raises $5M Seed', link: 'https://siliconangle.com/acme',
    });
    const merged = mergeFundingEvents([noAmount, withAmount]);
    expect(merged.events[0].amountUsd).toBe(5_000_000);
    expect(merged.events[0].needsHumanReview).toBe(false);
  });

  it('keeps each publisher\'s own figures so no outlet is misquoted', () => {
    const a = eventFrom({ title: 'Greyparrot raises $27M Series B', link: 'https://siliconangle.com/greyparrot', publishedAt: '2026-07-28T00:00:00.000Z' });
    const b = eventFrom({ title: 'Greyparrot raises $27M Series B', link: 'https://techfundingnews.com/greyparrot', publishedAt: '2026-07-29T00:00:00.000Z' });
    const [merged] = mergeFundingEvents([a, b]).events;

    // The bug this guards: the merged event's primary amountText was
    // written onto every article's row, so a TechFundingNews row read
    // "$27M (as stated by siliconangle.com)" — a misquotation of both.
    const byPublisher = new Map(merged.sources.map((s) => [s.publisher, s]));
    expect(byPublisher.get('siliconangle.com')!.amountText).toBe('$27M (as stated by siliconangle.com)');
    expect(byPublisher.get('techfundingnews.com')!.amountText).toBe('$27M (as stated by techfundingnews.com)');
  });

  it('records each publisher\'s figure separately when they disagree', () => {
    const a = eventFrom({ title: 'Enigma raises $71M Seed', link: 'https://techcrunch.com/enigma' });
    const b = eventFrom({ title: 'Enigma raises $70M Seed', link: 'https://siliconangle.com/enigma' });
    const [merged] = mergeFundingEvents([a, b]).events;
    const amounts = merged.sources.map((s) => s.amountUsd).sort((x, y) => (x ?? 0) - (y ?? 0));
    // Both original numbers survive the merge; neither is overwritten.
    expect(amounts).toEqual([70_000_000, 71_000_000]);
  });

  it('gives an event a stable identity built from what the sources stated', () => {
    const event = eventFrom({ title: 'Acme Robotics raises $5M Seed', publishedAt: '2026-07-27T00:00:00.000Z' });
    expect(eventIdentity(event)).toBe('acme robotics|2026-07-27|Seed|5000000');
    const undated = eventFrom({ title: 'Acme Robotics raises an undisclosed Seed round', publishedAt: '2026-07-27T00:00:00.000Z' });
    expect(eventIdentity(undated)).toBe('acme robotics|2026-07-27|Seed|amount-unknown');
  });
});

// ── Sector classification (§8) ────────────────────────────────────

describe('sector assignment is based on the product, not a broad word', () => {
  it('places a rocket-engine company in space tech', () => {
    expect(eventFrom({
      title: 'Venus Aerospace raises $90M Series B to build a new kind of rocket engine',
    }).sector).toBe('spacetech');
  });

  it('places a workforce product in future of work', () => {
    expect(eventFrom({
      title: 'Turno raises $12M Seed',
      description: 'Turno builds shift scheduling and workforce management software for hourly teams.',
    }).sector).toBe('fow');
  });

  it('places a model company in general AI', () => {
    expect(eventFrom({
      title: 'Fish Audio raises $52M seed',
      description: 'Fish Audio builds AI voice models for creators and enterprises.',
    }).sector).toBe('ai');
  });

  it('refuses a sector when the text does not support one', () => {
    // A cybersecurity company is genuinely outside the seven sectors, and
    // an honest null keeps it out of every shortlist.
    const event = eventFrom({
      title: 'Act Security raises $60M Seed',
      description: 'Act Security governs agentic access sprawl at the infrastructure layer.',
    });
    expect(event.sector).toBeNull();
    expect(event.sectorConfidence).toBe(0);
  });

  it('does not let a bare mention of AI decide a sector', () => {
    const event = eventFrom({
      title: 'Cascade raises $3.5M to help construction firms find and win projects using AI',
    });
    expect(event.sector).toBeNull();
  });
});
