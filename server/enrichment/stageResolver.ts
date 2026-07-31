import {
  canNameStage, isNamedVentureStage,
  type SourceFamily, type StageResult,
} from '../../shared/enrichment';

/**
 * Resolving a company's stage without inventing a financing event.
 *
 * THE RULE THIS MODULE ENFORCES
 *
 * An SEC Form D proves that an entity reported an exempt securities
 * offering. It does not name a venture round. The temptation — and the
 * thing that would have cleared 200 `Unknown` stages in one line — is to
 * map offering size onto a round name: under $5M is Seed, over that is
 * Series A. That mapping is fiction. A $3M Form D can be a pre-seed
 * extension, a bridge, a friends-and-family round, a real Seed, or a
 * partial close of a Series A, and the filing distinguishes none of them.
 * Writing "Seed" from it would put a specific, checkable, WRONG claim on
 * a company's record.
 *
 * So named stages (Pre-seed, Seed, Series A, Series B+) require a source
 * that NAMES them — the company, an accelerator, an investor in the
 * round, or funding press. Everything else that is genuinely early
 * resolves to `early-stage-round-not-disclosed`, which is a real answer
 * carrying a real explanation, not a shrug.
 *
 * Pure functions. The caller gathers the evidence; this decides what it
 * supports.
 */

/**
 * One thing a source says about stage.
 *
 * `statedStage` is what the source SAYS, when it says anything. A Form D
 * contributes an item with `statedStage: null` and a non-null
 * `offeringAmountUsd` — it is evidence, and it is deliberately unable to
 * name a stage.
 */
export interface StageEvidenceItem {
  sourceFamily: SourceFamily;
  url: string;
  /** Publication or filing date, YYYY-MM-DD. Null when the source states none. */
  date: string | null;
  /** The round name as literally stated by the source, or null. */
  statedStage: StageResult | null;
  /** Verbatim supporting text, truncated. Untrusted plain text. */
  supportingText: string;
  /** Offering/round size when the source states one. Never used to NAME a stage. */
  amountUsd?: number | null;
}

/** Everything else we know that bounds the answer without naming it. */
export interface StageContext {
  /** Company age in years, when a founding year is on record. */
  companyAgeYears: number | null;
  /** Team size when on record; 0 or null means not recorded, not "a team of zero". */
  teamSize: number | null;
  /** Accelerator on record (YC, Techstars…). */
  accelerator: string | null;
  /** Does the company's own site describe a shipping product? */
  hasShippingProduct: boolean;
  /** Is there any independent financing evidence at all? */
  hasFinancingEvidence: boolean;
  /** Was the only financing evidence a Form D? */
  onlyFinancingIsFormD: boolean;
  /** Grant funding (SBIR, NSF…) on record. */
  hasGrantFunding: boolean;
}

export interface StageOutcome {
  stage: StageResult;
  basis: 'explicit' | 'inferred';
  confidence: number;
  evidenceUrl: string | null;
  evidenceDate: string | null;
  explanation: string;
  conflicts: { stage: string; sourceUrl: string; detail: string }[];
}

/**
 * Round names as they appear in real announcements. Matched against
 * source text to find an EXPLICIT statement.
 *
 * Ordered so the more specific pattern is tested first: "Series A-1" and
 * "Series A extension" are Series A, while "Series B" and anything later
 * collapse to Series B+ because the distinctions past B do not change a
 * pre-seed fund's decision.
 */
const STAGE_PATTERNS: { pattern: RegExp; stage: StageResult }[] = [
  { pattern: /\bpre-?seed\b/i, stage: 'Pre-seed' },
  { pattern: /\bseries\s+[c-z]\b/i, stage: 'Series B+' },
  { pattern: /\bseries\s+b\b/i, stage: 'Series B+' },
  { pattern: /\bseries\s+a(?:-\d)?\b/i, stage: 'Series A' },
  { pattern: /\bseed\s+(?:round|funding|financing|extension)\b/i, stage: 'Seed' },
  { pattern: /\braises?\s+\$?[\d.]+\s*[mk]?\s+seed\b/i, stage: 'Seed' },
  { pattern: /\bseed\b/i, stage: 'Seed' },
  { pattern: /\bbootstrapp?ed\b/i, stage: 'Bootstrapped' },
  { pattern: /\b(?:grant[- ]funded|sbir|sttr|nsf\s+award|darpa\s+award)\b/i, stage: 'Grant-funded' },
  { pattern: /\b(?:pre-?launch|not\s+yet\s+launched|coming\s+soon|in\s+stealth)\b/i, stage: 'Pre-launch' },
];

