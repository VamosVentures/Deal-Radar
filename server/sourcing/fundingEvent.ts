import { normalizeCompanyKey, isHighConfidenceFuzzy } from './identity';
import { classifyCandidate, classifyPossessiveName, isAmbiguousCompanyName } from './classify';
import type { VerticalId } from '../../src/types';

/**
 * Funding-event extraction from published articles.
 *
 * Replaces a headline-prefix regex that produced company names like
 * "Edtech platform", "Travis Kalanick's robotics company", and bare
 * ambiguous words like "Natural" and "Cascade". Those are not companies,
 * and importing them as deals would have been worse than importing
 * nothing.
 *
 * The rule this module enforces: an article becomes a funding event ONLY
 * when it explicitly states that an operating company raised capital.
 * Everything else — fund launches, public offerings, debt facilities,
 * grants, acquisitions, investor profiles, market commentary — is
 * rejected with a named reason code. Nothing is inferred: an amount, a
 * round, an investor, or a location that the article does not state stays
 * null.
 *
 * Pure functions only. No network, no database — so every rule here is
 * directly testable against real article text.
 */

// ── Reason codes ──────────────────────────────────────────────────

/**
 * Every rejection carries one of these. Silent failures were the
 * original defect: 77 candidates produced 0 opportunities and the run
 * report said nothing about why.
 */
export const RSS_REASON_CODES = [
  // Feed / item level
  'feed-unreachable',
  'feed-not-a-feed',
  'feed-no-items',
  'item-no-title',
  'item-no-link',
  'item-link-malformed',
  'item-link-suspicious',
  // Is it a financing event at all?
  'no-financing-language',
  'fund-launch',
  'public-offering',
  'debt-or-project-finance',
  'grant-or-public-award',
  'acquisition-without-financing',
  'investor-or-fund-profile',
  'market-commentary',
  'financing-not-attributed',
  // Company resolution
  'financing-rumored-or-pending',
  'company-name-not-extractable',
  'company-name-is-descriptor',
  'company-name-is-person',
  'not-operating-company',
  'website-unresolved',
  'website-not-confirmed',
  // Event quality
  'no-announcement-date',
  'event-too-old',
  'no-amount-or-round-stated',
  // Downstream
  'no-sector-signal',
  'duplicate-syndicated',
  'duplicate-same-event',
  'corroboration-missing',
  'conflicting-financing-details',
] as const;
export type RssReasonCode = (typeof RSS_REASON_CODES)[number];

export const RSS_REASON_TEXT: Record<RssReasonCode, string> = {
  'feed-unreachable': 'The feed did not respond.',
  'feed-not-a-feed': 'The response body was not RSS or Atom.',
  'feed-no-items': 'The feed parsed but contained no items.',
  'item-no-title': 'The item has no title.',
  'item-no-link': 'The item has no link.',
  'item-link-malformed': 'The item link is not a usable http(s) URL.',
  'item-link-suspicious': 'The item link has an unsafe shape (credentials, bare IP, or non-web scheme).',
  'no-financing-language': 'Nothing in the article states that capital was raised.',
  'fund-launch': 'This is an investment fund closing its own fund, not a company raising capital.',
  'public-offering': 'This is a public-market offering by a listed company, not venture financing.',
  'debt-or-project-finance': 'The only financing described is debt or project finance.',
  'grant-or-public-award': 'This is a grant or public award, not capital raised from investors.',
  'acquisition-without-financing': 'This describes an acquisition or merger with no financing round.',
  'investor-or-fund-profile': 'This is about an investor or firm rather than a company that raised.',
  'market-commentary': 'This is market commentary or aggregate funding data, not a single event.',
  'financing-not-attributed': 'Funding language appears but is not attributed to a named company.',
  'financing-rumored-or-pending': 'The article reports a raise in progress or rumoured, not capital received.',
  'company-name-not-extractable': 'No company name could be read from the article without guessing.',
  'company-name-is-descriptor': 'The extracted subject is a category description, not a company name.',
  'company-name-is-person': 'The extracted subject refers to a person, not the company that raised.',
  'not-operating-company': 'The named entity is a fund, university, or government body.',
  'website-unresolved': 'No official website could be found for the company.',
  'website-not-confirmed': 'A candidate website responded but did not confirm the company identity.',
  'no-announcement-date': 'The article carries no publication or announcement date.',
  'event-too-old': 'The financing event is older than the 12-month window.',
  'no-amount-or-round-stated': 'Neither an amount nor a round is stated, so there is no verifiable event.',
  'no-sector-signal': 'The article text does not support any sector assignment.',
  'duplicate-syndicated': 'A syndicated copy of an article already processed.',
  'duplicate-same-event': 'A different article about a financing event already recorded.',
  'corroboration-missing': 'Only one independent source family — a second is required.',
  'conflicting-financing-details': 'Sources disagree on the amount or round; held for human review.',
};

export interface Rejection {
  code: RssReasonCode;
  /** The specific text that triggered it, so a human can check the call. */
  detail: string;
}

// ── Feed parsing (format-specific) ────────────────────────────────

export interface FeedItem {
  title: string;
  link: string;
  /** Full ISO timestamp as the feed published it, or null. */
  publishedAt: string | null;
  /** Summary/description/content, tags stripped. */
  description: string;
  author: string | null;
  guid: string | null;
  categories: string[];
  /**
   * Outbound links the publisher put in the syndicated content, excluding
   * their own host. These are how an article POINTS AT the company it is
   * writing about, which beats guessing a domain from the name — §5's
   * "explicit article links". Extracted from the feed's own content; no
   * article page is fetched to obtain them.
   */
  outboundLinks: string[];
}

export interface FeedParse {
  format: 'rss' | 'atom' | 'unknown';
  items: FeedItem[];
  /** Per-item rejections at the parse stage. */
  rejected: Rejection[];
}

