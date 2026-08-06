import type { Company, FitScore, PolicyFlag, ScoreComponent } from '../types';
import { PREFERRED_STATES, verticalById } from '../data/taxonomy';

/**
 * VamosVentures Fit Score — repeatable 100-point weighted model, displayed as
 * 1.0–10.0. Every point is deterministic and explained; there is no
 * unexplained AI-generated number anywhere in the score.
 *
 *   Thesis / vertical fit ................. 20
 *   Stage fit ............................. 15
 *   Mission alignment (verified only) ..... 15
 *   Traction signal ....................... 10
 *   Founder & team evidence ............... 10
 *   Geography ............................. 10
 *   Funding evidence .......................  5
 *   Accelerator / institutional validation .  5
 *   Evidence quality .......................  5
 *   Evidence recency .......................  5
 *
 * The score is normalized over the components that could actually be
 * JUDGED, not over all 100 points. Each component reports `assessable`,
 * which is false when the underlying data is absent.
 *
 * This exists because the absolute version could not rank anything. Of
 * the 100 points, mission alignment (15) needs verified founder self-ID,
 * traction (10) needs an analyst rating, stage (15) needs a recorded
 * stage, and most of founder evidence (10) needs background text — none
 * of which a Form D or a funding article carries. Across the 209 real
 * records: 0 had a traction rating, 0 had founder background text, and 9
 * had a known stage. So ~50 points were unreachable for almost every
 * company, every score compressed into 2.0–3.7, and 251 of 467 stored
 * scores sat in one half-point band. The number was measuring how much we
 * knew about a company, not how good a lead it was.
 *
 * Normalizing does NOT inflate anything: an unmeasured component is
 * excluded from both the numerator and the denominator rather than
 * counted as zero, and `completeness` (the share of the model that was
 * assessable) is reported alongside the score everywhere it appears. A
 * high score at low completeness is a confident answer about a small
 * amount of evidence, and the UI has to say so.
 *
 * Separate again from both, `evidenceConfidence` (0–1) expresses how
 * well-sourced the record is — a company can fit the thesis perfectly on
 * thin evidence, and the three must never be conflated.
 *
 * Policy exceptions (DeFi/blockchain, hardware-heavy, outside-thesis)
 * are FLAGS surfaced for partner review — they never auto-reject and
 * never silently zero a score.
 */

export const SCORING_VERSION = 'v4.1 (2026-08, evidence-gated provisional)';

/**
 * When a score may be presented as FULLY ASSESSED.
 *
 * v4.0 marked a score provisional only when *nothing at all* about the
 * company could be judged. That bar was far too low, and a live run
 * proved it: candidates with 35–45% completeness — no stage, no
 * traction, no founder, sometimes no location — were being presented as
 * assessed, ranked against genuinely researched records, and eligible
 * for the High-Fit KPI. A number normalized over a fifth of the model is
 * a confident answer about almost no evidence, and calling it "assessed"
 * is the specific thing this policy now prevents.
 *
 * A score is non-provisional ONLY when all three hold:
 *
 *  1. every CRITICAL component below could actually be judged,
 *  2. overall completeness meets `minCompleteness`,
 *  3. the record cites at least `minCitedSources` source URL(s).
 *
 * Nothing here changes any score, weight, or the 8.0 High-Fit threshold.
 * The policy only moves records in ONE direction — from "assessed" to
 * "provisional" — which removes them from High-Fit. It can never promote
 * a record or raise a number.
 *
 * WHY `mission` IS NOT CRITICAL. Mission alignment can only come from a
 * founder's voluntary public self-identification; this codebase forbids
 * inferring it from names, photos, schools, or any other proxy, and the
 * approved policy is explicit that unknown diversity data must not
 * become an automatic rejection. Requiring it here would make
 * non-provisional unreachable for every company in the database and
 * would, in practice, penalise founders nobody has asked yet. Thesis /
 * vertical fit is the "alignment" component this gate enforces —
 * whether the company matches the investment thesis — which is a
 * property of the company and is knowable from public evidence.
 *
 * `minCompleteness` is deliberately the WEAKER of the two numeric
 * conditions: satisfying every critical component already implies
 * >= 80% completeness under today's weights (20+15+10+10+10 critical,
 * plus the 15 always-assessable evidence points). It exists as a
 * backstop so the policy stays sound if component weights ever change,
 * not as the binding constraint today.
 */
