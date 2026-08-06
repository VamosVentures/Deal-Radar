import { normalizeDomainKey } from '../sourcing/identity';
import { isFounderTitle } from './founderExtraction';

/**
 * Parser for the PUBLIC Y Combinator company profile page.
 *
 * ─────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — a real extraction failure, not missing evidence
 * ─────────────────────────────────────────────────────────────────
 *
 * A previous pass reported "no founders publicly available" for four YC
 * companies and concluded the evidence did not exist. It does. Every one
 * of those pages carries an "Active Founders" section with full names,
 * roles and multi-sentence biographies, and the research plan was
 * already fetching the page successfully (HTTP 200, ~100KB, not thin,
 * not disqualified).
 *
 * The failure was one line deep in the generic extractor.
 * `extractPeopleFromHtml` works on `readableText`, which flattens every
 * tag to a single space, and its NAME_THEN_TITLE pattern requires
 * PUNCTUATION between a name and a title — a deliberate fix for an
 * earlier bug where "Aidan Ng Co-Founder" split into "Aidan Ng Co". YC
 * separates the name from the role with DOM structure, not punctuation:
 *
 *     <div class="text-xl font-bold">Joshua Ibrahim</div>
 *     <div class="text-gray-600">Founder</div>
 *
 * which flattens to "Joshua Ibrahim Founder" — no separator, no match.
 * So the page was read in full and then silently yielded nothing, and
 * `deriveFounderStatus` reported "research-exhausted", which reads as
 * "we looked everywhere and there is nothing" when the truth was "our
 * parser could not read a page that plainly lists three founders".
 *
 * Flattening to text throws away the only delimiter this page has, so
 * this parser reads the STRUCTURE instead. It is scoped to YC profile
 * URLs and leaves the generic extractor untouched for every other host.
 *
 * ─────────────────────────────────────────────────────────────────
 * RULES
 * ─────────────────────────────────────────────────────────────────
 *
 * - Public page only. Bookface and any login-protected page are never
 *   requested. LinkedIn URLs appear in this markup and are read ONLY as
 *   a signal that a profile exists; they are never fetched.
 * - YC renders each founder TWICE (a desktop block and a `md:hidden`
 *   mobile block). Duplicates collapse on normalized name, so three
 *   founders stay three founders and never become six.
 * - Identity is matched on website domain or canonical slug, never on
 *   company name — "Manifold" and "Manifold Freight" are different
 *   companies and the directory contains both.
 * - Everything YC hosts is the COMPANY describing itself, carried by a
 *   credible accelerator. It is company-claimed evidence, never
 *   independent confirmation.
 */

export interface YcFounder {
  fullName: string;
  /** Role exactly as the page prints it ("Founder", "CEO, Co-founder"). */
  role: string | null;
  /** Biography verbatim, bounded. */
  bio: string | null;
  /** A LinkedIn profile is LINKED here. Recorded as existing; never fetched. */
  linkedInUrl: string | null;
}

export interface YcTractionClaim {
  /** The sentence the page actually prints. */
  quote: string;
  /**
   * Which section it came from. This is load-bearing, not decoration:
   * a 'founder-bio' claim is almost always about a PRIOR company
   * ("At my last company, I managed $10M+ in contractor payouts") and is
   * founder-market-fit evidence, NOT this company's traction. Only
   * 'launch-post' and 'description' claims are about the company itself,
   * and even those are company-authored. The analyst UI shows the
   * section so the two are never confused.
   *
   * 'prior-company' is the same misattribution caught INSIDE a launch
   * post. Section alone was not enough: a YC launch post is a narrative
   * with an "Our Story" beat, and the sentence that beat opens with is
   * routinely about a company the founders no longer run —
   * "Before Unifold, we built wallet-as-a-service infrastructure and
   * were acquired ... where we helped onboard 30M+ users". Filing that
   * as launch-post/about-this-company credited Unifold with 30M+ users
   * it has never had. See classifyNarrative below.
   */
  section: 'launch-post' | 'description' | 'founder-bio' | 'prior-company';
  /** True only for sections where the company is describing ITSELF. */
  aboutThisCompany: boolean;
}

