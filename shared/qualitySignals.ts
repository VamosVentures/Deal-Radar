import type { DiscoveryCandidate } from './discovery';

/**
 * Stage 2 of the sourcing funnel: EVIDENCE-BACKED QUALITY PRIORITIZATION.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THIS IS NOT THE VAMOS FIT SCORE AND MUST NEVER BECOME IT.
 * ─────────────────────────────────────────────────────────────────────
 *
 * The official VamosVentures Fit Score lives in src/lib/scoring.ts, is computed
 * only from a persisted `Company`, and is unchanged by this file — same
 * ten components, same weights, same 8.0 Hot threshold. The number
 * produced here is an INTERNAL TRIAGE PRIORITY (0–100) whose only job is
 * to decide which candidates deserve expensive enrichment first, while
 * they are still candidates and before any of them is a company at all.
 *
 * The two are kept apart by construction, not by convention:
 *   - nothing in this file imports scoreCompany, saveScore, or any
 *     scoring type;
 *   - the value is stored on the discovery CANDIDATE, never on a
 *     scoring_results row;
 *   - a high priority here cannot raise a company's fit score by a
 *     single point, and a zero here cannot lower one.
 * There is a test asserting exactly this (server/tests/quality-signals.test.ts).
 *
 * Lives in shared/ because BOTH tiers need it: the server ranks
 * candidates with it during discovery, and the All Deals table needs the
 * same signals to decide "Promising — Needs Diligence" membership.
 * Duplicating them would let the two definitions drift. It is pure — no
 * database, no network, no scoring import — so sharing it cannot drag
 * server code into the browser bundle.
 *
 * WHY A TRIAGE LAYER AT ALL. The diagnostic that motivated this pass
 * found the funnel was not short of candidates — it was short of
 * candidates worth enriching. Every one of the 172 live companies had
 * `traction_note = "Unknown — not yet researched"`, 148 of them had
 * exactly one evidence item, and the strongest records in the database
 * were 2015-era YC alumni that no filter had questioned. Enrichment
 * effort was being spread evenly across a funnel that was not evenly
 * promising.
 *
 * EVERY SIGNAL MUST CITE TEXT. A signal fires only when a pattern
 * matches text a source actually published, and it records the matched
 * substring. Nothing here infers, and nothing here rewards a company for
 * being "AI" — there is deliberately no such signal, because the whole
 * point of retiring General AI as a vertical was that AI is a technology,
 * not evidence of anything.
 */

export type SignalDirection = 'positive' | 'negative';

export interface QualitySignal {
  key: string;
  direction: SignalDirection;
  label: string;
  /** Points AFTER the provenance weighting below. */
  points: number;
  /** Points the rule is worth at full confidence, before weighting. */
  fullPoints: number;
  /** The exact published substring that fired this signal. Never a paraphrase. */
  evidence: string;
  /** Where that text came from, when the match was in a cited evidence item. */
  sourceUrl?: string;
  /**
   * How much the source is trusted for TRIAGE.
   *
   *  'published'      the candidate's own cited discovery text.
   *  'company-claimed' the company describing itself — a YC profile, a
   *                    launch post, a founder biography. Real, cited, and
   *                    weighted DOWN, because an accelerator hosting a
   *                    company's own words is not a third party
   *                    confirming them.
   *  'independent'    a third party states it.
   */
  provenance: 'published' | 'company-claimed' | 'independent';
  /** The multiplier applied to `fullPoints` to get `points`. */
  weight: number;
}

export interface QualityAssessment {
  /** 0–100 internal triage priority. NOT the VamosVentures Fit Score. */
  priority: number;
  band: 'high' | 'medium' | 'low';
  signals: QualitySignal[];
  /**
   * How many genuinely INDEPENDENT sources back this candidate. A press
   * release syndicated to six outlets is one source, not six.
   */
  independentSources: number;
  /** Plain-language account of how `priority` was reached. */
  rationale: string;
}