export const NON_PROVISIONAL_POLICY = {
  /** Component keys that must ALL be assessable. */
  requiredComponents: ['thesis', 'stage', 'traction', 'founder', 'geo'] as const,
  /** Share of the 100-point model that must have been judgeable. */
  minCompleteness: 0.6,
  /** Distinct cited source URLs the record must carry. */
  minCitedSources: 1,
};

/** Human-readable labels for the policy's required components, for display. */
const REQUIRED_COMPONENT_LABELS: Record<string, string> = {
  thesis: 'thesis / vertical fit',
  stage: 'stage',
  traction: 'traction',
  founder: 'founder & team',
  geo: 'geography',
};

const DAY = 86_400_000;

const STAGE_POINTS: Record<Company['stage'], number> = {
  'Seed': 15,
  'Pre-seed': 12,
  'Series A': 9,
  'Stealth': 7,
  // Researched results. These are findings, not gaps, so they score.
  'Pre-launch': 11,
  'Bootstrapped': 8,
  'Grant-funded': 8,
  // The company is early and no source names the round. Scored between
  // Series A and Stealth: early enough to be in scope, but the specific
  // round is genuinely undisclosed rather than assumed to be seed.
  'Early-stage — round not publicly disclosed': 9,
  // Past the firm's stage. A real finding, scored low on FIT — which is
  // different from being excluded for lack of data.
  'Series B+': 3,
  // Sources disagree. We do not know, so this is excluded rather than
  // scored — see `assessable` in stageFit.
  'Stage conflict — manual review required': 5,
  // Unknown is not a stage the company chose — it is a gap in OUR data.
  // Scored low and said plainly, never guessed upward.
  'Unknown': 5,
};

/**
 * Stages we do not actually know. Excluded from the score rather than
 * counted low, because a gap in our data is not evidence about the
 * company. Everything else in STAGE_POINTS is a researched finding.
 */
const UNKNOWABLE_STAGES: Company['stage'][] = ['Unknown', 'Stage conflict — manual review required'];

const EXCEPTION_MESSAGES: Record<PolicyFlag, string> = {
  'defi-adjacent':
    'DeFi / blockchain is an adjacent or exception category that may conflict with current firm exclusions. Route to partner review — do not auto-reject.',
  'hardware-heavy':
    'Hardware-heavy business model sits outside the firm’s standard software-first thesis. Requires explicit partner sign-off.',
  'outside-thesis':
    'Flagged as outside the firm’s stated sectors despite a taxonomy vertical being on record. Needs partner review.',
};

