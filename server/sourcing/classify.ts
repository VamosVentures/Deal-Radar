import type { VerticalId } from '../../src/types';

/**
 * Deterministic sector classification.
 *
 * Two jobs, both of which must happen BEFORE any AI call so that money
 * is never spent researching an obviously irrelevant company:
 *
 *  1. Assign a primary sector from the candidate's own text.
 *  2. Say honestly when the text does not support any assignment, so
 *     the candidate stays 'Unknown' for a human rather than being
 *     forced into a bucket.
 *
 * This is keyword scoring, not inference. It reads only what the source
 * actually published (company name, pitch, subcategory, evidence text).
 * It never guesses from a founder's name, a location, or a domain
 * suffix. A candidate with no matching signal returns null — an honest
 * "don't know" is always preferred to a confident wrong answer, because
 * a wrong sector silently corrupts the per-sector shortlist.
 */

interface SectorRule {
  id: VerticalId;
  /** Strong signals — a single hit is enough to be decisive. */
  strong: RegExp[];
  /** Supporting signals — need corroboration to matter. */
  weak: RegExp[];
}

const RULES: SectorRule[] = [
  {
    id: 'robotics',
    strong: [/\brobot(ic|ics|s)?\b/i, /\bhumanoid\b/i, /\bcobot\b/i, /\bautonomous\s+(vehicle|mobile\s+robot|drone)/i, /\bwarehouse\s+automation\b/i, /\bteleoperat/i],
    weak: [/\bactuator/i, /\bmanipulat(or|ion)\b/i, /\bgripper/i, /\bdrone\b/i, /\bLiDAR\b/i, /\bmotion\s+planning\b/i, /\bfleet\s+of\s+machines\b/i],
  },
  {
    id: 'spacetech',
    strong: [
      /\bspace\s?(tech|craft|flight)\b/i, /\bsatellite/i, /\borbit(al)?\b/i, /\blaunch\s+vehicle\b/i,
      /\bearth\s+observation\b/i, /\bin-?space\b/i, /\bconstellation\s+of\s+satellites\b/i,
      // Product nouns, not the word "space". A rocket engine, a
      // spaceport, or a re-entry vehicle IS the space industry; a company
      // that merely says "aerospace" is not.
      /\brocket\s+(?:engine|motor|propulsion|stage)\b/i, /\brockets?\b/i, /\bhypersonic\b/i,
      /\bspaceport\b/i, /\blunar\b/i, /\bre-?entry\s+vehicle\b/i, /\bspace\s+station\b/i,
      /\bdeep\s+space\b/i,
    ],
    weak: [/\baerospace\b/i, /\bgeospatial\b/i, /\bremote\s+sensing\b/i, /\bground\s+station\b/i, /\bpayload\b/i, /\bLEO\b/, /\bpropulsion\b/i],
  },
  {
    id: 'health',
    strong: [/\bhealth(care)?\b/i, /\bclinic(al|s)?\b/i, /\bpatient/i, /\bmedical\b/i, /\bdiagnos(is|tic)/i, /\btherapeutic/i, /\boncolog/i, /\bmental\s+health\b/i, /\bgenomic/i, /\bbiotech/i, /\bEHR\b/, /\btelehealth\b/i],
    weak: [/\bwellness\b/i, /\bcare\s+(team|coordination|delivery)\b/i, /\bprovider(s)?\b/i, /\bpharma/i, /\bnurse/i, /\blongevity\b/i],
  },
  {
    id: 'fintech',
    strong: [/\bfintech\b/i, /\bpayment(s)?\b/i, /\bbanking\b/i, /\blending\b/i, /\bcredit\s+(card|union|score)\b/i, /\binsur(ance|tech)\b/i, /\bwealth\s+management\b/i, /\bpayroll\b/i, /\bunderwrit/i, /\bremittance/i],
    weak: [/\bfinanc(e|ial)\b/i, /\btreasury\b/i, /\bledger\b/i, /\bcompliance\b/i, /\bKYC\b/, /\binvest(ing|ment)\b/i, /\bcapital\s+markets\b/i],
  },
  {
    id: 'sustainability',
    strong: [/\bdecarboniz/i, /\bclimate\s?(tech)?\b/i, /\brenewable/i, /\bsolar\b/i, /\bwind\s+(power|farm|energy)\b/i, /\bgeothermal\b/i, /\bhydrogen\b/i, /\bcarbon\s+(capture|credit|removal)\b/i, /\bgrid\b/i, /\bEV\s+charging\b/i],
    weak: [/\benergy\b/i, /\bemission/i, /\bsustainab/i, /\bbattery\b/i, /\brecycl/i, /\bnuclear\b/i],
  },
  {
    id: 'fow',
    strong: [
      /\bfuture\s+of\s+work\b/i, /\bcopilot\b/i, /\bworkflow\s+automation\b/i, /\bhiring\b/i, /\brecruit/i,
      /\bHR\s+(tech|platform|software)\b/i, /\bfrontline\s+worker/i, /\bemployee\s+(experience|engagement|onboarding)\b/i,
      /\bproductivity\s+(tool|platform)\b/i,
      // Named products rather than category language.
      /\bapplicant\s+tracking\b/i, /\bworkforce\s+management\b/i, /\bshift\s+(?:scheduling|swap|management)\b/i,
      /\bupskill/i, /\breskill/i, /\bperformance\s+(?:review|management)\s+(?:software|platform|tool)\b/i,
      /\btalent\s+(?:marketplace|acquisition|platform)\b/i, /\bstaffing\s+(?:platform|marketplace|agency\s+software)\b/i,
      /\blearning\s+management\b/i, /\bdeskless\s+worker/i, /\bwage\s+access\b/i, /\btime\s+(?:and\s+attendance|tracking\s+software)\b/i,
    ],
    weak: [/\bcollaborat/i, /\bteam(s)?\s+(tool|platform)\b/i, /\bknowledge\s+(base|work)\b/i, /\bscheduling\b/i, /\bfreelanc/i, /\bcontractor/i, /\bonboarding\b/i, /\bemployer\b/i],
  },
  {
    id: 'ai',
    strong: [
      /\bfoundation\s+model/i, /\bLLM(s)?\b/, /\blarge\s+language\s+model/i,
      /\binference\s+(engine|infrastructure|serving)\b/i, /\bvector\s+(database|search)\b/i,
      /\bfine-?tun/i, /\bRAG\b/, /\bAI\s+(infrastructure|tooling|observability|evaluation|safety)\b/i,
      /\bMLOps\b/i, /\bmachine\s+learning\s+(platform|infrastructure)\b/i,
      // The product IS a model or an agent runtime.
      /\b(?:voice|speech|video|image|world|code|coding)\s+model(s)?\b/i,
      /\bAI\s+(?:voice|video|image|coding|agent)\s+(?:model|platform|assistant|tool)/i,
      /\bagentic\s+(?:infrastructure|runtime|platform)\b/i, /\bmodel\s+(?:serving|weights|training)\b/i,
      /\bAI-generated\s+content\s+detection\b/i, /\bAI\s+coding\s+(?:assistant|agent|tool)\b/i,
    ],
    weak: [/\bAI\b/, /\bartificial\s+intelligence\b/i, /\bneural\s+net/i, /\bmodel\s+training\b/i, /\bGPU\b/, /\bagent(ic|s)?\b/i, /\bdeep\s+learning\b/i],
  },
];

