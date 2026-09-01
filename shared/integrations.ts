// ─────────────────────────────────────────────────────────────────
// Shared integration contracts — imported by BOTH the React app and
// the Express backend so payloads are validated with the same Zod
// schemas on each side of the wire.
// ─────────────────────────────────────────────────────────────────
import { z } from 'zod';

// ── Modes & connection status ────────────────────────────────────

export type IntegrationMode = 'disconnected' | 'live';

export const integrationConnectionSchema = z.object({
  provider: z.enum(['hubspot', 'outlook', 'ai']),
  mode: z.enum(['disconnected', 'live']),
  connected: z.boolean(),
  account: z.string().nullable(), // portal id / mailbox / model name
  detail: z.string(), // human-readable status line
  permissions: z.array(z.string()),
  lastConnectedAt: z.string().nullable(),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

export interface IntegrationsStatus {
  mode: IntegrationMode;
  hubspot: IntegrationConnection;
  outlook: IntegrationConnection;
  ai: IntegrationConnection;
}

// ── Evidence & identity guardrails ───────────────────────────────

export const sourceEvidenceSchema = z.object({
  claim: z.string().min(3),
  source: z.string().min(3),
  url: z.string().min(4),
  date: z.string(),
  type: z.string(),
});
export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;

/**
 * Demographic data may cross the wire ONLY with all four of:
 * stated basis, named source, source URL/identifier, verification
 * status. Anything less is rejected server-side before any CRM write.
 * Nothing is ever inferred.
 */
export const verifiedDemographicSchema = z.object({
  indicator: z.string().min(2), // e.g. "Latino-led", "Female-led"
  basis: z.enum(['Self-identified', 'Verified public statement']),
  sourceName: z.string().min(8, 'Demographic claims require a named source'),
  sourceRef: z.string().min(4, 'Demographic claims require a source URL or identifier'),
  verificationStatus: z.enum(['Verified', 'Self-reported']),
});
export type VerifiedDemographic = z.infer<typeof verifiedDemographicSchema>;

// ── HubSpot record payloads ──────────────────────────────────────
//
// These map onto Vamos's OWN pre-existing HubSpot Company/Deal/Contact
// properties — the same ones every other deal in the portal carries,
// whether sourced by Deal Radar or entered any other way. No `vamos_*`
// custom property is ever created or written; see server/services/
// hubspot.ts's buildCompanyProperties/buildDealProperties for the exact
// internal property names, pulled from the live portal schema.
//
// A field with no corresponding property in Vamos's schema (fit score,
// rationale, risks, evidence, sourcing status, source URLs, the Deal
// Radar link) is never invented as a new property — it goes into a
// HubSpot Note attached at sync time instead (see buildSyncNoteBody).

/** HubSpot `industry_` (Company) — a fixed dropdown; values match src/data/taxonomy.ts vertical names exactly. */
export const HUBSPOT_INDUSTRY_OPTIONS = ['Consumer', 'Health & Wellness', 'EdTech', 'FinTech', 'Frontier', 'Future of Work', 'Sustainability', 'Other', 'AI'] as const;

/** HubSpot `round_currently_raising` (Company) — a fixed dropdown. */
export const HUBSPOT_ROUND_OPTIONS = ['Angel / Angel+', 'Pre-Seed / Pre-Seed+', 'Seed / Seed+', 'Series A / Series A+', 'Series B / Series B+', 'Series C / Series C+', 'Series D / Series D+', 'Series E / Series E+'] as const;

/** HubSpot `total_raising_for_round` (Company) — a fixed bucketed-range dropdown. */
export const HUBSPOT_RAISE_RANGE_OPTIONS = ['$0-1,000,000', '$1,000,000-5,000,000', '$5,000,000-10,000,000', '$10,000,000-20,000,000', '$20,000,000+'] as const;

/** HubSpot `top_accelerator_participation` (Company) — a fixed dropdown. "Other"/"Not applicable" are never auto-written — an unmatched accelerator is left unset and named in the sync Note instead. */
export const HUBSPOT_ACCELERATOR_OPTIONS = ['Techstars', '500 Global', 'Y Combinator', 'Plug & Play', 'MassChallenge', 'SOSV', 'ERA', 'Alchemist', 'AngelPad', 'StartX', 'IndieBio', 'Betaworks', 'DreamIt', 'Startupbootcamp', 'HAX'] as const;

/**
 * HubSpot `diverse_group` (Company) — a fixed dropdown, single-select.
 * "Not applicable" is excluded here on purpose: Deal Radar never asserts
 * a NEGATIVE demographic claim, only ever a verified positive one.
 */
export const HUBSPOT_DIVERSE_GROUP_OPTIONS = ['Asian', 'Black or African American', 'Caucasian', 'Disabled Person', 'Hispanic', 'LGBTQ+', 'Middle Eastern or Middle Eastern American', 'Native Hawaiian or other Pacific Islander', 'American Indian or Alaskan Native', 'Veteran', 'Women', 'First-generation college student', 'Other'] as const;

export const hubspotFounderSlotSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  linkedin: z.string().nullable(),
  jobTitle: z.string(),
});
/** One of HubSpot's five `founder_name__N`/`founder_email__N`/`founder_linkedin__N`/`founder__N_job_title` slots. */
export type HubSpotFounderSlot = z.infer<typeof hubspotFounderSlotSchema>;
export const HUBSPOT_MAX_FOUNDER_SLOTS = 5;