/**
 * Hosts that are never a company's official site: the publisher's own
 * network, social platforms, aggregators, and the services this project
 * is not permitted to read.
 */
const IGNORED_LINK_HOSTS = /(?:^|\.)(?:twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|youtu\.be|linkedin\.com|crunchbase\.com|pitchbook\.com|medium\.com|substack\.com|techcrunch\.com|siliconangle\.com|sifted\.eu|techfundingnews\.com|wordpress\.com|feedburner\.com|google\.com|apple\.com|amazon\.com|reddit\.com|github\.com|wikipedia\.org|bit\.ly|t\.co)$/i;

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Tags out, entities decoded, whitespace collapsed. */
function toText(raw: string | null): string {
  if (!raw) return '';
  return decodeEntities(stripCdata(raw).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagContent(block: string, tag: string): string | null {
  // Escape the ':' in namespaced tags; match the tag name exactly so
  // <content:encoded> is never picked up by a request for <content>.
  const t = tag.replace(/:/g, '\\:');
  const m = block.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i'));
  return m ? m[1] : null;
}

function allTagContents(block: string, tag: string): string[] {
  const t = tag.replace(/:/g, '\\:');
  const out: string[] = [];
  const re = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(m[1]);
  return out;
}

/** `Wed, 23 Jul 2026 15:00:00 +0000` or `2026-07-23T15:00:00Z` → full ISO. */
export function parseFeedDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return null;
  // A date far in the future is a feed bug, not a real announcement.
  return d.toISOString();
}

/**
 * URL safety for links we will store and later fetch. Deliberately
 * stricter than a URL parse: embedded credentials, bare IP hosts, and
 * non-web schemes are all signs of something we should not follow.
 */
export function checkArticleUrl(raw: string): Rejection | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { code: 'item-link-malformed', detail: raw.slice(0, 120) };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { code: 'item-link-suspicious', detail: `scheme ${u.protocol}` };
  }
  if (u.username || u.password) {
    return { code: 'item-link-suspicious', detail: 'embedded credentials' };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(':')) {
    return { code: 'item-link-suspicious', detail: `bare IP host ${u.hostname}` };
  }
  if (!u.hostname.includes('.') || u.hostname.endsWith('.')) {
    return { code: 'item-link-malformed', detail: `host ${u.hostname}` };
  }
  if (raw.length > 2000) {
    return { code: 'item-link-suspicious', detail: 'URL exceeds 2000 characters' };
  }
  return null;
}

/**
 * Parse RSS 2.0 or Atom, using each format's own field names.
 *
 * Sniffing the format matters: Atom has no <pubDate> and puts the URL in
 * a <link href> attribute, so an RSS-only parser silently returns entries
 * with no date and no link — which is exactly the class of bug that made
 * the pipeline look like it was working while producing nothing.
 */
