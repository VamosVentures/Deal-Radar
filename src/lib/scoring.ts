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
 * Separate from the fit score, `evidenceConfidence` (0–1) expresses
 * how well-sourced the record is — a company can fit the thesis
 * perfectly on thin evidence, and the two must never be conflated.
 *
 * Policy exceptions (DeFi/blockchain, hardware-heavy, outside-thesis)
 * are FLAGS surfaced for partner review — they never auto-reject and
 * never silently zero a score.
 */

export const SCORING_VERSION = 'v3.0 (2026-07)';

const DAY = 86_400_000;

const STAGE_POINTS: Record<Company['stage'], number> = {
  'Seed': 15,
  'Pre-seed': 12,
  'Series A': 9,
  'Stealth': 7,
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
  return { key: 'thesis', label: 'Thesis / vertical fit', points, max: 20, rationale };
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
          : 'Stealth — stage unconfirmed.';
  return { key: 'stage', label: 'Stage fit', points, max: 15, rationale };
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
      ? 'No verified self-identification on record. Scored 0 by policy — never inferred from names, photos, or other proxies. Ask during outreach if the founder is open to sharing.'
      : `Publicly identified founder signal (${verified
          .map((f) => `${f.name}: ${f.identity!.basis.toLowerCase()}, ${f.identity!.source}`)
          .join('; ')}). Indicators: ${parts.join(', ') || 'recorded, none matching focus'}.`;
  return { key: 'mission', label: 'Mission alignment (verified only)', points, max: 15, rationale };
}

function tractionSignal(c: Company): ScoreComponent {
  const points = Math.round(c.traction.level);
  return {
    key: 'traction',
    label: 'Traction signal',
    points: Math.min(10, Math.max(0, points)),
    max: 10,
    rationale: `Analyst rating ${c.traction.level}/10 — ${c.traction.note}`,
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

  return {
    key: 'founder',
    label: 'Founder & team evidence',
    points: Math.min(points, 10),
    max: 10,
    rationale: `${parts.join('; ')}. Based only on recorded backgrounds — unknowns stay unscored, and founder count alone never rejects a company.`,
  };
}

function geography(c: Company): ScoreComponent {
  const preferred = PREFERRED_STATES.includes(c.state);
  const unknown = c.state === '??';
  return {
    key: 'geo',
    label: 'Geography',
    points: preferred ? 10 : unknown ? 2 : 4,
    max: 10,
    rationale: preferred
      ? `${c.state} is a preferred state (${PREFERRED_STATES.join(', ')}).`
      : unknown
        ? 'Location unknown — minimal credit until recorded.'
        : `${c.state} is outside preferred states — partial credit; US-based deals remain eligible.`,
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
    key: 'funding',
    label: 'Funding evidence',
    points: Math.min(points, 5),
    max: 5,
    rationale: parts.length > 0 ? `${parts.join('; ')}.` : 'No funding information on record — unscored, not guessed.',
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
    key: 'validation',
    label: 'Accelerator / institutional validation',
    points: Math.min(points, 5),
    max: 5,
    rationale: parts.length > 0 ? `${parts.join('; ')}.` : 'No accelerator or institutional validation on record.',
  };
}

function evidenceQuality(c: Company): ScoreComponent {
  const primary = c.evidence.filter((e) => e.type === 'Filing' || e.type === 'Founder statement').length;
  const points = Math.min(5, c.evidence.length + primary);
  return {
    key: 'evidence',
    label: 'Evidence quality',
    points,
    max: 5,
    rationale: `${c.evidence.length} sourced item(s), ${primary} primary (filings / founder statements). Every recommendation must remain auditable.`,
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
  return { key: 'recency', label: 'Evidence recency', points, max: 5, rationale: detail };
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
  const score = Math.max(1, Math.round(totalPoints) / 10);
  const exceptions = c.flags.map((flag) => ({ flag, message: EXCEPTION_MESSAGES[flag] }));
  const confidence = evidenceConfidence(c);
  const strongest = [...components].sort((a, b) => b.points / b.max - a.points / a.max)[0];
  const weakest = [...components].sort((a, b) => a.points / a.max - b.points / b.max)[0];
  return {
    score,
    totalPoints,
    components,
    exceptions,
    version: SCORING_VERSION,
    evidenceConfidence: confidence,
    explanation: `Vamos Fit Score ${score.toFixed(1)}/10 (${totalPoints}/100 points, model ${SCORING_VERSION}). Strongest component: ${strongest.label} (${strongest.points}/${strongest.max}). Weakest: ${weakest.label} (${weakest.points}/${weakest.max}). Evidence confidence ${Math.round(confidence * 100)}% — a separate measure of how well-sourced the record is, not of thesis fit.`,
  };
}

export const flagLabel = (f: PolicyFlag): string =>
  f === 'defi-adjacent' ? 'DeFi / blockchain exception'
  : f === 'hardware-heavy' ? 'Hardware-heavy'
  : 'Outside core thesis';
