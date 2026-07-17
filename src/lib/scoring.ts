import type { Company, FitScore, PolicyFlag, ScoreComponent } from '../types';
import { PREFERRED_STATES, verticalById } from '../data/taxonomy';

/**
 * Vamos Fit Score — 100-point weighted model, displayed as 1.0–10.0.
 *
 *   Thesis / vertical fit ........ 25
 *   Stage fit .................... 20   (Seed strongest, then Pre-seed, Series A)
 *   Mission alignment ............ 20   (verified underrepresented founding team;
 *                                        counts ONLY self-identified / publicly
 *                                        verified indicators — never inferred)
 *   Traction signal .............. 15   (analyst-rated 0–10 with justification)
 *   Geography .................... 10   (preferred states, remainder partial)
 *   Evidence quality ............. 10   (breadth + primary-source weighting)
 *
 * Policy exceptions (DeFi/blockchain, hardware-heavy, outside-thesis)
 * are FLAGS surfaced for partner review — they never auto-reject and
 * never silently zero a score.
 */

const STAGE_POINTS: Record<Company['stage'], number> = {
  'Seed': 20,
  'Pre-seed': 16,
  'Series A': 12,
  'Stealth': 10,
};

const EXCEPTION_MESSAGES: Record<PolicyFlag, string> = {
  'defi-adjacent':
    'DeFi / blockchain is an adjacent or exception category that may conflict with current firm exclusions. Route to partner review — do not auto-reject.',
  'hardware-heavy':
    'Hardware-heavy business model sits outside the firm\u2019s standard software-first thesis. Requires explicit partner sign-off.',
  'outside-thesis':
    'Category is an adjacent area of interest, outside the four core sectors. Score is computed on the adjacent scale and needs partner review.',
};

function thesisFit(c: Company): ScoreComponent {
  const v = verticalById(c.vertical);
  const sub = v.subcategories.find((s) => s.name === c.subcategory);
  let points: number;
  let rationale: string;
  if (!sub) {
    points = 6;
    rationale = `Subcategory "${c.subcategory}" is not in the ${v.name} taxonomy — review classification.`;
  } else if (!v.core) {
    points = 14;
    rationale = `${v.name} is an adjacent-interest area, scored separately from the four core sectors.`;
  } else if (sub.exception) {
    points = 15;
    rationale = `Core sector, but "${sub.name}" is an exception subcategory: ${sub.exception}`;
  } else {
    points = 25;
    rationale = `Direct match: ${v.name} → ${sub.name}.`;
  }
  return { key: 'thesis', label: 'Thesis / vertical fit', points, max: 25, rationale };
}

function stageFit(c: Company): ScoreComponent {
  const points = STAGE_POINTS[c.stage];
  const rationale =
    c.stage === 'Seed'
      ? 'Seed is the firm\u2019s strongest stage focus.'
      : c.stage === 'Pre-seed'
        ? 'Pre-seed is in focus; earlier than the sweet spot.'
        : c.stage === 'Series A'
          ? 'Series A is in range but latest stage the firm leads.'
          : 'Stealth — stage unconfirmed.';
  return { key: 'stage', label: 'Stage fit', points, max: 20, rationale };
}

function missionAlignment(c: Company): ScoreComponent {
  const verified = c.founders.filter((f) => f.identity);
  const latino = verified.some((f) => f.identity!.latinoLed);
  const female = verified.some((f) => f.identity!.femaleLed);
  const other = verified.some((f) => f.identity!.otherUnderrepresented);

  let points = 0;
  const parts: string[] = [];
  if (latino) { points += 10; parts.push('Latino-led'); }
  if (female) { points += 6; parts.push('female-led'); }
  if (other) { points += 4; parts.push('other underrepresented'); }
  points = Math.min(points, 20);

  const rationale =
    verified.length === 0
      ? 'No verified self-identification on record. Scored 0 by policy — never inferred from names, photos, or other proxies. Ask during outreach if the founder is open to sharing.'
      : `Verified (${verified
          .map((f) => `${f.name}: ${f.identity!.basis.toLowerCase()}, ${f.identity!.source}`)
          .join('; ')}). Indicators: ${parts.join(', ') || 'recorded, none matching focus'}.`;
  return { key: 'mission', label: 'Mission alignment (verified only)', points, max: 20, rationale };
}

function tractionSignal(c: Company): ScoreComponent {
  const points = Math.round((c.traction.level / 10) * 10);
  return {
    key: 'traction',
    label: 'Traction signal',
    points,
    max: 10,
    rationale: `Analyst rating ${c.traction.level}/10 — ${c.traction.note}`,
  };
}

/**
 * Founder signal (Phase 4): count preference + recorded experience.
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
  if (prior) { points += 3; parts.push('prior founding experience recorded'); }
  const relevant = /engineer|research|phd|clinic|director|operator|led |head of|scientist|product|ex-|veteran of|big tech|google|meta|amazon|microsoft|stripe/.test(bg);
  if (relevant) { points += 2; parts.push('relevant technical/industry background recorded'); }
  if (c.accelerator) { points += 1; parts.push(`accelerator: ${c.accelerator}`); }

  return {
    key: 'founder',
    label: 'Founder signal',
    points: Math.min(points, 10),
    max: 10,
    rationale: `${parts.join('; ')}. Based only on recorded backgrounds — unknowns stay unscored, and founder count alone never rejects a company.`,
  };
}

function geography(c: Company): ScoreComponent {
  const preferred = PREFERRED_STATES.includes(c.state);
  return {
    key: 'geo',
    label: 'Geography',
    points: preferred ? 10 : 4,
    max: 10,
    rationale: preferred
      ? `${c.state} is a preferred state (${PREFERRED_STATES.join(', ')}).`
      : `${c.state} is outside preferred states — partial credit; US-based deals remain eligible.`,
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

export function scoreCompany(c: Company): FitScore {
  const components = [
    thesisFit(c),
    stageFit(c),
    missionAlignment(c),
    tractionSignal(c),
    founderSignal(c),
    geography(c),
    evidenceQuality(c),
  ];
  const totalPoints = components.reduce((s, x) => s + x.points, 0);
  const score = Math.max(1, Math.round(totalPoints) / 10);
  const exceptions = c.flags.map((flag) => ({ flag, message: EXCEPTION_MESSAGES[flag] }));
  return { score, totalPoints, components, exceptions };
}

export const flagLabel = (f: PolicyFlag): string =>
  f === 'defi-adjacent' ? 'DeFi / blockchain exception'
  : f === 'hardware-heavy' ? 'Hardware-heavy'
  : 'Outside core thesis';
