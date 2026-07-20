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

export const hubspotCompanyRecordSchema = z.object({
  name: z.string().min(1),
  domain: z.string().nullable(),
  website: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  country: z.string().default('United States'),
  description: z.string(),
  vertical: z.string(),
  subcategory: z.string(),
  stage: z.string(),
  accelerator: z.string().nullable(),
  fundingRaised: z.string().nullable(),
  dateFirstSurfaced: z.string(),
  lastRefreshed: z.string(),
  primarySource: z.string(),
  policyException: z.string().nullable(), // human-readable flag text or null
  dealRadarId: z.string(),
  dealRadarUrl: z.string(),
});
export type HubSpotCompanyRecord = z.infer<typeof hubspotCompanyRecordSchema>;

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
] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/** Statuses for which staleness no longer matters — the review is done. */
export const TERMINAL_COMPANY_STATUSES: readonly CompanyStatus[] = ['Passed', 'Synced to HubSpot'];

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
  /** What matched: existing radar link, Vamos property, domain, name, or founder email. */
  matchedOn: 'radar-id' | 'domain' | 'name' | 'founder-email';
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
