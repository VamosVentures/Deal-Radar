import type { DiscoveryCandidate, DiscoveryQuery } from '../../shared/discovery';
import { normalizeVerticalId, PREFERRED_STATES } from '../../src/data/taxonomy';
import { checkEntityType } from './classify';

/**
 * Stage 1 of the sourcing funnel: THESIS ELIGIBILITY.
 *
 * A hard, cheap, deterministic gate applied to every candidate BEFORE any
 * expensive enrichment is spent on it. It answers one question — "could
 * this ever be a Vamos deal?" — and nothing else. It does not rank, does
 * not score, and has no connection whatsoever to the Vamos Fit Score
 * (src/lib/scoring.ts). Stage 2 (qualitySignals.ts) does the ranking.
 *
 * The single most important rule here, inherited from the existing
 * pipeline and deliberately preserved: **a candidate is rejected only on
 * positive evidence of ineligibility, never on a gap in what we know.**
 * "Stage unknown" is not "wrong stage"; "location unknown" is not
 * "outside the US". Unknowns fall through to a human, exactly as
 * `matchesQuery` in server/services/discovery.ts already does. This
 * filter exists to remove candidates we can PROVE are out of thesis —
 * the mature company, the consultancy, the fund, the dead startup — not
 * to shrink the funnel by treating ignorance as disqualification.
 *
 * Why this is needed at all: a direct audit of the 172 live companies in
 * the dev database found 70 of the 111 Y Combinator records came from
 * batches S09–W23 (2009–2023). Brex (W17), Deel (W19), Newfront and
 * HealthSherpa (W15) are all in the pipeline as
 * "Early-stage — round not publicly disclosed", scoring 7.3 — the
 * second-highest band in the entire dataset. Nothing rejected them
 * because nothing was looking.
 */

export type ThesisRejectionCode =
  | 'not-operating-company'
  | 'excluded-business-type'
  | 'past-target-stage'
  | 'outside-geography'
  | 'outside-approved-vertical'
  | 'inactive'
  | 'duplicate'
  | 'source-credibility';

export interface ThesisCheck {
  code: ThesisRejectionCode;
  /** What the published text actually said, so the rejection is auditable. */
  evidence: string;
  reason: string;
}

export interface ThesisEligibility {
  eligible: boolean;
  /** Every failed hard requirement, not just the first — a reviewer sees the whole picture. */
  rejections: ThesisCheck[];
  /** Requirements that were checked and passed, for the audit trail. */
  passed: ThesisRejectionCode[];
  /** Requirements that could not be judged because the data is absent. These never reject. */
  undetermined: ThesisRejectionCode[];
}

/**
 * Per-source credibility floor. A source's baseline trustworthiness is a
 * property of the SOURCE, not of any one record from it: an SEC Form D is
 * a legal filing, a YC directory entry is a curated first-party listing,
 * and an arbitrary RSS item is whatever an outlet chose to publish.
 *
 * These are floors on the candidate's own `confidence`, not multipliers —
 * a low-confidence record from a high-credibility source (e.g. a Form D
 * whose issuer name is ambiguous) still fails, which is the intent.
 */
const SOURCE_CREDIBILITY_FLOOR: Record<string, number> = {
  sec: 0.5,
  grants: 0.5,
  yc: 0.5,
  'investor-news': 0.4,
  'funding-news': 0.3,
  github: 0.3,
  research: 0.3,
  producthunt: 0.3,
  upload: 0,
};
const DEFAULT_CREDIBILITY_FLOOR = 0.3;

/**
 * Business models the firm does not invest in, detected from the
 * company's OWN published description. Every pattern here describes a
 * services/labour business — revenue scales with headcount, not with
 * product — which is the specific thing the thesis excludes. A company
 * that merely MENTIONS consulting ("replacing expensive consultants") is
 * not caught, because the pattern requires the company to describe
 * ITSELF that way.
 */
const EXCLUDED_BUSINESS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bwe (?:are|'re) an? (?:agency|consultancy|consulting (?:firm|shop)|dev shop|design studio|staffing)\b/i, label: 'self-described agency/consultancy' },
  { pattern: /\b(?:digital|marketing|creative|branding|recruiting|staffing) agency\b/i, label: 'agency' },
  { pattern: /\b(?:consulting|advisory) (?:services|firm|practice|company)\b/i, label: 'consulting firm' },
  { pattern: /\bbespoke (?:software )?(?:development|engineering) (?:services|for clients)\b/i, label: 'custom development shop' },
  { pattern: /\b(?:staff|team) augmentation\b/i, label: 'staff augmentation' },
  { pattern: /\b(?:outsourc\w+|offshore) (?:development|engineering|team)\b/i, label: 'outsourced development' },
  { pattern: /\bwe build custom (?:software|apps|websites) for\b/i, label: 'custom build shop' },
  { pattern: /\bfreelanc\w+ (?:marketplace|network) for hire\b/i, label: 'freelance labour marketplace' },
];