function thesisFit(c: Company): ScoreComponent {
  const v = verticalById(c.vertical);
  const sub = v.subcategories.find((s) => s.name === c.subcategory);
  let points: number;
  let rationale: string;
  /**
   * A researched SECTOR is thesis-relevant on its own.
   *
   * This used to require an exact taxonomy subcategory match, so a
   * company confidently classified as "Health & Wellness → virtual care
   * delivery" scored as unassessable simply because that subvertical is
   * not a literal row in the taxonomy table. Knowing the sector is most
   * of what this component measures; the subcategory refines it.
   *
   * It is scored BELOW an exact match, because an exact match is a
   * stronger statement — and it stays assessable, because "we know the
   * sector and a specific subvertical" is knowledge, not a gap.
   */
  const sectorKnown = !!c.subcategory && !/unclassified|unknown/i.test(c.subcategory);

  if (!sub && sectorKnown) {
    points = 16;
    rationale = `${v.name} → ${c.subcategory}. Sector confirmed by research; the subvertical is more specific than the taxonomy, so this scores below an exact taxonomy match.`;
  } else if (!sub) {
    points = 5;
    rationale = `Subcategory "${c.subcategory}" is not in the ${v.name} taxonomy — review classification.`;
  } else if (sub.exception) {
    points = 12;
    rationale = `Core sector, but "${sub.name}" is an exception subcategory: ${sub.exception}`;
  } else {
    points = 20;
    rationale = `Direct match: ${v.name} → ${sub.name}.`;
  }
  // An unclassified subcategory is a gap in OUR classification, not a
  // judgement that the company fits the thesis badly.
  return {
    key: 'thesis', about: 'company', label: 'Thesis / vertical fit', points, max: 20, rationale,
    assessable: !!sub || sectorKnown,
  };
}

function stageFit(c: Company): ScoreComponent {
  const points = STAGE_POINTS[c.stage];
  const rationale =
    c.stage === 'Seed'
      ? 'Seed is the firm’s strongest stage focus.'
      : c.stage === 'Pre-seed'
        ? 'Pre-seed is in focus; earlier than the sweet spot.'
        : c.stage === 'Series A'
          ? 'Series A is in range but latest stage the firm leads.'
          : c.stage === 'Stealth'
            ? 'Stealth — the company is operating in stealth.'
            : c.stage === 'Early-stage — round not publicly disclosed'
              ? 'Researched as early-stage with the specific round undisclosed. Scored on that finding rather than excluded — the company is in scope; only the round name is unknown.'
              : c.stage === 'Series B+'
                ? 'Series B or later — past the stage the firm leads. Scored low on fit, which is a judgement about the company, not a gap in our data.'
                : c.stage === 'Bootstrapped'
                  ? 'Bootstrapped — no institutional round on record.'
                  : c.stage === 'Grant-funded'
                    ? 'Grant-funded — non-dilutive funding on record, no equity round.'
                    : c.stage === 'Pre-launch'
                      ? 'Pre-launch — earlier than the sweet spot but squarely in scope.'
                      : c.stage === 'Stage conflict — manual review required'
                        ? 'Sources disagree on the round, so the stage is excluded from the score until a reviewer settles it.'
                        : 'Stage is not on record, so this component is excluded from the score rather than scored low — an unrecorded stage is a gap in our data, not evidence that the company is early. Confirm the stage during review.';
  return {
    key: 'stage', about: 'company', label: 'Stage fit', points, max: 15, rationale,
    assessable: !UNKNOWABLE_STAGES.includes(c.stage),
  };
}

function missionAlignment(c: Company): ScoreComponent {
  const verified = c.founders.filter((f) => f.identity);
  const latino = verified.some((f) => f.identity!.latinoLed);
  const female = verified.some((f) => f.identity!.femaleLed);
  const other = verified.some((f) => f.identity!.otherUnderrepresented);

  let points = 0;
  const parts: string[] = [];
  if (latino) { points += 8; parts.push('Latino-led'); }
  if (female) { points += 4; parts.push('female-led'); }
  if (other) { points += 3; parts.push('other underrepresented'); }
  points = Math.min(points, 15);

  const rationale =
    verified.length === 0
      ? 'No verified self-identification on record. Excluded from the score rather than counted as zero — and never inferred from names, photos, or other proxies. Ask during outreach if the founder is open to sharing.'
      : `Publicly identified founder signal (${verified
          .map((f) => `${f.name}: ${f.identity!.basis.toLowerCase()}, ${f.identity!.source}`)
          .join('; ')}). Indicators: ${parts.join(', ') || 'recorded, none matching focus'}.`;
  // Absent self-identification is NOT a zero — it is unmeasured, and the
  // policy is that it may never be inferred. Counting it as 0 out of 15
  // penalised every company whose founders simply had not been asked,
  // which is both wrong and the largest single drag on the old score.
  return {
    key: 'mission', about: 'company',
    label: 'Mission alignment (verified only)',
    points, max: 15, rationale,
    assessable: verified.length > 0,
  };
}

