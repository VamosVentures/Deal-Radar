import { normalizeCompanyKey } from './identity';
import { classifyCandidate } from './classify';
import {
  checkCompanyName, disqualifyEvent, extractHq, extractInvestors, extractRound,
  hasEquityLanguage, publisherOf, readStatedRaise,
  type FeedItem, type FundingEvent, type Rejection,
} from './fundingEvent';
import { INVESTOR_REGISTRY, investorForUrl, MIN_INVESTOR_ALIAS_LENGTH, type RegisteredInvestor } from './investorRegistry';

/**
 * Funding events read from an INVESTOR'S OWN newsroom.
 *
 * The press pipeline answers "did a named publication report that a
 * company raised?". This one answers a different question: "did a firm
 * that took part in the financing say so, in writing, on its own site?"
 * That is a first-party record rather than a report of one, which is why
 * it counts as a separate source family and not as another publisher.
 *
 * Three gates, in this order, and all three must pass:
 *
 *   1. ON THE INVESTOR'S OWN DOMAIN. A VC newsroom that links out to
 *      Reuters is a press clipping service; the evidence lives at
 *      reuters.com and belongs to the press family. Only a page hosted on
 *      the registered domain is investor-primary.
 *   2. AN ACTUAL FINANCING EVENT. The same disqualifiers the press
 *      pipeline uses — IPOs, fund closes, acquisitions, grants, rumours —
 *      apply unchanged, plus the shapes unique to a VC blog: a new
 *      partner, a market report, a podcast, a portfolio page with no
 *      event on it.
 *   3. THIS FIRM PARTICIPATED. The page must SAY the host invested. A
 *      space fund's weekly news roundup is about other people's rounds;
 *      publishing it on a VC's server does not make the VC a party to
 *      them, and counting it as investor-primary evidence would be a
 *      fabricated relationship.
 *
 * Pure functions only — no network, no database. Every rule below is
 * testable against the real announcement text that motivated it.
 */

// ── Reason codes ──────────────────────────────────────────────────

/**
 * Rejection reasons specific to this source. The shared feed/format and
 * event-quality codes live in fundingEvent.ts and are reused verbatim;
 * these name the failures only an investor newsroom can have.
 */
export const INVESTOR_REASON_CODES = [
  // Feed / item level
  'feed-unreachable',
  'feed-not-a-feed',
  'feed-no-items',
  'item-no-title',
  'item-no-link',
  'item-link-malformed',
  'item-link-suspicious',
  // Is this page investor-primary at all?
  'investor-domain-unverified',
  'investor-page-off-domain',
  'investor-not-participant',
  // Is it a financing event?
  'not-a-financing-announcement',
  'portfolio-listing-no-event',
  'fund-launch',
  'public-offering',
  'debt-or-project-finance',
  'grant-or-public-award',
  'acquisition-without-financing',
  'investor-or-fund-profile',
  'market-commentary',
  'financing-rumored-or-pending',
  // Company resolution
  'company-name-not-extractable',
  'company-name-is-descriptor',
  'company-name-is-person',
  'not-operating-company',
  'website-unresolved',
  'website-not-confirmed',
  // Event quality
  'no-announcement-date',
  'event-too-old',
  'no-sector-signal',
  'duplicate-same-event',
  'conflicting-financing-details',
] as const;
export type InvestorReasonCode = (typeof INVESTOR_REASON_CODES)[number];

