import type { AssertionType, DiscoveryCandidate } from '../../shared/discovery';
import { politeFetch, RequestBudget } from './politeness';
import { pageDisqualifiedAsOfficialSite, readableText, hostBelongsToIssuer, looksParkedOrPlaceholder } from './pageSignals';
import { extractPeopleFromHtml, TEAM_PAGE_PATHS } from '../enrichment/founderExtraction';
import { extractFunding, extractLocation } from '../enrichment/companyFacts';
import { countIndependentSources } from './qualitySignals';

/**
 * Stage 3 of the sourcing funnel: EVIDENCE ENRICHMENT.
 *
 * Why this exists. The first controlled run settled an open question:
 * discovery-time snippets cannot support a well-evidenced score, and no
 * amount of better filtering changes that. A YC directory one-liner or a
 * funding headline gives a sector and maybe a city; it does not give a
 * stage, a customer, a founder background, or a moat. Every one of the
 * 172 companies on file had `traction = "Unknown — not yet researched"`,
 * 148 of them had exactly one evidence item, and under the v4.1
 * provisional policy every single one is — correctly — provisional.
 *
 * So this stage goes and reads the company's own pages for the
 * highest-priority eligible candidates, and records what it finds as
 * CITED FACTS rather than as fields appearing from nowhere.
 *
 * ─────────────────────────────────────────────────────────────────
 * RULES, all enforced here rather than trusted to callers
 * ─────────────────────────────────────────────────────────────────
 *
 * 1. Every fact carries its URL, the date we accessed it, the
 *    publication date when the page states one, and a VERBATIM quoted
 *    fragment. A fact with no quote cannot be constructed.
 * 2. Every fact is labelled fact / inference / unknown. "Inference"
 *    means we derived it from published text (a batch code read as a
 *    date); it never means we guessed.
 * 3. Primary sources are preferred and marked. The company's own site
 *    is primary; a third-party article is secondary.
 * 4. Independent-source counting reuses countIndependentSources, so
 *    one press release syndicated to six outlets stays one source.
 * 5. NOTHING is fabricated. If a page does not state a customer, the
 *    field is returned as unresolved — never filled with a plausible
 *    value, never widened from an adjacent claim.
 * 6. Founder IDENTITY (ethnicity, gender, race) is never extracted,
 *    inferred, or stored. There is deliberately no code path here that
 *    reads a name or an image for that purpose; the only founder data
 *    collected is the name and the role a page states in words.
 * 7. Spend and rate limits are the existing ones: politeFetch enforces
 *    per-host gaps, backoff, Retry-After, robots-respecting behaviour
 *    and response caching, and RequestBudget caps requests per
 *    candidate and per run. No paid service, credential, or billing is
 *    introduced — every fetch is an unauthenticated GET of a public
 *    page the company published about itself.
 */

/** The fields this stage tries to establish, in the order it tries them. */
export const ENRICHMENT_FIELDS = [
  'product', 'buyer', 'founders', 'customers', 'funding', 'stage',
  'accelerator', 'hq', 'moat', 'validation', 'activity',
] as const;
export type EnrichmentField = (typeof ENRICHMENT_FIELDS)[number];

export interface EnrichedFact {
  field: EnrichmentField;
  /** The normalized value a caller can act on. */
  value: string;
  assertionType: AssertionType;
  /** Verbatim fragment from the page. Never a paraphrase. */
  quote: string;
  sourceUrl: string;
  /** The company's own site is primary; anything else is secondary. */
  sourceKind: 'primary' | 'secondary';
  publishedAt: string | null;
  accessedAt: string;
}

export interface FetchedPage {
  url: string;
  status: number;
  ok: boolean;
  bytes: number;
  fromCache: boolean;
  skippedReason?: string;
}

export interface EnrichmentOutcome {
  candidateId: string;
  companyName: string;
  facts: EnrichedFact[];
  /** Fields no permitted source stated. Reported, never filled. */
  unresolved: EnrichmentField[];
  pages: FetchedPage[];
  /** Distinct sources after collapsing syndicated copies of one release. */
  independentSources: number;
  /** Fields backed by two or more independent sources. */
  corroboratedFields: EnrichmentField[];
  apiCalls: number;
  warnings: string[];
}

/** Pages worth reading on a company's own site, best-first. */
const EVIDENCE_PAGE_PATHS = [
  ...TEAM_PAGE_PATHS,
  '/customers', '/case-studies', '/customer-stories', '/products', '/product', '/solutions', '/pricing',
] as const;

const USER_AGENT = 'vamos-deal-radar research (contact: vamosventures.com)';