export const hubspotCompanyRecordSchema = z.object({
  name: z.string().min(1),
  domain: z.string().nullable(),
  website: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  country: z.string().default('United States'),
  description: z.string(),
  /** One of HUBSPOT_INDUSTRY_OPTIONS. */
  industry: z.string(),
  /** One of HUBSPOT_ROUND_OPTIONS, or null when Deal Radar's stage doesn't bucket cleanly into one. */
  roundCurrentlyRaising: z.string().nullable().default(null),
  /** One of HUBSPOT_RAISE_RANGE_OPTIONS, or null when the raise amount can't be parsed into a bucket. */
  totalRaisingForRound: z.string().nullable().default(null),
  /** One of HUBSPOT_ACCELERATOR_OPTIONS, or null when the named accelerator isn't on HubSpot's fixed list. */
  acceleratorParticipation: z.string().nullable().default(null),
  /** One of HUBSPOT_DIVERSE_GROUP_OPTIONS, taken from the first verified founder demographic on record (single-select field), or null. */
  diverseGroup: z.string().nullable().default(null),
  /** Free-text detail — set only alongside diverseGroup === 'Other'. */
  diverseGroupOther: z.string().nullable().default(null),
  /** Up to HUBSPOT_MAX_FOUNDER_SLOTS, in order. */
  founders: z.array(hubspotFounderSlotSchema).max(HUBSPOT_MAX_FOUNDER_SLOTS).default([]),
  /**
   * Deal Radar's own bookkeeping — NEVER sent to HubSpot as a property.
   * Used only to look up the locally-persisted hubspot_company_id/
   * hubspot_deal_id link and to build the sync Note's back-link.
   */
  dealRadarId: z.string(),
  dealRadarUrl: z.string(),
});
export type HubSpotCompanyRecord = z.infer<typeof hubspotCompanyRecordSchema>;

/**
 * Bucket a free-text stage into one of HubSpot's fixed
 * `round_currently_raising` options. Deal Radar's Stage type includes
 * states (Stealth, Bootstrapped, Grant-funded, Pre-launch, "round not
 * publicly disclosed", "manual review required") that have no honest
 * fundraising-round bucket — those return null rather than guess.
 */
export function mapStageToRound(stage: string): (typeof HUBSPOT_ROUND_OPTIONS)[number] | null {
  switch (stage) {
    case 'Pre-seed': return 'Pre-Seed / Pre-Seed+';
    case 'Seed': return 'Seed / Seed+';
    case 'Series A': return 'Series A / Series A+';
    case 'Series B+': return 'Series B / Series B+';
    default: return null;
  }
}

/**
 * Bucket a free-text raise amount (e.g. "$3.5M seed", "$500K") into one
 * of HubSpot's fixed `total_raising_for_round` ranges. Returns null
 * when no dollar figure can be confidently parsed out — never a guess.
 */