interface Rule {
  key: string;
  label: string;
  points: number;
  pattern: RegExp;
}

/**
 * Evidence gathered AFTER discovery, which the assessor could not
 * previously see.
 *
 * The defect this fixes: `assessQuality` ran once, at discovery time,
 * from the candidate's original snippet — and nothing recomputed it
 * afterwards. Grade came back LOW priority while carrying two founders
 * with cited payments/payroll backgrounds and a published payment-volume
 * claim, because neither had existed when the number was calculated.
 * A stale triage value was deciding queue membership.
 *
 * Everything here is weighted DOWN as company-claimed. It is genuine,
 * cited evidence and it may legitimately move triage priority — it is
 * not independent verification and must never be counted as such.
 */
export interface QualityContext {
  /**
   * Founder biographies, each with the URL that published it.
   * Founder-market-fit may fire from these ONLY when a source URL is
   * present — an uncited biography is not evidence.
   */
  founderBios?: { text: string; sourceUrl?: string }[];
  /** Pending company-claimed traction/customer claims awaiting analyst review. */
  companyClaimed?: { text: string; sourceUrl?: string }[];
}

/**
 * Company-claimed evidence counts, at a discount.
 *
 * 0.6 is a judgement, and it is deliberately not 1.0 and not 0. A YC
 * launch post saying "20 departments across 16 hospitals" is a real,
 * quotable, dated claim that should move a company up the research
 * queue — and it is the company talking about itself, so it must not
 * move it as far as an independent source would.
 */
const COMPANY_CLAIMED_WEIGHT = 0.6;

/**
 * Positive signals. Each is a piece of evidence that a company has a real
 * buyer, a real product, or a real reason to be defensible — the
 * characteristics the Scale AI archetype is being used to describe, found
 * at pre-seed/seed rather than at scale.
 */