/**
 * Claim patterns. Each yields a value AND the matched span, because the
 * span is the quote that makes the fact auditable. A pattern that cannot
 * produce a quote is not usable here.
 */
const CLAIM_PATTERNS: { field: EnrichmentField; assertion: AssertionType; pattern: RegExp }[] = [
  {
    field: 'customers',
    assertion: 'fact',
    pattern: /(?:our customers include|customers include|trusted by|used by|deployed (?:at|with)|in production at|partnered with|pilot(?:ing)? with)\s+([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})/,
  },
  {
    field: 'customers',
    assertion: 'fact',
    pattern: /\b(\d[\d,]*\+?)\s+(?:paying customers|enterprise customers|hospitals|clinics|utilities|banks|dealerships|teams)\b/i,
  },
  {
    field: 'buyer',
    assertion: 'fact',
    pattern: /\bfor\s+((?:enterprise|hospital|health system|clinic|payer|bank|credit union|insurer|utility|grid operator|manufacturer|warehouse|government|municipal)[\w\s-]{0,28}?)(?:s\b|\b)/i,
  },
  {
    field: 'moat',
    assertion: 'fact',
    pattern: /\b(proprietary [\w\s-]{3,40}|patent(?:ed|s|\s+pending)[\w\s-]{0,30}|our own (?:model|dataset|hardware|silicon|runtime)[\w\s-]{0,30}|\d+(?:\.\d+)?x\s+(?:faster|SOTA)[\w\s-]{0,25})/i,
  },
  {
    field: 'validation',
    assertion: 'fact',
    // Bounded deliberately tightly. A looser trailing run
    // (`[\w\s()-]{0,20}`) swallowed site navigation, producing quotes
    // like "Y Combinator Open menu About What" — technically words that
    // appear on the page, but not evidence of anything, and a quote a
    // reviewer cannot act on is worse than no quote. Only the program
    // name plus an explicit batch/award token is captured.
    pattern: /\b((?:Y Combinator|Techstars|SBIR|STTR|NSF|NIH|ARPA-E|DOE)(?:\s*\(?(?:[WSF]\d{2}|grant|award|fellowship)\)?)?)/,
  },
  {
    field: 'activity',
    assertion: 'fact',
    pattern: /\b((?:launched|shipped|released|announced|went live)\s+[\w\s-]{4,50})/i,
  },
];