function tractionSignal(c: Company): ScoreComponent {
  const points = Math.round(c.traction.level);
  /**
   * An analyst rating of 0 means nobody has assessed traction yet — not
   * that the company has none.
   *
   * Three note shapes mean "unrated", and the third was missing. Import
   * writes `Signals only: … (unrated — needs analyst review)` when
   * discovery found a traction-ish phrase but no person has judged it.
   * That note does not start with "Unknown", so it was being read as a
   * real analyst rating OF ZERO: the component became assessable, scored
   * 0/10, dropped the company's score, and — worse — removed traction
   * from the list of missing critical components, so the record looked
   * better researched than it was. Observed live on a candidate whose
   * only "signal" was a source saying it serves 16 hospitals.
   *
   * An explicit `unrated` marker now keeps the component unassessable,
   * which is what an unjudged signal actually is.
   */
  const note = c.traction.note.trim();
  const unrated = /^unknown|not yet researched|\bunrated\b/i.test(note);
  const rated = c.traction.level > 0 || !unrated;
  return {
    key: 'traction', about: 'company',
    label: 'Traction signal',
    points: Math.min(10, Math.max(0, points)),
    max: 10,
    rationale: `Analyst rating ${c.traction.level}/10 — ${c.traction.note}`,
    assessable: rated,
  };
}

/**
 * Founder & team evidence: count preference + recorded experience.
 * 2–5 founders is ideal; solo or >5 scores lower but NEVER rejects.
 * Experience points come only from analyst-recorded background text —
 * nothing is inferred from names, photos, schools, or networks.
 */
function founderSignal(c: Company): ScoreComponent {
  const n = c.founders.length;
  const parts: string[] = [];
  let points = 0;

  if (n >= 2 && n <= 5) { points += 4; parts.push(`${n} founders (ideal range 2–5)`); }
  else if (n === 1) { points += 1; parts.push('solo founder (lower input, never a rejection)'); }
  else if (n > 5) { points += 1; parts.push(`${n} founders (above ideal range, never a rejection)`); }
  else { parts.push('no founders on record'); }

  /**
   * Only REAL recorded background counts.
   *
   * The placeholder every import writes is "Unknown — requires manual
   * research", and the relevance pattern below contains `research` — so
   * a company with two placeholder founders and nothing else on record
   * was being awarded 2 points for "relevant technical/industry
   * background recorded". It was scoring the absence of research as
   * evidence of research. Placeholders are stripped first.
   */
  const realBackgrounds = c.founders
    .map((f) => f.background ?? '')
    .filter((b) => b.trim().length > 0 && !/^unknown/i.test(b.trim()));
  const bg = realBackgrounds.join(' ').toLowerCase();
  const prior = /found(ed|er)|co-found|started a|built .{0,24}(startup|company)|exited/.test(bg);
  if (prior) { points += 4; parts.push('prior founding experience recorded'); }
  const relevant = /engineer|research|phd|clinic|director|operator|led |head of|scientist|product|ex-|veteran of|big tech|google|meta|amazon|microsoft|stripe/.test(bg);
  if (relevant) { points += 2; parts.push('relevant technical/industry background recorded'); }

  // A placeholder "Unknown founder" row is not a founder on record. When
  // every founder is a placeholder with no background text, there is
  // nothing here to judge.
  const named = c.founders.filter((f) => !/unknown/i.test(f.name)).length;
  const anyBackground = c.founders.some((f) => f.background && !/^unknown/i.test(f.background.trim()));

  return {
    key: 'founder', about: 'company',
    label: 'Founder & team evidence',
    points: Math.min(points, 10),
    max: 10,
    rationale: `${parts.join('; ')}. Based only on recorded backgrounds — unknowns stay unscored, and founder count alone never rejects a company.`,
    assessable: named > 0 || anyBackground,
  };
}