export function bucketRaiseAmount(raising: string | null | undefined): (typeof HUBSPOT_RAISE_RANGE_OPTIONS)[number] | null {
  if (!raising) return null;
  const m = raising.match(/\$\s*([\d,.]+)\s*([kKmM])?/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = m[2]?.toLowerCase();
  const dollars = unit === 'k' ? num * 1_000 : unit === 'm' ? num * 1_000_000 : num;
  if (dollars < 1_000_000) return '$0-1,000,000';
  if (dollars < 5_000_000) return '$1,000,000-5,000,000';
  if (dollars < 10_000_000) return '$5,000,000-10,000,000';
  if (dollars < 20_000_000) return '$10,000,000-20,000,000';
  return '$20,000,000+';
}

/** Match a free-text accelerator name against HubSpot's fixed list. Returns null (never "Other") on no confident match — the real name still reaches the sync Note. */
export function matchAcceleratorOption(accelerator: string | null | undefined): (typeof HUBSPOT_ACCELERATOR_OPTIONS)[number] | null {
  if (!accelerator) return null;
  const norm = accelerator.trim().toLowerCase();
  return HUBSPOT_ACCELERATOR_OPTIONS.find((opt) => norm.includes(opt.toLowerCase()) || opt.toLowerCase().includes(norm)) ?? null;
}

/**
 * Map verified founder demographic indicators onto HubSpot's single-
 * select `diverse_group` dropdown. Only ever reads VerifiedDemographic
 * entries that already passed verifiedDemographicSchema (named source +
 * basis) — nothing is inferred here, only translated into the fixed
 * option list HubSpot requires. The field is single-select, so when
 * multiple distinct indicators exist across founders, the first one
 * found wins; the rest still appear in the sync Note.
 */
export function mapDiverseGroup(demographics: VerifiedDemographic[]): { diverseGroup: string | null; diverseGroupOther: string | null } {
  if (demographics.length === 0) return { diverseGroup: null, diverseGroupOther: null };
  const KEYWORDS: [RegExp, (typeof HUBSPOT_DIVERSE_GROUP_OPTIONS)[number]][] = [
    [/latin|hispanic/i, 'Hispanic'],
    [/female|women/i, 'Women'],
    [/black|african/i, 'Black or African American'],
    [/veteran/i, 'Veteran'],
    [/lgbtq/i, 'LGBTQ+'],
    [/asian/i, 'Asian'],
    [/disab/i, 'Disabled Person'],
    [/middle east/i, 'Middle Eastern or Middle Eastern American'],
    [/pacific islander|native hawaiian/i, 'Native Hawaiian or other Pacific Islander'],
    [/native american|american indian|alaska/i, 'American Indian or Alaskan Native'],
    [/first.gen/i, 'First-generation college student'],
    [/caucasian|white/i, 'Caucasian'],
  ];
  const indicator = demographics[0].indicator;
  const matched = KEYWORDS.find(([re]) => re.test(indicator));
  return matched ? { diverseGroup: matched[1], diverseGroupOther: null } : { diverseGroup: 'Other', diverseGroupOther: indicator };
}

export const hubspotContactRecordSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string(),
  email: z.string().email().nullable(),
  jobTitle: z.string(),
  linkedinUrl: z.string().nullable(),
  companyName: z.string(),
  infoSource: z.string(),
  verificationStatus: z.enum(['Verified', 'Unverified']),
  relationshipOwner: z.string().nullable(),
  lastOutreachDate: z.string().nullable(),
  /** Optional; every entry must independently satisfy the guardrail schema. */
  demographics: z.array(verifiedDemographicSchema).default([]),
});
export type HubSpotContactRecord = z.infer<typeof hubspotContactRecordSchema>;

/**
 * Whether a person may be written to HubSpot as a contact.
 *
 * Lives here, in shared, rather than in the client's CRM helpers,
 * because BOTH tiers have to agree and the server has to be the one that
 * actually enforces it — a rule only the UI applies is a rule anyone
 * with the API can skip.
 *
 * Two exclusions, for the same underlying reason:
 *
 *   - Placeholder rows. The imported founders table still carries
 *     "Unknown founder" for most companies. Syncing one creates a
 *     contact literally named that in a CRM the whole team shares and
 *     builds outreach from.
 *
 *   - Single-token names. They cannot be matched against an existing
 *     record, so they create a duplicate person instead of finding the
 *     real one.
 *
 * Probable founder CANDIDATES are excluded too, but upstream of this
 * function: a candidate is a person the research found and is not
 * willing to assert, and writing it to a shared system of record
 * asserts it permanently. Only a verified founder reaches here.
 */