const POSITIVE_RULES: Rule[] = [
  {
    key: 'named-customers',
    label: 'Named customers or credible pilots',
    points: 14,
    // The capitalised token after the phrase is what makes this a NAMED
    // customer rather than a claim about customers in general — "used by
    // Xcel Energy" fires, "used by thousands of teams" does not.
    pattern: /\b(?:our customers include|customers include|used by|trusted by|powering|deployed (?:at|with)|pilot(?:s|ing)? with|partnered with|working with|serving)\s+[A-Z][\w&.-]*/,
  },
  {
    key: 'commercial-proof',
    label: 'Contract, revenue, usage, or deployment evidence',
    points: 14,
    pattern: /\b(?:\$\d[\d.,]*\s*(?:k|m|mm|million)?\s*(?:in\s+)?(?:ARR|MRR|revenue|bookings|contracts?)|\d[\d,.]*\s*(?:k|m|\+)?\s*(?:paying customers|active users|downloads|installs|transactions|deployments)|generate[sd]?\s+millions|thousands of (?:customer )?(?:interactions|orders|requests)\s+(?:every|per)\s+day)\b/i,
  },
  {
    key: 'enterprise-buyer',
    label: 'Clear enterprise or institutional buyer',
    points: 9,
    /**
     * BUYER CLARITY, not the word "enterprise".
     *
     * The previous pattern matched a bare `enterprise` anywhere in the
     * text, and a manual review of the shortlist found four companies
     * (Aktoria Robotics, Avoca Systems, Openroll, UNIT AI) that
     * qualified on nothing but that one word — usually an "Enterprise"
     * tag or the phrase "for enterprises". A tag is not a buyer.
     *
     * What counts now is a buyer you could actually name in a meeting:
     *   - a specific institution type (health system, credit union,
     *     grid operator, municipality…), which is a real segment;
     *   - a buyer ROLE or department (CIO, procurement, RevOps…);
     *   - "enterprise" only when bound to a concrete buyer noun
     *     (enterprise customers/buyers/contracts/deployments/IT…) or a
     *     named Fortune tier — never standing alone.
     *
     * Deliberately NOT counted: a standalone "enterprise" tag, "we build
     * enterprise software", "for enterprises", a sector, a geography, or
     * an accelerator.
     */
    pattern: new RegExp(
      String.raw`\b(?:`
      // Concrete institution types — each is a real buyer segment.
      + String.raw`health systems?|hospitals?|clinics?|payers?|providers?|`
      + String.raw`banks?|credit unions?|insurers?|lenders?|broker-?dealers?|`
      + String.raw`utilit(?:y|ies)|grid operators?|ISOs?|`
      + String.raw`local government|municipalit(?:y|ies)|government agenc(?:y|ies)|school districts?|`
      + String.raw`warehouses?|manufacturers?|dealerships?|carriers?|pharmac(?:y|ies)|`
      // Buyer roles and departments — a person with a budget.
      + String.raw`CIOs?|CISOs?|CFOs?|CTOs?|COOs?|procurement|compliance teams?|`
      + String.raw`engineering leaders?|revenue teams?|GTM teams?|operations teams?|finance teams?|`
      + String.raw`IT (?:teams?|departments?|leaders?)|`
      // "Enterprise" ONLY when bound to a buyer noun.
      + String.raw`Fortune \d+|F\d{3}|`
      + String.raw`enterprise (?:customers?|clients?|buyers?|accounts?|contracts?|deployments?|IT|sales|procurement)`
      + String.raw`)\b`,
      'i',
    ),
  },
  {
    key: 'technical-moat',
    label: 'Technical differentiation',
    points: 9,
    pattern: /\b(?:patent(?:ed|s|\s+pending)?|proprietary (?:model|algorithm|architecture|hardware|process)|our own (?:model|silicon|hardware|runtime)|\d+(?:\.\d+)?x\s+(?:faster|SOTA|state[- ]of[- ]the[- ]art|the competition)|peer[- ]reviewed|published in (?:Nature|Science|NeurIPS|ICML))\b/i,
  },
  {
    key: 'data-moat',
    label: 'Proprietary data or workflow advantage',
    points: 9,
    pattern: /\b(?:proprietary (?:data|dataset|corpus)|exclusive (?:data|access|partnership|licen[cs]e)|our (?:own )?dataset|feedback loop|improves with (?:every )?(?:use|usage)|system of record|closed[- ]loop)\b/i,
  },
  {
    key: 'founder-market-fit',
    label: 'Founder-market fit / prior operating or research experience',
    points: 9,
    /**
     * Case matters here, but only in specific places — which is why
     * there is no blanket `i` flag.
     *
     * `former(?:ly)?\s+(?:at\s+)?[A-Z]` and `research…\s+[A-Z]` rely on
     * the capital to identify a company or institution NAME; making the
     * whole rule case-insensitive would match "former engineer" and
     * "researchers at the" as founder-market fit.
     *
     * But the sentence-initial forms were being missed entirely:
     * "Previously at Barclays" and "Ex-Anduril" are how biographies
     * actually start a sentence, and a lowercase-only `previously` never
     * matched one. Only the alternatives that do not depend on case are
     * opened up, one letter at a time.
     */
    pattern: new RegExp(
      String.raw`\b(?:`
      + String.raw`[Ee]x-|`
      + String.raw`[Ff]ormer(?:ly)?\s+(?:at\s+)?[A-Z]|`
      /**
       * "Previously, I built and exited my first startup."
       *
       * The comma is the whole point. `previously\s+(?:built|…)`
       * required whitespace immediately after the word, and real
       * biographies almost always write "Previously, I …" — so Grade's
       * two founders (a Barclays payments lead and a two-time exited
       * founder) and Unifold's co-founder all produced NO
       * founder-market-fit signal at all, and Grade sat at LOW priority
       * with the strongest founder evidence in the shortlist.
       */
      + String.raw`[Pp]reviously[,:]?\s+(?:I\s+)?(?:at|led|built|founded|co-founded|worked|spent|ran|was|a\s)|`
      + String.raw`[Mm]ost recently[,:]?\s+(?:I\s+)?(?:at|led|built|spent|worked)|`
      + String.raw`[Cc]o-founded\s+[A-Z]|`
      + String.raw`\d+\+?\s+years of experience|`
      + String.raw`PhD|Ph\.D\.|`
      + String.raw`[Ss]econd[- ]time founder|[Ss]pun? out of|`
      + String.raw`[Rr]esearch(?:er)?s? (?:from|at)\s+[A-Z]`
      + String.raw`)`,
    ),
  },
  {
    key: 'institutional-validation',
    label: 'Accelerator, grant, research-spinout, or institutional validation',
    points: 8,
    pattern: /\b(?:Y Combinator|Techstars|accelerator|SBIR|STTR|NSF|DOE|ARPA-E|NIH|grant[- ]funded|awarded a grant|fellowship|residency|university spin-?out)\b/i,
  },
  {
    key: 'capital-efficiency',
    label: 'Capital efficiency',
    points: 5,
    pattern: /\b(?:bootstrapped|profitable|default alive|capital[- ]efficient|no outside (?:funding|capital))\b/i,
  },
  {
    key: 'market-expansion',
    label: 'Large initial market with credible expansion path',
    points: 5,
    pattern: /\b(?:starting with|beginning with|first market|then expand(?:ing)? (?:to|into)|\$\d[\d.,]*\s*(?:b|bn|billion|trillion)\s+market|TAM)\b/i,
  },
];