function geography(c: Company): ScoreComponent {
  const preferred = PREFERRED_STATES.includes(c.state);
  const unknown = c.state === '??';
  return {
    key: 'geo', about: 'company',
    label: 'Geography',
    points: preferred ? 10 : unknown ? 2 : 4,
    max: 10,
    rationale: preferred
      ? `${c.state} is a preferred state (${PREFERRED_STATES.join(', ')}).`
      : unknown
        ? 'Location unknown — minimal credit until recorded.'
        : `${c.state} is outside preferred states — partial credit; US-based deals remain eligible.`,
    assessable: !unknown,
  };
}

/** Funding evidence: a recorded raise/round plus how recent it is. Unknown stays 0 — never guessed. */
function fundingEvidence(c: Company, today: number): ScoreComponent {
  const hasAmount = !!c.raising;
  const date = c.lastFundingDate ? new Date(c.lastFundingDate).getTime() : null;
  let points = 0;
  const parts: string[] = [];
  if (hasAmount) { points += 3; parts.push(`recorded raise: ${c.raising}`); }
  if (date && !Number.isNaN(date)) {
    const age = today - date;
    if (age <= 365 * DAY) { points += 2; parts.push(`funding dated ${c.lastFundingDate} (within 12 months)`); }
    else { points += 1; parts.push(`funding dated ${c.lastFundingDate} (older than 12 months)`); }
  }
  return {
    key: 'funding', about: 'company',
    label: 'Funding evidence',
    points: Math.min(points, 5),
    max: 5,
    rationale: parts.length > 0 ? `${parts.join('; ')}.` : 'No funding information on record — unscored, not guessed.',
    assessable: hasAmount || (!!date && !Number.isNaN(date)),
  };
}

/** Accelerator / institutional validation from recorded facts only. */
function institutionalValidation(c: Company): ScoreComponent {
  const acceleratorEvidence = c.evidence.filter((e) => e.type === 'Accelerator').length;
  const filings = c.evidence.filter((e) => e.type === 'Filing').length;
  let points = 0;
  const parts: string[] = [];
  if (c.accelerator) { points += 3; parts.push(`accelerator on record: ${c.accelerator}`); }
  if (acceleratorEvidence > 0) { points += 1; parts.push(`${acceleratorEvidence} accelerator evidence item(s)`); }
  if (filings > 0) { points += 1; parts.push(`${filings} public filing(s)`); }
  return {
    key: 'validation', about: 'our-evidence',
    label: 'Accelerator / institutional validation',
    points: Math.min(points, 5),
    max: 5,
    rationale: parts.length > 0 ? `${parts.join('; ')}.` : 'No accelerator or institutional validation on record.',
    // Always assessable: this is measured from OUR evidence set, which we
    // always hold in full. "No accelerator on record" is a real finding
    // about what we sourced, not a gap we are guessing around.
    assessable: true,
  };
}

function evidenceQuality(c: Company): ScoreComponent {
  const primary = c.evidence.filter((e) => e.type === 'Filing' || e.type === 'Founder statement').length;
  const points = Math.min(5, c.evidence.length + primary);
  return {
    key: 'evidence', about: 'our-evidence',
    label: 'Evidence quality',
    points,
    max: 5,
    rationale: `${c.evidence.length} sourced item(s), ${primary} primary (filings / founder statements). Every recommendation must remain auditable.`,
    // Our own evidence set is always fully known.
    assessable: true,
  };
}

