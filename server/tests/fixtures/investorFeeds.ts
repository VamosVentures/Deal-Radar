import type { FeedItem } from '../../sourcing/fundingEvent';

/**
 * Investor-newsroom fixtures.
 *
 * Every one is a real title shape observed on a registered investor's
 * feed on 2026-07-29, kept verbatim so a test failure means the rules
 * changed rather than that the fixture was imagined. Bodies are trimmed
 * to the sentence that carries the fact under test.
 */

export function investorItem(over: Partial<FeedItem> & { title: string; link: string }): FeedItem {
  return {
    publishedAt: '2026-07-20T12:00:00.000Z',
    description: '',
    author: null,
    guid: null,
    categories: [],
    outboundLinks: [],
    ...over,
  };
}

// ── Valid investor announcements ──────────────────────────────────

/** First-person: the firm names the company and its own participation. */
export const FIRST_PERSON_HEALTH = investorItem({
  title: 'Why We Invested in Karoo Health',
  link: 'https://www.7wireventures.com/news/why-we-invested-in-karoo-health/',
  description: 'Karoo Health delivers cardiovascular care management for health systems and their patients.',
  publishedAt: '2026-07-21T00:00:00.000Z',
});

/** Company-voice press release hosted by a participating investor. */
export const PRESS_RELEASE_ON_INVESTOR_DOMAIN = investorItem({
  title: 'Optura secures $17.5 Million Series A from Salesforce Ventures and Echo Health Ventures to scale its clinical platform',
  link: 'https://www.echohealthventures.com/news/optura-series-a/',
  description: 'Optura, a clinical documentation company, said the round was led by Salesforce Ventures with participation from Echo Health Ventures.',
  publishedAt: '2026-05-14T00:00:00.000Z',
});

/** `<Alias>-backed` names the company and the firm's stake in one phrase. */
export const BACKED_PREFIX = investorItem({
  title: 'ARCH-backed SonoThera secures Series B funding to advance safer gene therapies',
  link: 'https://www.archventure.com/news/sonothera-series-b/',
  description: 'SonoThera is developing non-viral gene therapy for patients, backed by ARCH Venture Partners.',
  publishedAt: '2026-06-11T00:00:00.000Z',
});

/** Space tech — the sector the shortlist is shortest in. */
export const SPACE_INVESTMENT = investorItem({
  title: 'Why We Invested in Star Catcher',
  link: 'https://b.capital/why-we-invested-in-star-catcher/',
  description: 'Star Catcher is building an in-space energy grid to beam power to satellites in orbit. We led their Series A.',
  publishedAt: '2026-06-09T00:00:00.000Z',
});

// ── Investor pages that are not financing ─────────────────────────

export const FIRM_HIRE = investorItem({
  title: 'Anish Aitharaju Joins 7wire Ventures as Investment Principal',
  link: 'https://www.7wireventures.com/news/anish-aitharaju-joins/',
  description: 'We are pleased to welcome Anish to the investment team.',
  publishedAt: '2026-06-26T00:00:00.000Z',
});

export const FIRM_REPORT = investorItem({
  title: 'Echo Health Ventures releases 2025 Impact Report',
  link: 'https://www.echohealthventures.com/news/2025-impact-report/',
  description: 'Our annual impact report covers the portfolio and the year.',
  publishedAt: '2026-04-16T00:00:00.000Z',
});

/** A round the host firm had nothing to do with, republished on its site. */
export const THIRD_PARTY_ROUND = investorItem({
  title: 'AvenCell gets $112M to build switchable CAR-T therapies',
  link: 'https://www.fprimecapital.com/news/avencell-112m/',
  description: 'AvenCell Therapeutics raised $112 million in a Series B led by Novo Holdings.',
  publishedAt: '2026-07-10T00:00:00.000Z',
});