/**
 * Read a stage out of source text.
 *
 * Returns null when the text names no round — which is the common case
 * and must stay distinguishable from "the text names Seed".
 */
export function readStatedStage(text: string): StageResult | null {
  for (const { pattern, stage } of STAGE_PATTERNS) {
    if (pattern.test(text)) return stage;
  }
  return null;
}

/**
 * Does this evidence item carry an explicit, citable stage claim?
 *
 * Both halves are required. A funding article that names "Series A" is a
 * stage claim. A Form D that happens to contain the word "seed" in a
 * business description is not, because the Form D family cannot name a
 * round no matter what string appears in it.
 */
export function isExplicitStageClaim(item: StageEvidenceItem): boolean {
  return item.statedStage !== null && canNameStage(item.sourceFamily) && isNamedVentureStage(item.statedStage);
}

/** Prefer the most recent dated evidence; undated evidence sorts last. */
function byRecency(a: StageEvidenceItem, b: StageEvidenceItem): number {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return 0;
}

/**
 * Resolve a stage from evidence plus context.
 *
 * The order of the branches is the policy:
 *   1. Sources that NAME a round and disagree     → conflict, to a human
 *   2. A source that names a round                → explicit named stage
 *   3. Non-venture states a source states plainly → Bootstrapped / Grant-funded / Pre-launch
 *   4. Anything else that is genuinely early      → bounded inference
 *   5. Nothing at all                             → bounded inference, lowest confidence
 *
 * Note that branch 4 is reached by every Form-D-only company, and that
 * this is the correct destination for them rather than a failure of the
 * pipeline.
 */
