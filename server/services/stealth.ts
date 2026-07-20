import { z } from 'zod';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import {
  founderHypothesisSchema, stealthSignalSchema,
  type FounderHypothesis, type StealthSignal,
} from '../../shared/discovery';

/**
 * Stealth Founder Radar. Signals come from authorized public sources
 * or explicit user input (a pasted public-profile URL is stored as
 * evidence — NEVER crawled). Hypotheses are generated ONLY from the
 * recorded signal fields, are permanently labeled hypothesis /
 * unverified / requires-human-review, always carry at least one
 * alternative, and never touch names, photos, schools, locations,
 * languages, or networks to infer sensitive traits.
 */

/**
 * No seeded or simulated signals: the feed starts empty and only ever
 * contains records from authorized sources or explicit user entry.
 * Any legacy simulated records left over from earlier builds are
 * filtered out on read.
 */
export function listSignals(): StealthSignal[] {
  return z
    .array(stealthSignalSchema)
    .catch([])
    .parse(store.raw.stealthSignals)
    .filter((s) => !s.simulated);
}

const signalInputSchema = stealthSignalSchema.omit({ id: true, simulated: true });

export function addSignal(raw: unknown): StealthSignal {
  const parsed = signalInputSchema.parse(raw);
  const signal: StealthSignal = { ...parsed, simulated: false, id: store.nextId('sig') };
  store.raw.stealthSignals = [...listSignals(), signal];
  store.save();
  audit({ provider: 'system', mode: 'local', action: 'stealth-signal-add', subject: signal.id, outcome: 'ok', detail: `${signal.signalType} — source ${signal.sourceName}` });
  return signal;
}

const signalPatchSchema = z.object({
  assignedTo: z.string().nullable().optional(),
  outreachStatus: z.enum(['None', 'Research queue', 'Outreach approved', 'Draft generated', 'Contacted']).optional(),
  verificationStatus: z.enum(['Verified', 'Not verified', 'Unknown', 'Requires manual review']).optional(),
});

export function patchSignal(id: string, raw: unknown): StealthSignal {
  const patch = signalPatchSchema.parse(raw);
  const signals = listSignals();
  const idx = signals.findIndex((s) => s.id === id);
  if (idx === -1) throw Object.assign(new Error('Signal not found.'), { status: 404 });
  signals[idx] = { ...signals[idx], ...patch };
  store.raw.stealthSignals = signals;
  store.save();
  return signals[idx];
}

// ── Hypothesis (deterministic, evidence-bound) ───────────────────

/** Fields a hypothesis may draw on. Identity-adjacent fields are structurally excluded. */
function hypothesisInputs(s: StealthSignal) {
  return {
    signalType: s.signalType,
    previousRole: s.previousRole,
    knownSkills: s.knownSkills,
    priorStartups: s.priorStartups,
    possibleVertical: s.possibleVertical,
    possibleTheme: s.possibleTheme,
    evidenceSummary: s.evidenceSummary,
    confidence: s.confidence,
    // Deliberately excluded: founderName, education institution names, employer
    // names, locations — no sensitive-trait inference from proxies, ever.
  };
}

export function generateHypothesis(signalId: string): FounderHypothesis {
  const s = listSignals().find((x) => x.id === signalId);
  if (!s) throw Object.assign(new Error('Signal not found.'), { status: 404 });
  const inp = hypothesisInputs(s);

  const supporting: string[] = [];
  if (inp.possibleVertical !== 'Unknown') supporting.push(`Recorded signal points at ${inp.possibleVertical}: ${inp.evidenceSummary}`);
  if (inp.knownSkills.length > 0) supporting.push(`Stated skills/experience: ${inp.knownSkills.join(', ')} (from the recorded source only).`);
  if (inp.priorStartups.length > 0) supporting.push(`Prior founding experience on record: ${inp.priorStartups.join('; ')}.`);
  if (supporting.length === 0) supporting.push(`Only the raw signal itself: ${inp.evidenceSummary}`);

  const contradictory: string[] = [s.alternativeExplanation];
  if (s.verificationStatus !== 'Verified') contradictory.push('No item in this record is verified yet — the underlying signal itself could be stale or misread.');

  const missing: string[] = [];
  if (s.possibleVertical === 'Unknown') missing.push('No vertical indication yet — needs a public statement or product artifact.');
  missing.push('No incorporation filing, website, or public company announcement on record.');
  if (s.education === 'Unknown') missing.push('Background details unconfirmed (only if the founder chooses to share them).');

  const alternatives = [
    s.alternativeExplanation,
    inp.signalType === 'New GitHub organization/repository'
      ? 'Open-source hobby project with no commercial intent.'
      : 'Career move to an existing company rather than founding one.',
  ];

  const hypothesis = founderHypothesisSchema.parse({
    signalId,
    isHypothesis: true,
    unverified: true,
    requiresHumanReview: true,
    likelyVertical: inp.possibleVertical === 'Unknown'
      ? 'Unknown — the recorded evidence does not support a vertical guess'
      : `${inp.possibleVertical} (hypothesis only)`,
    possibleProductArea: inp.possibleTheme === 'Unknown'
      ? 'Unknown — requires manual research'
      : `${inp.possibleTheme} (hypothesis only)`,
    confidenceBand: inp.confidence,
    supportingEvidence: supporting,
    contradictoryEvidence: contradictory,
    alternativeHypotheses: alternatives,
    missingInformation: missing,
    demo: true, // deterministic template — no model call
  });
  audit({ provider: 'system', mode: 'local', action: 'stealth-hypothesis', subject: signalId, outcome: 'ok', detail: `band ${inp.confidence}; labeled hypothesis/unverified/requires-human-review` });
  return hypothesis;
}
