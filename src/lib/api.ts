import type {
  CompanyStatus,
  CompanySyncRequest,
  DuplicateMatch,
  EmailGenContext,
  FitExplainContext,
  FitExplanation,
  GeneratedEmail,
  HubSpotPipelineInfo,
  HubSpotPipelineMapping,
  IntegrationsStatus,
  PortfolioCompany,
  PortfolioComparison,
  StaleSettings,
  SyncResult,
} from '../../shared/integrations';
import type {
  DiscoveryCandidate, DiscoveryQuery, DiscoveryRun, FounderHypothesis,
  ScheduledJob, StealthSignal,
} from '../../shared/discovery';
import type { OpportunityClass } from '../../shared/opportunity';
import type { QualificationResult } from '../../shared/qualification';

export type UiStatus = 'Connected' | 'Not connected' | 'Disconnected' | 'Configuration required' | 'Expired' | 'Error';
export type StatusMap = Record<'hubspot' | 'outlook' | 'ai' | 'refresh', { status: UiStatus; detail: string }>;
export type FullStatus = IntegrationsStatus & { statuses: StatusMap };

export interface ConnectorInfo {
  meta: { id: string; name: string; what: string; needs: string; setup: string; kind: 'integration' | 'local' | 'public' };
  state: { id: string; enabled: boolean; lastSyncAt: string | null; lastSyncMode: 'live' | 'local' | 'simulated' | 'failed' | null; recordsImported: number; lastError: string | null };
}

export interface RefreshLogEntry {
  id: string;
  at: string;
  trigger: 'manual' | 'scheduled';
  scope: string;
  status: 'ok' | 'partial' | 'failed' | 'cancelled';
  results: { connector: string; mode: 'live' | 'local' | 'simulated' | 'failed'; records: number; detail: string }[];
}

export interface CompanyMeta {
  lastRefreshed?: string;
  reviewStatus?: string;
  discoverySource?: string;
  discoveredAt?: string;
  hubspotCompanyId?: string;
  /** Computed: true when a non-terminal company has gone unreviewed past the staleness threshold. */
  stale?: boolean;
  /** Per-field origin: verified / user-entered / extracted / ai-inferred / unverified / missing. */
  provenance?: Record<string, string>;
  addedEvidence?: { claim: string; source: string; url: string; date: string; type: string }[];
}

export interface HubSpotSearchHit {
  recordId: string;
  type: 'company' | 'contact' | 'deal';
  title: string;
  subtitle: string;
  url: string | null;
  demo: boolean;
}

/**
 * The React app NEVER holds HubSpot, Microsoft, or AI credentials —
 * every integration call goes to the local backend, which owns the
 * secrets. POSTs carry an Idempotency-Key so double-clicks can't
 * create duplicate CRM records or drafts.
 */

export class ApiError extends Error {
  status: number;
  hint?: string;
  issues?: string[];
  constructor(status: number, body: { message?: string; hint?: string; issues?: string[] }) {
    super(body.message ?? `Request failed (${status})`);
    this.status = status;
    this.hint = body.hint;
    this.issues = body.issues;
  }
}