/**
 * Negative signals. These lower triage priority; they never reject —
 * rejection is stage 1's job, and only on hard, provable grounds.
 */
const NEGATIVE_RULES: Rule[] = [
  {
    key: 'thin-wrapper',
    label: 'Thin AI wrapper with no stated defensibility',
    points: -16,
    pattern: /\b(?:GPT wrapper|ChatGPT wrapper|thin wrapper|built on top of (?:ChatGPT|GPT-\d)|simply wraps|a wrapper (?:around|for))\b/i,
  },
  {
    key: 'services-business',
    label: 'Agency or consulting work presented as software',
    points: -18,
    // Requires the company to describe its OWN delivery model. Bare
    // "consulting" or "advisory" was too loose during calibration: a
    // fintech whose CUSTOMERS are advisory firms is not a consultancy,
    // and mislabelling it would bury a legitimate candidate.
    pattern: /\b(?:consulting services|consulting firm|we consult|managed services|done[- ]for[- ]you|white[- ]glove implementation|professional services|our (?:agency|consultancy)|advisory (?:services|practice))\b/i,
  },
  {
    key: 'hype-only',
    label: 'Funding or hype language with no product evidence',
    // Weak evidence of a weak company — marketing copy is a house style
    // as often as it is an absence of substance, so it nudges rather
    // than dominates.
    points: -6,
    pattern: /\b(?:revolutioni[sz]\w+|game[- ]chang\w+|disrupt\w+ the|next[- ]generation platform|world[- ]class|cutting[- ]edge)\b/i,
  },
  {
    key: 'mature-signal',
    label: 'Mature or well-funded beyond the target stage',
    points: -20,
    pattern: /\b(?:series\s+[b-z]\b|\$\d{3,}\s?(?:m|million)|\$\d+(?:\.\d+)?\s?(?:b|bn|billion)|unicorn|IPO|acquired by)\b/i,
  },
  {
    key: 'unverified-claim',
    label: 'Claim stated without a verifiable source',
    points: -6,
    pattern: /\b(?:reportedly|rumou?red|sources say|is said to|allegedly|we understand that)\b/i,
  },
];