/** A published date the page states about itself. Absent stays null. */
function statedPublishedAt(html: string): string | null {
  const meta = html.match(/<meta[^>]+(?:article:published_time|datePublished)["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i);
  if (meta) return meta[1];
  const time = html.match(/<time[^>]+datetime=["'](\d{4}-\d{2}-\d{2})/i);
  return time ? time[1] : null;
}

function makeFact(args: {
  field: EnrichmentField;
  value: string;
  quote: string;
  url: string;
  primary: boolean;
  publishedAt: string | null;
  assertion?: AssertionType;
  accessedAt: string;
}): EnrichedFact {
  return {
    field: args.field,
    value: args.value.replace(/\s+/g, ' ').trim().slice(0, 240),
    assertionType: args.assertion ?? 'fact',
    // Bounded so a fact can never smuggle a whole page into the record,
    // but long enough that a reviewer can judge it without re-fetching.
    quote: args.quote.replace(/\s+/g, ' ').trim().slice(0, 300),
    sourceUrl: args.url,
    sourceKind: args.primary ? 'primary' : 'secondary',
    publishedAt: args.publishedAt,
    accessedAt: args.accessedAt,
  };
}

/** Every fact one page supports. Only what the page actually says. */
export function extractFactsFromPage(args: {
  html: string;
  url: string;
  companyName: string;
  primary: boolean;
  accessedAt: string;
}): EnrichedFact[] {
  const { html, url, companyName, primary, accessedAt } = args;
  const text = readableText(html);
  const publishedAt = statedPublishedAt(html);
  const facts: EnrichedFact[] = [];
  const push = (field: EnrichmentField, value: string, quote: string, assertion?: AssertionType) =>
    facts.push(makeFact({ field, value, quote, url, primary, publishedAt, assertion, accessedAt }));

  for (const { field, assertion, pattern } of CLAIM_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    push(field, m[1] ?? m[0], m[0], assertion);
  }

  // Founders: NAME AND STATED ROLE ONLY. extractPeopleFromHtml requires
  // a founder/officer title printed next to the name, so a board member
  // or an advisor is not returned as a founder. No attribute of the
  // person beyond what the page prints in words is read, recorded, or
  // derived — see rule 6 in this file's header.
  for (const p of extractPeopleFromHtml(html, 6)) {
    push('founders', p.title ? `${p.fullName} — ${p.title}` : p.fullName, p.supportingText);
  }

  // Location and funding reuse the existing extractors, so this stage
  // cannot drift from how the rest of the app reads the same text.
  const loc = extractLocation(text);
  if (loc) push('hq', [loc.city, loc.state].filter(Boolean).join(', '), loc.evidence);
  const funding = extractFunding(text, companyName);
  if (funding) {
    push('funding', funding.amountText, funding.evidence);
    // A round NAME is a fact when the same sentence prints it; the
    // pipeline's stage vocabulary is resolved downstream, not here.
    if (funding.roundType) push('stage', funding.roundType, funding.evidence);
  }

  return facts.filter((f) => f.value.length > 0 && f.quote.length > 0);
}

/**
 * URLs to read, best-first, deduplicated and capped.
 *
 * Ordering matters more than it looks. The first version listed the
 * company's home page and then all fifteen speculative same-site paths
 * (/about, /team, /customers, …) before the candidate's own cited
 * sources — so with a realistic page budget the cited third-party URLs
 * were never reached, and the corroboration this stage exists to
 * establish was structurally impossible to find. Most of those guessed
 * paths do not exist on any given site; a cited URL is a page we already
 * know is real.
 *
 * So: home page, then KNOWN cited sources, then guessed paths with
 * whatever budget is left.
 */
function pagePlan(cand: DiscoveryCandidate, maxPages: number): string[] {
  const homepage: string[] = [];
  const guessed: string[] = [];
  const site = cand.website !== 'Unknown' ? cand.website : null;
  if (site) {
    try {
      const root = new URL(site);
      homepage.push(root.origin + (root.pathname === '/' ? '' : root.pathname));
      for (const p of EVIDENCE_PAGE_PATHS) guessed.push(root.origin + p);
    } catch {
      // Unparseable website; the cited evidence URLs still apply.
    }
  }
  const cited = cand.evidence.map((e) => e.url);
  return [...new Set([...homepage, ...cited, ...guessed])].slice(0, maxPages);
}

export interface EnrichOptions {
  /** Hard cap on pages fetched for this candidate. */
  maxPages?: number;
  /** Shared across a whole run when the caller passes one. */
  budget?: RequestBudget;
  now?: Date;
}

/**
 * Research one candidate against permitted public sources.
 *
 * Never throws: a source failing is an expected outcome that has to be
 * reported alongside what did succeed, not an exception that loses the
 * rest of the run's work.
 */
export async function enrichCandidateEvidence(
  cand: DiscoveryCandidate,
  opts: EnrichOptions = {},
): Promise<EnrichmentOutcome> {
  const maxPages = opts.maxPages ?? 6;
  const budget = opts.budget ?? new RequestBudget(maxPages);
  const accessedAt = (opts.now ?? new Date()).toISOString().slice(0, 10);

  const pages: FetchedPage[] = [];
  const facts: EnrichedFact[] = [];
  const warnings: string[] = [];
  let apiCalls = 0;

  for (const url of pagePlan(cand, maxPages)) {
    const res = await politeFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }, budget });
    apiCalls += res.requests;
    if (!res.ok) {
      pages.push({ url, status: res.status, ok: false, bytes: 0, fromCache: res.fromCache, skippedReason: res.detail ?? res.failure });
      if (res.failure === 'budget-exhausted') { warnings.push(`Page budget exhausted before ${url}.`); break; }
      continue;
    }

    const primary = hostBelongsToIssuer(url, cand.companyName);

    // Page hygiene, applied at the RIGHT strictness for each kind of
    // source.
    //
    // `pageDisqualifiedAsOfficialSite` also rejects thin pages, because
    // a two-line page is not a credible official website. That test is
    // correct for a company's own domain and wrong for everything else:
    // a legitimate news item, award listing or accelerator profile is
    // often short, and running the strict check over third-party URLs
    // silently threw away exactly the independent corroboration this
    // stage exists to collect. Secondary sources are therefore only
    // rejected when they are genuinely parked or a registrar
    // placeholder — a page that is not about a company at all.
    const disqualified = primary
      ? pageDisqualifiedAsOfficialSite(res.body)
      : (looksParkedOrPlaceholder(res.body) ? 'Parked or placeholder page.' : null);
    if (disqualified) {
      pages.push({ url, status: res.status, ok: false, bytes: res.body.length, fromCache: res.fromCache, skippedReason: disqualified });
      continue;
    }

    pages.push({ url, status: res.status, ok: true, bytes: res.body.length, fromCache: res.fromCache });
    facts.push(...extractFactsFromPage({ html: res.body, url, companyName: cand.companyName, primary, accessedAt }));
  }

  // Independent-source counting over everything now backing this
  // candidate — its original citations plus the pages just read.
  const asEvidence = [
    ...cand.evidence.map((e) => ({ claim: e.claim, url: e.url })),
    ...facts.map((f) => ({ claim: f.quote, url: f.sourceUrl })),
  ] as DiscoveryCandidate['evidence'];
  const independentSources = countIndependentSources(asEvidence);

  // A field is corroborated only when two sources that are genuinely
  // independent of each other state it.
  const corroboratedFields = [...new Set(facts.map((f) => f.field))].filter((field) => {
    const forField = facts.filter((f) => f.field === field);
    return countIndependentSources(
      forField.map((f) => ({ claim: f.quote, url: f.sourceUrl })) as DiscoveryCandidate['evidence'],
    ) >= 2;
  });

  const found = new Set(facts.map((f) => f.field));
  const unresolved = ENRICHMENT_FIELDS.filter((f) => !found.has(f));

  return {
    candidateId: cand.id,
    companyName: cand.companyName,
    facts,
    unresolved,
    pages,
    independentSources,
    corroboratedFields,
    apiCalls,
    warnings,
  };
}

/**
 * Fold researched facts back onto the candidate.
 *
 * Strictly additive: a field the candidate already knows is never
 * overwritten, and a field no fact established stays exactly as it was
 * ('Unknown'). Every folded value arrives with its citation appended to
 * the candidate's evidence, so nothing gains a value without gaining a
 * source at the same time.
 */
export function applyEnrichment(cand: DiscoveryCandidate, outcome: EnrichmentOutcome): DiscoveryCandidate {
  const first = (field: EnrichmentField) => outcome.facts.find((f) => f.field === field);
  const all = (field: EnrichmentField) => outcome.facts.filter((f) => f.field === field);

  const founderFacts = all('founders');
  const customerFacts = all('customers');
  const hq = first('hq');
  const funding = first('funding');
  const accelerator = first('validation');

  const [hqCity, hqState] = hq ? hq.value.split(',').map((s) => s.trim()) : [undefined, undefined];

  // Each new evidence row is a real citation for a real folded value.
  const cited = new Set(cand.evidence.map((e) => e.url));
  const newEvidence = outcome.facts
    .filter((f) => !cited.has(f.sourceUrl))
    .filter((f, i, arr) => arr.findIndex((x) => x.sourceUrl === f.sourceUrl) === i)
    .map((f) => ({
      claim: `${f.field}: ${f.quote}`,
      source: f.sourceKind === 'primary' ? `${cand.companyName} (own site)` : new URL(f.sourceUrl).hostname,
      url: f.sourceUrl,
      dateAccessed: f.accessedAt,
      publishedAt: f.publishedAt,
      verificationStatus: 'Not verified' as const,
      confidence: f.sourceKind === 'primary' ? 0.8 : 0.6,
      notes: `Enriched from ${f.sourceKind} source; recorded as ${f.assertionType}.`,
      assertionType: f.assertionType,
    }));

  return {
    ...cand,
    founderNames: cand.founderNames.length > 0
      ? cand.founderNames
      : founderFacts.map((f) => f.value.split(' — ')[0]).slice(0, 6),
    founderCount: cand.founderCount ?? (founderFacts.length > 0 ? founderFacts.length : null),
    hqCity: cand.hqCity !== 'Unknown' ? cand.hqCity : (hqCity || 'Unknown'),
    hqState: cand.hqState !== 'Unknown' ? cand.hqState : (hqState && /^[A-Z]{2}$/.test(hqState) ? hqState : 'Unknown'),
    publicFunding: cand.publicFunding !== 'Unknown' ? cand.publicFunding : (funding?.value ?? 'Unknown'),
    accelerator: cand.accelerator !== 'Unknown' ? cand.accelerator : (accelerator?.value ?? 'Unknown'),
    // Traction signals are quoted, never summarised — an analyst has to
    // be able to see the words the company used.
    tractionSignals: [
      ...cand.tractionSignals,
      ...customerFacts.map((f) => `${f.value} — "${f.quote}" (${f.sourceUrl}, accessed ${f.accessedAt})`),
    ],
    evidence: [...cand.evidence, ...newEvidence],
    independentSources: outcome.independentSources,
  };
}
