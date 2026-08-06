import { z } from 'zod';
import { VERTICAL_ID_VALUES } from '../src/types';

// ── Phase 4 shared contracts: discovery, stealth, scheduling ─────
// Every claim carries source attribution; unknowns stay 'Unknown' —
// nothing is fabricated to fill a field.

export const DISCOVERY_SOURCES = [
  'yc', 'accelerators', 'websites', 'funding-news', 'investor-news', 'sec', 'github',
  'grants', 'patents', 'research', 'hackathons', 'producthunt',
  'registries', 'upload', 'licensed',
] as const;
export type DiscoverySourceId = (typeof DISCOVERY_SOURCES)[number];

/** Restricted services — requests naming them are rejected outright. */
export const RESTRICTED_SOURCES = ['linkedin', 'pitchbook', 'crunchbase'] as const;

/**
 * Runtime (Zod) source of truth for sector ids, shared by every Zod enum
 * on both tiers. Re-exported from src/types.ts — the ONE canonical list
 * of the five approved verticals (health, fintech, fow, sustainability,
 * frontier; see its doc comment for the Frontier/AI/aoi history) —
 * rather than a second hand-copied array that could drift from it.
 */
export { VERTICAL_ID_VALUES };

/** Same list plus the explicit 'Unknown' escape hatch used by candidates/signals. */
export const VERTICAL_ID_VALUES_WITH_UNKNOWN = [...VERTICAL_ID_VALUES, 'Unknown'] as const;

export const GEOGRAPHIES = ['Preferred states', 'United States', 'LATAM'] as const;
export const PREFERRED_STATES_P4 = ['NM', 'NY', 'NJ', 'OR', 'CA', 'TX', 'IL'] as const;

/**
 * Per-run ceilings for USER-INITIATED discovery, shared by the request
 * schema and the UI controls so the two cannot disagree.
 *
 * Both are deliberately low. A discovery run is a funnel into a HUMAN
 * review queue, and the constraint on that queue is reviewer attention,
 * not how many rows a database can hold. Returning two hundred
 * candidates does not surface more good companies; it buries the good
 * ones and spends tokens and third-party requests doing it.
 */
export const MAX_RESULTS_PER_RUN = 20;
export const MAX_SOURCES_PER_RUN = 3;

