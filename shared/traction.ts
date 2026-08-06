import { z } from 'zod';

/**
 * Analyst traction review — the states, their scoring behaviour, and the
 * rules that stop an unsupported opinion from becoming a score.
 *
 * WHY THIS EXISTS. Traction was unassessable for 100% of the 209
 * companies on file: every one carried the literal string
 * "Unknown — not yet researched". Traction is worth 10 of the model's
 * 100 points and is one of the five components the v4.1 provisional
 * policy requires, so with nothing recording it, no company could ever
 * be fully assessed — and the pipeline had no way for a human to record
 * what they had found. Discovery can surface a claim; only a person can
 * judge whether a pilot is real.
 *
 * ─────────────────────────────────────────────────────────────────
 * THE TWO STATES THAT DO NOT SCORE
 * ─────────────────────────────────────────────────────────────────
 *
 * `unknown` and `no-public-traction` both leave the traction component
 * UNASSESSABLE, which keeps the record provisional. The second is the
 * subtle one and it is deliberate:
 *
 *   "We searched and found no public evidence of traction" is a
 *   statement about the SEARCH, not about the company.
 *
 * A pre-seed company with three signed design partners and no press has
 * exactly the same public footprint as one with no customers at all.
 * Scoring the first as zero would punish it for being early and quiet,
 * which is the profile this firm is explicitly trying to find. So the
 * finding is RECORDED — it is real, useful diligence, and it stops the
 * next analyst repeating the search — but it is excluded from the score
 * rather than counted against the company.
 *
 * ─────────────────────────────────────────────────────────────────
 * EVIDENCE IS REQUIRED FOR A POSITIVE STATE
 * ─────────────────────────────────────────────────────────────────
 *
 * A scoring state needs either a source URL or a substantive analyst
 * note. Without one, `validateTractionReview` refuses the review
 * outright rather than quietly recording a number nobody can audit.
 * This is what stops "analyst clicked 'named customer'" from becoming
 * seven points out of ten.
 */

export const TRACTION_STATES = [
  'unknown',
  'no-public-traction',
  'pre-launch',
  'design-partner',
  'pilot',
  'paid-pilot',
  'named-customer',
  'recurring-revenue',
  'multiple-deployments',
  'scaled-adoption',
] as const;
export type TractionState = (typeof TRACTION_STATES)[number];

export interface TractionStateSpec {
  id: TractionState;
  label: string;
  /**
   * The 0–10 rating this state contributes to the EXISTING traction
   * component. These are not new weights — the component's maximum is
   * still 10 and the rubric is untouched; this only says which rating a
   * given finding corresponds to.
   */
  level: number;
  /** False = the traction component stays unassessable, so the record stays provisional. */
  scores: boolean;
  /** Shown in the review UI so the analyst knows what they are asserting. */
  description: string;
}

export const TRACTION_STATE_SPECS: Record<TractionState, TractionStateSpec> = {
  unknown: {
    id: 'unknown', label: 'Unknown / not yet researched', level: 0, scores: false,
    description: 'Nobody has looked yet. Excluded from the score — a gap in our work, not a finding about the company.',
  },
  'no-public-traction': {
    id: 'no-public-traction', label: 'No publicly disclosed traction', level: 0, scores: false,
    description:
      'We searched and found nothing public. Recorded as real diligence, but EXCLUDED from the score: '
      + 'a quiet pre-seed company with signed design partners looks identical from the outside to one with none, '
      + 'and absence of public evidence is not proof of absence.',
  },
  'pre-launch': {
    id: 'pre-launch', label: 'Pre-launch', level: 1, scores: true,
    description: 'Product is not yet available to customers. A real finding, scored low.',
  },
  'design-partner': {
    id: 'design-partner', label: 'Design partner(s)', level: 3, scores: true,
    description: 'One or more organisations are co-developing the product, typically unpaid.',
  },
  pilot: {
    id: 'pilot', label: 'Pilot', level: 4, scores: true,
    description: 'A live unpaid pilot or trial deployment with a real organisation.',
  },
  'paid-pilot': {
    id: 'paid-pilot', label: 'Paid pilot', level: 6, scores: true,
    description: 'A pilot the customer is paying for — the first real evidence of willingness to pay.',
  },
  'named-customer': {
    id: 'named-customer', label: 'Named customer', level: 7, scores: true,
    description: 'At least one identified customer in production, named publicly or to us.',
  },
  'recurring-revenue': {
    id: 'recurring-revenue', label: 'Recurring revenue', level: 8, scores: true,
    description: 'Contracted recurring revenue on record.',
  },
  'multiple-deployments': {
    id: 'multiple-deployments', label: 'Multiple deployments / customers', level: 9, scores: true,
    description: 'Several independent customers or deployments in production.',
  },
  'scaled-adoption': {
    id: 'scaled-adoption', label: 'Scaled commercial adoption', level: 10, scores: true,
    description: 'Broad commercial adoption with repeatable sales.',
  },
};

/** How the claim was established. Kept separate from the state itself. */
export const TRACTION_VERIFICATIONS = ['company-claimed', 'independently-confirmed', 'analyst-assessment'] as const;
export type TractionVerification = (typeof TRACTION_VERIFICATIONS)[number];