async function call<T>(path: string, init?: RequestInit & { idempotent?: boolean }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init?.idempotent) headers['Idempotency-Key'] = crypto.randomUUID();
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, {
      message: 'The Deal Radar backend is not reachable.',
      hint: 'Start it with `npm run dev` (runs web + API together) or `npm run dev:server`.',
    });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  status: () => call<FullStatus>('/api/integrations/status'),

  auth: {
    status: () => call<{ configured: boolean; authenticated: boolean }>('/api/auth/status'),
    login: (password: string) => call<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
    logout: () => call<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  },

  hubspot: {
    connect: () => call<{ authUrl: string | null; message: string }>('/api/hubspot/connect', { method: 'POST', body: '{}' }),
    disconnect: () => call<{ ok: boolean }>('/api/hubspot/disconnect', { method: 'POST', body: '{}' }),
    verify: () => call<{ ok: boolean; detail: string }>('/api/hubspot/verify', { method: 'POST', body: '{}' }),
    search: (query: string, type: 'companies' | 'contacts' | 'deals') =>
      call<{ hits: HubSpotSearchHit[]; demo: boolean }>('/api/hubspot/search', {
        method: 'POST',
        body: JSON.stringify({ query, type }),
      }),
    checkDuplicate: (input: { name: string; domain: string | null; founderEmails?: string[]; dealRadarId?: string }) =>
      call<{ matches: DuplicateMatch[]; demo: boolean }>('/api/hubspot/check-duplicate', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    pipelines: () =>
      call<{ pipelines: HubSpotPipelineInfo[]; demo: boolean }>('/api/hubspot/pipelines'),
    getMapping: () =>
      call<{ mapping: HubSpotPipelineMapping | null; radarStages: string[] }>('/api/hubspot/pipeline-mapping'),
    saveMapping: (mapping: HubSpotPipelineMapping) =>
      call<{ ok: boolean }>('/api/hubspot/pipeline-mapping', {
        method: 'PUT',
        body: JSON.stringify(mapping),
      }),
    syncCompany: (payload: CompanySyncRequest) =>
      call<SyncResult>('/api/hubspot/sync-company', {
        method: 'POST',
        body: JSON.stringify(payload),
        idempotent: true,
      }),
    logActivity: (companyId: string, note: string, actor: string) =>
      call<{ ok: boolean; demo: boolean }>('/api/hubspot/log-activity', {
        method: 'POST',
        body: JSON.stringify({ companyId, note, actor }),
        idempotent: true,
      }),
    failedSyncs: () => call<{ failed: { companyId: string; detail: string; at: string }[] }>('/api/hubspot/failed-syncs'),
    retrySync: (companyId: string) =>
      call<SyncResult>('/api/hubspot/retry-sync', {
        method: 'POST',
        body: JSON.stringify({ companyId }),
        idempotent: true,
      }),
  },

  outlook: {
    status: () =>
      call<{ mode: 'live' | 'disconnected'; connected: boolean; account: string | null; permissions: string[]; lastConnectedAt: string | null; detail: string }>('/api/outlook/status'),
    connect: () =>
      call<{ authUrl: string | null; message: string }>('/api/outlook/connect', {
        method: 'POST',
        body: '{}',
      }),
    disconnect: () =>
      call<{ ok: boolean }>('/api/outlook/disconnect', { method: 'POST', body: '{}' }),
    saveDraft: (input: { companyId: string; to: string; subject: string; body: string; senderName: string; tone: string }) =>
      call<{ ok: boolean; demo: boolean; draftId: string; outlookDraftId: string; webLink: string | null; message: string }>('/api/outlook/drafts', {
        method: 'POST',
        body: JSON.stringify(input),
        idempotent: true,
      }),
  },

  ai: {
    explainFit: (context: FitExplainContext) =>
      call<FitExplanation>('/api/ai/explain-fit', { method: 'POST', body: JSON.stringify(context) }),
    comparePortfolio: (company: FitExplainContext) =>
      call<PortfolioComparison>('/api/ai/compare-portfolio', { method: 'POST', body: JSON.stringify({ company }) }),
  },

  refresh: {
    connectors: () => call<{ connectors: ConnectorInfo[] }>('/api/refresh/connectors'),
    setEnabled: (id: string, enabled: boolean) =>
      call<ConnectorInfo['state']>(`/api/refresh/connectors/${id}/enabled`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    run: (req: { connectorIds?: string[] | null; companyIds?: string[] | null; vertical?: string | null; staleOnly?: boolean; maxRecords?: number }) =>
      call<RefreshLogEntry>('/api/refresh/run', { method: 'POST', body: JSON.stringify(req) }),
    cancel: () => call<{ ok: boolean; message: string }>('/api/refresh/cancel', { method: 'POST', body: '{}' }),
    log: () => call<{ log: RefreshLogEntry[] }>('/api/refresh/log'),
  },

  discovery: {
    sources: () => call<{ sources: { id: string; name: string; state: 'live' | 'credentials-required' | 'planned' | 'unavailable'; liveCapable: boolean; needs: string }[] }>('/api/discovery/sources'),
    estimate: (q: Partial<DiscoveryQuery>) =>
      call<{ estimatedTokens: number; estimatedCostUsd: number; note: string }>('/api/discovery/estimate', { method: 'POST', body: JSON.stringify(q) }),
    run: (query: Partial<DiscoveryQuery>, actor: string) =>
      call<DiscoveryRun>('/api/discovery/run', { method: 'POST', body: JSON.stringify({ query, actor }) }),
    cancel: () => call<{ ok: boolean; message: string }>('/api/discovery/cancel', { method: 'POST', body: '{}' }),
    candidates: (params?: { runId?: string; status?: string }) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString();
      return call<{ candidates: DiscoveryCandidate[] }>(`/api/discovery/candidates${qs ? `?${qs}` : ''}`);
    },
    import: (candidateIds: string[], actor: string, duplicateAction: 'skip' | 'merge-evidence' | 'import-anyway') =>
      call<{ imported: string[]; merged: string[]; skipped: { id: string; reason: string }[] }>('/api/discovery/import', {
        method: 'POST',
        body: JSON.stringify({ candidateIds, actor, duplicateAction }),
      }),
    runs: () => call<{ runs: DiscoveryRun[] }>('/api/discovery/runs'),
  },

  stealth: {
    signals: () => call<{ signals: StealthSignal[] }>('/api/stealth/signals'),
    addSignal: (signal: Omit<StealthSignal, 'id'>) =>
      call<StealthSignal>('/api/stealth/signals', { method: 'POST', body: JSON.stringify(signal) }),
    patchSignal: (id: string, patch: { assignedTo?: string | null; outreachStatus?: StealthSignal['outreachStatus']; verificationStatus?: StealthSignal['verificationStatus'] }) =>
      call<StealthSignal>(`/api/stealth/signals/${id}`, { method: 'POST', body: JSON.stringify(patch) }),
    hypothesis: (id: string) =>
      call<FounderHypothesis>(`/api/stealth/signals/${id}/hypothesis`, { method: 'POST', body: '{}' }),
  },

  schedule: {
    get: () => call<{ active: boolean; label: string; jobs: ScheduledJob[] }>('/api/schedule'),
    save: (job: Omit<ScheduledJob, 'id' | 'lastRunAt'>) =>
      call<ScheduledJob>('/api/schedule', { method: 'POST', body: JSON.stringify(job) }),
    remove: (id: string) => call<{ ok: boolean }>(`/api/schedule/${id}`, { method: 'DELETE' }),
    /** Administrator-only: run this schedule's search immediately, outside its cadence. */
    runNow: (id: string, actor: string) =>
      call<DiscoveryRun>(`/api/schedule/${id}/run-now`, { method: 'POST', body: JSON.stringify({ actor }) }),
  },

  imports: {
    importCsv: (csv: string) =>
      call<{ imported: number; skipped: { row: number; issues: string[] }[]; total: number }>('/api/companies/import-csv', {
        method: 'POST',
        body: JSON.stringify({ csv }),
      }),
    imported: () => call<{
      companies: unknown[];
      companyMeta: Record<string, CompanyMeta>;
      opportunities: Record<string, unknown>;
      qualifications: Record<string, unknown>;
      /** Every stored deal-evidence row per company, keyed by company id. */
      dealEvidence: Record<string, unknown[]>;
      quarantine: Record<string, { reason: string; at: string }>;
    }>('/api/companies/imported'),
    clear: () => call<{ ok: boolean }>('/api/companies/imported/clear', { method: 'POST', body: '{}' }),
    setStatus: (id: string, status: CompanyStatus, actor: string) =>
      call<{ ok: boolean; status: CompanyStatus }>(`/api/companies/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, actor }),
      }),
    refresh: (id: string, actor: string) =>
      call<{ ok: boolean; lastRefreshed: string }>(`/api/companies/${id}/refresh`, {
        method: 'POST',
        body: JSON.stringify({ actor }),
      }),
    refreshResearch: (id: string, actor: string) =>
      call<RefreshResearchResult>(`/api/companies/${id}/refresh-research`, {
        method: 'POST',
        body: JSON.stringify({ actor }),
      }),
    /**
     * Manual website confirmation. Two calls on purpose: `preview`
     * writes nothing and returns the before/after, `confirm` refuses
     * without an explicit `confirmed: true`.
     */
    previewWebsiteConfirmation: (id: string, input: WebsiteConfirmationInput) =>
      call<WebsiteConfirmationPreview>(`/api/companies/${id}/website-confirmation/preview`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    confirmWebsite: (id: string, input: WebsiteConfirmationInput) =>
      call<WebsiteConfirmationResult>(`/api/companies/${id}/website-confirmation/confirm`, {
        method: 'POST',
        body: JSON.stringify({ ...input, confirmed: true }),
      }),
    bulkStatus: (ids: string[], status: CompanyStatus, actor: string) =>
      call<{ ok: boolean; status: CompanyStatus; updated: string[]; skipped: { id: string; reason: string }[] }>('/api/companies/bulk-status', {
        method: 'POST',
        body: JSON.stringify({ ids, status, actor }),
      }),
    getPortfolio: () => call<{ portfolio: PortfolioCompany[] }>('/api/portfolio'),
    savePortfolio: (portfolio: PortfolioCompany[]) =>
      call<{ count: number }>('/api/portfolio', { method: 'PUT', body: JSON.stringify(portfolio) }),
    addPortfolioCompany: (company: Partial<PortfolioCompany>) =>
      call<{ ok: boolean; count: number }>('/api/portfolio/company', { method: 'POST', body: JSON.stringify(company) }),
    importPortfolioCsv: (csv: string) =>
      call<{ imported: number; skipped: { row: number; issues: string[] }[]; total: number }>('/api/portfolio/import-csv', {
        method: 'POST',
        body: JSON.stringify({ csv }),
      }),
  },

  outreach: {
    generate: (context: EmailGenContext) =>
      call<GeneratedEmail>('/api/outreach/generate', {
        method: 'POST',
        body: JSON.stringify(context),
      }),
    regenerate: (context: EmailGenContext, instructions: string) =>
      call<GeneratedEmail>('/api/outreach/regenerate', {
        method: 'POST',
        body: JSON.stringify({ context, instructions }),
      }),
  },

  admin: {
    status: () => call<AdminStatus>('/api/admin/status'),
    diversityAnalytics: () => call<DiversityAnalytics>('/api/admin/diversity-analytics'),
    sourceAnalytics: () => call<{ sources: SourceAnalytics[] }>('/api/admin/source-analytics'),
    backups: {
      list: () => call<{ backups: BackupMetadata[]; settings: { maxBackups: number; maxBackupAgeDays: number } }>('/api/admin/backups'),
      create: (actor: string) => call<BackupMetadata>('/api/admin/backups', { method: 'POST', body: JSON.stringify({ actor }) }),
    },
  },

  staleSettings: {
    get: () => call<StaleSettings>('/api/stale-settings'),
    update: (patch: Partial<StaleSettings>) =>
      call<StaleSettings>('/api/admin/stale-settings', { method: 'PUT', body: JSON.stringify(patch) }),
  },

  duplicates: {
    /** Possible-duplicate review queue — uncertain matches surfaced during discovery/import, awaiting a human decision. */
    list: (status?: 'pending' | 'confirmed-duplicate' | 'not-duplicate') =>
      call<{ duplicates: PossibleDuplicateEntry[] }>(`/api/duplicates${status ? `?status=${status}` : ''}`),
    resolve: (id: number, resolution: 'confirmed-duplicate' | 'not-duplicate', actor: string) =>
      call<{ ok: boolean }>(`/api/duplicates/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution, actor }) }),
  },
};