export const discoveryQuerySchema = z.object({
  vertical: z.enum(VERTICAL_ID_VALUES).nullable().default(null),
  subcategory: z.string().nullable().default(null),
  areasOfInterest: z.array(z.string()).default([]),
  terms: z.array(z.string().min(2)).max(10).default([]),
  geography: z.enum(GEOGRAPHIES).default('United States'),
  states: z.array(z.string().length(2)).default([]),
  stages: z.array(z.enum(['Pre-seed', 'Seed', 'Series A'])).default(['Pre-seed', 'Seed', 'Series A']),
  sources: z.array(z.enum(DISCOVERY_SOURCES)).min(1),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  maxResults: z.number().int().min(1).max(200).default(MAX_RESULTS_PER_RUN),
  maxApiCalls: z.number().int().min(1).max(100).default(20),
  maxModelCalls: z.number().int().min(0).max(50).default(0),
  maxEstimatedTokens: z.number().int().min(0).max(500_000).default(50_000),
  minConfidence: z.number().min(0).max(1).default(0),
  mode: z.enum(['new-only', 'stale-only', 'all']).default('new-only'),
  /**
   * Evidence-recency threshold (days). A candidate whose evidence is
   * ALL older than this is dropped. Candidates with no dated evidence
   * are never excluded by this — unknowns are never guessed away.
   * null = no recency filter.
   */
  minEvidenceRecencyDays: z.number().int().min(1).max(3650).nullable().default(null),
  /**
   * Refresh-age threshold (days) used only in 'stale-only' mode: a
   * candidate is kept only if it matches an existing company that has
   * gone unrefreshed for at least this long (or was never refreshed).
   */
  staleAfterDays: z.number().int().min(1).max(365).default(30),
  /**
   * PREVIEW (dry-run) mode. The run queries its sources for real and
   * reports exactly what it found, but writes no DATA: no candidate
   * enters the review queue, no run row is written, no company is
   * created, no score is saved, no review decision is recorded, no CRM
   * stage moves, no HubSpot sync and no outreach happens (discovery
   * never did the last four automatically in any mode — preview removes
   * the one thing it did do, which was writing candidate rows a human
   * would later have to dismiss). Candidate and run ids come from an
   * in-memory counter rather than the persisted sequence, so even the
   * id numbering is left where it was.
   *
   * Two deliberate exceptions, both bookkeeping rather than data:
   *   - the run LOCK is still taken and released, because a preview
   *     really is hitting the same third-party sources and should not
   *     run concurrently with a real sweep;
   *   - the audit ledger still records the run, because an unlogged
   *     outbound request is exactly what that ledger exists to catch.
   *
   * This exists so a sourcing change can be VALIDATED against live
   * sources before anyone decides whether its output belongs in the
   * pipeline. Enforced in server/services/discovery.ts, not by the
   * caller, so every entry point (route, script, scheduler) gets it.
   */
  preview: z.boolean().default(false),
  /**
   * Drop candidates the stage-1 thesis filter rejects
   * (server/sourcing/thesisFilter.ts) instead of merely annotating them.
   *
   * DEFAULTS TO TRUE — this is normal discovery behaviour.
   *
   * It shipped as opt-in for one pass so it could be measured before it
   * changed anything. A controlled run across all five verticals then
   * showed 24 rejections with zero false positives: 23 companies whose
   * own cited source named a Series B/C/E, a $2B raise or an
   * acquisition, plus one exact duplicate. Those are companies the firm
   * provably does not invest in, and leaving them in the queue spends
   * the one budget that actually binds — reviewer attention.
   *
   * What this does NOT do, by construction (see thesisFilter.ts):
   *   - it never rejects on an UNKNOWN. Unknown stage, unknown location
   *     and unknown vertical all flow through to human review; only
   *     positive published evidence of ineligibility rejects.
   *   - it never rejects a 'likely' duplicate — only an exact one.
   *   - it does not touch policy EXCEPTIONS (DeFi-adjacent,
   *     hardware-heavy, outside-thesis). Those remain flags for partner
   *     review and are never auto-rejections.
   *   - it triggers no CRM change, sync, or outreach.
   * Every rejection records the published text that caused it, on the
   * candidate and in the run's audit entry.
   *
   * DOCUMENTED OVERRIDE: pass `enforceThesisFilter: false` on the
   * request to get annotate-only behaviour back for a single run — the
   * verdicts are still computed and attached, nothing is dropped. Use it
   * to audit what the filter would remove before trusting it on a new
   * source.
   */
  enforceThesisFilter: z.boolean().default(true),
  /**
   * Minimum stage-2 triage priority (0–100) a candidate must reach to be
   * kept. null = keep everything, which is the default.
   *
   * This orders and filters CANDIDATES only. It is not the VamosVentures Fit
   * Score, cannot change one, and has no relationship to the 8.0 Hot
   * threshold — see server/sourcing/qualitySignals.ts.
   */
  minQualityPriority: z.number().int().min(0).max(100).nullable().default(null),
});
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;

/**
 * What a USER may ask for, as opposed to what the pipeline can express.
 *
 * The cost controls live here rather than on `discoveryQuerySchema`
 * because the two describe genuinely different operations, and capping
 * both would degrade one of them for no saving:
 *
 *   A discovery RUN casts a wide net for companies nobody has seen yet.
 *   It is the expensive one, it is the one a user triggers, and three
 *   well-chosen sources answer the question they actually asked — a
 *   fifteen-source sweep returning twenty rows spends most of its budget
 *   on candidates discarded before a human sees them.
 *
 *   A per-company REFRESH re-checks one company we already hold across
 *   every source that might mention it. Its cost is bounded by the
 *   single company and its own API-call budget, and breadth is the
 *   entire point (see services/companyRefresh.ts).
 *
 * Enforced server-side, at the request boundary, so the limit holds for
 * any client. Validating only in the UI would leave the API open to
 * exactly the expensive run this exists to prevent.
 */