export interface YcProfile {
  slug: string;
  canonicalUrl: string;
  name: string | null;
  website: string | null;
  batch: string | null;
  status: string | null;
  location: string | null;
  teamSize: number | null;
  foundedYear: number | null;
  description: string | null;
  launchPost: string | null;
  founders: YcFounder[];
  tractionClaims: YcTractionClaim[];
  tags: string[];
}

const YC_PROFILE_RE = /^https?:\/\/(?:www\.)?ycombinator\.com\/companies\/([a-z0-9][a-z0-9-]*)\/?$/i;

/** Is this the public profile page for one company (not the directory)? */
export function isYcProfileUrl(url: string): boolean {
  return YC_PROFILE_RE.test(url.trim());
}

export function ycSlugFromUrl(url: string): string | null {
  const m = url.trim().match(YC_PROFILE_RE);
  return m ? m[1].toLowerCase() : null;
}

// ── HTML helpers ─────────────────────────────────────────────────
// Deliberately small and local. The point of this module is that it
// reads STRUCTURE, so it needs tag boundaries — which is exactly what
// readableText() destroys.

function decode(s: string): string {
  return s
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2019;|&rsquo;/gi, '’')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function stripTags(s: string): string {
  return decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Block-level tags — the boundaries a reader sees as "end of a line". */
const BLOCK_BOUNDARY = /<\s*\/?\s*(?:div|p|li|ul|ol|br|h[1-6]|section|tr|td|table|blockquote)\b[^>]*>/gi;

/**
 * Like stripTags, but keeps block boundaries as newlines.
 *
 * Flattening every tag to a SPACE loses the only sentence boundary a
 * launch post has where its author used markup instead of punctuation,
 * and the consequence was silent data loss rather than a wrong answer.
 * Grade's launch post ends its Traction heading like this:
 *
 *     <h3>Traction 📊</h3>
 *     <p>In the last 30 days, companies used Grade to pay out $380k+
 *        to creators, up 120% MoM</p>
 *     <h3>Our ask 📣</h3>
 *
 * No period anywhere. Flattened to spaces it becomes one run-on string,
 * so TRACTION_SENTENCE — which needs a terminating . ! or ? — either
 * matched nothing or swallowed the next three headings and blew the
 * 320-character cap. Grade's single most important public claim, the one
 * naming its payment volume and growth rate, was dropped from the
 * evidence queue entirely while thinner sentences around it were kept.
 *
 * The same flattening is why an excerpt could begin mid-URL
 * ("com/in/sam-oberly/ ) Our CTO, ..."): a href's dots read as sentence
 * ends. URLs are removed before segmenting for that reason.
 */
function blockText(html: string): string {
  return decode(
    html
      .replace(BLOCK_BOUNDARY, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Text of every element whose class attribute contains `needle`, in document order. */
function textOfClass(html: string, needle: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(\\w+)[^>]*class="[^"]*${needle}[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const t = stripTags(m[2]);
    if (t) out.push(t);
  }
  return out;
}

/**
 * The `Label: Value` rows in the sidebar card.
 *
 * YC renders them as two sibling children of a
 * `flex flex-row justify-between` div, so the label and value survive as
 * adjacent text once the inner tags are stripped.
 */
function metaField(html: string, label: string): string | null {
  const re = new RegExp(`${label}\\s*:?\\s*<\\/[^>]+>([\\s\\S]{0,300}?)<\\/div>`, 'i');
  const m = html.match(re);
  if (m) {
    const v = stripTags(m[1]);
    if (v) return v;
  }
  // Fallback: the flattened "Label: Value" form.
  const flat = stripTags(html).match(new RegExp(`${label}\\s*:\\s*([^:]{1,60}?)(?=\\s{2,}|\\s+[A-Z][a-z]+\\s*:|$)`));
  return flat ? flat[1].trim() : null;
}

/** The slice of markup between the Active Founders heading and the next section. */
function foundersSection(html: string): string | null {
  const start = html.search(/Active\s+Founders/i);
  if (start < 0) return null;
  const rest = html.slice(start);
  // Ends at the next top-level section heading, whichever comes first.
  const end = rest.search(/Company\s+Launches|Jobs at|Similar Companies|<footer/i);
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 40_000);
}

/**
 * Founders, deduplicated.
 *
 * Each founder is a `text-xl font-bold` name followed by a
 * `text-gray-600` role and a `whitespace-pre-line` biography. YC emits
 * the whole block twice (desktop + mobile), and the two copies are
 * IDENTICAL — so collapsing on the normalized name keeps one of each
 * person and cannot merge two different co-founders.
 */
function parseFounders(section: string): YcFounder[] {
  const byName = new Map<string, YcFounder>();

  // Split on the name marker so each chunk holds exactly one person.
  const parts = section.split(/<div[^>]*class="[^"]*text-xl font-bold[^"]*"[^>]*>/i).slice(1);
  for (const part of parts) {
    const nameRaw = part.slice(0, part.indexOf('</div>'));
    const fullName = stripTags(nameRaw);
    // A name is two-to-four capitalised words. Anything else is a
    // heading or a company card that happens to share the class.
    if (!/^[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{L}'’.-]+){1,3}$/u.test(fullName)) continue;

    const key = fullName.toLowerCase().replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim();
    if (byName.has(key)) continue;

    const role = textOfClass(part, 'text-gray-600')[0] ?? null;
    /**
     * The role must be a FOUNDER or officer title.
     *
     * YC's own "Active Founders" section only lists founders, but the
     * same card markup is reused elsewhere on the page and a reader
     * cannot rely on position alone. Reusing `isFounderTitle` — the
     * predicate the generic extractor already uses — keeps one
     * definition of "is this person a founder" instead of two that can
     * drift. A "Head of Sales" in this block is a real employee and not
     * a founder, and recording them as one would be a false statement
     * about a named individual.
     */
    if (!role || !isFounderTitle(role)) continue;
    const bio = textOfClass(part, 'whitespace-pre-line')[0] ?? null;
    const li = part.match(/href="(https:\/\/(?:www\.)?linkedin\.com\/in\/[^"]+)"/i);

    byName.set(key, {
      fullName,
      role: role.length <= 80 ? role : null,
      bio: bio ? bio.slice(0, 1200) : null,
      linkedInUrl: li ? li[1] : null,
    });
  }
  return [...byName.values()];
}

/**
 * Prior-company framing: this sentence is about a company or employer
 * the founders are no longer describing as THIS one.
 *
 * Every pattern here requires an explicit temporal or possessive marker.
 * "Our Beginning: this all began when a doctor at Johns Hopkins told
 * us..." is Scheduling Wizard's OWN origin story and must stay
 * attributed to Scheduling Wizard, so a bare past tense is deliberately
 * not enough on its own.
 */
const PRIOR_COMPANY_FRAMING = [
  // Case class rather than the /i flag: the capital that follows is what
  // makes this "before <a company>" and not "before we ship". "Before"
  // also opens a sentence, so both spellings have to be allowed.
  /\b[Bb]efore\s+(?:founding\s+|starting\s+|building\s+)?[A-Z]/,
  /\bprior to\s+(?:founding|starting|building|joining|this)\b/i,
  /\bat (?:my|our|his|her|their) (?:last|previous|former|prior)\b/i,
  /\b(?:my|our|his|her|their) (?:last|previous|former|prior) (?:company|startup|job|role|venture|employer)\b/i,
  /\bpreviously (?:at|with|a |the |product lead|co-?founded|built|led|founded)\b/i,
  /\bwe (?:later )?left the acquiring company\b/i,
  /\bwas acquired by\b|\bwere acquired by\b|\bwe (?:exited|sold)\b/i,
  /\b(?:co-?founded|founded|built and exited|built, scaled,? and exited)\b[^.!?\n]*\b(?:acquired|exited|sold)\b/i,
];

/**
 * A sentence that is ABOUT a named founder rather than about the
 * company. Uses this company's own parsed founder list, so it needs no
 * heuristic guess at who counts as a founder.
 *
 * The case this exists for, from Scheduling Wizard's launch post:
 * "Our CTO, Abdelrahman Hamimi, is an AWS certified cloud solutions
 * architect who built internal automation software at GEICO used
 * internally across multiple departments." Read as a company claim, the
 * phrase "across multiple departments" reads as deployment breadth for
 * Scheduling Wizard. It is a fact about GEICO.
 */
function mentionsOwnFounder(sentence: string, founderNames: string[]): boolean {
  return founderNames.some((n) => {
    const parts = n.split(/\s+/).filter((p) => p.length > 2);
    // Full name, or a distinctive surname — YC posts use both
    // ("Our CEO, Sam Oberly" / "Lotanna and James here").
    return sentence.includes(n)
      || (parts.length > 1 && sentence.includes(parts[parts.length - 1]) && /\b(?:our|the)\s+(?:CEO|CTO|COO|CFO|founder|co-?founder|head)\b/i.test(sentence));
  });
}

/** Does this sentence re-anchor the narrative on the CURRENT company? */
function reAnchorsOnCompany(sentence: string, companyName: string | null): boolean {
  if (companyName && new RegExp(`\\b${companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sentence)) return true;
  // Present-tense product framing: the company describing what it does now.
  return /\b(?:we (?:are|have|handle|support|serve|offer|help|track|process|now)\b|today,? we\b|our (?:platform|product|API|SDK|clients|customers) (?:is|are|now)\b)/i.test(sentence);
}

/**
 * Sentences that assert commercial traction. Extracted, never judged.
 *
 * The money alternative sits OUTSIDE the \b...\b wrapper, and that is a
 * fix rather than a style choice. `\b` requires a word character on one
 * side, and a currency amount in running prose is preceded by a space —
 * space then `$` is two non-word characters, so no boundary exists and
 * `\b\$` could never match. Every money-only claim was therefore
 * invisible to this pattern. Grade's launch post states its entire
 * commercial result in one such line — "In the last 30 days, companies
 * used Grade to pay out $380k+ to creators, up 120% MoM" — which
 * contains no other keyword here, so the single most important public
 * fact about the company was dropped while thinner sentences around it
 * were kept. Word-boundary anchoring still applies to the word
 * keywords, where it is what stops "processing" matching inside a
 * longer token.
 */
const TRACTION_SENTENCE = new RegExp(
  String.raw`[^.!?\n]*(?:\b(?:`
  + String.raw`customers?|clients?|hospitals?|departments?|design partners?|pilots?|contracts?|`
  + String.raw`integrat(?:ed|ion|ions)|live with|deployed|onboard(?:ed|ing)|processed|processing|`
  + String.raw`revenue|ARR|MRR|GMV|payment volume|payouts?|pa(?:y|ys|ying|id) out|`
  + String.raw`transactions?|users?|waitlist|LOIs?|letters of intent`
  + String.raw`)\b|`
  + String.raw`\$\d[\d.,]*\s*(?:k|m|b|million|billion)\+?`
  + String.raw`)[^.!?\n]*[.!?\n]?`,
  'gi',
);

/** Split on real sentence ends AND on block boundaries (see blockText). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tractionFrom(
  text: string | null,
  section: YcTractionClaim['section'],
  ctx: { companyName?: string | null; founderNames?: string[] } = {},
): YcTractionClaim[] {
  if (!text) return [];
  const founderNames = ctx.founderNames ?? [];
  const out: YcTractionClaim[] = [];

  /**
   * Narrative carry-forward.
   *
   * "Before Grade, we built, scaled, and exited 4 mobile AI apps." is
   * caught by the framing patterns. The sentence AFTER it — "Creators
   * were our main growth channel, and they helped us reach millions of
   * users." — names no prior company and would otherwise be filed as
   * Grade reaching millions of users. It is the same paragraph about the
   * same prior apps.
   *
   * So a prior-company sentence opens a narrative that stays prior until
   * a sentence re-anchors on this company. Erring toward "prior" is the
   * safe direction: a misfiled prior-company claim can inflate a score,
   * whereas a claim marked prior is still stored, still shown to the
   * analyst, and merely carries no traction suggestion.
   */
  let inPriorNarrative = false;

  for (const sentence of sentences(text)) {
    if (reAnchorsOnCompany(sentence, ctx.companyName ?? null)) inPriorNarrative = false;
    const isPrior = PRIOR_COMPANY_FRAMING.some((re) => re.test(sentence))
      || mentionsOwnFounder(sentence, founderNames);
    if (isPrior) inPriorNarrative = true;

    for (const m of sentence.matchAll(TRACTION_SENTENCE)) {
      const quote = m[0].trim().replace(/\s+/g, ' ');
      // Long enough to be a claim, short enough to be one sentence.
      if (quote.length < 25 || quote.length > 320) continue;
      const effective: YcTractionClaim['section'] = section === 'founder-bio'
        ? 'founder-bio'
        : (isPrior || inPriorNarrative) ? 'prior-company' : section;
      out.push({
        quote,
        section: effective,
        aboutThisCompany: effective === 'launch-post' || effective === 'description',
      });
    }
  }
  return out;
}

export function parseYcProfile(html: string, url: string): YcProfile | null {
  const slug = ycSlugFromUrl(url);
  if (!slug) return null;

  const section = foundersSection(html);
  const founders = section ? parseFounders(section) : [];

  /**
   * The company's own website, taken from the SIDEBAR CARD only.
   *
   * Scanning the whole document for the first non-YC outbound link
   * returned a Google Plus URL out of the page footer for all four test
   * companies — a real link on the page, and completely the wrong fact.
   * The sidebar card is the one place YC states the company's own site,
   * and it always follows the Primary Partner row.
   */
  const cardStart = html.search(/Primary\s+Partner/i);
  const card = cardStart > 0 ? html.slice(cardStart, cardStart + 4000) : '';
  const websiteMatch = [...card.matchAll(/href="(https?:\/\/[^"]+)"/gi)]
    .map((m) => m[1])
    .find((h) => !/ycombinator\.com|linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|github\.com|plus\.google|bookface|startupschool/i.test(h));

  const nameFromCard = textOfClass(html, 'text-xl font-medium')[0] ?? null;

  /**
   * The company description, taken from OUTSIDE the founders section.
   *
   * YC uses the class `prose` for both the company description and every
   * founder biography. Picking "the first long .prose block" therefore
   * returned a founder's bio — and it was then labelled as the company
   * describing ITSELF. Concretely: Grade's founder writes "At my last
   * company, I managed $10M+ in contractor payouts", about a PREVIOUS
   * company, and that sentence was being filed as Grade's own traction.
   * That is a false statement about Grade, and precisely the
   * misattribution this parser has to avoid.
   *
   * So the founders section is cut out first, and any text that matches
   * a founder biography is rejected outright.
   */
  const beforeFounders = section ? html.slice(0, html.search(/Active\s+Founders/i)) : html;
  const afterFounders = section ? html.slice(html.search(/Active\s+Founders/i) + section.length) : '';
  const founderBios = new Set(founders.map((f) => f.bio).filter(Boolean) as string[]);
  const description = [...textOfClass(beforeFounders, 'prose'), ...textOfClass(afterFounders, 'prose')]
    .find((t) => t.length > 60 && !founderBios.has(t)) ?? null;

  // Block boundaries preserved — see blockText. A launch post is written
  // as headings and list items, and its punctuation cannot be trusted to
  // mark where one claim ends and the next begins.
  /**
   * The launch post, BOUNDED at the next section.
   *
   * A fixed 6000-character slab from the "Company Launches" heading runs
   * past the end of the post and into whatever YC renders next — the
   * "Similar Companies" cards are other companies' one-liners, and any
   * of them matching TRACTION_SENTENCE would be filed as THIS company's
   * claim. `description` already cuts at a boundary; this did not, and
   * the two need the same discipline for the same reason.
   */
  let launchPost: string | null = null;
  const li = html.search(/Company\s+Launches/i);
  if (li > 0) {
    const slab = html.slice(li, li + 12_000);
    const stop = slab.slice(1).search(/Similar\s+Companies|Jobs at|Active\s+Founders|<footer/i);
    launchPost = blockText(stop > 0 ? slab.slice(0, stop + 1) : slab.slice(0, 6000)).slice(0, 4000);
  }

  const teamSizeRaw = metaField(html, 'Team Size');
  const foundedRaw = metaField(html, 'Founded');

  const founderNames = founders.map((f) => f.fullName);
  const ctx = { companyName: nameFromCard, founderNames };
  const tractionClaims = [
    ...tractionFrom(launchPost, 'launch-post', ctx),
    ...tractionFrom(description, 'description', ctx),
    ...founders.flatMap((f) => tractionFrom(f.bio, 'founder-bio', ctx)),
  ];
  /**
   * One claim per distinct sentence. When the same sentence surfaces in
   * two sections the MORE CAUTIOUS attribution wins, rather than
   * whichever section happened to run first — the same sentence cannot
   * be both about this company and about a prior one, and if either
   * reading says "prior", crediting it to this company is the error that
   * matters.
   */
  const bestByQuote = new Map<string, YcTractionClaim>();
  for (const c of tractionClaims) {
    const k = c.quote.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const prev = bestByQuote.get(k);
    if (!prev || (prev.aboutThisCompany && !c.aboutThisCompany)) bestByQuote.set(k, c);
  }
  const dedupedClaims = [...bestByQuote.values()];

  return {
    slug,
    canonicalUrl: `https://www.ycombinator.com/companies/${slug}`,
    name: nameFromCard,
    website: websiteMatch ?? null,
    batch: metaField(html, 'Batch'),
    status: metaField(html, 'Status'),
    location: metaField(html, 'Location'),
    teamSize: teamSizeRaw && /^\d+$/.test(teamSizeRaw) ? Number(teamSizeRaw) : null,
    foundedYear: foundedRaw && /^\d{4}$/.test(foundedRaw) ? Number(foundedRaw) : null,
    description,
    launchPost,
    founders,
    tractionClaims: dedupedClaims,
    tags: [...new Set(textOfClass(html, 'ycdc-badge').map((t) => t.trim()).filter(Boolean))],
  };
}

/**
 * Does this YC profile actually describe the candidate we are researching?
 *
 * Domain first, then canonical slug. NEVER the company name on its own:
 * the directory contains both "Manifold" (warehouse robotics, S26) and
 * "Manifold Freight", and matching on name would silently attribute one
 * company's founders to the other.
 */
export function ycProfileMatchesCandidate(
  profile: YcProfile,
  candidate: { website?: string | null; ycSlug?: string | null },
): { matches: boolean; basis: 'domain' | 'slug' | 'none' } {
  if (candidate.ycSlug && candidate.ycSlug.toLowerCase() === profile.slug) {
    return { matches: true, basis: 'slug' };
  }
  const a = normalizeDomainKey(candidate.website ?? null);
  const b = normalizeDomainKey(profile.website);
  if (a && b && a === b) return { matches: true, basis: 'domain' };
  return { matches: false, basis: 'none' };
}
