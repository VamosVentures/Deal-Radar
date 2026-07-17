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

const today = () => new Date().toISOString().slice(0, 10);

const SEEDED: Omit<StealthSignal, 'id'>[] = [
  {
    founderName: 'J. Almeida (fictional)',
    previousRole: 'Staff engineer, payments team',
    previousEmployer: 'Large fintech (simulated)',
    knownSkills: ['payments infrastructure', 'ledger systems'],
    priorStartups: [],
    education: 'Unknown',
    signalType: 'New GitHub organization/repository',
    signalDate: '2026-06-20',
    sourceName: 'Simulated: GitHub public activity',
    sourceUrl: 'https://example.com/sim/github/almeida-labs',
    dateAccessed: today(),
    possibleVertical: 'fintech',
    possibleTheme: 'ledger tooling',
    evidenceSummary: 'Simulated fixture: new public org "almeida-labs" with two ledger-related repositories created in June 2026.',
    confidence: 'Medium',
    verificationStatus: 'Not verified',
    alternativeExplanation: 'Could be a personal side project or open-source contribution unrelated to a company.',
    suggestedNextStep: 'Watch repo activity for org growth; check for a public company announcement before any outreach.',
    assignedTo: null,
    outreachStatus: 'None',
    simulated: true,
  },
  {
    founderName: 'S. Quintero (fictional)',
    previousRole: 'Clinical operations lead',
    previousEmployer: 'Regional health system (simulated)',
    knownSkills: ['care coordination', 'clinical ops'],
    priorStartups: ['One prior founded company (simulated bio)'],
    education: 'Unknown',
    signalType: 'Public bio states building/founder/stealth',
    signalDate: '2026-07-01',
    sourceName: 'Simulated: conference speaker bio',
    sourceUrl: 'https://example.com/sim/conf/quintero',
    dateAccessed: today(),
    possibleVertical: 'health',
    possibleTheme: 'care navigation',
    evidenceSummary: 'Simulated fixture: public speaker bio reads "building something new in care navigation".',
    confidence: 'High',
    verificationStatus: 'Not verified',
    alternativeExplanation: 'The phrase may describe an internal initiative at the current employer rather than a new company.',
    suggestedNextStep: 'Look for an incorporation filing or website; verify the bio is current.',
    assignedTo: null,
    outreachStatus: 'Research queue',
    simulated: true,
  },
];

export function listSignals(): StealthSignal[] {
  let signals = z.array(stealthSignalSchema).catch([]).parse(store.raw.stealthSignals);
  if (signals.length === 0 && store.raw.stealthSignals.length === 0) {
    signals = SEEDED.map((s) => ({ ...s, id: store.nextId('sig') }));
    store.raw.stealthSignals = signals;
    store.save();
  }
  return signals;
}

const signalInputSchema = stealthSignalSchema.omit({ id: true }).extend({
  simulated: z.boolean().default(false), // manual entries are real user-provided records
});

export function addSignal(raw: unknown): StealthSignal {
  const parsed = signalInputSchema.parse(raw);
  const signal: StealthSignal = { ...parsed, id: store.nextId('sig') };
  store.raw.stealthSignals = [...listSignals(), signal];
  store.save();
  audit({ provider: 'system', mode: 'mock', action: 'stealth-signal-add', subject: signal.id, outcome: 'ok', detail: `${signal.signalType} — source ${signal.sourceName}` });
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
  audit({ provider: 'system', mode: 'mock', action: 'stealth-hypothesis', subject: signalId, outcome: 'ok', detail: `band ${inp.confidence}; labeled hypothesis/unverified/requires-human-review` });
  return hypothesis;
}