export interface PossibleDuplicateEntry {
  id: number;
  companyId: string;
  otherCompanyId: string | null;
  matchedBy: string;
  similarity: number;
  detail: string;
  status: 'pending' | 'confirmed-duplicate' | 'not-duplicate';
  createdAt: string;
  company: { id: string; name: string } | null;
  otherCompany: { id: string; name: string } | null;
}

/** The Settings — Admin Only system panel. Presence booleans only — never secret values. */
export interface AdminStatus {
  database: { ok: boolean; engine: string; location: string; companies: number; migrationVersion: number };
  connectors: Record<'github' | 'hubspot' | 'outlook' | 'ai', { status: UiStatus; detail: string }>;
  credentials: Record<string, boolean>;
  sourcing: {
    lastRun: { at: string; status: string; initiatedBy: string } | null;
    lastSuccessfulRun: { at: string; status: string } | null;
    lastFailedRun: { at: string; status: string } | null;
    recordsRetrieved: number;
    recordsCreated: number;
    recordsUpdated: number;
    recentErrors: string[];
    rateLimited: string[];
  };
  hubspotFailedSyncs: { companyId: string; detail: string; at: string }[];
}

/** Result of a "Refresh live research" action — see server/services/companyRefresh.ts. */
export interface RefreshResearchResult {
  companyId: string;
  refreshedAt: string;
  newEvidenceCount: number;
  newEvidence: { claim: string; source: string; url: string; date: string; type: string }[];
  updatedFields: { field: string; from: string; to: string; source: string }[];
  conflictingFields: { field: string; existing: string; attempted: string; source: string; reason: string }[];
  unchangedFieldCount: number;
  newFounderNamesFound: string[];
  sourcesRan: { sourceId: string; detail: string; found: number }[];
  sourcesFailed: { sourceId: string; detail: string; found: number }[];
  sourcesSkipped: { sourceId: string; detail: string; found: number }[];
  fieldsRequiringHumanReview: string[];
  oldScore: { score: number; version: string } | null;
  newScore: { score: number; version: string };
}