export function parseFeed(xml: string): FeedParse {
  const rejected: Rejection[] = [];
  const isAtom = /<feed[\s>][\s\S]*?xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(xml)
    || (/<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml));
  const isRss = /<rss[\s>]/i.test(xml) || /<item[\s>]/i.test(xml);

  if (!isAtom && !isRss) {
    return { format: 'unknown', items: [], rejected: [{ code: 'feed-not-a-feed', detail: xml.slice(0, 80) }] };
  }

  const blocks = isAtom
    ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? []
    : xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];

  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = toText(tagContent(block, 'title'));
    if (!title) { rejected.push({ code: 'item-no-title', detail: block.slice(0, 60) }); continue; }

    // Atom: <link rel="alternate" href="…"/>. RSS: <link>…</link>.
    let link = '';
    if (isAtom) {
      const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
      const pick = links.find((a) => /rel\s*=\s*["']alternate["']/i.test(a)) ?? links.find((a) => !/rel\s*=/i.test(a));
      link = pick?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';
    } else {
      link = toText(tagContent(block, 'link'));
    }
    if (!link) { rejected.push({ code: 'item-no-link', detail: title.slice(0, 80) }); continue; }
    const urlProblem = checkArticleUrl(link);
    if (urlProblem) { rejected.push(urlProblem); continue; }

    const publishedAt = isAtom
      ? parseFeedDate(toText(tagContent(block, 'published')) || toText(tagContent(block, 'updated')))
      : parseFeedDate(
        toText(tagContent(block, 'pubDate'))
        || toText(tagContent(block, 'dc:date'))
        || toText(tagContent(block, 'date')),
      );

    // Prefer the longest available body text: full content beats a
    // truncated summary, and the round/investors usually live in the body.
    const bodies = isAtom
      ? [tagContent(block, 'content'), tagContent(block, 'summary')]
      : [tagContent(block, 'content:encoded'), tagContent(block, 'description'), tagContent(block, 'summary')];
    const description = bodies.map(toText).sort((a, b) => b.length - a.length)[0] ?? '';

    const author = isAtom
      ? toText(tagContent(tagContent(block, 'author') ?? '', 'name')) || null
      : toText(tagContent(block, 'dc:creator')) || toText(tagContent(block, 'author')) || null;

    const categories = isAtom
      ? [...block.matchAll(/<category\b[^>]*term\s*=\s*["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1]))
      : allTagContents(block, 'category').map(toText).filter(Boolean);

    const rawBody = (isAtom
      ? [tagContent(block, 'content'), tagContent(block, 'summary')]
      : [tagContent(block, 'content:encoded'), tagContent(block, 'description')])
      .filter(Boolean).map((b) => stripCdata(b!)).join(' ');
    const publisherHost = (() => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const outboundLinks = [...new Set(
      [...rawBody.matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
        .map((m) => decodeEntities(m[1]).trim())
        .filter((u) => /^https?:\/\//i.test(u))
        .filter((u) => !checkArticleUrl(u))
        .filter((u) => {
          const h = new URL(u).hostname.replace(/^www\./, '');
          return h !== publisherHost && !IGNORED_LINK_HOSTS.test(h);
        }),
    )].slice(0, 12);

    items.push({
      title,
      link: link.trim(),
      outboundLinks,
      publishedAt,
      description,
      author,
      guid: toText(tagContent(block, isAtom ? 'id' : 'guid')) || null,
      categories: [...new Set(categories)],
    });
  }

  return { format: isAtom ? 'atom' : 'rss', items, rejected };
}

// ── Is this a financing event? ────────────────────────────────────

/** Verbs that, with a company subject and an amount, state a raise. */
const RAISE_VERBS = 'raises|raised|lands|landed|secures|secured|closes|closed|nabs|nabbed|banks|banked|snags|snagged|picks up|picked up|pulls in|pulled in|scores|scored|gets|got|nets|netted';

/**
 * Currency symbol is captured, not assumed. A €4M round is a real stated
 * amount, but it is not four million dollars and must never be recorded
 * as one — no conversion rate is a stated fact.
 */
const AMOUNT = '([$€£¥])\\s?([\\d.,]+)\\s*(k|m|b|bn|thousand|million|billion)?';

/** "Acme raises $5M", "Acme has raised a $5M Series A". */
const RAISE_PATTERN = new RegExp(
  `^(.{2,70}?)\\s+(?:has\\s+|have\\s+|just\\s+)?(?:${RAISE_VERBS})\\s+(?:an?\\s+|its\\s+|another\\s+)?(?:additional\\s+)?${AMOUNT}`,
  'i',
);

/** A raise with no disclosed amount: "Acme raises a Series A". */
const RAISE_NO_AMOUNT_PATTERN = new RegExp(
  `^(.{2,70}?)\\s+(?:has\\s+|have\\s+|just\\s+)?(?:${RAISE_VERBS})\\s+(?:an?\\s+|its\\s+)?(?:undisclosed\\s+)?(pre-?seed|seed|series\\s+[a-f])\\b`,
  'i',
);

/** Any financing language at all — used to separate "not an event" from "an event we could not attribute". */
const FINANCING_LANGUAGE = new RegExp(`\\b(?:${RAISE_VERBS})\\b|\\bfunding\\b|\\bfinancing\\b|\\binvestment\\b|\\bround\\b`, 'i');

/**
 * Disqualifiers. Order matters: the most specific non-event shapes are
 * tested first so an article gets the most informative reason code.
 *
 * Each pattern was written against a real headline shape seen in these
 * feeds, not imagined. A disqualifier only fires on the TITLE plus the
 * first part of the body, because a passing mention deep in an article
 * ("the round follows the firm's $200M fund") should not disqualify a
 * genuine company raise.
 */
const DISQUALIFIERS: { code: RssReasonCode; pattern: RegExp }[] = [
  // A VC/PE firm closing its own fund. "closes $200M Fund III",
  // "raises $150M debut fund", "launches a $50M vehicle".
  { code: 'fund-launch', pattern: /\b(?:fund|vehicle)\s+(?:[IVXL]+|\d+)\b/i },
  { code: 'fund-launch', pattern: /\b(?:debut|first|second|third|new|inaugural|maiden|flagship|oversubscribed)\s+(?:\$[\d.,]+\s*[kmb]\w*\s+)?fund\b/i },
  { code: 'fund-launch', pattern: /\b(?:raises|raised|closes|closed|launches|launched|announces|unveils)\s+(?:an?\s+)?(?:\$[\d.,]+\s*(?:k|m|b|bn|million|billion)?\s+)?(?:venture|growth|seed|opportunity|evergreen|early-stage|late-stage|debt|crypto|climate|AI)?\s*fund\b/i },
  { code: 'fund-launch', pattern: /\bfund\s+to\s+(?:back|invest|bet|double\s+down)\b/i },
  { code: 'fund-launch', pattern: /\b(?:VC|venture\s+(?:capital|firm)|PE|private\s+equity)\s+(?:firm|fund)\b.{0,40}\b(?:closes|closed|raises|raised)\b/i },

  // Public markets.
  { code: 'public-offering', pattern: /\b(?:initial\s+public\s+offering|IPO\b|direct\s+listing|SPAC\b|goes?\s+public|files?\s+(?:to|for)\s+(?:an?\s+)?IPO|secondary\s+offering|follow-?on\s+offering|public\s+offering\s+of|share\s+sale|stock\s+offering)\b/i },

  // Debt and project finance. Only a disqualifier when no equity round
  // is also stated — checked by the caller before this list is applied.
  { code: 'debt-or-project-finance', pattern: /\b(?:debt\s+facility|credit\s+facility|term\s+loan|revolving\s+credit|warehouse\s+facility|asset-?backed|project\s+financ\w*|bond\s+(?:sale|offering|issue)|convertible\s+note\s+facility|loan\s+from)\b/i },

  // Public money.
  { code: 'grant-or-public-award', pattern: /\b(?:grant\s+(?:from|of|award)|awarded\s+(?:a\s+)?\$|SBIR|STTR|NSF\s+(?:grant|award)|NIH\s+(?:grant|award)|DARPA\s+(?:contract|award)|DOE\s+(?:grant|loan|award)|EU\s+grant|Horizon\s+Europe|research\s+grant)\b/i },
  { code: 'grant-or-public-award', pattern: /\b(?:university|universities|college)\b.{0,30}\b(?:receives?|awarded|wins?)\b/i },

  // M&A with no round for the subject.
  { code: 'acquisition-without-financing', pattern: /\b(?:acquires?|acquired|acquiring|acquisition\s+of|buys?\s+\w|bought|to\s+buy|merges?\s+with|merger\s+with|takeover\s+of|snaps?\s+up)\b/i },

  // Articles about investors, not companies.
  { code: 'investor-or-fund-profile', pattern: /\b(?:limited\s+partners?|LPs\b|general\s+partner|joins?\s+as\s+(?:a\s+)?partner|(?:new|next)\s+partner\s+at|our\s+(?:thesis|portfolio)|portfolio\s+construction|anchor\s+investor\s+in\s+the\s+fund)\b/i },

  // A raise in progress is a fundraising rumour, not capital received.
  // "in talks to raise", "reportedly raising", "seeking $50M".
  { code: 'financing-rumored-or-pending', pattern: /\b(?:in\s+talks\s+to\s+raise|reportedly\s+(?:raising|in\s+talks)|is\s+raising|are\s+raising|(?:plans|planning|seeking|looking|aiming|set)\s+to\s+raise|seeks?\s+\$|hopes\s+to\s+raise|would\s+raise|could\s+raise|nearing\s+a\s+deal)\b/i },

  // A person raising for their own venture: the company is unnamed.
  { code: 'company-name-is-person', pattern: /\b(?:raises?|raised|closes?|closed|lands?|landed|secures?|secured)\s+(?:an?\s+)?\$[\d.,]+\s*\w*\s+(?:\w+\s+){0,3}?(?:for|to\s+(?:fund|build|launch|start))\s+(?:his|her|their)\b/i },

  // Aggregate commentary.
  { code: 'market-commentary', pattern: /\b(?:state\s+of\s+(?:venture|the\s+market)|funding\s+(?:dropped|fell|rose|slowed|rebounded|dipped|surged)|Q[1-4]\s+\d{4}\s+(?:funding|venture|data|report)|year\s+in\s+(?:review|venture)|(?:weekly|monthly)\s+(?:funding\s+)?roundup|here(?:'|’)s\s+every|deal\s+flow\s+(?:data|trends)|these\s+\d+\s+startups|list\s+of\s+startups)\b/i },
];

/** Equity-round language that overrides the debt disqualifier. */
const EQUITY_LANGUAGE = /\b(?:pre-?seed|seed|series\s+[a-f]|equity\s+round|equity\s+financing|priced\s+round|valuation\s+of|post-money|led\s+by)\b/i;

// ── Company-name validation ───────────────────────────────────────

/**
 * Category nouns that end a description rather than a name. "Edtech
 * platform raises $4.5M" names no company; storing "Edtech platform"
 * as a company would have been a fabricated record.
 *
 * "Labs", "Systems", "Technologies", "Health" and friends are absent on
 * purpose — they are extremely common in genuine company names.
 */
const DESCRIPTOR_TAIL = /\b(?:platform|startup|startups|company|companies|firm|firms|maker|makers|provider|providers|business|businesses|venture|unicorn|giant|app|tool|marketplace|service|competitor|rival|challenger|player|outfit|brand|chain|operator|developer|team)$/i;

/** Words that mean the subject is a reference, not a name. */
const DESCRIPTOR_HEAD = /^(?:this|that|these|those|the|a|an|another|former|ex|one|two|three|several|some|its|his|her|their|my|our|yet)\b/i;

/**
 * A possessive attributes the company to a PERSON, so the name is absent.
 *
 * Any possessive disqualifies a HEADLINE SUBJECT — "Kalshi's rival raises
 * $20M" is about the rival, and the rival is not named. That is a
 * stricter threshold than the one the issuer qualifier applies to stored
 * legal names, where McDonald's Corporation is a perfectly good name; see
 * classifyPossessiveName for why both are right. The pattern itself is
 * shared so the two cannot drift.
 */
function isPersonPossessive(span: string): boolean {
  return classifyPossessiveName(span).kind !== 'none';
}

/**
 * Category nouns that can precede the real name inside a headline
 * subject: "Inference startup Infinity", "AI-powered travel agency Fora",
 * "Bot-detection startup Spur". The name is what follows.
 */
const DESCRIPTOR_MID = /(?:\b(?:startup|startups|platform|company|agency|firm|app|maker|provider|marketplace|business|brand|studio|outfit|competitor|rival|challenger|spinout|spin-?off|subsidiary)\s+|[\w.]+-based\s+)/i;

/** Clause words that mean the captured span is prose, not a name. */
const CLAUSE_WORD = /\b(?:and|with|after|before|amid|despite|while|says|said|plans|wants|founded|backed|led|reportedly|which|whose|that|to|from|for|of|in|on|as|its|his|her|their)\b/i;

export interface NameCheck {
  ok: boolean;
  name: string;
  /**
   * A single common word ("Natural", "Cascade") identifies a real company
   * but not uniquely. The event is kept; domain guessing is not allowed.
   */
  ambiguous: boolean;
  /** Where in the text the name was read from, for the audit trail. */
  from: 'subject' | 'after-comma' | 'before-comma' | 'after-descriptor';
  rejection: Rejection | null;
}

function tidy(span: string): string {
  return span.trim().replace(/^[-–—]\s*/, '').replace(/[,;:.]$/, '').trim();
}

/**
 * The leading run of proper-noun tokens: "Fora hits unicorn status" →
 * "Fora", "Bluecore Energy raised" → "Bluecore Energy".
 *
 * Headlines are sentence case, so capitalisation cannot separate a name
 * from the first word of a sentence — but it reliably marks where a name
 * ENDS, because the verb and object that follow are lowercase.
 */
function leadingProperNouns(span: string): string {
  const tokens = tidy(span).split(/\s+/);
  const kept: string[] = [];
  for (const t of tokens) {
    if (!/^[A-Z0-9]/.test(t)) break;
    kept.push(t);
  }
  return kept.join(' ');
}

/**
 * Validate one candidate span.
 *
 * Two passes on purpose. The veto pass looks at the WHOLE span, because
 * "Edtech platform" is only recognisable as a description while the word
 * "platform" is still attached — narrow it first and you get a company
 * called "Edtech". The narrowed pass then trims the verb and object off
 * the end of a genuine name.
 */
function validateName(candidate: string): { ok: boolean; name: string; code: RssReasonCode; detail: string } {
  const span = tidy(candidate);
  const fail = (code: RssReasonCode, detail: string) => ({ ok: false as const, name: span, code, detail });

  if (span.length < 2) return fail('company-name-not-extractable', `"${candidate}"`);
  if (isPersonPossessive(span)) return fail('company-name-is-person', `"${span}"`);
  if (DESCRIPTOR_HEAD.test(span)) return fail('company-name-is-descriptor', `leading word in "${span}"`);
  if (DESCRIPTOR_TAIL.test(span)) return fail('company-name-is-descriptor', `trailing category noun in "${span}"`);

  const name = leadingProperNouns(span);
  if (name.length < 2) return fail('company-name-is-descriptor', `no proper noun in "${span}"`);
  if (LEGAL_SUFFIX_ONLY.test(name)) return fail('company-name-not-extractable', `only a legal suffix: "${name}"`);
  // A leading gerund starts a subordinate clause, not a name: "Bucking EV
  // headwinds, Foo raises $300M" must not yield a company called
  // "Bucking EV". Two-word names ending in -ing are rare enough that
  // rejecting them costs less than inventing one.
  if (/^\w+ing\b/i.test(name) && name.includes(' ')) {
    return fail('company-name-is-descriptor', `leading gerund in "${name}"`);
  }
  if (CLAUSE_WORD.test(name)) return fail('company-name-is-descriptor', `clause word in "${name}"`);
  if (DESCRIPTOR_TAIL.test(name)) return fail('company-name-is-descriptor', `trailing category noun in "${name}"`);
  const words = name.split(/\s+/);
  if (words.length > 4) return fail('company-name-is-descriptor', `${words.length} words: "${name}"`);
  // A bare abbreviation names no company. "AI" is the extraction leaking a
  // fragment of the headline, not a startup called AI.
  if (words.length === 1 && (name.length < 3 || BARE_ABBREVIATION.test(name))) {
    return fail('company-name-not-extractable', `"${name}" is an abbreviation, not a name`);
  }
  return { ok: true, name, code: 'company-name-not-extractable', detail: '' };
}

/** Abbreviations that appear in headlines but never alone as a company name. */
const BARE_ABBREVIATION = /^(?:AI|ML|IT|US|USA|UK|EU|VC|PE|CEO|CTO|IPO|SaaS|API|GPU|LLM|B2B|B2C|HR|SEC|FDA|NHS)$/i;

/** A bare legal suffix names no company: "Acme, Inc. raises $5M" → not "Inc.". */
const LEGAL_SUFFIX_ONLY = /^(?:Inc\.?|LLC|L\.?L\.?C\.?|Ltd\.?|Limited|Corp\.?|Corporation|Co\.?|Company|LP|L\.?P\.?|PLC|GmbH|S\.?A\.?|B\.?V\.?|AB|Oy|AS|N\.?V\.?)$/i;

/**
 * Read the company name out of a headline subject.
 *
 * The naive version of this — "everything before the verb" — produced
 * "Edtech platform", "Travis Kalanick's robotics company", and
 * "AegisAI, founded by former Google security execs". So candidates are
 * tried in order of how directly they name a company, and the first that
 * validates wins:
 *
 *   1. after a category noun                 "Inference startup Infinity"
 *   2. before the first comma                "AegisAI, founded by …"
 *   3. after the last comma                  "As AI content floods …, Pangram"
 *   4. the whole subject                     "Antares"
 *
 * The descriptor-stripped span is tried FIRST because the whole subject
 * would otherwise validate: "Inference startup Infinity" breaks no rule,
 * yet the company is Infinity and "Inference startup" is the reporter's
 * own description of it.
 *
 * If none validate, the subject genuinely does not contain a company
 * name and the article is rejected rather than guessed at.
 */
export function checkCompanyName(raw: string): NameCheck {
  const subject = raw
    .replace(/^(?:exclusive|breaking|report|scoop|update)\s*[:,-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;:]$/, '');

  const attempts: { text: string; from: NameCheck['from'] }[] = [];

  // Every category-noun boundary is a candidate split, tried rightmost
  // first so "AI-powered travel agency Fora" yields "Fora" and not
  // "travel agency Fora". Trying only the last one is not enough: a
  // headline can carry two category nouns ("… agency Fora hits unicorn
  // status") and the rightmost split lands past the name.
  const descriptorEnds: number[] = [];
  for (let from = 0; ;) {
    const m = subject.slice(from).match(DESCRIPTOR_MID);
    if (!m || m.index === undefined) break;
    from += m.index + m[0].length;
    descriptorEnds.push(from);
  }
  for (const end of [...descriptorEnds].reverse()) {
    attempts.push({ text: subject.slice(end), from: 'after-descriptor' });
  }

  if (subject.includes(',')) {
    // After the last comma FIRST. English puts a subordinate clause before
    // the subject ("Bucking EV headwinds, Foo raises …", "As AI content
    // floods the internet, Pangram raises …"), so the tail is the more
    // likely name. The appositive case ("AegisAI, founded by …, lands …")
    // leaves an empty tail and falls through to the head.
    attempts.push({ text: subject.slice(subject.lastIndexOf(',') + 1), from: 'after-comma' });
    attempts.push({ text: subject.slice(0, subject.indexOf(',')), from: 'before-comma' });
  }
  attempts.push({ text: subject, from: 'subject' });

  let firstFailure: { code: RssReasonCode; detail: string } | null = null;
  for (const attempt of attempts) {
    const v = validateName(attempt.text);
    if (!v.ok) { firstFailure ??= v; continue; }
    const name = v.name;
    return {
      ok: true,
      name,
      // Guarding domain discovery, not the event itself. A real run
      // "confirmed" natural.com for a company called Natural — a name
      // collision, not evidence. The event still stands on the article.
      ambiguous: isAmbiguousCompanyName(name),
      from: attempt.from,
      rejection: null,
    };
  }

  const failure = firstFailure ?? { code: 'company-name-not-extractable' as RssReasonCode, detail: `"${subject}"` };
  return { ok: false, name: subject, ambiguous: false, from: 'subject', rejection: failure };
}

// ── Field extraction (stated facts only) ──────────────────────────

const UNIT_MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

export function parseStatedAmount(
  digits: string, unit: string | undefined, symbol = '$',
): { usd: number | null; text: string } | null {
  const base = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(base) || base <= 0) return null;
  const key = (unit ?? '').toLowerCase();
  const multiplier = UNIT_MULTIPLIER[key] ?? 1;
  // A bare "$4.5" with no unit is a parse artefact, not a real amount.
  if (multiplier === 1 && base < 1000) return null;
  const suffix = key ? key[0].toUpperCase() : '';
  return {
    // Only a dollar figure is a dollar figure. A euro or pound amount is
    // recorded as the source wrote it and left unconverted.
    usd: symbol === '$' ? Math.round(base * multiplier) : null,
    text: `${symbol}${digits}${suffix}`,
  };
}

const ROUND_PATTERN = /\b(pre-?seed|seed|series\s+([a-f])|bridge|angel|growth)\s*(?:round|funding|financing|investment)?\b/i;

/** Canonical round label, or null when the article never says. */
export function extractRound(text: string): string | null {
  const m = text.match(ROUND_PATTERN);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  if (raw.startsWith('pre')) return 'Pre-seed';
  if (raw === 'seed') return 'Seed';
  if (raw === 'angel') return 'Angel';
  if (raw === 'bridge') return 'Bridge';
  if (raw === 'growth') return 'Growth';
  return `Series ${m[2].toUpperCase()}`;
}

const INVESTOR_LEAD = /\b(?:led\s+by|co-?led\s+by|backed\s+by|from\s+lead\s+investor)\s+([^.;]{2,120})/i;
const INVESTOR_ALSO = /\b(?:with\s+participation\s+from|joined\s+by|participation\s+by|also\s+(?:invested|participated)[^,.]*?:?)\s+([^.;]{2,160})/i;

const NOT_AN_INVESTOR = /^(?:a|an|the|its|their|new|existing|several|multiple|other|various|angel|strategic)?\s*(?:investors?|backers?|funds?|firms?|others?)$/i;

/** Investors, only where the article names them. Never inferred. */
export function extractInvestors(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [INVESTOR_LEAD, INVESTOR_ALSO]) {
    const m = text.match(pattern);
    if (!m) continue;
    const parts = m[1]
      .replace(/\s+/g, ' ')
      // "led by Index Ventures, with participation from …" — the lead
      // capture must stop where the next clause starts, or the whole
      // participant list gets attributed as co-leads.
      .split(/\bwith\s+participation\s+from\b|\bjoined\s+by\b|\balongside\b|\bwith\s+support\s+from\b/i)[0]
      // "Sarah Guo's Conviction Partners" → the firm, not the partner.
      .replace(/\b[A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)?[’']s\s+/g, '')
      // Protect legal suffixes before splitting: "Slauson & Co." split on
      // the ampersand yielded a firm called "Co", which is not a firm.
      .replace(/\s*(?:,|&|\band\b)\s*(Co|Co\.|Company|Inc|Inc\.|LLC|Ltd|LP|Partners|Capital|Ventures)\b/gi, ' $1')
      .split(/,\s*|\s+and\s+|\s*&\s*/)
      .map((p) => p.replace(/^(?:existing\s+investors?\s+)/i, '').trim())
      .map((p) => p.replace(/\s+(?:which|who|that)\b.*$/i, '').trim())
      .filter((p) => p.length >= 2 && p.length <= 60)
      .filter((p) => !NOT_AN_INVESTOR.test(p))
      // A lowercase-only fragment is prose, not a firm name.
      .filter((p) => /[A-Z]/.test(p));
    found.push(...parts);
  }
  return [...new Set(found)].slice(0, 8);
}

const HQ_PATTERN = /\b(?:based\s+in|headquartered\s+in|out\s+of)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})(?:\s*,\s*([A-Z]{2})\b)?/;

const US_STATE_ABBR = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND',
  'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/** HQ only when the article states it. */
export function extractHq(text: string): { city: string | null; state: string | null } {
  const m = text.match(HQ_PATTERN);
  if (!m) return { city: null, state: null };
  const state = m[2] && US_STATE_ABBR.has(m[2]) ? m[2] : null;
  return { city: m[1].trim(), state };
}

// ── The event ─────────────────────────────────────────────────────

export interface FundingEventSource {
  url: string;
  publisher: string;
  title: string;
  announcedAt: string;
  excerpt: string;
  /**
   * What THIS publisher stated, not what the merged event settled on.
   * Kept per-source because attributing one outlet's figure to another is
   * a misquotation, and because a conflict is only describable when both
   * original numbers survive the merge.
   */
  amountUsd: number | null;
  amountText: string | null;
  roundType: string | null;
  /** Links this article pointed at, used to resolve the company's own site. */
  outboundLinks: string[];
}

export interface EventConflict {
  field: 'amount' | 'round';
  values: string[];
  sources: string[];
}

export interface FundingEvent {
  companyName: string;
  /** Normalized identity key, shared with the dedupe pipeline. */
  companyKey: string;
  /**
   * The name is a single common word, so a matching domain would not be
   * evidence of identity. Blocks domain guessing; the event still stands.
   */
  nameAmbiguous: boolean;
  /** Which part of the article the name was read from. */
  nameFrom: string;
  /** Confirmed official site, filled in by resolution. Never guessed. */
  website: string | null;
  websiteConfirmedBy: string | null;
  /** Publication date of the announcement, YYYY-MM-DD. */
  announcedAt: string;
  amountUsd: number | null;
  amountText: string | null;
  roundType: string | null;
  investors: string[];
  hqCity: string | null;
  hqState: string | null;
  publisher: string;
  articleUrl: string;
  articleTitle: string;
  evidenceExcerpt: string;
  retrievedAt: string;
  sector: VerticalId | null;
  sectorConfidence: number;
  sectorMatched: string[];
  /** Every article covering this same event, including the primary one. */
  sources: FundingEventSource[];
  conflicts: EventConflict[];
  needsHumanReview: boolean;
}

export type ExtractResult =
  | { ok: true; event: FundingEvent }
  | { ok: false; rejection: Rejection };

export function publisherOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

const MAX_EVENT_AGE_DAYS = 365;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/**
 * Turn one feed item into a funding event, or explain exactly why not.
 *
 * `today` is passed in rather than read from the clock so the age rule is
 * testable and so a whole run shares one reference date.
 */
export function extractFundingEvent(item: FeedItem, today: string): ExtractResult {
  const reject = (code: RssReasonCode, detail: string): ExtractResult => ({ ok: false, rejection: { code, detail } });

  const title = item.title.trim();
  // Disqualifiers read the headline plus the opening of the body — where
  // a publisher states what the article is about.
  const lead = `${title}. ${item.description.slice(0, 600)}`;

  // Attribution comes FIRST, because it decides how much of the article
  // the disqualifiers may read. When the headline itself states that a
  // named company raised, only the headline can disqualify it: an article
  // about Bluecore Energy's pre-seed mentions its lead investor's own
  // $100M Fund II in the body, and reading that as a fund launch threw
  // away a real deal.
  let subject: string | null = null;
  let amount: { usd: number | null; text: string } | null = null;
  const withAmount = title.match(RAISE_PATTERN);
  if (withAmount) {
    amount = parseStatedAmount(withAmount[3], withAmount[4], withAmount[2]);
    if (amount) subject = withAmount[1];
  }
  if (!subject) {
    const noAmount = title.match(RAISE_NO_AMOUNT_PATTERN);
    if (noAmount) subject = noAmount[1];
  }
  // The headline may be a teaser ("A new way to pay for AI agents") while
  // the body's first sentence carries the real statement.
  if (!subject && item.description) {
    const firstSentence = item.description.split(/(?<=[.!?])\s/).slice(0, 2).join(' ');
    const m = firstSentence.match(RAISE_PATTERN);
    if (m) {
      const parsed = parseStatedAmount(m[3], m[4], m[2]);
      if (parsed) { amount = parsed; subject = m[1]; }
    }
  }
  // Disqualifiers, scoped by what we found.
  const hasEquity = EQUITY_LANGUAGE.test(lead);
  const scope = subject ? title : lead;
  for (const { code, pattern } of DISQUALIFIERS) {
    const m = scope.match(pattern);
    if (!m) continue;
    // A round that mixes debt and equity is still a venture round.
    if (code === 'debt-or-project-finance' && hasEquity) continue;
    // "Acme raises $5M and acquires Foo" is a financing event that also
    // mentions an acquisition, not an acquisition story.
    if (code === 'acquisition-without-financing' && subject) continue;
    return reject(code, `"${m[0].trim()}" in "${title.slice(0, 80)}"`);
  }

  if (!subject) {
    // Distinguishing these two matters: one means the article is not about
    // financing at all, the other means it is but we could not tell who
    // raised — the second is a gap worth reviewing, the first is noise.
    return reject(
      FINANCING_LANGUAGE.test(lead) ? 'financing-not-attributed' : 'no-financing-language',
      title.slice(0, 100),
    );
  }

  const nameCheck = checkCompanyName(subject);
  if (!nameCheck.ok) return reject(nameCheck.rejection!.code, nameCheck.rejection!.detail);

  const roundType = extractRound(lead);
  if (!amount && !roundType) return reject('no-amount-or-round-stated', title.slice(0, 100));

  if (!item.publishedAt) return reject('no-announcement-date', title.slice(0, 100));
  const announcedAt = item.publishedAt.slice(0, 10);
  const age = daysBetween(announcedAt, today);
  if (age > MAX_EVENT_AGE_DAYS) return reject('event-too-old', `published ${announcedAt}, ${age} days ago`);

  const sector = classifyCandidate({
    companyName: nameCheck.name,
    pitch: item.description.slice(0, 2000),
    subcategory: item.categories.join(', '),
    evidenceText: title,
  });

  const publisher = publisherOf(item.link);
  const excerpt = `${title}${item.description ? ` — ${item.description.slice(0, 300)}` : ''}`;
  const hq = extractHq(lead);

  return {
    ok: true,
    event: {
      companyName: nameCheck.name,
      companyKey: normalizeCompanyKey(nameCheck.name),
      nameAmbiguous: nameCheck.ambiguous,
      nameFrom: nameCheck.from,
      website: null,
      websiteConfirmedBy: null,
      announcedAt,
      amountUsd: amount?.usd ?? null,
      amountText: amount ? `${amount.text} (as stated by ${publisher})` : null,
      roundType,
      investors: extractInvestors(lead),
      hqCity: hq.city,
      hqState: hq.state,
      publisher,
      articleUrl: item.link,
      articleTitle: title,
      evidenceExcerpt: excerpt,
      retrievedAt: today,
      sector: sector.vertical,
      sectorConfidence: sector.confidence,
      sectorMatched: sector.matched,
      sources: [{
        url: item.link, publisher, title, announcedAt, excerpt,
        amountUsd: amount?.usd ?? null,
        amountText: amount ? `${amount.text} (as stated by ${publisher})` : null,
        roundType,
        outboundLinks: item.outboundLinks,
      }],
      conflicts: [],
      needsHumanReview: false,
    },
  };
}

// ── Deduplication ─────────────────────────────────────────────────

/**
 * Two articles describe the same event when they name the same company
 * and their announcement dates are close.
 *
 * Date proximity rather than equality is required because syndication is
 * not instantaneous — the same round gets written up over several days —
 * while a genuinely separate round for the same company is months apart.
 */
const SAME_EVENT_WINDOW_DAYS = 21;

/** Stable identity for a merged event, for storage and re-identification. */
export function eventIdentity(event: FundingEvent): string {
  return [
    event.companyKey,
    event.announcedAt,
    event.roundType ?? 'round-unknown',
    event.amountUsd ?? 'amount-unknown',
  ].join('|');
}

export interface MergeOutcome {
  events: FundingEvent[];
  /** How many articles were folded into an existing event. */
  mergedArticles: number;
  /** Events whose sources disagree on amount or round. */
  conflicted: FundingEvent[];
}

/**
 * Same company? Exact key, or the same identity written two ways —
 * "Spur" and "Spur Intelligence", "Multiverse" and "Multiverse
 * Computing". Uses the dedupe pipeline's own matcher so corroboration
 * and deduplication cannot disagree about what one company is.
 */
function sameCompanyKey(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  // One name is the other plus a qualifier: "Spur" / "Spur Intelligence",
  // "Multiverse" / "Multiverse Computing". The word boundary is required
  // so "Ramp" does not match "Rampart".
  if (b.startsWith(`${a} `) || a.startsWith(`${b} `)) return true;
  return isHighConfidenceFuzzy(a, b);
}

function isSameEvent(a: FundingEvent, b: FundingEvent): boolean {
  if (!sameCompanyKey(a.companyKey, b.companyKey)) return false;
  if (Math.abs(daysBetween(a.announcedAt, b.announcedAt)) > SAME_EVENT_WINDOW_DAYS) return false;
  // Same company, months apart → separate rounds, which must stay separate.
  return true;
}

/**
 * Merge articles covering the same financing event into one event that
 * keeps every source URL.
 *
 * Counting a round once is the point: three outlets rewriting the same
 * press release is one deal, and treating it as three would inflate the
 * pipeline while adding no information. Independence is judged by
 * publisher — two copies from the same host are not two sources.
 */
export function mergeFundingEvents(events: FundingEvent[]): MergeOutcome {
  const merged: FundingEvent[] = [];
  let mergedArticles = 0;

  // Oldest first, so the earliest report is the primary record — the
  // first outlet to publish is the closest thing to the announcement.
  const ordered = [...events].sort((a, b) => a.announcedAt.localeCompare(b.announcedAt));

  for (const event of ordered) {
    const existing = merged.find((m) => isSameEvent(m, event));
    if (!existing) { merged.push({ ...event, sources: [...event.sources] }); continue; }

    mergedArticles += 1;
    for (const s of event.sources) {
      if (!existing.sources.some((e) => e.url === s.url)) existing.sources.push(s);
    }

    // Conflicting facts are recorded, never averaged or overwritten.
    if (event.amountUsd !== null && existing.amountUsd !== null && event.amountUsd !== existing.amountUsd) {
      addConflict(existing, 'amount', [
        `${existing.amountText ?? existing.amountUsd} (${existing.publisher})`,
        `${event.amountText ?? event.amountUsd} (${event.publisher})`,
      ], [existing.articleUrl, event.articleUrl]);
    } else if (existing.amountUsd === null && event.amountUsd !== null) {
      existing.amountUsd = event.amountUsd;
      existing.amountText = event.amountText;
    }

    if (event.roundType && existing.roundType && event.roundType !== existing.roundType) {
      addConflict(existing, 'round', [
        `${existing.roundType} (${existing.publisher})`,
        `${event.roundType} (${event.publisher})`,
      ], [existing.articleUrl, event.articleUrl]);
    } else if (!existing.roundType && event.roundType) {
      existing.roundType = event.roundType;
    }

    // Non-conflicting detail from a later article is additive.
    existing.investors = [...new Set([...existing.investors, ...event.investors])].slice(0, 8);
    existing.hqCity ??= event.hqCity;
    existing.hqState ??= event.hqState;
    if (!existing.sector && event.sector) {
      existing.sector = event.sector;
      existing.sectorConfidence = event.sectorConfidence;
      existing.sectorMatched = event.sectorMatched;
    }
  }

  return { events: merged, mergedArticles, conflicted: merged.filter((e) => e.conflicts.length > 0) };
}

function addConflict(event: FundingEvent, field: 'amount' | 'round', values: string[], sources: string[]): void {
  const existing = event.conflicts.find((c) => c.field === field);
  if (existing) {
    existing.values = [...new Set([...existing.values, ...values])];
    existing.sources = [...new Set([...existing.sources, ...sources])];
  } else {
    event.conflicts.push({ field, values: [...new Set(values)], sources: [...new Set(sources)] });
  }
  // A disputed amount is not a fact. A human decides.
  event.needsHumanReview = true;
}

/** Distinct publishers behind an event. Syndicated copies do not count twice. */
export function independentPublishers(event: FundingEvent): string[] {
  return [...new Set(event.sources.map((s) => s.publisher))];
}