/**
 * Is this sentence about a PREVIOUS company rather than this one?
 *
 * Unifold's launch post reads "Before Unifold, we built
 * wallet-as-a-service infrastructure and were acquired by a leading
 * crypto payments company". That is the founders' prior company being
 * acquired — and it was firing the `mature-signal` negative against
 * Unifold, a current W26 batch company, dropping its triage priority by
 * 20 points and pushing it out of the shortlist.
 *
 * Maturity is a statement about THIS company's stage today. A sentence
 * that explicitly frames itself as history cannot establish it.
 */
const PRIOR_COMPANY_CONTEXT = new RegExp(
  // No trailing \b: several alternatives end at a comma ("Before
  // Unifold,"), and a word boundary cannot follow a comma — which made
  // the whole guard silently never match the case it was written for.
  String.raw`\b(?:`
  + String.raw`before\s+[A-Z]\w*\s*,|at my last company|my (?:previous|prior|last|first) (?:company|startup)|`
  + String.raw`previously|prior to (?:founding|starting|this)|in a past life|`
  + String.raw`our (?:first|previous|last) (?:company|startup)|earlier in (?:my|our) career`
  + String.raw`)`,
  'i',
);

/** Registrable-ish host for a URL, lowercased. Bad URLs collapse to ''. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Loose text fingerprint, so a syndicated press release matches itself
 * across outlets.
 *
 * Returns '' for anything SHORT, which switches that claim to
 * host-only deduplication. Identical wording is evidence of copying
 * only when there was enough wording to copy: two independent outlets
 * both printing "based in Austin, TX" is a coincidence of the English
 * language, not one press release counted twice, and collapsing those
 * threw away genuine corroboration during calibration.
 */
const FINGERPRINT_MIN_CHARS = 40;

function claimFingerprint(claim: string): string {
  const normalized = claim.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length >= FINGERPRINT_MIN_CHARS ? normalized.slice(0, 120) : '';
}

/**
 * Count genuinely independent confirmations.
 *
 * Two evidence items are the same confirmation when they share a host OR
 * when their claim text fingerprints match — the second case is what
 * catches one press release republished by six outlets, which would
 * otherwise read as six-way corroboration of a claim nobody verified
 * twice.
 */
export function countIndependentSources(evidence: DiscoveryCandidate['evidence']): number {
  const seenHosts = new Set<string>();
  const seenClaims = new Set<string>();
  let n = 0;
  for (const e of evidence) {
    const h = host(e.url);
    const f = claimFingerprint(e.claim);
    if ((h && seenHosts.has(h)) || (f && seenClaims.has(f))) continue;
    if (h) seenHosts.add(h);
    if (f) seenClaims.add(f);
    n += 1;
  }
  return n;
}

interface Segment {
  text: string;
  url?: string;
  provenance: QualitySignal['provenance'];
  weight: number;
  /** Rules this segment is allowed to fire. Absent = all of them. */
  only?: Set<string>;
}

/**
 * Every piece of text the assessor may read, with how far each is
 * trusted.
 *
 * Ordered so full-confidence published text is considered BEFORE
 * discounted company-claimed text: a rule fires once, and it should fire
 * on the strongest source that supports it.
 */