export function resolveStage(evidence: StageEvidenceItem[], ctx: StageContext): StageOutcome {
  const explicit = evidence.filter(isExplicitStageClaim).sort(byRecency);

  // ── 1. Conflict ──────────────────────────────────────────────────
  // Distinct named stages from separate sources. Recency does NOT break
  // this tie automatically: a company really can raise a Seed and then a
  // Series A, but it can also be miscategorised by one outlet, and the
  // two look identical from here. A human settles it.
  const distinct = [...new Set(explicit.map((e) => e.statedStage))];
  if (distinct.length > 1) {
    const newest = explicit[0];
    return {
      stage: 'stage-conflict-manual-review',
      basis: 'explicit',
      confidence: 0.3,
      evidenceUrl: newest.url,
      evidenceDate: newest.date,
      explanation: `Sources disagree on the round: ${distinct.join(' vs ')}. `
        + 'This can be a real progression between rounds or a reporting error, and the evidence on record cannot '
        + 'tell those apart. Left as a conflict rather than resolved by picking the most recent article.',
      conflicts: explicit.map((e) => ({
        stage: e.statedStage as string,
        sourceUrl: e.url,
        detail: e.supportingText,
      })),
    };
  }

  // ── 2. An explicitly named round ─────────────────────────────────
  if (explicit.length > 0) {
    const best = explicit[0];
    const corroborating = explicit.length;
    return {
      stage: best.statedStage as StageResult,
      basis: 'explicit',
      confidence: Math.min(0.95, 0.7 + 0.1 * (corroborating - 1) + (best.date ? 0.05 : 0)),
      evidenceUrl: best.url,
      evidenceDate: best.date,
      explanation: `${best.statedStage} stated explicitly by ${best.sourceFamily}`
        + `${best.date ? ` on ${best.date}` : ' (source states no date)'}`
        + `${corroborating > 1 ? `, corroborated by ${corroborating - 1} further source${corroborating > 2 ? 's' : ''}` : ''}.`,
      conflicts: [],
    };
  }

  // ── 3. Non-venture states, when a source says so plainly ─────────
  const nonVenture = evidence
    .filter((e) => e.statedStage !== null && !isNamedVentureStage(e.statedStage))
    .sort(byRecency);
  if (nonVenture.length > 0) {
    const best = nonVenture[0];
    return {
      stage: best.statedStage as StageResult,
      basis: 'explicit',
      confidence: 0.7,
      evidenceUrl: best.url,
      evidenceDate: best.date,
      explanation: `${best.statedStage} stated by ${best.sourceFamily}`
        + `${best.date ? ` on ${best.date}` : ''}. No venture round is named by any source on record.`,
      conflicts: [],
    };
  }

  // Grant funding on record with nothing else is a real, nameable state.
  if (ctx.hasGrantFunding && !ctx.hasFinancingEvidence) {
    return {
      stage: 'Grant-funded',
      basis: 'inferred',
      confidence: 0.5,
      evidenceUrl: null,
      evidenceDate: null,
      explanation: 'Grant funding is on record and no equity financing is. Inferred rather than stated: the grant '
        + 'establishes non-dilutive funding, and the absence of a recorded round is our sourcing, not proof there was none.',
      conflicts: [],
    };
  }

  // ── 4. Bounded inference ─────────────────────────────────────────
  // This is where every Form-D-only company lands, on purpose.
  const bounds: string[] = [];
  if (ctx.onlyFinancingIsFormD) {
    bounds.push(
      'the only financing evidence is an SEC Form D, which reports that an exempt offering occurred but never names '
      + 'a venture round — translating it into "Seed" would assert a financing event no source states',
    );
  } else if (ctx.hasFinancingEvidence) {
    bounds.push('financing evidence is on record but no source names the round');
  }
  if (ctx.companyAgeYears !== null) {
    bounds.push(`the company is approximately ${ctx.companyAgeYears} year${ctx.companyAgeYears === 1 ? '' : 's'} old`);
  }
  if (ctx.teamSize !== null && ctx.teamSize > 0) bounds.push(`the recorded team size is ${ctx.teamSize}`);
  if (ctx.accelerator) bounds.push(`${ctx.accelerator} participation is on record`);
  if (ctx.hasShippingProduct) bounds.push('the company describes a shipping product');

  const amounts = evidence.map((e) => e.amountUsd).filter((a): a is number => typeof a === 'number' && a > 0);
  if (amounts.length > 0) {
    const max = Math.max(...amounts);
    bounds.push(
      `the largest recorded offering is $${(max / 1_000_000).toFixed(1)}M — recorded as a fact about the filing, `
      + 'not used to infer a round name, because offering size does not map onto stage',
    );
  }

  const dated = evidence.filter((e) => e.date).sort(byRecency)[0] ?? null;

  if (bounds.length === 0) {
    return {
      stage: 'early-stage-round-not-disclosed',
      basis: 'inferred',
      confidence: 0.15,
      evidenceUrl: dated?.url ?? null,
      evidenceDate: dated?.date ?? null,
      explanation: 'No source names a round, and nothing on record — age, team size, accelerator, product status, or '
        + 'financing — bounds the stage either. Recorded as early-stage with the round undisclosed because the company '
        + 'is in an early-stage pipeline, not because any evidence establishes it. Confidence is deliberately low.',
      conflicts: [],
    };
  }

  /**
   * Confidence rises with how much genuinely bounds the answer, and is
   * capped well below an explicit claim. This is an inference and the
   * number says so — it can never be mistaken for a sourced stage.
   */
  const confidence = Math.min(0.55, 0.2 + 0.08 * bounds.length);

  return {
    stage: 'early-stage-round-not-disclosed',
    basis: 'inferred',
    confidence: Number(confidence.toFixed(2)),
    evidenceUrl: dated?.url ?? null,
    evidenceDate: dated?.date ?? null,
    explanation: `No source names a round. Bounded to early-stage because ${bounds.join('; ')}. `
      + 'The specific round remains undisclosed and is not guessed.',
    conflicts: [],
  };
}