/**
 * Positive evidence that a company is PAST the stage the firm leads.
 * Deliberately narrow: every pattern below is a fact a source stated, not
 * an inference from company age. A 2015 YC batch is a strong hint but not
 * proof of maturity on its own — that is handled as a quality SIGNAL in
 * stage 2, where it lowers priority rather than rejecting outright.
 */
const MATURE_STAGE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bseries\s+[b-z]\b/i, label: 'Series B or later named' },
  { pattern: /\b(?:IPO|initial public offering|went public|NASDAQ|NYSE)\b/i, label: 'public-market event' },
  { pattern: /\b(?:was )?acquired by\b/i, label: 'acquired' },
  { pattern: /\b(?:decacorn|unicorn)\b/i, label: 'unicorn/decacorn' },
  { pattern: /\bvaluation of \$\s?(\d+(?:\.\d+)?)\s?(?:b|bn|billion)\b/i, label: 'billion-dollar valuation' },
  { pattern: /\bat a \$\s?(\d+(?:\.\d+)?)\s?(?:b|bn|billion)\b/i, label: 'billion-dollar valuation' },
  { pattern: /\braise[sd]?\s+\$\s?(\d{3,})\s?(?:m|mm|million)\b/i, label: 'raise of $100M or more' },
  { pattern: /\braise[sd]?\s+\$\s?(\d+(?:\.\d+)?)\s?(?:b|bn|billion)\b/i, label: 'raise of $1B or more' },
  { pattern: /\bgrowth (?:round|equity)\b/i, label: 'growth round' },
];

/** Sources state this plainly when they state it at all. Never inferred from silence. */
const INACTIVE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?:shut down|shutting down|ceased operations|wound down|is defunct|out of business)\b/i, label: 'stated shutdown' },
  { pattern: /\b(?:chapter 7|chapter 11|bankrupt\w*|liquidat\w+)\b/i, label: 'stated insolvency' },
  { pattern: /\bstatus:\s*inactive\b/i, label: 'source marked inactive' },
];

/** Every text field a source actually published for this candidate, concatenated once. */
function publishedText(c: DiscoveryCandidate): string {
  return [
    c.companyName,
    c.pitch !== 'Unknown' ? c.pitch : '',
    c.subcategory !== 'Unknown' ? c.subcategory : '',
    c.mostRecentRound !== 'Unknown' ? c.mostRecentRound : '',
    c.publicFunding !== 'Unknown' ? c.publicFunding : '',
    ...c.tractionSignals,
    ...c.evidence.map((e) => e.claim),
  ].filter(Boolean).join(' \n ');
}

/**
 * Which states count as in-scope for this run. Mirrors the geography
 * handling in server/services/discovery.ts `matchesQuery` exactly — an
 * explicit state list wins, then the named geography, and 'United
 * States'/'LATAM' impose no state-level restriction at all.
 */
function inScopeStates(q: DiscoveryQuery): string[] | null {
  if (q.states.length > 0) return q.states;
  if (q.geography === 'Preferred states') return [...PREFERRED_STATES];
  return null;
}