export function isSyncableContactName(name: string): boolean {
  const trimmed = (name ?? '').trim();
  if (trimmed.length < 3) return false;
  if (/\bunknown\b/i.test(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length >= 2;
}

/** "Unknown" is what the importer wrote when a source stated no role. An empty title is honest; the word is not. */
export function cleanJobTitle(role: string): string {
  return /^unknown$/i.test((role ?? '').trim()) ? '' : role;
}

export const hubspotDealRecordSchema = z.object({
  companyName: z.string().min(1),
  fitScore: z.number().min(1).max(10),
  recommendation: z.string(),
  vertical: z.string(),
  stage: z.string(),
  scoreBreakdown: z.array(
    z.object({ label: z.string(), points: z.number(), max: z.number() }),
  ),
  rationale: z.string(),
  risks: z.string(),
  evidenceQualityScore: z.number(),
  policyException: z.string().nullable(),
  sourcingStatus: z.string(),
  dateSurfaced: z.string(),
  nextAction: z.string(),
  relationshipOwner: z.string().nullable(),
  dealRadarId: z.string(),
  dealRadarUrl: z.string(),
  /** Plain-language scoring explanation (model version + strongest/weakest components). */
  scoreExplanation: z.string().default(''),
  /** Who approved the sync and when — recorded on the HubSpot deal. */
  approvedBy: z.string().nullable().default(null),
  approvalDate: z.string().nullable().default(null),
  /** Evidence source URLs backing the recommendation. */
  sourceUrls: z.array(z.string()).default([]),
});
export type HubSpotDealRecord = z.infer<typeof hubspotDealRecordSchema>;

// ── Radar → HubSpot pipeline mapping ─────────────────────────────

export const RADAR_HUBSPOT_STAGES = [
  'Surfaced',
  'Needs Review',
  'Approved to Track',
  'Outreach Approved',
  'Outreach Drafted',
  'Founder Contacted',
  'Meeting Scheduled',
  'Active Diligence',
  'Monitor',
  'Passed',
] as const;
export type RadarHubSpotStage = (typeof RADAR_HUBSPOT_STAGES)[number];

export const hubspotPipelineMappingSchema = z.object({
  pipelineId: z.string().min(1),
  pipelineLabel: z.string(),
  stages: z.record(z.string(), z.string()), // RadarHubSpotStage -> HubSpot stage id
});
export type HubSpotPipelineMapping = z.infer<typeof hubspotPipelineMappingSchema>;

export interface HubSpotPipelineInfo {
  id: string;
  label: string;
  stages: { id: string; label: string }[];
}

// ── Company review status (internal — distinct from HubSpot stages) ─
// A deliberately small lifecycle for the review queue itself. This is
// NOT the HubSpot pipeline (RADAR_HUBSPOT_STAGES above maps to that
// external CRM); it is Deal Radar's own screening status. 'Stale' is
// never stored here — it is a computed overlay (see companyMetaView)
// based on how long a non-terminal company has gone unreviewed.

export const COMPANY_STATUSES = [
  'New',
  'Awaiting Review',
  'Research Needed',
  'Approved for HubSpot',
  'Synced to HubSpot',
  'Monitor',
  'Passed',
  // Distinct from 'Passed': 'Passed' is Vamos's own investment decision
  // (we looked and declined); this is an objective fact about the company
  // itself — it was acquired, shut down, or is otherwise no longer an
  // independent operating company — and applies regardless of whether
  // Vamos ever reviewed it. Kept separate so a report can later tell
  // "we passed" apart from "there was nothing left to pass on."
  'Acquired / Inactive',
] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/** Statuses for which staleness no longer matters — the review is done. */
export const TERMINAL_COMPANY_STATUSES: readonly CompanyStatus[] = ['Passed', 'Synced to HubSpot', 'Acquired / Inactive'];

/** Default age (days) after which a non-terminal company is flagged Stale. */
export const DEFAULT_STALE_AFTER_DAYS = 30;

/**
 * Administrator-configurable stale-record settings (Phase 10). Stored via
 * the generic sourcing_config key/value store (getConfig/setConfig) under
 * key STALE_SETTINGS_KEY — no server restart or code change needed to
 * change how staleness is computed. Distinct from (and not to be confused
 * with): a schedule job's "refresh age" (drives the stale-record-refresh
 * job type) and a discovery query's evidence-recency filter (drops
 * candidates by evidence age, not company display status).
 */
export const staleSettingsSchema = z.object({
  /** Days since last_refreshed/discoveredAt/createdAt before a non-terminal company is flagged Stale. */
  staleAfterDays: z.number().int().min(1).max(365).default(DEFAULT_STALE_AFTER_DAYS),
  /** Whether a company in 'Monitor' status can be flagged Stale. */
  monitorGoesStale: z.boolean().default(true),
  /** Whether a company in 'Research Needed' status can be flagged Stale. */
  researchNeededGoesStale: z.boolean().default(true),
  /** Whether the Overview page shows the Stale-companies metric/list at all. */
  showStaleOnOverview: z.boolean().default(true),
  /** Cap on how many stale companies Overview will enumerate/link to (the count itself is never capped). */
  maxStaleOnOverview: z.number().int().min(1).max(500).default(50),
  /** Whether the Companies page's stale filter is pre-selected when the page loads. */
  defaultStaleFilter: z.enum(['all', 'stale-only', 'exclude-stale']).default('all'),
});
export type StaleSettings = z.infer<typeof staleSettingsSchema>;
export const DEFAULT_STALE_SETTINGS: StaleSettings = staleSettingsSchema.parse({});
export const STALE_SETTINGS_KEY = 'stale-settings';

// ── Sync request / result ────────────────────────────────────────

export const companySyncRequestSchema = z.object({
  company: hubspotCompanyRecordSchema,
  contacts: z.array(hubspotContactRecordSchema),
  deal: hubspotDealRecordSchema,
  radarStage: z.enum(RADAR_HUBSPOT_STAGES),
  duplicateResolution: z.enum(['create-new', 'update-existing']).default('create-new'),
  existingRecordId: z.string().nullable().default(null),
});
export type CompanySyncRequest = z.infer<typeof companySyncRequestSchema>;

export interface DuplicateMatch {
  recordId: string;
  name: string;
  domain: string | null;
  /** What matched: domain, name, or founder email. Idempotency for a record Deal Radar already synced is handled separately, via its own locally-persisted hubspot_company_id/hubspot_deal_id link — not a HubSpot-side property. */
  matchedOn: 'domain' | 'name' | 'founder-email';
  url: string | null; // link into HubSpot when live
  demo: boolean;
}

export interface SyncResult {
  demo: boolean;
  companyId: string;
  companyUrl: string | null;
  contactIds: string[];
  dealId: string;
  dealUrl: string | null;
  action: 'created' | 'updated';
  message: string;
}

// ── Outreach generation ──────────────────────────────────────────

export const OUTREACH_TONES = [
  'Warm and conversational',
  'Concise and direct',
  'Thesis-focused',
  'Founder-first',
  'Formal',
  'Custom',
] as const;
export type OutreachTone = (typeof OUTREACH_TONES)[number];

export const emailGenContextSchema = z.object({
  companyId: z.string(),
  companyName: z.string().min(1),
  companyDescription: z.string(),
  vertical: z.string(),
  subcategory: z.string(),
  whyFits: z.string(),
  founderFirstName: z.string().min(1),
  founderFullName: z.string(),
  founderRole: z.string(),
  founderEmail: z.string().email().nullable(),
  /** Verified background detail — only pass facts with a source. */
  verifiedFounderDetail: z.string().nullable(),
  recentMilestone: z.string().nullable(),
  acceleratorOrFunding: z.string().nullable(),
  sourceLinks: z.array(z.object({ label: z.string(), url: z.string() })),
  senderName: z.string().min(1),
  senderRole: z.string(),
  tone: z.enum(OUTREACH_TONES),
  customInstructions: z.string().default(''),
  meetingAsk: z.string().default('a 25-minute intro call in the next two weeks'),
});
export type EmailGenContext = z.infer<typeof emailGenContextSchema>;

export const generatedEmailSchema = z.object({
  subject: z.string().min(3),
  body: z.string().min(30),
  rationale: z.string(),
  sources: z.array(z.object({ label: z.string(), url: z.string() })),
  weakEvidence: z.boolean(),
  warnings: z.array(z.string()),
  demo: z.boolean(),
});
export type GeneratedEmail = z.infer<typeof generatedEmailSchema>;

// ── Outreach records, drafts, activity, follow-ups ───────────────

export const outreachDraftSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  senderName: z.string(),
  tone: z.string(),
  outlookDraftId: z.string().nullable(),
  outlookWebLink: z.string().nullable(),
  demo: z.boolean(),
  createdAt: z.string(),
});
export type OutreachDraft = z.infer<typeof outreachDraftSchema>;

