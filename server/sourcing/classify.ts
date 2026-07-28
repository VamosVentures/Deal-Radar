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
    strong: [/\bspace\s?(tech|craft|flight)\b/i, /\bsatellite/i, /\borbit(al)?\b/i, /\blaunch\s+vehicle\b/i, /\bearth\s+observation\b/i, /\bin-?space\b/i, /\bconstellation\s+of\s+satellites\b/i],
    weak: [/\baerospace\b/i, /\bgeospatial\b/i, /\bremote\s+sensing\b/i, /\bground\s+station\b/i, /\bpayload\b/i, /\bLEO\b/],
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
    strong: [/\bfuture\s+of\s+work\b/i, /\bcopilot\b/i, /\bworkflow\s+automation\b/i, /\bhiring\b/i, /\brecruit/i, /\bHR\s+(tech|platform)\b/i, /\bfrontline\s+worker/i, /\bemployee\s+(experience|engagement)\b/i, /\bproductivity\s+(tool|platform)\b/i],
    weak: [/\bcollaborat/i, /\bteam(s)?\s+(tool|platform)\b/i, /\bknowledge\s+(base|work)\b/i, /\bscheduling\b/i, /\bfreelanc/i, /\bcontractor/i],
  },
  {
    id: 'ai',
    strong: [/\bfoundation\s+model/i, /\bLLM(s)?\b/, /\blarge\s+language\s+model/i, /\binference\s+(engine|infrastructure|serving)\b/i, /\bvector\s+(database|search)\b/i, /\bfine-?tun/i, /\bRAG\b/, /\bAI\s+(infrastructure|tooling|observability|evaluation|safety)\b/i, /\bMLOps\b/i, /\bmachine\s+learning\s+(platform|infrastructure)\b/i],
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

export interface EntityCheck {
  isOperatingCompany: boolean;
  /** Why it was rejected, for the run report. Empty when accepted. */
  reason: string;
}

/**
 * Is this name plausibly an operating company rather than a fund,
 * university, or government body? Name-only, deterministic.
 */
export function checkEntityType(companyName: string): EntityCheck {
  const name = (companyName ?? '').trim();
  if (name.length === 0) return { isOperatingCompany: false, reason: 'No company name.' };

  for (const { pattern, kind } of NON_COMPANY_PATTERNS) {
    const m = name.match(pattern);
    if (m) {
      return {
        isOperatingCompany: false,
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