export function evaluateThesisEligibility(c: DiscoveryCandidate, q: DiscoveryQuery): ThesisEligibility {
  const rejections: ThesisCheck[] = [];
  const passed: ThesisRejectionCode[] = [];
  const undetermined: ThesisRejectionCode[] = [];
  const text = publishedText(c);

  // ── Operating status: is this even a company? ──────────────────
  const entity = checkEntityType(c.companyName);
  if (!entity.isOperatingCompany) {
    rejections.push({ code: 'not-operating-company', evidence: c.companyName, reason: entity.reason });
  } else {
    passed.push('not-operating-company');
  }

  // ── Excluded business types ────────────────────────────────────
  const excluded = EXCLUDED_BUSINESS_PATTERNS.find((p) => p.pattern.test(text));
  if (excluded) {
    rejections.push({
      code: 'excluded-business-type',
      evidence: text.match(excluded.pattern)?.[0] ?? excluded.label,
      reason: `Describes itself as a ${excluded.label} — a services business whose revenue scales with headcount, which is outside the firm's product-led thesis.`,
    });
  } else if (c.pitch === 'Unknown' && c.evidence.every((e) => e.claim.length < 40)) {
    // Nothing substantive to read. Not a pass and not a rejection.
    undetermined.push('excluded-business-type');
  } else {
    passed.push('excluded-business-type');
  }

  // ── Stage: past the stage the firm leads? ──────────────────────
  const mature = MATURE_STAGE_PATTERNS.find((p) => p.pattern.test(text));
  if (mature) {
    rejections.push({
      code: 'past-target-stage',
      evidence: text.match(mature.pattern)?.[0] ?? mature.label,
      reason: `Source states ${mature.label} — past the pre-seed/seed/Series A range this run targets.`,
    });
  } else if (c.stage === 'Unknown') {
    undetermined.push('past-target-stage');
  } else {
    passed.push('past-target-stage');
  }

  // ── Geography ──────────────────────────────────────────────────
  const states = inScopeStates(q);
  if (!states) {
    passed.push('outside-geography');
  } else if (c.hqState === 'Unknown') {
    undetermined.push('outside-geography');
  } else if (!states.includes(c.hqState)) {
    rejections.push({
      code: 'outside-geography',
      evidence: `${c.hqCity !== 'Unknown' ? `${c.hqCity}, ` : ''}${c.hqState}`,
      reason: `Recorded location is outside the run's geography (${states.join(', ')}).`,
    });
  } else {
    passed.push('outside-geography');
  }

  // ── Approved vertical ──────────────────────────────────────────
  // Only a vertical the source itself asserted is checked here. An
  // 'Unknown' vertical is resolved later by the deterministic classifier
  // at import time (server/services/discovery.ts resolveVertical), which
  // already refuses to guess — pre-rejecting here would discard
  // candidates the classifier can read perfectly well.
  if (c.vertical === 'Unknown') {
    undetermined.push('outside-approved-vertical');
  } else if (normalizeVerticalId(c.vertical) === null) {
    rejections.push({
      code: 'outside-approved-vertical',
      evidence: c.vertical,
      reason: `"${c.vertical}" is not one of the five approved verticals and has no legacy alias onto one.`,
    });
  } else {
    passed.push('outside-approved-vertical');
  }

  // ── Operating status: stated shutdown / insolvency ─────────────
  const dead = INACTIVE_PATTERNS.find((p) => p.pattern.test(text));
  if (dead) {
    rejections.push({
      code: 'inactive',
      evidence: text.match(dead.pattern)?.[0] ?? dead.label,
      reason: `Source states the company is no longer operating (${dead.label}).`,
    });
  } else {
    passed.push('inactive');
  }

  // ── Duplicates ─────────────────────────────────────────────────
  // Only an EXACT duplicate is a hard rejection. A 'likely' match is a
  // fuzzy-name or founder-overlap hit that the existing pipeline
  // deliberately routes to a human rather than auto-merging, and that
  // decision is not this filter's to overturn.
  //
  // 'stale-only' mode is exempt entirely. That mode exists to RE-CHECK
  // companies already on file, so every candidate it produces is
  // supposed to match an existing record — treating that as a duplicate
  // rejection would empty every refresh run, which is exactly what
  // happened the moment this filter was switched on by default.
  if (q.mode === 'stale-only') {
    passed.push('duplicate');
  } else if (c.duplicateStatus === 'exact') {
    rejections.push({
      code: 'duplicate',
      evidence: c.duplicateOfName ?? c.duplicateOfId ?? 'existing record',
      reason: `Exact duplicate of an existing record (${c.duplicateOfName ?? c.duplicateOfId}).`,
    });
  } else {
    passed.push('duplicate');
  }

  // ── Minimum source credibility ─────────────────────────────────
  const floor = SOURCE_CREDIBILITY_FLOOR[c.sourceId] ?? DEFAULT_CREDIBILITY_FLOOR;
  if (c.confidence < floor) {
    rejections.push({
      code: 'source-credibility',
      evidence: `confidence ${c.confidence} from ${c.sourceId}`,
      reason: `Below the ${floor} confidence floor for ${c.sourceId}.`,
    });
  } else {
    passed.push('source-credibility');
  }

  return { eligible: rejections.length === 0, rejections, passed, undetermined };
}