export const TRACTION_VERIFICATION_LABELS: Record<TractionVerification, string> = {
  'company-claimed': 'Company-claimed (the company says so)',
  'independently-confirmed': 'Independently confirmed (a third party states it)',
  'analyst-assessment': 'Analyst assessment (our judgement, not a published fact)',
};

export const TRACTION_EVIDENCE_TYPES = [
  'company-website', 'customer-announcement', 'press-coverage', 'filing-or-grant',
  'founder-statement', 'product-listing', 'analyst-call', 'other',
] as const;
export type TractionEvidenceType = (typeof TRACTION_EVIDENCE_TYPES)[number];

export const tractionReviewSchema = z.object({
  companyId: z.string().min(1),
  state: z.enum(TRACTION_STATES),
  evidenceType: z.enum(TRACTION_EVIDENCE_TYPES),
  /** Named customer/pilot/deployment, when it is publishable. */
  customerName: z.string().max(200).nullable().default(null),
  verification: z.enum(TRACTION_VERIFICATIONS),
  /**
   * A revenue or usage figure, VERBATIM, only when a source directly
   * supports it. Free text on purpose: "$40k ARR" and "3 sites live" are
   * both legitimate and neither should be coerced into a number the
   * source did not state.
   */
  metricValue: z.string().max(200).nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
  analystNote: z.string().max(4000).nullable().default(null),
  evidenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  confidence: z.enum(['low', 'medium', 'high']),
  missingDiligence: z.string().max(2000).nullable().default(null),
  /**
   * Free-text actor, matching this build's single-shared-password auth
   * model. This is NOT a cryptographically verified identity and must
   * never be presented as one.
   */
  actor: z.string().min(1).default('team'),
});
export type TractionReviewInput = z.infer<typeof tractionReviewSchema>;

export interface TractionReviewRecord extends TractionReviewInput {
  id: number;
  previousState: TractionState | null;
  at: string;
}

/** Does this state contribute a rating to the official score? */
export const tractionStateScores = (s: TractionState): boolean => TRACTION_STATE_SPECS[s].scores;
export const tractionStateLevel = (s: TractionState): number => TRACTION_STATE_SPECS[s].level;

/**
 * The note written onto `companies.traction_note`.
 *
 * Two hard requirements, both about not laundering an opinion into a
 * fact. Non-scoring states must produce a note the EXISTING scorer still
 * reads as unresearched (it tests for /^unknown|not yet researched/),
 * and every scoring note must carry its verification level so nobody
 * reads an analyst's judgement as a published fact.
 */
export function tractionNoteFor(r: TractionReviewInput): string {
  const spec = TRACTION_STATE_SPECS[r.state];
  if (!spec.scores) {
    // MUST start with "Unknown" so the traction component stays
    // unassessable — see tractionSignal() in src/lib/scoring.ts.
    return r.state === 'no-public-traction'
      ? `Unknown for scoring — analyst searched and found no publicly disclosed traction${r.evidenceDate ? ` as of ${r.evidenceDate}` : ''}. `
        + 'Absence of public evidence is not evidence of absence, so this is excluded from the score rather than counted as zero.'
        + (r.analystNote ? ` Analyst note: ${r.analystNote}` : '')
      : 'Unknown — not yet researched';
  }
  const bits = [
    spec.label,
    r.customerName ? `(${r.customerName})` : null,
    r.metricValue ? `— ${r.metricValue}` : null,
  ].filter(Boolean).join(' ');
  const provenance = TRACTION_VERIFICATION_LABELS[r.verification];
  const cite = r.sourceUrl ? ` Source: ${r.sourceUrl}` : ' No source URL — analyst note only.';
  return `${bits}. ${provenance}.${r.evidenceDate ? ` Evidence dated ${r.evidenceDate}.` : ''}${cite}`
    + (r.analystNote ? ` Analyst note: ${r.analystNote}` : '');
}

export interface TractionValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Reject a review that would put a number on the board without anything
 * behind it.
 *
 * Deliberately strict about metrics: a revenue or usage figure is the
 * single easiest thing to type in from memory, so it requires a source
 * URL specifically — an analyst note is not enough to publish "$40k
 * ARR" as though a source said it.
 */
export function validateTractionReview(r: TractionReviewInput): TractionValidation {
  const errors: string[] = [];
  const spec = TRACTION_STATE_SPECS[r.state];
  const hasNote = !!r.analystNote && r.analystNote.trim().length >= 10;
  const hasUrl = !!r.sourceUrl;

  if (spec.scores && !hasUrl && !hasNote) {
    errors.push(
      `"${spec.label}" contributes ${spec.level}/10 to the official score, so it needs a source URL `
      + 'or an analyst note of at least 10 characters explaining what was found. '
      + 'A state on its own is an opinion, and an opinion must not silently become a score.',
    );
  }
  if (r.metricValue && !hasUrl) {
    errors.push(
      'A revenue or usage figure may only be recorded with a source URL that directly supports it. '
      + 'Record the finding in the analyst note instead if no citable source states the number.',
    );
  }
  if (r.verification === 'independently-confirmed' && !hasUrl) {
    errors.push('"Independently confirmed" requires the third-party source URL that confirms it.');
  }
  if (r.customerName && !hasUrl && !hasNote) {
    errors.push('Naming a customer requires a source URL or an analyst note recording where it came from.');
  }
  return { ok: errors.length === 0, errors };
}