export const discoveryRequestSchema = discoveryQuerySchema.extend({
  sources: z.array(z.enum(DISCOVERY_SOURCES)).min(1).max(
    MAX_SOURCES_PER_RUN,
    `A run may query at most ${MAX_SOURCES_PER_RUN} sources. Choose the ones most likely to answer the question — `
    + 'every extra source costs third-party requests and tokens for candidates that are usually discarded.',
  ),
  maxResults: z.number().int().min(1).max(
    MAX_RESULTS_PER_RUN,
    `A run may return at most ${MAX_RESULTS_PER_RUN} candidates. The limit is reviewer attention, not storage.`,
  ).default(MAX_RESULTS_PER_RUN),
});

export const VERIFICATION_STATUSES = ['Verified', 'Not verified', 'Unknown', 'Requires manual review'] as const;

/** Fact vs. inference vs. unknown — see `assertionType` on candidateEvidenceSchema. */
export const ASSERTION_TYPES = ['fact', 'inference', 'unknown'] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

/** Hard stage-1 rejection codes — see server/sourcing/thesisFilter.ts. */
export const THESIS_REJECTION_CODES = [
  'not-operating-company', 'excluded-business-type', 'past-target-stage', 'outside-geography',
  'outside-approved-vertical', 'inactive', 'duplicate', 'source-credibility',
] as const;

export const thesisCheckSchema = z.object({
  code: z.enum(THESIS_REJECTION_CODES),
  evidence: z.string(),
  reason: z.string(),
});

export const qualitySignalSchema = z.object({
  key: z.string(),
  direction: z.enum(['positive', 'negative']),
  label: z.string(),
  points: z.number(),
  evidence: z.string(),
  sourceUrl: z.string().optional(),
});

export const candidateEvidenceSchema = z.object({
  claim: z.string().min(3),
  source: z.string().min(2),
  url: z.string().url(),
  /** When WE fetched it. Not a publication date — see publishedAt. */
  dateAccessed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * When the SOURCE published or filed it, as YYYY-MM-DD.
   *
   * This field exists because its absence silently killed the entire
   * funding-news pipeline: the RSS adapter knew each article's real
   * publication date, but normalization wrote it into a free-text
   * `notes` string ("Published 2026-07-23") and set `dateAccessed` to
   * the run time. Downstream, opportunity classification could only
   * read `dateAccessed`, concluded "no evidence carries a publication
   * date", and demoted every single RSS candidate to a company lead.
   * 77 candidates, 0 opportunities — entirely from a lost field.
   */
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('Not verified'),
  confidence: z.number().min(0).max(1).default(0.5),
  notes: z.string().default(''),
  /**
   * What KIND of statement this evidence item is — the distinction
   * between "a source printed this" and "we worked this out" and "we do
   * not know", which the record previously could not express at all.
   *
   *   'fact'      the cited source itself states the claim, verbatim.
   *   'inference' we derived it from what the source states (e.g. a YC
   *               batch code read as an approximate date). The URL still
   *               points at the underlying published text.
   *   'unknown'   the field is recorded as unresolved. Never a guess
   *               dressed up as a finding.
   *
   * Defaults to 'fact' because every adapter in this codebase records
   * published text verbatim (server/sourcing/types.ts: "`evidenceText`
   * is what the source actually says, not a summary the adapter
   * invented"), so that is the accurate label for existing rows rather
   * than a convenient one.
   */
  assertionType: z.enum(ASSERTION_TYPES).default('fact'),
});
export type CandidateEvidence = z.infer<typeof candidateEvidenceSchema>;

const unknownable = z.string().min(1).or(z.literal('Unknown')).default('Unknown');