/**
 * Manual website confirmation — see server/services/websiteConfirmation.ts.
 * Mirrored here rather than imported because the browser bundle must not
 * pull in server code.
 */
export interface WebsiteConfirmationInput {
  website: string;
  evidenceUrl: string;
  reason: string;
  actor: string;
}

export interface WebsiteConfirmationPreview {
  companyId: string;
  companyName: string;
  previous: {
    website: string | null;
    websiteOrigin: string | null;
    classification: OpportunityClass | null;
    qualification: QualificationResult | null;
    independentSources: number;
  };
  proposed: {
    website: string;
    evidenceUrl: string;
    websiteOrigin: 'verified';
    effect: string;
  };
  warnings: string[];
  blockers: string[];
}

export interface WebsiteConfirmationResult {
  ok: boolean;
  message: string;
  preview: WebsiteConfirmationPreview;
  applied?: {
    website: string;
    classificationBefore: OpportunityClass | null;
    classificationAfter: OpportunityClass;
    qualificationBefore: QualificationResult | null;
    qualificationAfter: QualificationResult;
    quarantined: boolean;
    evidenceRowAdded: boolean;
  };
}

export interface BackupMetadata {
  file: string;
  createdAt: string;
  sizeBytes: number;
  schemaVersion: number;
  companyCount: number;
  triggeredBy: string;
}

