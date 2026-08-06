import type { Company, FitScore } from '../types';
import { NON_PROVISIONAL_POLICY } from './scoring';
import { TRACK_THRESHOLD } from '../../shared/scoringThresholds';

/**
 * "Promising — Needs Diligence".
 *
 * The problem this solves. The v4.1 provisional policy is correct and it
 * has an obvious side effect: a genuinely excellent pre-seed company
 * with a quiet public footprint looks exactly like a weak one. Both are
 * provisional, both sort below assessed records, and both drift down the
 * table until nobody looks at them again. The companies most likely to
 * be mispriced by the market are precisely the ones with the least
 * public evidence, so "sparse evidence" must not become "invisible".
 *
 * This queue is the counterweight: it surfaces records that look worth
 * researching AND are missing something that could materially change
 * their score. It is a WORK LIST, not a ranking, and it deliberately
 * has no authority of its own —
 *
 *   - it never changes a score, a weight, or a threshold;
 *   - it never marks anything High-Fit (every member is provisional by
 *     definition, and provisional records are excluded from High-Fit by
 *     the scorer, not by this file);
 *   - it adds no Overview KPI card. The ten approved cards are
 *     untouched; this lives inside the existing All Deals workflow as a
 *     filter.
 *
 * There is no lowered threshold anywhere here. `TRACK_THRESHOLD` (6.5)
 * is reused as the "already looks interesting" signal because it is the
 * firm's existing boundary for a company worth tracking — but a
 * company can also qualify on quality-priority signals alone, which is
 * how a strong company with a thin preliminary score still surfaces.
 */

/** Quality-priority band, as computed by server/sourcing/qualitySignals.ts. */
export type QualityBand = 'high' | 'medium' | 'low';

export interface PromisingInput {
  company: Company;
  fit: FitScore;
  /** From the discovery candidate this company came from, when known. */
  qualityBand?: QualityBand | null;
  qualityPriority?: number | null;
  /** The stage-2 signals, so "substantive" can be judged rather than assumed. */
  qualitySignals?: { key: string; direction: 'positive' | 'negative'; label: string; evidence: string }[];
  /** Review status from company meta — terminal statuses are excluded. */
  reviewStatus?: string;
  /** True when a human has confirmed this is a duplicate of another record. */
  confirmedDuplicate?: boolean;
  /** Quarantined or otherwise not an operating company. */
  inactive?: boolean;
  /** Failed the stage-1 thesis filter, when that verdict is on record. */
  thesisEligible?: boolean | null;
  /** Injectable clock, so batch-age tests are reproducible. */
  today?: Date;
}

export interface PromisingVerdict {
  /** Broad queue: provisional, in-thesis, and still researchable. */
  needsDiligence: boolean;
  /** Narrow queue: needsDiligence AND genuinely promising. */
  eligible: boolean;
  /** The substantive signals that got it into the narrow queue. */
  substantiveSignals: string[];
  /** Why it is in the queue — shown in the row. */
  reasons: string[];
  /** Why it is NOT, when it is not. */
  exclusions: string[];
  /** Critical components that could still move the score, in policy order. */
  missingCritical: string[];
  /** The single most useful next action, derived from what is missing. */
  nextAction: string;
  /** The largest thing that could sink it, derived from the record. */
  primaryRisk: string;
}

/** Statuses that mean the company has left the funnel. */
const TERMINAL_STATUSES = ['Synced to HubSpot', 'Passed', 'Dismissed'];

const COMPONENT_LABELS: Record<string, string> = {
  thesis: 'Thesis / vertical fit',
  stage: 'Stage',
  traction: 'Traction',
  founder: 'Founder & team',
  geo: 'Geography',
};

/**
 * The next diligence action for a missing component. Ordered by which
 * gap is worth closing first: traction and founders are the two the
 * whole corpus is missing, and they are also the two that need a human.
 */
const NEXT_ACTION: Record<string, string> = {
  traction: 'Run an analyst traction review — record what is (or is not) publicly disclosed, with a source.',
  founder: 'Run founder research against the company site, accelerator profile and any filing on record.',
  stage: 'Establish the round from a filing, the accelerator profile, or a funding announcement.',
  geo: 'Confirm the headquarters from the company site or a filing — a city with no state does not score.',
  thesis: 'Classify the subvertical from the company’s own product description.',
};


