import { z } from 'zod';

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
 * Runtime source of truth for sector ids, shared by every Zod enum on
 * both tiers. Robotics, Space Tech, and General AI were promoted from
 * `aoi` subcategories to first-class sectors; `aoi` remains as the
 * genuine catch-all. Mirrors the VerticalId union in src/types.ts and
 * the VERTICALS table in src/data/taxonomy.ts — change all three
 * together.
 */
export const VERTICAL_ID_VALUES = [
  'health', 'fintech', 'fow', 'sustainability', 'robotics', 'spacetech', 'ai', 'aoi',
] as const;

/** Same list plus the explicit 'Unknown' escape hatch used by candidates/signals. */
export const VERTICAL_ID_VALUES_WITH_UNKNOWN = [...VERTICAL_ID_VALUES, 'Unknown'] as const;

export const GEOGRAPHIES = ['Preferred states', 'United States', 'LATAM'] as const;
export const PREFERRED_STATES_P4 = ['NM', 'NY', 'NJ', 'OR', 'CA', 'TX', 'IL'] as const;

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
  maxResults: z.number().int().min(1).max(200).default(25),
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
});
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;

export const VERIFICATION_STATUSES = ['Verified', 'Not verified', 'Unknown', 'Requires manual review'] as const;

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