export const INVESTOR_REASON_TEXT: Record<InvestorReasonCode, string> = {
  'feed-unreachable': 'The investor feed did not respond.',
  'feed-not-a-feed': 'The response body was not RSS or Atom.',
  'feed-no-items': 'The feed parsed but contained no items.',
  'item-no-title': 'The item has no title.',
  'item-no-link': 'The item has no link.',
  'item-link-malformed': 'The item link is not a usable http(s) URL.',
  'item-link-suspicious': 'The item link has an unsafe shape (credentials, bare IP, or non-web scheme).',
  'investor-domain-unverified': 'The feed is not served from the investor\'s registered official domain, so nothing under it can be attributed to that firm.',
  'investor-page-off-domain': 'The item links to a third-party site rather than the investor\'s own domain, so the evidence is press, not investor-primary.',
  'investor-not-participant': 'The page never states that this investor took part in the financing. A firm writing about someone else\'s round is not a first-party source.',
  'not-a-financing-announcement': 'The page is investor news — a hire, a report, an event, a product update — not a financing event.',
  'portfolio-listing-no-event': 'A portfolio entry or spotlight with no dated financing event stated.',
  'fund-launch': 'This is the firm closing its own fund, not a portfolio company raising capital.',
  'public-offering': 'This is a public-market offering, not venture financing.',
  'debt-or-project-finance': 'The only financing described is debt or project finance.',
  'grant-or-public-award': 'This is a grant or public award — a commercialization signal, not an equity round.',
  'acquisition-without-financing': 'This describes an acquisition or merger with no financing round.',
  'investor-or-fund-profile': 'This is about the firm or its people rather than a company that raised.',
  'market-commentary': 'This is market commentary or a news roundup, not a single financing event.',
  'financing-rumored-or-pending': 'The page reports a raise in progress or rumoured, not capital received.',
  'company-name-not-extractable': 'No company name could be read from the announcement without guessing.',
  'company-name-is-descriptor': 'The extracted subject is a category description, not a company name.',
  'company-name-is-person': 'The extracted subject refers to a person, not the company that raised.',
  'not-operating-company': 'The named entity is a fund, university, or government body.',
  'website-unresolved': 'No official website could be found for the company.',
  'website-not-confirmed': 'A candidate website responded but did not confirm the company identity.',
  'no-announcement-date': 'The announcement carries no publication date.',
  'event-too-old': 'The financing event is older than the 12-month window.',
  'no-sector-signal': 'The announcement text does not support any sector assignment.',
  'duplicate-same-event': 'A different announcement about a financing event already recorded.',
  'conflicting-financing-details': 'Sources disagree on the amount or round; held for human review.',
};

export interface InvestorRejection {
  code: InvestorReasonCode;
  detail: string;
}

// ── Gate 3: did this firm take part? ──────────────────────────────

/**
 * First-person investment language. A firm writing "we invested in X" is
 * stating its own participation as plainly as language allows.
 *
 * Each pattern captures the company span in group 1 so the same match
 * both proves participation and locates the company — they cannot
 * disagree about which company the firm claims to have backed.
 */
