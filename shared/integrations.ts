// ─────────────────────────────────────────────────────────────────
// Shared integration contracts — imported by BOTH the React app and
// the Express backend so payloads are validated with the same Zod
// schemas on each side of the wire.
// ─────────────────────────────────────────────────────────────────
import { z } from 'zod';

// ── Modes & connection status ────────────────────────────────────

export type IntegrationMode = 'mock' | 'live';

export const integrationConnectionSchema = z.object({
  provider: z.enum(['hubspot', 'outlook', 'ai']),
  mode: z.enum(['mock', 'live']),
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
  matchedOn: 'domain' | 'name';
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

export const OUTREACH_STATUSES = [
  'Not Reviewed',
  'Approved for Tracking',
  'Added to HubSpot',
  'Outreach Approved',
  'Draft Generated',
  'Saved to Outlook',
  'Manually Marked Sent',
  'Replied',
  'Meeting Scheduled',
  'Follow-Up Needed',
  'Monitor',
  'Closed',
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

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

export const outreachActivitySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum([
    'company-added',
    'outreach-approved',
    'draft-created',
    'marked-sent',
    'follow-up-set',
    'meeting-scheduled',
    'note',
  ]),
  detail: z.string(),
  actor: z.string(),
  at: z.string(),
  hubspotNoteId: z.string().nullable(),
});
export type OutreachActivity = z.infer<typeof outreachActivitySchema>;

export const followUpTaskSchema = z.object({
  companyId: z.string(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string(),
  done: z.boolean(),
});
export type FollowUpTask = z.infer<typeof followUpTaskSchema>;

export interface OutreachRecord {
  companyId: string;
  companyName: string;
  founderName: string;
  founderEmail: string | null;
  owner: string;
  vertical: string;
  companyStage: string;
  fitScore: number;
  policyException: string | null;
  sourceQuality: number; // evidence-quality points 0–10
  hubspotStatus: 'Not added' | 'Added' | 'Updated';
  hubspotCompanyId: string | null;
  hubspotUrl: string | null;
  outreachStatus: OutreachStatus;
  draftCreatedAt: string | null;
  draftSubject: string | null;
  outlookDraftId: string | null;
  outlookWebLink: string | null;
  emailSentAt: string | null;
  lastResponseAt: string | null;
  meetingStatus: 'None' | 'Requested' | 'Scheduled' | 'Held';
  followUp: FollowUpTask | null;
  nextAction: string;
  activities: OutreachActivity[];
}

// ── Audit log & errors ───────────────────────────────────────────

export const integrationAuditLogSchema = z.object({
  id: z.string(),
  at: z.string(),
  provider: z.enum(['hubspot', 'outlook', 'ai', 'system']),
  mode: z.enum(['mock', 'live']),
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