export const discoveryCandidateSchema = z.object({
  id: z.string(),
  runId: z.string(),
  discoveredAt: z.string(),
  sourceId: z.enum(DISCOVERY_SOURCES),
  simulated: z.boolean(),
  /** The source's own record id (repo slug, accession number, …) for exact re-identification. */
  externalId: z.string().nullable().default(null),
  companyName: z.string().min(1),
  website: unknownable,
  pitch: unknownable,
  vertical: z.enum(VERTICAL_ID_VALUES_WITH_UNKNOWN).default('Unknown'),
  subcategory: unknownable,
  stage: z.enum(['Pre-seed', 'Seed', 'Series A', 'Stealth', 'Unknown']).default('Unknown'),
  hqCity: unknownable,
  hqState: unknownable,
  foundingYear: z.number().int().min(1990).max(2100).nullable().default(null),
  founderNames: z.array(z.string()).default([]),
  founderCount: z.number().int().min(0).nullable().default(null),
  accelerator: unknownable,
  publicFunding: unknownable,
  mostRecentRound: unknownable,
  fundingDate: z.string().nullable().default(null),
  tractionSignals: z.array(z.string()).default([]),
  evidence: z.array(candidateEvidenceSchema).min(1, 'Every candidate needs at least one source-attributed evidence item'),
  confidence: z.number().min(0).max(1),
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('Not verified'),
  duplicateStatus: z.enum(['none', 'likely', 'exact']).default('none'),
  duplicateOfId: z.string().nullable().default(null),
  duplicateOfName: z.string().nullable().default(null),
  policyExceptionFlags: z.array(z.enum(['defi-adjacent', 'hardware-heavy', 'outside-thesis'])).default([]),
  suggestedNextStep: z.string().default('Requires manual review'),
  status: z.enum(['pending', 'imported', 'merged', 'dismissed']).default('pending'),

  // ── Two-stage funnel verdicts ─────────────────────────────────
  // Both are nullable and default to null so every candidate written
  // before this existed parses unchanged and reads honestly as "not
  // evaluated" rather than as "evaluated and found to be nothing".
  /** Stage 1 (thesisFilter.ts): did this clear every hard thesis requirement? null = not evaluated. */
  thesisEligible: z.boolean().nullable().default(null),
  /** Every hard requirement it failed, with the published text that failed it. */
  thesisRejections: z.array(thesisCheckSchema).default([]),
  /**
   * Stage 2 (qualitySignals.ts): INTERNAL enrichment-triage priority,
   * 0–100. This is not, and must never be conflated with, the VamosVentures Fit
   * Score — it ranks candidates for research effort, is computed from
   * different inputs, and never reaches scoring_results.
   */
  qualityPriority: z.number().min(0).max(100).nullable().default(null),
  qualityBand: z.enum(['high', 'medium', 'low']).nullable().default(null),
  qualitySignals: z.array(qualitySignalSchema).default([]),
  /** Distinct sources backing this candidate after collapsing syndicated copies of one release. */
  independentSources: z.number().int().min(0).default(0),
});
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;

export const RUN_STATUSES = [
  'Completed', 'Completed with warnings', 'Cancelled', 'Failed', 'Simulated', 'Configured but inactive',
] as const;

export const discoveryRunSchema = z.object({
  id: z.string(),
  /** Start time. */
  at: z.string(),
  /** End time. */
  completedAt: z.string(),
  runType: z.enum(['manual', 'scheduled-weekly', 'scheduled-biweekly']),
  mode: z.enum(['live', 'local', 'simulated', 'mixed']),
  query: discoveryQuerySchema,
  sourceResults: z.array(z.object({
    sourceId: z.string(),
    mode: z.enum(['live', 'local', 'simulated', 'failed', 'skipped']),
    found: z.number(),
    detail: z.string(),
    /** Typed failure state (timeout, rate-limited, invalid-response, …) when mode is failed/skipped. */
    failureKind: z.enum(['timeout', 'rate-limited', 'http-error', 'invalid-response', 'network', 'missing-credentials', 'not-configured']).optional(),
    /** Real elapsed time (ms) of the adapter call — absent for a skip, since nothing ran. Used by source-quality analytics. */
    durationMs: z.number().optional(),
  })),
  discovered: z.number(),
  updatedExisting: z.number(),
  duplicatesSkipped: z.number(),
  /** Every candidate that matched an existing record, exact or likely — regardless of what happened to it afterward. */
  duplicatesIdentified: z.number().default(0),
  /** Candidates dropped by the evidence-recency or refresh-age policy filters (not by schema validation, not as duplicates). */
  filteredByPolicy: z.number().default(0),
  /** Candidates dropped by the stage-1 hard thesis filter (only when `enforceThesisFilter` is on). */
  filteredByThesis: z.number().default(0),
  /** Candidates dropped for falling below `minQualityPriority` (stage-2 triage, never the Vamos score). */
  filteredByQuality: z.number().default(0),
  /** True when this run persisted nothing — see `preview` on the query. */
  preview: z.boolean().default(false),
  rejectedByValidation: z.number(),
  imported: z.number(),
  errors: z.array(z.string()),
  apiCalls: z.number(),
  modelCalls: z.number(),
  estimatedTokens: z.number(),
  estimatedCostUsd: z.number(),
  durationMs: z.number(),
  status: z.enum(RUN_STATUSES),
  initiatedBy: z.string(),
});
export type DiscoveryRun = z.infer<typeof discoveryRunSchema>;