/**
 * Entity-type exclusions.
 *
 * The public sources return real records that are not operating
 * companies, and importing one as a "deal" is a data-integrity failure
 * even though the record itself is genuine. Two big offenders, both
 * found by a real dry run rather than theorised:
 *
 *  - SEC Form D is filed by INVESTMENT FUNDS as well as startups, so a
 *    "fintech" search returns things like "Tribe Capital Fintech Fund I,
 *    L.P." and an "AI infrastructure" search returns
 *    "Andreessen Horowitz Fund X-B - AI Infrastructure, L.P.".
 *  - arXiv's affiliation field is usually a UNIVERSITY DEPARTMENT, so a
 *    "climate tech" search returns "School of Management, Foshan
 *    University" as though it were a company.
 *
 * These are rejected on the published name alone — no inference, no
 * guessing. A borderline name is kept, because a human reviewing one
 * extra candidate is cheaper than silently dropping a real company.
 */
const NON_COMPANY_PATTERNS: { pattern: RegExp; kind: string }[] = [
  // Pooled investment vehicles.
  { pattern: /\bfund\s+(?:[IVXL]+|\d+)\b/i, kind: 'investment fund' },
  { pattern: /\b(?:fund|partners)\s*,?\s*(?:L\.?P\.?|LLC)\b/i, kind: 'investment fund' },
  { pattern: /\ba\s+series\s+of\b/i, kind: 'series LLC / fund vehicle' },
  { pattern: /\b(?:SICAV|RAIF|SCSp|SPV|feeder\s+fund|offshore\s+fund|growth\s+fund|credit\s+fund|venture[s]?\s+fund|capital\s+fund)\b/i, kind: 'investment fund' },
  { pattern: /\bfund\b.*\b(?:L\.?P\.?|LLC|Ltd)\b/i, kind: 'investment fund' },
  { pattern: /\b(?:co-?invest|feeder|master\s+fund|parallel\s+fund)\b/i, kind: 'investment vehicle' },
  // A bare "LP" / "L.P." / "Limited Partnership" suffix is a partnership
  // vehicle. LLC is deliberately NOT treated this way — plenty of real
  // operating startups are LLCs, but almost none are LPs.
  { pattern: /,?\s*(?:L\.?P\.?|Limited\s+Partnership)\s*$/i, kind: 'limited partnership' },

  // Academic and research institutions.
  { pattern: /\b(?:universit|college)\w*\b/i, kind: 'university' },
  { pattern: /\b(?:school|department|faculty|institute|laborator|centre|center)\s+(?:of|for)\b/i, kind: 'academic department' },
  { pattern: /\b(?:academy|polytechnic|CNRS|INRIA|Max\s+Planck)\b/i, kind: 'research institution' },

  // Government and non-operating entities.
  { pattern: /\b(?:ministry|department\s+of\s+(?:energy|defense|defence)|national\s+laborator)\b/i, kind: 'government body' },
];