/** Evidence recency: how fresh the newest sourced item is. */
function evidenceRecency(c: Company, today: number): ScoreComponent {
  const newest = c.evidence
    .map((e) => new Date(e.date).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  let points = 0;
  let detail = 'No dated evidence on record.';
  if (newest) {
    const age = today - newest;
    points = age <= 30 * DAY ? 5 : age <= 90 * DAY ? 4 : age <= 180 * DAY ? 3 : age <= 365 * DAY ? 2 : 1;
    detail = `Newest evidence is ${Math.max(0, Math.floor(age / DAY))} day(s) old.`;
  }
  return { key: 'recency', about: 'our-evidence', label: 'Evidence recency', points, max: 5, rationale: detail, assessable: !!newest };
}

/**
 * Evidence confidence (0–1) — how well-sourced the record is. This is
 * NOT the fit score: it answers "how much can we trust what we know",
 * not "how well does it fit the thesis".
 */
export function evidenceConfidence(c: Company, today: Date = new Date()): number {
  const todayMs = today.getTime();
  const count = Math.min(c.evidence.length, 4) / 4; // breadth, saturates at 4 items
  const primaryShare = c.evidence.length > 0
    ? c.evidence.filter((e) => e.type === 'Filing' || e.type === 'Founder statement').length / c.evidence.length
    : 0;
  const distinctSources = new Set(c.evidence.map((e) => e.source)).size;
  const diversity = Math.min(distinctSources, 3) / 3;
  const newest = c.evidence
    .map((e) => new Date(e.date).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  const freshness = newest ? Math.max(0, 1 - (todayMs - newest) / (365 * DAY)) : 0;
  return Math.round((0.4 * count + 0.2 * primaryShare + 0.2 * diversity + 0.2 * freshness) * 100) / 100;
}

/**
 * `today` is injectable (defaults to the real clock) so the same stored
 * company data is provably reproducible in a test — two components read
 * the wall clock (funding/evidence recency), and without pinning it the
 * score can drift by a point across a bucket boundary (30/90/180/365
 * days) between two runs on different calendar days.
 */
export function scoreCompany(c: Company, today: Date = new Date()): FitScore {
  const todayMs = today.getTime();
  const components = [
    thesisFit(c),
    stageFit(c),
    missionAlignment(c),
    tractionSignal(c),
    founderSignal(c),
    geography(c),
    fundingEvidence(c, todayMs),
    institutionalValidation(c),
    evidenceQuality(c),
    evidenceRecency(c, todayMs),
  ];
  const totalPoints = components.reduce((s, x) => s + x.points, 0);

  // Normalize over what could actually be judged.
  //
  // When every component is assessable, assessablePoints is 100 and this
  // is arithmetically identical to the old score — the change is a no-op
  // for a fully-known company and only affects records with genuine gaps.
  const assessed = components.filter((x) => x.assessable);
  const unassessed = components.filter((x) => !x.assessable);
  const assessablePoints = assessed.reduce((s, x) => s + x.max, 0);
  const earned = assessed.reduce((s, x) => s + x.points, 0);
  const completeness = Math.round((assessablePoints / 100) * 100) / 100;

  const score = assessablePoints > 0
    ? Math.max(1, Math.round((earned / assessablePoints) * 100) / 10)
    : 1;

  // ── Provisional gate (NON_PROVISIONAL_POLICY) ─────────────────
  //
  // Accelerator validation, evidence quality, and evidence recency are
  // all measured from the evidence set WE hold, so they are assessable
  // for every record. On a bare Form D they are the ONLY assessable
  // components, and normalizing over just those produces numbers like
  // "7.6/10" out of 15 available points — a confident score containing
  // no statement about the company at all.
  //
  // v4.0 caught only that extreme case. It let through the much more
  // common one: a record with a sector and a location but no stage, no
  // traction, no founder and no funding scored 7.1 at 35% completeness
  // and was presented as assessed. Every requirement below has to hold
  // now, and a record failing any of them is still scored and still
  // shown — it is simply labelled provisional, told exactly what is
  // missing, and kept out of High-Fit.
  const byKey = new Map(components.map((x) => [x.key, x]));
  const missingCritical = NON_PROVISIONAL_POLICY.requiredComponents
    .filter((k) => !byKey.get(k)?.assessable)
    .map((k) => REQUIRED_COMPONENT_LABELS[k] ?? k);
  const citedSources = new Set(
    c.evidence.map((e) => e.url).filter((u): u is string => typeof u === 'string' && u.trim().length > 0),
  ).size;

  const failsCompleteness = completeness < NON_PROVISIONAL_POLICY.minCompleteness;
  const failsCitations = citedSources < NON_PROVISIONAL_POLICY.minCitedSources;
  const provisional = missingCritical.length > 0 || failsCompleteness || failsCitations;

  const provisionalCauses: string[] = [];
  if (missingCritical.length > 0) {
    provisionalCauses.push(`${missingCritical.length} critical component(s) could not be judged: ${missingCritical.join(', ')}`);
  }
  if (failsCompleteness) {
    provisionalCauses.push(
      `only ${Math.round(completeness * 100)}% of the model was assessable, below the ${Math.round(NON_PROVISIONAL_POLICY.minCompleteness * 100)}% floor`,
    );
  }
  if (failsCitations) {
    provisionalCauses.push(`${citedSources} cited source URL(s), below the minimum of ${NON_PROVISIONAL_POLICY.minCitedSources}`);
  }

  const provisionalReason = provisional
    ? `Provisional — not a fully assessed score. ${provisionalCauses.join('; ')}. `
      + `The number shown is normalized over only what could be judged, so it is a confident answer about a small amount of evidence rather than a verdict on the company. `
      + `It is ranked below assessed companies and is excluded from High-Fit. `
      + `Research the missing component(s) to turn it into a real fit score — nothing about the company is being counted against it.`
    : null;

  const exceptions = c.flags.map((flag) => ({ flag, message: EXCEPTION_MESSAGES[flag] }));
  const confidence = evidenceConfidence(c, today);

  // Rank only over components that were actually judged — "weakest:
  // mission alignment 0/15" was meaningless when the answer was simply
  // never collected.
  const ranked = assessed.length > 0 ? assessed : components;
  const strongest = [...ranked].sort((a, b) => b.points / b.max - a.points / a.max)[0];
  const weakest = [...ranked].sort((a, b) => a.points / a.max - b.points / b.max)[0];

  const gapNote = unassessed.length > 0
    ? ` Not assessable on ${unassessed.length} component(s) — ${unassessed.map((x) => x.label.toLowerCase()).join(', ')} — so ${assessablePoints} of the model's 100 points could be judged (${Math.round(completeness * 100)}% completeness). These are gaps in what we have recorded, never findings against the company, and they are excluded from the score rather than counted as zero.`
    : ' Every component was assessable (100% completeness).';

  return {
    score,
    totalPoints,
    assessablePoints,
    completeness,
    provisional,
    provisionalReason,
    components,
    exceptions,
    version: SCORING_VERSION,
    evidenceConfidence: confidence,
    explanation: `VamosVentures Fit Score ${score.toFixed(1)}/10 — ${earned} of ${assessablePoints} assessable points (model ${SCORING_VERSION}). Strongest assessed component: ${strongest.label} (${strongest.points}/${strongest.max}). Weakest: ${weakest.label} (${weakest.points}/${weakest.max}).${gapNote}${provisionalReason ? ` ${provisionalReason}` : ''} Evidence confidence ${Math.round(confidence * 100)}% — a separate measure of how well-sourced the record is, not of thesis fit.`,
  };
}

export const flagLabel = (f: PolicyFlag): string =>
  f === 'defi-adjacent' ? 'DeFi / blockchain exception'
  : f === 'hardware-heavy' ? 'Hardware-heavy'
  : 'Outside core thesis';