function textSegments(c: DiscoveryCandidate, ctx: QualityContext = {}): Segment[] {
  const segs: Segment[] = [];
  const pub = (text: string, url?: string) =>
    segs.push({ text, url, provenance: 'published' as const, weight: 1 });

  if (c.pitch !== 'Unknown') pub(c.pitch, c.website !== 'Unknown' ? c.website : undefined);

  /**
   * The subcategory is OUR OWN classification label, and it must not be
   * able to fire an evidence rule.
   *
   * It was being pushed in as `published` text alongside the company's
   * pitch and its cited evidence, so the taxonomy strings this codebase
   * assigns were read back as if a source had published them. Our own
   * subvertical names contain buyer nouns by construction, and
   * `enterprise-buyer` matches bare institution types — so
   * "warehouse and logistics robotics", "Healthcare infrastructure" or
   * a subcategory naming pharmacies fired buyer clarity on nothing but a
   * label we wrote. Because `enterprise-buyer` also counts as a
   * SUBSTANTIVE signal in src/lib/promisingQueue.ts AND suppresses the
   * -8 `no-buyer` penalty, one taxonomy match was enough to clear both
   * the substantive-evidence gate and the quality band — making
   * "Promising" reachable from sector language alone. That is exactly
   * what promisingQueue.ts:200-204 says is impossible ("Sector and
   * geography are excluded by definition").
   *
   * So it is not read as evidence at all. Restricting it to a subset of
   * rules was tempting, but every rule it could plausibly support has the
   * same defect: firing `data-moat` off the label "Genomics & personalized
   * medicine" is the same category error as firing `enterprise-buyer` off
   * "Healthcare infrastructure". The subvertical is still used everywhere
   * it belongs — filters, breakdowns, thesis matching, display — just not
   * as a source that says something about the company.
   */

  if (c.accelerator !== 'Unknown') pub(c.accelerator);
  if (c.publicFunding !== 'Unknown') pub(c.publicFunding);
  if (c.mostRecentRound !== 'Unknown') pub(c.mostRecentRound);
  for (const t of c.tractionSignals) pub(t);
  for (const e of c.evidence) pub(e.claim, e.url);

  /**
   * Founder biographies, CITED ONLY.
   *
   * Restricted to the founder-market-fit rule: a biography is evidence
   * about a person, and letting it fire `commercial-proof` would turn
   * "at my last company I managed $10M+ in payouts" into this company's
   * traction — the exact misattribution the YC parser already guards
   * against upstream. An uncited biography is skipped entirely.
   */
  for (const b of ctx.founderBios ?? []) {
    if (!b.sourceUrl) continue;
    segs.push({
      text: b.text, url: b.sourceUrl,
      provenance: 'company-claimed', weight: COMPANY_CLAIMED_WEIGHT,
      only: new Set(['founder-market-fit']),
    });
  }

  // Pending company-claimed claims: real, cited, discounted, and never
  // treated as independent verification.
  for (const cc of ctx.companyClaimed ?? []) {
    segs.push({
      text: cc.text, url: cc.sourceUrl,
      provenance: 'company-claimed', weight: COMPANY_CLAIMED_WEIGHT,
    });
  }
  return segs;
}