/**
 * How old an accelerator batch may be for a company to count as
 * PROMISING, in years.
 *
 * A manual inspection of the first top-20 found two clear false
 * positives — Tara AI (YC W15) and Checkr (YC S14) — both a decade past
 * the stage this firm leads, both sitting in the pipeline as
 * "Early-stage — round not publicly disclosed" because no public source
 * states a round for them. The discovery adapter already refuses to
 * ingest stale batches; stored records predate that gate, so the same
 * rule is applied here rather than left to catch them one at a time.
 *
 * This filters the SHORTLIST only. Those records stay in Needs
 * Diligence, keep their score, and are never deleted — a mature company
 * is a real finding, just not a promising early-stage lead.
 */
const MAX_BATCH_AGE_YEARS = 3;

/**
 * "Y Combinator (W15)" → 2015. Reuses the same two-digit batch
 * convention as server/sourcing/adapters/ycombinator.ts; anything
 * unparseable returns null and is KEPT, because an unreadable batch is a
 * gap in the record and not evidence of age.
 */
export function acceleratorBatchYear(accelerator: string | null | undefined): number | null {
  if (!accelerator) return null;
  const m = accelerator.match(/\b(?:W|S|F|Sp|X)(\d{2})\b/i);
  return m ? 2000 + Number(m[1]) : null;
}

