/**
 * The investors whose own newsrooms this project reads.
 *
 * An entry here is a claim with two parts, and BOTH have to be true for
 * anything published under it to count as investor-primary evidence:
 *
 *  1. `domain` is that firm's official website, and
 *  2. the firm actually participated in the financing the page describes.
 *
 * (1) is settled here, once, by hand. (2) cannot be — it is a property of
 * each individual announcement — so it is re-checked per item by
 * `investorAnnouncement.ts`, which rejects anything that does not SAY the
 * firm took part. A VC blogging about somebody else's round is press
 * commentary published on a VC's server; it is not a first-party record,
 * and treating it as one would be exactly the kind of manufactured
 * diversity this phase exists to avoid.
 *
 * Every feed below was probed on 2026-07-29: HTTP 200, a parseable
 * RSS body, item links on the registered domain, and a robots.txt that
 * does not disallow the feed path. Nothing here needs a credential, and
 * no page behind a login or paywall is read.
 */

export interface RegisteredInvestor {
  /** Firm name as the firm writes it. */
  name: string;
  /** The firm's verified official host, without `www.`. Evidence pages must live here. */
  domain: string;
  /** Public feed URL. Must itself be served from `domain`. */
  feed: string;
  /**
   * Additional strings that identify THIS firm in an announcement's own
   * text — used only to detect participation, never to guess anything.
   *
   * Deliberately conservative: each alias must be long enough and
   * distinctive enough that finding it in a sentence about a financing
   * round means the firm, not a coincidence. "Echo" alone is a word;
   * "Echo Health Ventures" is a firm.
   */
  aliases: string[];
  /** What this firm actually invests in — context for a reader of the run report, not a filter. */
  focus: string;
}

/** An alias shorter than this is a word, not an identity. */
export const MIN_INVESTOR_ALIAS_LENGTH = 4;

export const INVESTOR_REGISTRY: RegisteredInvestor[] = [
  // ── Health-weighted ─────────────────────────────────────────────
  {
    name: 'Echo Health Ventures',
    domain: 'echohealthventures.com',
    feed: 'https://www.echohealthventures.com/feed/',
    aliases: ['Echo Health Ventures', 'Echo Health'],
    focus: 'Digital health and healthcare services',
  },
  {
    name: '7wire Ventures',
    domain: '7wireventures.com',
    feed: 'https://www.7wireventures.com/feed/',
    aliases: ['7wire Ventures', '7wire'],
    focus: 'Digital health',
  },
  {
    name: 'Venrock',
    domain: 'venrock.com',
    feed: 'https://www.venrock.com/feed/',
    aliases: ['Venrock'],
    focus: 'Healthcare and technology',
  },
  {
    name: 'ARCH Venture Partners',
    domain: 'archventure.com',
    feed: 'https://www.archventure.com/feed/',
    aliases: ['ARCH Venture Partners', 'ARCH Venture', 'ARCH-backed'],
    focus: 'Biotechnology and deep science',
  },
  {
    name: 'F-Prime Capital',
    domain: 'fprimecapital.com',
    feed: 'https://www.fprimecapital.com/feed/',
    aliases: ['F-Prime Capital', 'F-Prime'],
    focus: 'Healthcare and technology',
  },
  {
    name: 'Foresite Capital',
    domain: 'foresitecapital.com',
    feed: 'https://www.foresitecapital.com/feed/',
    aliases: ['Foresite Capital', 'Foresite'],
    focus: 'Healthcare and life sciences',
  },
  {
    name: 'SOSV',
    domain: 'sosv.com',
    feed: 'https://sosv.com/feed/',
    aliases: ['SOSV', 'HAX', 'IndieBio'],
    focus: 'Deep tech, human health, climate',
  },

  // ── Space ───────────────────────────────────────────────────────
  {
    name: 'Seraphim Space',
    domain: 'seraphim.vc',
    feed: 'https://seraphim.vc/feed/',
    aliases: ['Seraphim Space', 'Seraphim'],
    focus: 'Space technology',
  },
  {
    name: 'B Capital',
    domain: 'b.capital',
    feed: 'https://b.capital/feed/',
    aliases: ['B Capital'],
    focus: 'Multi-stage: health, climate, space, enterprise',
  },

  // ── Work, learning, workforce ───────────────────────────────────
  {
    name: 'Reach Capital',
    domain: 'reachcapital.com',
    feed: 'https://www.reachcapital.com/feed/',
    aliases: ['Reach Capital'],
    focus: 'Education, workforce and future of work',
  },
  {
    name: 'Union Square Ventures',
    domain: 'usv.com',
    feed: 'https://www.usv.com/writing/feed/',
    aliases: ['Union Square Ventures', 'USV'],
    focus: 'Networks, access to knowledge and capital',
  },

  // ── Multi-sector ────────────────────────────────────────────────
  {
    name: 'Menlo Ventures',
    domain: 'menlovc.com',
    feed: 'https://www.menlovc.com/feed/',
    aliases: ['Menlo Ventures', 'Menlo'],
    focus: 'AI, healthcare, security, enterprise',
  },
  {
    name: 'Mayfield',
    domain: 'mayfield.com',
    feed: 'https://www.mayfield.com/feed/',
    aliases: ['Mayfield Fund', 'Mayfield'],
    focus: 'AI, enterprise and engineering biology',
  },
  {
    name: 'Insight Partners',
    domain: 'insightpartners.com',
    feed: 'https://www.insightpartners.com/feed/',
    aliases: ['Insight Partners', 'Insight Venture'],
    focus: 'Software, healthcare IT, work tooling',
  },
  {
    name: 'Lightspeed Venture Partners',
    domain: 'lsvp.com',
    feed: 'https://www.lsvp.com/feed/',
    aliases: ['Lightspeed Venture Partners', 'Lightspeed'],
    focus: 'Multi-stage, multi-sector',
  },
  {
    name: 'Anzu Partners',
    domain: 'anzupartners.com',
    feed: 'https://www.anzupartners.com/feed/',
    aliases: ['Anzu Partners', 'Anzu'],
    focus: 'Industrial and life-science hardware',
  },
  {
    name: 'Balderton Capital',
    domain: 'balderton.com',
    feed: 'https://www.balderton.com/feed/',
    aliases: ['Balderton Capital', 'Balderton'],
    focus: 'European early and growth stage',
  },
];