/** Newest publication date across the cited evidence, in ms. Null when nothing is dated. */
function newestPublishedAt(c: DiscoveryCandidate): number | null {
  const dates = c.evidence
    .map((e) => (e.publishedAt ? new Date(e.publishedAt).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  return dates.length > 0 ? Math.max(...dates) : null;
}

/**
 * Neutral anchor. A candidate about which nothing is known scores here —
 * not zero.
 *
 * The first calibration run against live sources made the reason
 * obvious: with the scale starting at zero and clamped there, 36 of 37
 * real candidates tied on 0 and the value could not order anything,
 * which is its entire purpose. Real directory one-liners are short, and
 * most of them legitimately trip the "no identifiable buyer" negative
 * without tripping any positive — so the floor swallowed the whole
 * distribution.
 *
 * Anchoring in the middle means negatives are expressible as movement
 * DOWN from "we know nothing" and positives as movement up, and the two
 * stay comparable. It is also the honest reading: absent evidence is not
 * the worst possible case, it is the unknown case.
 */
const NEUTRAL_ANCHOR = 25;

const BAND_HIGH = 55;
const BAND_MEDIUM = 30;

export function assessQuality(
  c: DiscoveryCandidate,
  now: Date = new Date(),
  ctx: QualityContext = {},
): QualityAssessment {
  const segs = textSegments(c, ctx);
  const signals: QualitySignal[] = [];
  const fired = new Set<string>();

  for (const rule of [...POSITIVE_RULES, ...NEGATIVE_RULES]) {
    for (const seg of segs) {
      if (seg.only && !seg.only.has(rule.key)) continue;
      const m = seg.text.match(rule.pattern);
      if (!m) continue;
      // A maturity claim framed as history is about a PRIOR company and
      // says nothing about this one's stage. See PRIOR_COMPANY_CONTEXT.
      if (rule.key === 'mature-signal' && PRIOR_COMPANY_CONTEXT.test(seg.text)) continue;
      if (fired.has(rule.key)) break; // each signal counts once, however many times it appears
      fired.add(rule.key);
      // A NEGATIVE finding is never discounted for being company-claimed:
      // a company admitting a weakness about itself is the most credible
      // version of that claim there is.
      const weight = rule.points < 0 ? 1 : seg.weight;
      signals.push({
        key: rule.key,
        direction: rule.points >= 0 ? 'positive' : 'negative',
        label: rule.label,
        points: Math.round(rule.points * weight),
        fullPoints: rule.points,
        evidence: m[0].trim().slice(0, 160),
        sourceUrl: seg.url,
        provenance: seg.provenance,
        weight,
      });
      break;
    }
  }

  // ── Recent commercial or product momentum ──────────────────────
  // Dated from the source's own publication date, never from when we
  // happened to fetch it (dateAccessed is our clock, not theirs).
  const newest = newestPublishedAt(c);
  if (newest !== null) {
    const ageDays = (now.getTime() - newest) / 86_400_000;
    if (ageDays <= 180) {
      signals.push({
        key: 'recent-momentum',
        direction: 'positive',
        label: 'Recent product or commercial momentum',
        points: 7, fullPoints: 7, provenance: 'published', weight: 1,
        evidence: `newest cited source published ${Math.max(0, Math.round(ageDays))} day(s) ago`,
      });
    }
  }

  // ── Corroboration ──────────────────────────────────────────────
  const independentSources = countIndependentSources(c.evidence);
  if (independentSources >= 2) {
    signals.push({
      key: 'corroborated',
      direction: 'positive',
      label: 'Independently corroborated',
      points: 6, fullPoints: 6, provenance: 'independent', weight: 1,
      evidence: `${independentSources} independent sources after collapsing syndicated copies`,
    });
  }

  // ── No identifiable customer or buyer ──────────────────────────
  // A genuine absence, and reported as one: it is the single most common
  // reason a candidate cannot be told apart from any other candidate.
  if (!fired.has('named-customers') && !fired.has('enterprise-buyer') && !fired.has('commercial-proof')) {
    signals.push({
      key: 'no-buyer',
      direction: 'negative',
      label: 'No identifiable customer or buyer in the published text',
      points: -8, fullPoints: -8, provenance: 'published', weight: 1,
      evidence: 'no customer, buyer, or commercial-proof language found in any cited source',
    });
  }

  const raw = NEUTRAL_ANCHOR + signals.reduce((s, x) => s + x.points, 0);
  const priority = Math.max(0, Math.min(100, raw));
  const band = priority >= BAND_HIGH ? 'high' : priority >= BAND_MEDIUM ? 'medium' : 'low';

  const pos = signals.filter((s) => s.direction === 'positive');
  const neg = signals.filter((s) => s.direction === 'negative');
  const rationale =
    `Triage priority ${priority}/100 (${band}) — an internal enrichment-ordering value, not the VamosVentures Fit Score. `
    + `${pos.length} positive signal(s)${pos.length > 0 ? `: ${pos.map((s) => `${s.label} (+${s.points}${s.weight < 1 ? ` of ${s.fullPoints}, company-claimed` : ''})`).join(', ')}` : ''}. `
    + `${neg.length} negative signal(s)${neg.length > 0 ? `: ${neg.map((s) => `${s.label} (${s.points})`).join(', ')}` : ''}. `
    + `${independentSources} independent source(s) after collapsing syndicated copies.`;

  return { priority, band, signals, independentSources, rationale };
}