// ── Possessive person names ───────────────────────────────────────

/**
 * "Travis Kalanick's robotics company" attributes a company to a PERSON
 * instead of naming it. The record is real — the article exists, the
 * round happened — but the string is a description, and no amount of
 * corroboration can turn it into a company name.
 *
 * This lives here, next to the other entity-type rules, so extraction
 * and qualification share ONE detector. They previously did not: the RSS
 * extractor caught this at import time and the qualifier could not, so
 * every full requalification pass overwrote the specific finding with a
 * generic "insufficient evidence" and the reason had to be rediscovered
 * by a human each time.
 *
 * Straight and curly apostrophes both count. Publishers use ’ and
 * databases use ', and a rule that sees only one of them is a rule that
 * works on Tuesdays.
 */
const POSSESSIVE = /([’'])s(\s+)/;

/**
 * Category nouns that make the text after a possessive a DESCRIPTION of
 * a company rather than the rest of its name. "…'s robotics company" is
 * a description; "…'s Original" is a brand.
 */
const POSSESSIVE_DESCRIPTOR_NOUN = /\b(?:company|companies|startup|startups|firm|business|venture|outfit|app|platform|lab|labs|studio|project|effort|spinout|spin-?off|unicorn|maker|shop)\b\.?$/i;

export type PossessiveVerdict =
  | { kind: 'none' }
  /** A possessive whose remainder describes rather than names: confident. */
  | { kind: 'possessive-descriptor'; owner: string; descriptor: string }
  /** A possessive with a proper-noun remainder: "McDonald's Corporation". */
  | { kind: 'possessive'; owner: string; descriptor: string };

/**
 * Classify a possessive in a name, without deciding what to do about it.
 *
 * The two callers need different thresholds and both are right:
 *
 *  - A HEADLINE SUBJECT containing any possessive never names the
 *    company — "Kalshi's rival raises…" is about the rival, whoever it
 *    is. `server/sourcing/fundingEvent.ts` rejects on either kind.
 *  - A STORED LEGAL NAME is different, because plenty of real companies
 *    own an apostrophe: McDonald's Corporation, Lowe's Companies, Ben's
 *    Original, Trader Joe's. Only `possessive-descriptor` is a finding
 *    there.
 *
 * Keeping the pattern in one place and the thresholds at the call sites
 * is what stops the two from drifting apart again.
 */
export function classifyPossessiveName(companyName: string): PossessiveVerdict {
  const name = (companyName ?? '').trim();
  const m = name.match(POSSESSIVE);
  if (!m || m.index === undefined) return { kind: 'none' };

  const owner = name.slice(0, m.index).trim();
  const descriptor = name.slice(m.index + m[0].length).trim();
  if (owner.length === 0 || descriptor.length === 0) return { kind: 'none' };

  // A lowercase remainder is prose — a name would be capitalised. A
  // remainder ending in a category noun is a description even when it
  // starts with a capital, which is what "Elon Musk's AI startup" is.
  const startsLowercase = /^\p{Ll}/u.test(descriptor);
  if (startsLowercase || POSSESSIVE_DESCRIPTOR_NOUN.test(descriptor)) {
    return { kind: 'possessive-descriptor', owner, descriptor };
  }
  return { kind: 'possessive', owner, descriptor };
}

export interface EntityCheck {
  isOperatingCompany: boolean;
  /** Why it was rejected, for the run report. Empty when accepted. */
  reason: string;
  /**
   * Machine-readable finding, so a caller can act on WHICH problem this
   * is rather than parsing the sentence. Absent when accepted.
   */
  kind?: 'no-name' | 'person-possessive' | (string & {});
}

/**
 * Is this name plausibly an operating company rather than a fund,
 * university, government body, or a description of someone's company?
 * Name-only, deterministic, no network.
 */
export function checkEntityType(companyName: string): EntityCheck {
  const name = (companyName ?? '').trim();
  if (name.length === 0) return { isOperatingCompany: false, reason: 'No company name.', kind: 'no-name' };

  const possessive = classifyPossessiveName(name);
  if (possessive.kind === 'possessive-descriptor') {
    return {
      isOperatingCompany: false,
      kind: 'person-possessive',
      reason: `Not a company name — it attributes a company to "${possessive.owner}" and then describes it ("${possessive.descriptor}") instead of naming it.`,
    };
  }

  for (const { pattern, kind } of NON_COMPANY_PATTERNS) {
    const m = name.match(pattern);
    if (m) {
      return {
        isOperatingCompany: false,
        kind,
        reason: `Looks like a ${kind}, not an operating company ("${m[0].trim()}").`,
      };
    }
  }
  return { isOperatingCompany: true, reason: '' };
}

export interface Classification {
  /** null means "the text does not support a sector" — never a guess. */
  vertical: VerticalId | null;
  /** 0–1. How clearly the text pointed at this sector. */
  confidence: number;
  /** The exact phrases that drove the decision, for the audit trail. */
  matched: string[];
  /** Other sectors that also scored, so ambiguity stays visible. */
  runnersUp: { vertical: VerticalId; score: number }[];
}

const STRONG_WEIGHT = 3;
const WEAK_WEIGHT = 1;

/**
 * Classify from whatever text the source actually gave us. Pass the
 * fields separately rather than pre-joined so a future change can weight
 * them differently (a name match is stronger evidence than a passing
 * mention in an abstract).
 */
export function classifyCandidate(input: {
  companyName?: string;
  pitch?: string;
  subcategory?: string;
  evidenceText?: string;
}): Classification {
  const haystack = [input.companyName, input.pitch, input.subcategory, input.evidenceText]
    .filter(Boolean).join(' \n ');

  if (haystack.trim().length === 0) {
    return { vertical: null, confidence: 0, matched: [], runnersUp: [] };
  }

  const scored = RULES.map((rule) => {
    const matched: string[] = [];
    let score = 0;
    for (const p of rule.strong) {
      const m = haystack.match(p);
      if (m) { score += STRONG_WEIGHT; matched.push(m[0].trim()); }
    }
    for (const p of rule.weak) {
      const m = haystack.match(p);
      if (m) { score += WEAK_WEIGHT; matched.push(m[0].trim()); }
    }
    return { vertical: rule.id, score, matched };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { vertical: null, confidence: 0, matched: [], runnersUp: [] };
  }

  const top = scored[0];
  const second = scored[1];

  // A single weak hit is not evidence of anything — plenty of companies
  // mention "energy" or "AI" in passing.
  if (top.score < STRONG_WEIGHT) {
    return {
      vertical: null,
      confidence: 0,
      matched: top.matched,
      runnersUp: scored.map((s) => ({ vertical: s.vertical, score: s.score })),
    };
  }

  // Confidence reflects both absolute strength and how clearly the top
  // sector beat the runner-up. Two sectors tied at the same score is a
  // genuinely ambiguous company, and the number should say so.
  const separation = second ? (top.score - second.score) / top.score : 1;
  const strength = Math.min(1, top.score / (STRONG_WEIGHT * 2));
  const confidence = Math.round((0.5 * strength + 0.5 * separation) * 100) / 100;

  return {
    vertical: top.vertical,
    confidence,
    matched: [...new Set(top.matched)],
    runnersUp: scored.slice(1, 4).map((s) => ({ vertical: s.vertical, score: s.score })),
  };
}

/**
 * Does this candidate belong in the shortlist for `target`?
 *
 * Used as the pre-AI gate: a candidate that fails this is never
 * researched, so no money is spent on it. Deliberately strict — for a
 * per-sector shortlist, a false positive (wrong company in the sector)
 * is worse than a false negative (we simply find another candidate).
 */
export function matchesSector(
  input: Parameters<typeof classifyCandidate>[0],
  target: VerticalId,
  minConfidence = 0.5,
): { ok: boolean; classification: Classification; reason: string } {
  const c = classifyCandidate(input);

  // Entity type is checked FIRST: a fund named "…Robotics Fund II, L.P."
  // will classify as robotics perfectly well, and would sail through
  // every other check.
  const entity = checkEntityType(input.companyName ?? '');
  if (!entity.isOperatingCompany) {
    return { ok: false, classification: c, reason: entity.reason };
  }

  if (c.vertical === null) {
    return { ok: false, classification: c, reason: 'No sector signal in the published text.' };
  }
  if (c.vertical !== target) {
    return { ok: false, classification: c, reason: `Classified as ${c.vertical}, not ${target}.` };
  }
  if (c.confidence < minConfidence) {
    return { ok: false, classification: c, reason: `Sector signal too weak (${c.confidence} < ${minConfidence}).` };
  }
  return { ok: true, classification: c, reason: `Matched ${target} on: ${c.matched.slice(0, 4).join(', ')}.` };
}

// ── Structured source taxonomies ──────────────────────────────────

/**
 * Y Combinator publishes `industries` and `tags` per company. That is
 * real structured evidence and it beats keyword-guessing at the
 * company's name, so it is consulted first.
 *
 * Weighted, because YC tags overlap: "Spaceium Inc" carries
 * ['Hard Tech', 'Robotics', 'Space Exploration', 'Aerospace'] and is a
 * space company that happens to build robots. Specific space/robotics
 * terms therefore outscore the generic ones.
 */
const YC_TAXONOMY: { pattern: RegExp; vertical: VerticalId; weight: number }[] = [
  // Space — deliberately heavy, since space companies frequently also
  // tag Robotics/Hard Tech and would otherwise be misfiled.
  { pattern: /^(?:aviation and space|space exploration|commercial space launch|satellite|aerospace)$/i, vertical: 'spacetech', weight: 5 },
  { pattern: /\b(?:space|orbital|satellite|launch)\b/i, vertical: 'spacetech', weight: 3 },

  { pattern: /^(?:robotics|drones|autonomous vehicles?)$/i, vertical: 'robotics', weight: 4 },
  { pattern: /\brobot/i, vertical: 'robotics', weight: 3 },

  { pattern: /^(?:healthcare|health tech|healthcare it|diagnostics|therapeutics|medical devices?|digital health|bio|biotech|consumer health services|drug discovery|healthcare services)$/i, vertical: 'health', weight: 5 },
  { pattern: /\b(?:health|medical|clinical|patient|bio)\b/i, vertical: 'health', weight: 2 },

  { pattern: /^(?:fintech|payments|banking as a service|insurance|lending|credit|asset management|consumer finance|financial services)$/i, vertical: 'fintech', weight: 5 },
  { pattern: /\b(?:fintech|payment|banking|lending|insurance)\b/i, vertical: 'fintech', weight: 2 },

  { pattern: /^(?:climate|energy|sustainability|solar|carbon removal|climate tech|renewable energy)$/i, vertical: 'sustainability', weight: 5 },
  { pattern: /\b(?:climate|carbon|renewable|solar|decarboniz)\b/i, vertical: 'sustainability', weight: 2 },

  { pattern: /^(?:recruiting|recruiting and talent|hr tech|human resources|productivity|collaboration|future of work|workflow automation|hiring)$/i, vertical: 'fow', weight: 5 },
  { pattern: /\b(?:recruit|hiring|hr\b|workforce|productivity|collaboration)\b/i, vertical: 'fow', weight: 2 },

  // General AI is last and needs a SPECIFIC tag: almost every YC company
  // now tags "AI", so a bare AI tag is not evidence of an AI-infrastructure
  // company. Only infra/tooling-shaped tags count.
  { pattern: /^(?:ai\/ml|machine learning|generative ai|ai infrastructure|mlops|infrastructure|developer tools)$/i, vertical: 'ai', weight: 4 },
  { pattern: /\b(?:llm|foundation model|inference|vector database)\b/i, vertical: 'ai', weight: 4 },
];

export interface TaxonomyMatch {
  vertical: VerticalId | null;
  confidence: number;
  matched: string[];
}

/**
 * Map a source's own category labels onto a sector. Returns null when
 * the labels do not clearly indicate one — the caller then falls back
 * to text classification, and failing that, refuses.
 */
export function classifyFromTaxonomy(labels: string[]): TaxonomyMatch {
  const clean = labels.map((l) => (l ?? '').trim()).filter(Boolean);
  if (clean.length === 0) return { vertical: null, confidence: 0, matched: [] };

  const totals = new Map<VerticalId, { score: number; matched: string[] }>();
  for (const label of clean) {
    for (const rule of YC_TAXONOMY) {
      if (rule.pattern.test(label)) {
        const cur = totals.get(rule.vertical) ?? { score: 0, matched: [] };
        cur.score += rule.weight;
        cur.matched.push(label);
        totals.set(rule.vertical, cur);
        break; // one rule per label — the most specific pattern listed first wins
      }
    }
  }
  if (totals.size === 0) return { vertical: null, confidence: 0, matched: [] };

  const ranked = [...totals.entries()].sort((a, b) => b[1].score - a[1].score);
  const [vertical, top] = ranked[0];
  const second = ranked[1]?.[1].score ?? 0;
  const separation = top.score > 0 ? (top.score - second) / top.score : 0;
  const confidence = Math.round(Math.min(1, (top.score / 5) * 0.6 + separation * 0.4) * 100) / 100;

  return { vertical, confidence, matched: [...new Set(top.matched)] };
}

// ── Name ambiguity ────────────────────────────────────────────────

/**
 * Common English words used as company names.
 *
 * These matter for exactly one decision: whether a domain derived from
 * the name can be treated as evidence of identity. It cannot. A real run
 * "confirmed" natural.com for a company called Natural and enigma.com
 * for Enigma, because a page that contains the word "natural" tells you
 * nothing — the word is everywhere. For a distinctive name like
 * "Greyparrot" the same check IS meaningful, which is why this is a word
 * list and not a word count. An earlier version required two words or a
 * twelve-character stem, and that rule threw away every genuine
 * single-word company along with the ambiguous ones.
 *
 * Curated and auditable rather than inferred. A name absent from this
 * list is still verified by finding it on the page before it is trusted.
 */
const AMBIGUOUS_NAME_WORDS = new Set([
  'natural', 'cascade', 'enigma', 'infinity', 'origin', 'apex', 'nova', 'atlas', 'vertex',
  'summit', 'beacon', 'prism', 'catalyst', 'momentum', 'pulse', 'forge', 'anchor', 'compass',
  'horizon', 'lattice', 'helix', 'nexus', 'cipher', 'aurora', 'multiverse', 'ramp', 'spur',
  'cadence', 'harbor', 'harbour', 'haven', 'lighthouse', 'foundry', 'kernel', 'vector',
  'matrix', 'quantum', 'fusion', 'orbit', 'current', 'spark', 'ember', 'ridge', 'valley',
  'mesa', 'delta', 'alpha', 'omega', 'zenith', 'pinnacle', 'keystone', 'bedrock', 'slate',
  'onyx', 'quartz', 'cobalt', 'indigo', 'antares', 'sierra', 'tide', 'wave', 'surge', 'drift',
  'stride', 'pace', 'tempo', 'rhythm', 'chord', 'echo', 'signal', 'relay', 'conduit',
  'circuit', 'node', 'mesh', 'weave', 'thread', 'fabric', 'canvas', 'palette', 'chapter',
  'ledger', 'tally', 'bridge', 'gateway', 'portal', 'summit', 'crest', 'bloom', 'sprout',
  'harvest', 'meridian', 'axiom', 'theorem', 'quotient', 'tangent', 'radius', 'quorum',
  'cohort', 'legacy', 'heritage', 'frontier', 'expanse', 'terrain', 'basalt', 'granite',
  'obsidian', 'lumen', 'candela', 'photon', 'proton', 'neutron', 'axis', 'pivot', 'fulcrum',
  'lever', 'ratchet', 'cogent', 'lucid', 'candid', 'earnest', 'prosper', 'thrive', 'flourish',
]);

/**
 * Is this name too common a word for a matching domain to prove identity?
 *
 * Only single-word names can be ambiguous this way: two distinctive words
 * together ("Bluecore Energy", "Pine Park Health") are already specific
 * enough that a domain collision is unlikely.
 */
export function isAmbiguousCompanyName(name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return false;
  return AMBIGUOUS_NAME_WORDS.has(words[0].toLowerCase().replace(/[^a-z]/g, ''));
}