export const PORTFOLIO_LISTING = investorItem({
  title: 'Welcoming Seaport Therapeutics to Our Portfolio',
  link: 'https://www.foresitecapital.com/news/welcoming-seaport-therapeutics/',
  description: 'Seaport Therapeutics is advancing neuropsychiatric medicines. Foresite Capital invests across the life sciences.',
  publishedAt: '2026-07-01T00:00:00.000Z',
});

export const PORTFOLIO_SPOTLIGHT = investorItem({
  title: 'Portfolio Spotlight: Online Oceans',
  link: 'https://seraphim.vc/portfolio-spotlight-online-oceans/',
  description: 'A look at what Online Oceans has been building this quarter.',
  publishedAt: '2026-07-23T00:00:00.000Z',
});

// ── Non-equity and non-venture events ─────────────────────────────

export const GOVERNMENT_GRANT = investorItem({
  title: 'Helio Bio awarded $2.4M in an NIH grant to expand its assay platform',
  link: 'https://www.archventure.com/news/helio-bio-nih-grant/',
  description: 'ARCH Venture Partners portfolio company Helio Bio received the award from the National Institutes of Health. Backed by ARCH Venture Partners since seed.',
  publishedAt: '2026-07-02T00:00:00.000Z',
});

export const PUBLIC_OFFERING = investorItem({
  title: 'Kardigan raises $400M in IPO to fund three clinical-stage programs',
  link: 'https://www.archventure.com/news/kardigan-ipo/',
  description: 'Kardigan, backed by ARCH Venture Partners, listed on Nasdaq.',
  publishedAt: '2026-06-18T00:00:00.000Z',
});

export const FIRM_FUND_CLOSE = investorItem({
  title: 'Mayfield closes $955M Fund XVII to back AI-first companies',
  link: 'https://www.mayfield.com/news/fund-xvii/',
  description: 'We are pleased to announce our seventeenth fund.',
  publishedAt: '2026-07-14T00:00:00.000Z',
});

// ── Domain problems ───────────────────────────────────────────────

/** An investor newsroom that links out to a publication. */
export const OFF_DOMAIN_LINK = investorItem({
  title: 'Knox Systems Raises $25M Series A to Scale Its AI-Managed Cloud',
  link: 'https://www.geekwire.com/2026/knox-systems-series-a/',
  description: 'M12, Microsoft\'s venture fund, led the round.',
  publishedAt: '2026-03-17T00:00:00.000Z',
});

/** A host that merely ends with a registered name is a different site. */
export const LOOKALIKE_DOMAIN = investorItem({
  title: 'Why We Invested in Acme Robotics',
  link: 'https://notarchventure.com/why-we-invested-in-acme-robotics/',
  description: 'Acme Robotics builds warehouse robots.',
  publishedAt: '2026-07-10T00:00:00.000Z',
});

// ── Date problems ─────────────────────────────────────────────────

export const NO_DATE = investorItem({
  title: 'Why We Invested in Karoo Health',
  link: 'https://www.7wireventures.com/news/why-we-invested-in-karoo-health/',
  description: 'Karoo Health delivers cardiovascular care management.',
  publishedAt: null,
});

export const STALE_DATE = investorItem({
  title: 'Announcing Our Investment in Thyme Care',
  link: 'https://www.foresitecapital.com/news/thyme-care/',
  description: 'Thyme Care is transforming the oncology patient experience.',
  publishedAt: '2023-08-23T00:00:00.000Z',
});

// ── Common-name safeguards ────────────────────────────────────────

/**
 * "Cadence" is also a large public EDA company, a musical term, and a
 * dozen other businesses. The financing is real; the NAME identifies no
 * one uniquely, so no domain may be derived from it.
 */
export const COMMON_WORD_NAME = investorItem({
  title: 'Why We Invested: Cadence',
  link: 'https://b.capital/why-we-invested-cadence/',
  description: 'Cadence delivers remote patient monitoring for chronic conditions.',
  publishedAt: '2026-06-25T00:00:00.000Z',
});