/** Source-quality analytics — computed from persisted run history only, never fabricated. */
export interface SourceAnalytics {
  sourceId: string;
  name: string;
  state: 'live' | 'credentials-required' | 'planned' | 'unavailable';
  totalAppearances: number;
  successfulRuns: number;
  failedRuns: number;
  skippedRuns: number;
  failureRate: number | null;
  avgResponseTimeMs: number | null;
  resultsRetrieved: number;
  companiesImported: number;
  companiesApprovedOrSynced: number;
  avgFitScoreOfImported: number | null;
  mostRecentSuccessfulRunAt: string | null;
  mostRecentFailedRunAt: string | null;
}

/** Source-diversity analytics, computed server-side from persisted evidence only. */
export interface DiversityAnalytics {
  totalCompanies: number;
  totalOpportunities: number;
  companyLeads: number;
  quarantined: number;
  humanReview: number;
  byClassification: Record<string, number>;
  byPrimarySource: Record<string, number>;
  byTier: Record<string, number>;
  byQualification: Record<string, number>;
  sharePct: Record<string, number>;
  singleSourceOpportunities: number;
  multiSourceOpportunities: number;
  perSector: { vertical: string; qualified: number; families: string[]; shortfall: number; warnings: string[] }[];
  publicCompaniesExcluded: number;
  fundsOrSpvsExcluded: number;
  warnings: string[];
}