// ── Audit log & errors ───────────────────────────────────────────

export const integrationAuditLogSchema = z.object({
  id: z.string(),
  at: z.string(),
  provider: z.enum(['hubspot', 'outlook', 'ai', 'system']),
  mode: z.enum(['live', 'local']),
  action: z.string(),
  subject: z.string(), // e.g. company id — never bodies or tokens
  outcome: z.enum(['ok', 'blocked', 'error']),
  detail: z.string(),
});
export type IntegrationAuditLog = z.infer<typeof integrationAuditLogSchema>;

export const integrationErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  issues: z.array(z.string()).optional(),
});
export type IntegrationError = z.infer<typeof integrationErrorSchema>;

// ── Helpers shared by both sides ─────────────────────────────────

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const noProto = trimmed.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const host = noProto.split(/[/?#]/)[0];
  return host.includes('.') ? host : null;
}

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'’]/g, '')
    .replace(/\b(inc|llc|ltd|corp|co|labs|technologies|tech)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── AI analysis (Phase 3): structured, Zod-validated outputs ─────

export const fitExplainContextSchema = z.object({
  companyId: z.string(),
  companyName: z.string().min(1),
  vertical: z.string(),
  subcategory: z.string(),
  stage: z.string(),
  score: z.number(),
  components: z.array(z.object({ label: z.string(), points: z.number(), max: z.number(), rationale: z.string() })),
  exceptions: z.array(z.string()),
});
export type FitExplainContext = z.infer<typeof fitExplainContextSchema>;

export const fitExplanationSchema = z.object({
  summary: z.string().min(20),
  strengths: z.array(z.string()).min(1),
  concerns: z.array(z.string()),
  suggestedNextStep: z.string(),
  demo: z.boolean(),
  cached: z.boolean().default(false),
});
export type FitExplanation = z.infer<typeof fitExplanationSchema>;

export const portfolioCompanySchema = z.object({
  name: z.string().min(1),
  vertical: z.string(),
  stage: z.string(),
  status: z.string().default('Active'),
  // Phase 4 additions — all defaulted so Phase 3 records keep parsing.
  website: z.string().default(''),
  themes: z.array(z.string()).default([]),
  publicDescription: z.string().default(''),
  investmentDate: z.string().default(''), // only when publicly available
  evidenceUrls: z.array(z.string()).default([]),
  partnershipThemes: z.array(z.string()).default([]),
  competitiveOverlapThemes: z.array(z.string()).default([]),
});
export type PortfolioCompany = z.infer<typeof portfolioCompanySchema>;

export const portfolioComparisonSchema = z.object({
  summary: z.string().min(20),
  overlaps: z.array(z.object({ portfolioCompany: z.string(), note: z.string() })),
  whitespace: z.string(),
  demo: z.boolean(),
  cached: z.boolean().default(false),
  // Phase 4 additions (defaulted for compatibility). Filled only when
  // the portfolio data supports them — never fabricated.
  sharedThemes: z.array(z.string()).default([]),
  partnershipOpportunities: z.array(z.string()).default([]),
  concentrationRisk: z.string().default(''),
  themeExpansion: z.string().default(''),
  confidence: z.enum(['Low', 'Medium', 'High']).default('Low'),
  evidenceNotes: z.array(z.string()).default([]),
});
export type PortfolioComparison = z.infer<typeof portfolioComparisonSchema>;

// ── Unavailable-integration wording ───────────────────────────────

/**
 * The exact status text shown for the two integrations that cannot run in
 * this local review build, defined once and shared by the API and the UI.
 *
 * These are deliberately not the generic "Implemented — credentials
 * required" that every other connector uses. That phrasing reads as a
 * developer's note about the code, and a reviewer seeing it on a demo
 * cannot tell whether the feature is broken, half-built, or simply
 * switched off. Both of these say who has to do what instead:
 *
 *  - Outlook is blocked on an administrator granting Microsoft Graph
 *    credentials, which is not something this application can do.
 *  - AI is switched off for this pilot by choice — there is no key and no
 *    spend — and outreach falls back to a labelled local template rather
 *    than failing.
 *
 * Neither string may imply a connection exists. Nothing in this build
 * fabricates a connector response.
 */
export const OUTLOOK_UNAVAILABLE_STATUS = 'Awaiting Microsoft administrator configuration';
export const AI_UNAVAILABLE_STATUS = 'Not enabled for this local pilot';

export const OUTLOOK_UNAVAILABLE_DETAIL =
  'Awaiting Microsoft administrator configuration. Drafting into a real mailbox needs Microsoft Graph credentials '
  + '(MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_REDIRECT_URI) issued by a tenant administrator. '
  + 'Until those exist this integration is not connected, no mailbox is reachable, and every Outlook action fails '
  + 'with an explicit error rather than appearing to succeed.';

export const AI_UNAVAILABLE_DETAIL =
  'Not enabled for this local pilot. No AI provider or key is configured and no paid API is called. '
  + 'Outreach drafts and fit explanations come from a deterministic local template built only from recorded '
  + 'evidence, and are labelled as such wherever they appear.';