/**
 * Investor feeds that were probed and deliberately NOT registered.
 *
 * Recorded because an unexplained absence looks like an oversight, and
 * because each of these is a real answer about what this source family
 * can and cannot do.
 */
export const EXCLUDED_INVESTOR_FEEDS: { host: string; reason: string }[] = [
  {
    host: 'm12.vc',
    reason:
      'Every item links off-domain (forbes.com, reuters.com, bloomberg.com, techcrunch.com). '
      + 'M12 curates press coverage rather than publishing its own announcements, so nothing there is investor-primary — '
      + 'the pages are press, and registering the feed would only spend a request to reject every item.',
  },
  {
    host: 'foundersfund.com',
    reason: 'Feed is real and on-domain but its newest item is from February 2024 — every item is outside the 12-month window.',
  },
  {
    host: 'mucker.com',
    reason: 'Publishes founder-education essays only; probed a full feed and found no financing announcement of any kind.',
  },
  {
    host: 'a16z.com, luxcapital.com, dcvc.com, khoslaventures.com, playground.global, oakhcft.com, emcap.com',
    reason: 'No RSS/Atom feed at any conventional path (HTTP 404). No feed means no credential-free, robots-clean way to read them.',
  },
  {
    host: 'toyotaventures.com',
    reason: 'Connection timed out on every probe. Unreachable, not excluded on policy.',
  },
  {
    host: 'flarecapital.com',
    reason: 'Feed returns HTTP 200 but contains zero items.',
  },
  {
    host: 'eclipse.vc',
    reason: 'The /feed/ path returns an HTML page, not a feed.',
  },
];

const BY_DOMAIN = new Map(INVESTOR_REGISTRY.map((i) => [i.domain, i]));

/** Strip `www.` and lowercase, so host comparisons are about the site, not the label. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** The registered investor for a URL's host, or null when the host is not ours. */
export function investorForUrl(url: string): RegisteredInvestor | null {
  let host: string;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
  const exact = BY_DOMAIN.get(host);
  if (exact) return exact;
  // A subdomain of a registered domain is still that firm's site
  // (news.example.com under example.com). A domain that merely ENDS with
  // the registered string is not — `notarchventure.com` must not match.
  for (const investor of INVESTOR_REGISTRY) {
    if (host.endsWith(`.${investor.domain}`)) return investor;
  }
  return null;
}

export function registeredFeeds(): string[] {
  return INVESTOR_REGISTRY.map((i) => i.feed);
}

/** The investor whose feed this URL is, matched by host rather than by string equality. */
export function investorForFeed(feedUrl: string): RegisteredInvestor | null {
  return investorForUrl(feedUrl);
}
