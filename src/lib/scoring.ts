import type { Company, FitScore, PolicyFlag, ScoreComponent } from '../types';
import { PREFERRED_STATES, verticalById } from '../data/taxonomy';

/**
 * Vamos Fit Score — repeatable 100-point weighted model, displayed as
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

export const SCORING_VERSION = 'v4.0 (2026-07, normalized)';

const DAY = 86_400_000;

const STAGE_POINTS: Record<Company['stage'], number> = {
  'Seed': 15,
  'Pre-seed': 12,
  'Series A': 9,
  'Stealth': 7,
  // Unknown is not a stage the company chose — it is a gap in OUR data.
  // Scored low and said plainly, never guessed upward.
  'Unknown': 5,
};

const EXCEPTION_MESSAGES: Record<PolicyFlag, string> = {
  'defi-adjacent':
    'DeFi / blockchain is an adjacent or exception category that may conflict with current firm exclusions. Route to partner review — do not auto-reject.',
  'hardware-heavy':
    'Hardware-heavy business model sits outside the firm’s standard software-first thesis. Requires explicit partner sign-off.',
  'outside-thesis':
    'Category is outside the core sectors. Score is computed on the separate other-industries scale and needs partner review.',
};

function thesisFit(c: Company): ScoreComponent {
  const v = verticalById(c.vertical);
  const sub = v.subcategories.find((s) => s.name === c.subcategory);
  let points: number;
  let rationale: string;
  if (!sub) {
    points = 5;
    rationale = `Subcategory "${c.subcategory}" is not in the ${v.name} taxonomy — review classification.`;
  } else if (!v.core) {
    points = 11;
    rationale = `${v.name} is outside the core sectors and scored on a separate scale.`;
  } else if (sub.exception) {
    points = 12;
    rationale = `Core sector, but "${sub.name}" is an exception subcategory: ${sub.exception}`;
  } else {
    points = 20;
    rationale = `Direct match: ${v.name} → ${sub.name}.`;
  }
  // An unclassified subcategory is a gap in OUR classification, not a
  // judgement that the company fits the thesis badly.
  return { key: 'thesis', about: 'company', label: 'Thesis / vertical fit', points, max: 20, rationale, assessable: !!sub };
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
            : 'Stage is not on record, so this component is excluded from the score rather than scored low — an unrecorded stage is a gap in our data, not evidence that the company is early. Confirm the stage during review.';
  return { key: 'stage', about: 'company', label: 'Stage fit', points, max: 15, rationale, assessable: c.stage !== 'Unknown' };
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
  // An analyst rating of 0 with an "Unknown"/unresearched note means nobody
  // has assessed traction yet. Not a company with no traction.
  const rated = c.traction.level > 0 || !/^unknown|not yet researched/i.test(c.traction.note.trim());
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

  const bg = c.founders.map((f) => f.background).join(' ').toLowerCase();
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
function fundingEvidence(c: Company): ScoreComponent {
  const hasAmount = !!c.raising;
  const date = c.lastFundingDate ? new Date(c.lastFundingDate).getTime() : null;
  let points = 0;
  const parts: string[] = [];
  if (hasAmount) { points += 3; parts.push(`recorded raise: ${c.raising}`); }
  if (date && !Number.isNaN(date)) {
    const age = Date.now() - date;
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
function evidenceRecency(c: Company): ScoreComponent {
  const newest = c.evidence
    .map((e) => new Date(e.date).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  let points = 0;
  let detail = 'No dated evidence on record.';
  if (newest) {
    const age = Date.now() - newest;
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
export function evidenceConfidence(c: Company): number {
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
  const freshness = newest ? Math.max(0, 1 - (Date.now() - newest) / (365 * DAY)) : 0;
  return Math.round((0.4 * count + 0.2 * primaryShare + 0.2 * diversity + 0.2 * freshness) * 100) / 100;
}

export function scoreCompany(c: Company): FitScore {
  const components = [
    thesisFit(c),
    stageFit(c),
    missionAlignment(c),
    tractionSignal(c),
    founderSignal(c),
    geography(c),
    fundingEvidence(c),
    institutionalValidation(c),
    evidenceQuality(c),
    evidenceRecency(c),
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

  // Accelerator validation, evidence quality, and evidence recency are all
  // measured from the evidence set WE hold, so they are assessable for
  // every record. On a bare Form D they are the ONLY assessable
  // components, and normalizing over just those produced numbers like
  // "HealthSherpa 7.6/10" out of 15 available points — a confident score
  // containing no statement about the company at all. 92 of 174 live
  // records are in exactly that position.
  //
  // So a score with no company-descriptive component behind it is marked
  // provisional. It is still shown, because hiding it would lose the
  // sourcing signal, but it must never outrank an actually-assessed
  // company.
  const assessedAboutCompany = assessed.filter((x) => x.about === 'company');
  const provisional = assessedAboutCompany.length === 0;
  const provisionalReason = provisional
    ? `Provisional: none of the company-descriptive components (thesis fit, stage, mission, traction, founders, geography, funding) could be judged from what is on record. `
      + `This number reflects only the quality of our own sourcing — accelerator validation, evidence quality, and evidence recency — so it is not a statement about the company and is ranked below assessed companies. `
      + `Record a stage, location, or classification to make it a real fit score.`
    : null;

  const exceptions = c.flags.map((flag) => ({ flag, message: EXCEPTION_MESSAGES[flag] }));
  const confidence = evidenceConfidence(c);

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
    explanation: `Vamos Fit Score ${score.toFixed(1)}/10 — ${earned} of ${assessablePoints} assessable points (model ${SCORING_VERSION}). Strongest assessed component: ${strongest.label} (${strongest.points}/${strongest.max}). Weakest: ${weakest.label} (${weakest.points}/${weakest.max}).${gapNote}${provisionalReason ? ` ${provisionalReason}` : ''} Evidence confidence ${Math.round(confidence * 100)}% — a separate measure of how well-sourced the record is, not of thesis fit.`,
  };
}

export const flagLabel = (f: PolicyFlag): string =>
  f === 'defi-adjacent' ? 'DeFi / blockchain exception'
  : f === 'hardware-heavy' ? 'Hardware-heavy'
  : 'Outside core thesis';