const INVESTOR_VOICE: { pattern: RegExp; namesCompany: boolean }[] = [
  { pattern: /\bwhy\s+we\s+invested\s*(?:in\b|:)\s*(.{2,70})/i, namesCompany: true },
  { pattern: /\bwe(?:'ve|’ve|\s+have)?\s+(?:just\s+)?(?:invested|co-?invested)\s+in\s+(.{2,70})/i, namesCompany: true },
  { pattern: /\bour\s+(?:latest\s+|newest\s+|first\s+)?investment\s+in\s+(.{2,70})/i, namesCompany: true },
  { pattern: /^\s*(?:announcing\s+)?investing\s+in\s+(.{2,70})/i, namesCompany: true },
  { pattern: /\bannouncing\s+our\s+(?:investment|partnership)\s+(?:in|with)\s+(.{2,70})/i, namesCompany: true },
  { pattern: /\b(?:backing|we\s+are\s+backing)\s+(.{2,70})/i, namesCompany: true },
  { pattern: /\bdoubling\s+down\s+on\s+(.{2,70})/i, namesCompany: true },
  { pattern: /\b(?:leading|we\s+(?:led|co-?led))\s+(?:the\s+)?(.{2,70}?)['’]s\s+(?:pre-?seed|seed|series\s+[a-f]|round)/i, namesCompany: true },
  { pattern: /\bwelcom(?:e|ing)\s+(.{2,70}?)\s+to\s+(?:our|the)\s+portfolio\b/i, namesCompany: true },
  /**
   * States participation but names nobody. "we led their $12M Seed" is a
   * sentence about a company introduced earlier — capturing what follows
   * would yield a company called "their $12M Seed", which is why these
   * are kept separate rather than given a capture group and hoped for.
   */
  { pattern: /\bwe\s+(?:led|co-?led)\b/i, namesCompany: false },
  { pattern: /\bwe(?:'ve|’ve|\s+have)?\s+(?:just\s+)?invested\b/i, namesCompany: false },
];

/**
 * The firm naming ITSELF as a participant, in a company-voice press
 * release it is hosting: "…secures $17.5M Series A from Salesforce
 * Ventures and Echo Health Ventures", "ARCH-backed SonoThera secures…".
 *
 * The alias must appear within financing language, not merely somewhere
 * on the page — a boilerplate "About Menlo Ventures" footer says nothing
 * about who funded this particular round.
 */
const PARTICIPATION_CONTEXT = /\b(?:led\s+by|co-?led\s+by|backed\s+by|funded\s+by|from|with\s+participation\s+from|joined\s+by|investors?\s+include|participation\s+by|investment\s+from|-backed)\b/i;

export interface Participation {
  participated: boolean;
  /** The exact words that established it — quoted in the stored evidence. */
  quote: string;
  /** Company span captured by first-person language, when there was one. */
  companySpan: string | null;
  how: 'first-person' | 'named-as-participant' | 'none';
}

/** Escape a registry alias for use inside a RegExp — names contain `.`, `-`, `&`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does this announcement state that `investor` took part in the
 * financing it describes?
 *
 * Answering "no" is the common case and the important one. Seraphim
 * Space publishes a weekly SpaceTech news roundup covering rounds it had
 * nothing to do with; ARCH republishes coverage of companies it does
 * back and of ones it does not. Only the sentence itself can tell them
 * apart, so only the sentence is consulted.
 */
export function checkParticipation(text: string, investor: RegisteredInvestor): Participation {
  // A pattern that NAMES the company wins over one that merely states
  // participation, so the whole list is scanned before settling.
  let statedOnly: Participation | null = null;
  for (const { pattern, namesCompany } of INVESTOR_VOICE) {
    const m = text.match(pattern);
    if (!m) continue;
    const found: Participation = {
      participated: true,
      quote: m[0].trim().slice(0, 160),
      companySpan: namesCompany ? (m[1] ?? null) : null,
      how: 'first-person',
    };
    if (namesCompany) return found;
    statedOnly ??= found;
  }

  // "Menlo's Investment in Fireworks" — first-person in substance, third
  // person in grammar. Built from the registry rather than from a generic
  // `\w+'s investment in` so that a page describing SOMEONE ELSE's
  // investment ("Sequoia's investment in X", republished by us) is not
  // read as ours.
  for (const alias of investor.aliases) {
    if (alias.length < MIN_INVESTOR_ALIAS_LENGTH) continue;
    const own = new RegExp(
      `\\b${escapeRegExp(alias)}['’]s\\s+(?:latest\\s+|newest\\s+|first\\s+)?investment\\s+in\\s+(.{2,70})`,
      'i',
    );
    const m = text.match(own);
    if (!m) continue;
    return {
      participated: true,
      quote: m[0].trim().slice(0, 160),
      companySpan: m[1],
      how: 'first-person',
    };
  }

  for (const alias of investor.aliases) {
    if (alias.length < MIN_INVESTOR_ALIAS_LENGTH) continue;
    const re = new RegExp(`(.{0,90})\\b${escapeRegExp(alias)}\\b(.{0,60})`, 'i');
    const m = text.match(re);
    if (!m) continue;
    const window = `${m[1]}${alias}${m[2]}`;
    if (!PARTICIPATION_CONTEXT.test(window)) continue;
    return {
      participated: true,
      quote: window.trim().slice(0, 160),
      companySpan: null,
      how: 'named-as-participant',
    };
  }

  return statedOnly ?? { participated: false, quote: '', companySpan: null, how: 'none' };
}

// ── Gate 2: is it a financing event? ──────────────────────────────

/**
 * Firm news that is not about a portfolio company's financing. Written
 * against the real titles these feeds publish, not imagined ones.
 */
const NOT_A_FINANCING_ANNOUNCEMENT: RegExp[] = [
  // People moves, at the firm or at a portfolio company.
  /\b(?:joins?|joining|welcom(?:e|ing))\b[^.]{0,60}\bas\s+(?:an?\s+)?(?:\w+\s+){0,2}(?:partner|principal|associate|advisor|adviser|director|fellow)\b/i,
  /\b(?:joins?|joining|welcom(?:e|ing))\b[^.]{0,60}\bto\s+the\s+team\b/i,
  /\bnames?\b[^.]{0,60}\b(?:general\s+partner|managing\s+director|chief\s+\w+\s+officer|partner)\b/i,
  /\b(?:our\s+new|new)\s+(?:senior\s+)?(?:associate|principal|partner|analyst)\b/i,
  // Publications, events, podcasts, indices.
  /\b(?:impact|annual|prognosis|state\s+of|market|industry)\s+report\b/i,
  /\b(?:podcast|webinar|summit|conference|fireside|roundtable|demo\s+day|cohort|programme|program)\b/i,
  /\b(?:news\s+roundup|roundup\s*[–—-]|weekly\s+(?:digest|roundup)|index\s+Q[1-4])\b/i,
  /\bpredictions\b/i,
  // Portfolio-company operating news that is not financing.
  /\b(?:launches?|launched|introduces?|unveils?|releases?|announces?)\s+(?:its\s+|the\s+|a\s+|new\s+)?(?:[A-Z][\w™®-]*\s+)?(?:product|platform|feature|update|version|partnership|collaboration|programme|program|system|tool)\b/i,
  /\bFDA\s+(?:clearance|approval|designation)\b/i,
  /\b(?:partners?\s+with|partnership\s+with|collaborat\w+\s+with|selected\s+by|honors?|honou?red|award(?:ed)?\s+(?:to|for)\s+(?!\$))/i,
  /\b(?:test\s+flight|completes?\s+\w+\s+(?:test|mission)|sets?\s+\w+\s+record)\b/i,
];

/** A portfolio page or spotlight with nothing dated on it. */
const PORTFOLIO_LISTING = [
  /\bwelcom(?:e|ing)\b[^.]{0,60}\bto\s+(?:our|the)\s+portfolio\b/i,
  /^\s*portfolio\s+(?:spotlight|update|company)\b/i,
  /^\s*(?:meet|introducing)\s+our\s+portfolio\b/i,
];

/**
 * Financing language that makes a page an EVENT rather than a listing.
 * A portfolio welcome that also says "we led their Series A" is an
 * event; one that only says "welcome" is a listing.
 */
const STATES_FINANCING = /\b(?:invest(?:ed|ing|ment)|raise[sd]?|raising|round|financing|funding|seed|series\s+[a-f]|pre-?seed|led\s+the|co-?led|back(?:ed|ing)\s+\w)\b/i;

// ── Company-name extraction from an investor's own phrasing ───────

/**
 * Words after which the company name has ended. "Investing in Pangram to
 * Stop AI Slop" names Pangram; everything from "to" onward is the
 * investor's editorial subtitle.
 */
const SPAN_TERMINATOR = /^(?:to|for|from|and|with|as|at|in|on|the|a|an|its|their|our|that|which|who|why|how|so|because|after|before|while|amid|by|into|toward|towards|across|beyond|is|are|was|were|will|can|could)$/i;

/**
 * Verbs that mean the company has stopped being named and started doing
 * something. These matter specifically because investor newsrooms
 * republish Title Case press releases — "TytoCare Names Adam Pellegrini
 * as CEO and Closes $25M+ Growth Round" — where capitalisation cannot
 * mark where the name ends, because every word is capitalised.
 */
const SPAN_ACTION_VERB = /^(?:names?|named|appoints?|hires?|promotes?|launch(?:es|ed)?|announces?|announced|unveils?|introduces?|releases?|expands?|adds?|brings?|partners?|selects?|selected|welcomes?|joins?|acquires?|acquired|reaches?|sets?|completes?|wins?|receives?|opens?|closes?|secures?|raises?|lands?|nabs?|banks?|debuts?|files?|signs?|delivers?|ships?|reports?|shares?|talks?|discusses?)$/i;

/**
 * Trim an investor's phrasing down to the company name it contains.
 *
 * Investor headlines are titled essays: "Bespoke Labs: Building the
 * Infrastructure for AI Agents", "Suno, the Platform for Creative
 * Entertainment", "AI Fabrik From Inception". The name is the run of
 * words before the first structural break — a colon, a dash, a comma, or
 * a word that starts the editorial clause.
 *
 * Trimming BEFORE validation matters: the shared name validator reads
 * the leading run of capitalised tokens, and "AI Fabrik From Inception"
 * is capitalised the whole way through, so the untrimmed span would be
 * rejected as prose and a real investment would be lost.
 */
export function trimCompanySpan(raw: string): string {
  let span = raw.trim();
  // A sentence boundary first. When a title-level match runs on into the
  // summary text, everything past the full stop belongs to a different
  // sentence — that is how "Our Investment in Cheiron" once produced a
  // company called "Cheiron. Drug".
  span = span.split(/[.!?](?:\s|$)/)[0];
  // Structural breaks — everything after them is subtitle.
  span = span.split(/\s*[:—–|]\s*|\s+[-]\s+/)[0];
  span = span.split(',')[0];
  const kept: string[] = [];
  for (const token of span.split(/\s+/)) {
    const bare = token.replace(/[^\w'’&.-]/g, '');
    if (kept.length > 0 && (SPAN_TERMINATOR.test(bare) || SPAN_ACTION_VERB.test(bare))) break;
    kept.push(token);
    if (kept.length >= 5) break;
  }
  return kept.join(' ').replace(/[.?!]+$/, '').trim();
}

/**
 * Strip an `<Alias>-backed ` prefix and report it, because that hyphenated
 * form is simultaneously the firm claiming participation and a
 * description sitting in front of the company's real name:
 * "ARCH-backed SonoThera secures Series B funding".
 */
/**
 * Is this extracted "company" actually one of the registered firms?
 * Returns the firm's name when so, for the rejection detail.
 */
export function matchesAnyRegisteredInvestor(name: string): string | null {
  const squashed = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (squashed.length === 0) return null;
  for (const investor of INVESTOR_REGISTRY) {
    for (const alias of [investor.name, ...investor.aliases]) {
      const a = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (a.length >= MIN_INVESTOR_ALIAS_LENGTH && a === squashed) return investor.name;
    }
  }
  return null;
}

function stripBackedPrefix(title: string, investor: RegisteredInvestor): { text: string; matched: string | null } {
  for (const alias of investor.aliases) {
    const re = new RegExp(`^\\s*${escapeRegExp(alias.replace(/-backed$/i, ''))}-backed\\s+`, 'i');
    const m = title.match(re);
    if (m) return { text: title.slice(m[0].length), matched: m[0].trim() };
  }
  return { text: title, matched: null };
}

// ── The event ─────────────────────────────────────────────────────

export interface InvestorEventResult {
  ok: boolean;
  event?: FundingEvent;
  rejection?: InvestorRejection;
}

const MAX_EVENT_AGE_DAYS = 365;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/**
 * Turn one item from an investor's feed into a funding event, or explain
 * exactly why not.
 *
 * `today` is injected rather than read from the clock so the age rule is
 * testable and a whole run shares one reference date.
 */
export function extractInvestorEvent(item: FeedItem, today: string): InvestorEventResult {
  const reject = (code: InvestorReasonCode, detail: string): InvestorEventResult =>
    ({ ok: false, rejection: { code, detail } });

  // ── Gate 1: the page must be the investor's own ────────────────
  const investor = investorForUrl(item.link);
  if (!investor) {
    return reject(
      'investor-page-off-domain',
      `${publisherOf(item.link)} is not a registered investor domain, so this page is press, not a first-party record.`,
    );
  }

  const title = item.title.trim();
  const body = item.description.slice(0, 1200);
  const lead = `${title}. ${body}`;

  // ── Gate 2: is this a financing event? ─────────────────────────
  //
  // Firm news is tested before the shared disqualifiers because it is
  // the most common non-event here and deserves the most specific code.
  for (const pattern of NOT_A_FINANCING_ANNOUNCEMENT) {
    const m = title.match(pattern);
    if (m) return reject('not-a-financing-announcement', `"${m[0].trim()}" in "${title.slice(0, 80)}"`);
  }
  // A portfolio page is judged on its TITLE alone. Consulting the body
  // would let boilerplate ("we invest in seed-stage companies") turn a
  // membership listing into an event it never described.
  for (const pattern of PORTFOLIO_LISTING) {
    const m = title.match(pattern);
    if (!m) continue;
    if (STATES_FINANCING.test(title.replace(pattern, ' '))) break;
    return reject('portfolio-listing-no-event', `"${m[0].trim()}" states no financing event`);
  }

  const stripped = stripBackedPrefix(title, investor);
  const raise = readStatedRaise(stripped.text) ?? readStatedRaise(body.split(/(?<=[.!?])\s/).slice(0, 2).join(' '));

  // The TITLE is checked for the firm's own voice separately from the
  // whole page, because only a title-level match may name the company. An
  // investor's phrasing found deep in a body paragraph proves the firm
  // invests in things; it does not establish that THIS page is about a
  // round in THAT company. Reading a body match as a company name
  // produced a company called "European" out of an open letter signed by
  // a hundred founders.
  const titleParticipation = checkParticipation(title, investor);
  const hasSubject = raise !== null || titleParticipation.companySpan !== null;

  // Shared disqualifiers, scoped exactly as the press pipeline scopes
  // them: once a named subject is established, only the title may
  // disqualify, so a firm's own fund size mentioned in the body cannot
  // turn a portfolio company's round into a "fund launch".
  //
  // These run BEFORE the participation gate on purpose. An IPO is not a
  // venture round and a fund close is not a company raising, whoever was
  // involved — answering "was this firm in it?" first would report the
  // less informative of two true things.
  const disqualified = disqualifyEvent(hasSubject ? title : lead, {
    hasEquity: hasEquityLanguage(lead),
    hasSubject,
    label: title,
    // `investor-or-fund-profile` catches PRESS articles that are about a
    // firm rather than a company — it keys on phrases like "our
    // portfolio", which are simply the house style on a firm's own site.
    // The question it exists to answer is the one gates 1 and 3 answer
    // properly here, so applying it as well would reject "Welcoming
    // Cheiron to our portfolio: we led their $12M Seed".
    skip: ['investor-or-fund-profile'],
  });
  if (disqualified) {
    return reject(disqualified.code as InvestorReasonCode, disqualified.detail);
  }

  // ── Gate 3: did this firm take part? ───────────────────────────
  const pageParticipation = titleParticipation.participated
    ? titleParticipation
    : checkParticipation(lead, investor);
  const backedPrefix = stripped.matched;
  if (!pageParticipation.participated && !backedPrefix) {
    return reject(
      'investor-not-participant',
      `"${title.slice(0, 90)}" never states that ${investor.name} invested. Published on their site, but about someone else's financing.`,
    );
  }
  const participationQuote = pageParticipation.participated
    ? pageParticipation.quote
    : `${backedPrefix} — ${investor.name} named as an existing backer`;

  // ── The company ────────────────────────────────────────────────
  //
  // First-person phrasing is preferred over a press-release headline:
  // when a firm says "our investment in Cheiron", Cheiron is named by
  // the party to the transaction, which is as direct as it gets.
  const spans = [
    titleParticipation.companySpan !== null ? trimCompanySpan(titleParticipation.companySpan) : null,
    raise ? trimCompanySpan(raise.subject) : null,
  ].filter((s): s is string => !!s && s.length >= 2);

  if (spans.length === 0) {
    return reject(
      'company-name-not-extractable',
      `"${title.slice(0, 90)}" states an investment but names no company in a form that can be read without guessing.`,
    );
  }

  let name: ReturnType<typeof checkCompanyName> | null = null;
  let firstFailure: Rejection | null = null;
  for (const span of spans) {
    const check = checkCompanyName(span);
    if (check.ok) { name = check; break; }
    firstFailure ??= check.rejection;
  }
  if (!name) {
    return reject(
      (firstFailure?.code as InvestorReasonCode) ?? 'company-name-not-extractable',
      firstFailure?.detail ?? `"${title.slice(0, 90)}"`,
    );
  }

  // A firm announcing capital for ITSELF is raising a fund, not backing a
  // portfolio company — "Menlo Turns 50 and Announces $3B in Fresh
  // Capital". Checked against every registered firm, not just the host,
  // because one firm announcing another's fund close is equally not a
  // company round.
  const selfNamed = matchesAnyRegisteredInvestor(name.name);
  if (selfNamed) {
    return reject('fund-launch', `"${name.name}" is ${selfNamed}, an investment firm, not a company that raised.`);
  }

  // Neither an amount nor a round is REQUIRED here, and that is a
  // deliberate difference from the press pipeline. A headline that says
  // only "Acme raises" is probably not a real report; a firm that says
  // "we invested in Acme" has stated a financing event it was party to,
  // whether or not it chose to disclose the size. What is not stated
  // stays null — never estimated from the firm's typical cheque size.
  const roundType = extractRound(lead);

  if (!item.publishedAt) return reject('no-announcement-date', title.slice(0, 100));
  const announcedAt = item.publishedAt.slice(0, 10);
  const age = daysBetween(announcedAt, today);
  if (age > MAX_EVENT_AGE_DAYS) return reject('event-too-old', `published ${announcedAt}, ${age} days ago`);

  const sector = classifyCandidate({
    companyName: name.name,
    pitch: body,
    subcategory: item.categories.join(', '),
    evidenceText: title,
  });

  // The host firm is a known participant by construction, so it belongs
  // in the investor list even when the prose never repeats its name.
  const investors = [...new Set([investor.name, ...extractInvestors(lead)])].slice(0, 8);
  const hq = extractHq(lead);
  const excerpt = `${title}${body ? ` — ${body.slice(0, 300)}` : ''}`;
  const amountText = raise?.amount ? `${raise.amount.text} (as stated by ${investor.name})` : null;

  return {
    ok: true,
    event: {
      companyName: name.name,
      companyKey: normalizeCompanyKey(name.name),
      nameAmbiguous: name.ambiguous,
      nameFrom: `investor-announcement:${name.from}`,
      website: null,
      websiteConfirmedBy: null,
      announcedAt,
      amountUsd: raise?.amount?.usd ?? null,
      amountText,
      roundType,
      investors,
      hqCity: hq.city,
      hqState: hq.state,
      publisher: investor.domain,
      articleUrl: item.link,
      articleTitle: title,
      evidenceExcerpt: excerpt,
      retrievedAt: today,
      sector: sector.vertical,
      sectorConfidence: sector.confidence,
      sectorMatched: sector.matched,
      sources: [{
        url: item.link,
        publisher: investor.domain,
        title,
        announcedAt,
        excerpt,
        amountUsd: raise?.amount?.usd ?? null,
        amountText,
        roundType,
        outboundLinks: item.outboundLinks,
        sourceId: 'investor-news',
        investor: investor.name,
        investorDomain: investor.domain,
        participation: participationQuote,
      }],
      conflicts: [],
      needsHumanReview: false,
    },
  };
}