export function assessPromising(input: PromisingInput): PromisingVerdict {
  const { company, fit } = input;
  const reasons: string[] = [];
  const exclusions: string[] = [];

  const byKey = new Map(fit.components.map((c) => [c.key, c]));
  const missingCritical = NON_PROVISIONAL_POLICY.requiredComponents
    .filter((k) => !byKey.get(k)?.assessable)
    .map((k) => k as string);

  // ── Hard exclusions ────────────────────────────────────────────
  if (input.thesisEligible === false) exclusions.push('Failed the thesis filter.');
  /**
   * A policy EXCEPTION is a partner decision, not an analyst one.
   *
   * Agon carries `outside-thesis` (migration 17: its own evidence says
   * "European defence AI infrastructure" — outside the US geography
   * requirement, and defence is not an approved vertical). It was
   * appearing on the promising shortlist, which would have sent an
   * analyst to do diligence on a company whose eligibility has not been
   * settled. Same for the DeFi and hardware-heavy exceptions.
   *
   * These are NOT rejections — the record stays in Needs Diligence with
   * its score intact, exactly as the scoring model requires ("flags
   * never auto-reject"). They simply do not belong in a prioritised
   * research queue until a partner has ruled.
   */
  if (company.flags.length > 0) {
    exclusions.push(
      `Carries a policy exception (${company.flags.join(', ')}) — needs a partner ruling before analyst diligence.`,
    );
  }
  if (input.inactive) exclusions.push('Not an active operating record (quarantined or inactive).');
  if (input.confirmedDuplicate) exclusions.push('Confirmed duplicate of another record.');
  if (input.reviewStatus && TERMINAL_STATUSES.includes(input.reviewStatus)) {
    exclusions.push(`Terminal review status (${input.reviewStatus}).`);
  }
  if (!fit.provisional) {
    // A fully assessed record does not need this queue — it is already
    // comparable and ranks on its own merits.
    exclusions.push('Score is fully assessed, so it ranks normally rather than needing diligence.');
  }
  if (missingCritical.length === 0) {
    exclusions.push('No critical component is missing, so more research cannot change the assessability of the score.');
  }

  // ── Needs Diligence: the broad population ──────────────────────
  // Everything that is in-thesis, alive, provisional, and still has a
  // gap worth closing. This is a work list and it is SUPPOSED to be big.
  const needsDiligence = exclusions.length === 0;

  // ── Promising: the narrow, prioritised subset ──────────────────
  //
  // The first version of this queue held 127 of 172 active companies —
  // 74% of the corpus. A shortlist that contains three quarters of
  // everything is not a shortlist, and the reason was that its two
  // entry conditions were satisfied by almost every record: a YC
  // accelerator field, and a preliminary score computed over so few
  // components that it cleared the Track threshold trivially.
  //
  // So Promising now requires ALL of:
  //   - Needs Diligence (in-thesis, active, provisional, researchable)
  //   - at or above TRACK_THRESHOLD on what could be judged
  //   - at least a MEDIUM quality-priority band
  //   - at least one SUBSTANTIVE signal
  //
  // "Substantive" is the load-bearing word. Sector and geography are
  // excluded by definition: every company has both, so neither
  // distinguishes anything. An accelerator on its own is excluded for
  // the same reason — 111 of the 172 came from YC. What counts is
  // evidence about the founders, a customer, a buyer, defensibility, or
  // commercial proof.
  const SUBSTANTIVE_KEYS = new Set([
    'named-customers', 'commercial-proof', 'enterprise-buyer',
    'technical-moat', 'data-moat', 'founder-market-fit',
  ]);
  const substantiveSignals = (input.qualitySignals ?? [])
    .filter((s) => s.direction === 'positive' && SUBSTANTIVE_KEYS.has(s.key))
    .map((s) => `${s.label}: "${s.evidence}"`);

  /**
   * Founder evidence counts through the CITED signal, not through a
   * second, weaker test.
   *
   * This block used to treat any founder row with a non-"Unknown"
   * `background` string as substantive on its own. That string is written
   * automatically: server/services/enrichment.ts fills it with
   * `verdict.summary`, the pipeline's own research summary. So a company
   * became "Promising" partly on the strength of a sentence this codebase
   * generated about it, with no source attached — while the parallel path
   * in shared/qualitySignals.ts deliberately REQUIRES a source URL for
   * exactly the same evidence and skips an uncited biography entirely.
   *
   * Two definitions of "founder evidence is substantive", one of which
   * quietly ignored the citation rule. `founder-market-fit` is already in
   * SUBSTANTIVE_KEYS above and is only awarded from a cited biography, so
   * removing this shortcut narrows the queue to evidence a reviewer can
   * open — it does not remove founder evidence from consideration.
   */

  const meetsTrack = fit.score >= TRACK_THRESHOLD;
  const meetsBand = input.qualityBand === 'high' || input.qualityBand === 'medium';

  const batchYear = acceleratorBatchYear(company.accelerator);
  const thisYear = (input.today ?? new Date()).getUTCFullYear();
  const staleBatch = batchYear !== null && thisYear - batchYear > MAX_BATCH_AGE_YEARS;

  if (meetsBand) {
    reasons.push(`Quality-priority band ${input.qualityBand!.toUpperCase()} (${input.qualityPriority ?? '?'}/100).`);
  }
  if (meetsTrack) {
    reasons.push(
      `Preliminary score ${fit.score.toFixed(1)} is at or above the Track threshold (${TRACK_THRESHOLD}) `
      + `on the ${Math.round(fit.completeness * 100)}% of the model that could be judged.`,
    );
  }
  for (const s of substantiveSignals) reasons.push(s);

  if (needsDiligence) {
    if (!meetsTrack) exclusions.push(`Preliminary score ${fit.score.toFixed(1)} is below the Track threshold (${TRACK_THRESHOLD}).`);
    if (!meetsBand) exclusions.push(`Quality-priority band is ${input.qualityBand ?? 'unknown'}, below medium.`);
    if (substantiveSignals.length === 0) {
      exclusions.push('No substantive signal — sector, geography and an accelerator alone do not distinguish this record.');
    }
    if (staleBatch) {
      exclusions.push(
        `Accelerator batch ${company.accelerator} is ${thisYear - batchYear!} years old — past the stage the firm leads. `
        + 'Kept in Needs Diligence; excluded from the promising shortlist.',
      );
    }
  }

  const eligible = needsDiligence && meetsTrack && meetsBand && substantiveSignals.length > 0 && !staleBatch;

  // ── Next action and risk ───────────────────────────────────────
  const firstGap = ['traction', 'founder', 'stage', 'geo', 'thesis'].find((k) => missingCritical.includes(k));
  const nextAction = firstGap
    ? NEXT_ACTION[firstGap]
    : 'No critical gap — review normally.';

  const primaryRisk = missingCritical.includes('traction') && missingCritical.includes('founder')
    ? 'Neither traction nor the founding team is established, so nothing yet distinguishes this from any other early record.'
    : missingCritical.includes('traction')
      ? 'No traction on record — the company may have none, or may simply not have published it.'
      : missingCritical.includes('founder')
        ? 'No founder background on record — founder-market fit is unassessed.'
        : fit.evidenceConfidence < 0.4
          ? 'Thinly sourced: the record rests on very few independent sources.'
          : 'Evidence is sparse but the critical components are covered.';

  return {
    needsDiligence,
    eligible,
    substantiveSignals,
    reasons,
    exclusions,
    missingCritical: missingCritical.map((k) => COMPONENT_LABELS[k] ?? k),
    nextAction,
    primaryRisk,
  };
}