// ── Stealth Founder Radar ────────────────────────────────────────

export const STEALTH_SIGNAL_TYPES = [
  'Public departure announcement', 'New GitHub organization/repository', 'New open-source project',
  'Patent filing', 'Public filing', 'Research publication', 'Accelerator/fellowship/residency', 'Hackathon/demo day',
  'Government grant', 'New company/domain registration', 'Hiring announcement',
  'Public bio states building/founder/stealth', 'Public interview/announcement', 'User-provided public profile',
] as const;

export const stealthSignalSchema = z.object({
  id: z.string(),
  founderName: z.string().min(2),
  previousRole: unknownable,
  previousEmployer: unknownable,
  knownSkills: z.array(z.string()).default([]),
  priorStartups: z.array(z.string()).default([]),
  education: unknownable,
  signalType: z.enum(STEALTH_SIGNAL_TYPES),
  signalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceName: z.string().min(2),
  sourceUrl: z.string().url(),
  dateAccessed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  possibleVertical: z.enum(VERTICAL_ID_VALUES_WITH_UNKNOWN).default('Unknown'),
  possibleTheme: unknownable,
  /** Suspected geography (city/state or region) — 'Unknown' until recorded, never guessed. */
  suspectedGeography: unknownable,
  /** Why this looks like stealth activity — what the source actually says. */
  evidenceSummary: z.string().min(5),
  confidence: z.enum(['Low', 'Medium', 'High']),
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('Not verified'),
  alternativeExplanation: z.string().min(5),
  suggestedNextStep: z.string().min(5),
  assignedTo: z.string().nullable().default(null),
  outreachStatus: z.enum(['None', 'Research queue', 'Outreach approved', 'Draft generated', 'Contacted']).default('None'),
  simulated: z.boolean().default(true),
});
export type StealthSignal = z.infer<typeof stealthSignalSchema>;

/**
 * A hypothesis is ALWAYS labeled hypothesis/unverified/requires-human-
 * review (literal true — the schema cannot represent anything else),
 * and never contains demographic or sensitive-trait inference.
 */
export const founderHypothesisSchema = z.object({
  signalId: z.string(),
  isHypothesis: z.literal(true).default(true),
  unverified: z.literal(true).default(true),
  requiresHumanReview: z.literal(true).default(true),
  likelyVertical: z.string(),
  possibleProductArea: z.string(),
  confidenceBand: z.enum(['Low', 'Medium', 'High']),
  supportingEvidence: z.array(z.string()),
  contradictoryEvidence: z.array(z.string()),
  alternativeHypotheses: z.array(z.string()).min(1, 'At least one alternative must always be presented'),
  missingInformation: z.array(z.string()).min(1),
  demo: z.boolean().default(true),
});
export type FounderHypothesis = z.infer<typeof founderHypothesisSchema>;

// ── Scheduling (configuration; execution gated by RUN_SCHEDULER) ─

export const scheduledJobSchema = z.object({
  id: z.string(),
  cadence: z.enum(['weekly', 'biweekly']),
  jobType: z.enum(['incremental-sourcing', 'full-sourcing', 'stale-refresh', 'source-refresh', 'vertical-refresh']),
  query: discoveryQuerySchema.nullable().default(null),
  enabled: z.boolean().default(false),
  lastRunAt: z.string().nullable().default(null),
});
export type ScheduledJob = z.infer<typeof scheduledJobSchema>;
