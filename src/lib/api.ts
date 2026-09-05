import type { TractionState } from '../../shared/traction';

/** One extractor finding awaiting an accept / edit / reject decision. */
export interface PendingEvidenceItem {
  id: number;
  kind: 'traction' | 'stage';
  quote: string;
  sourceUrl: string;
  section: string;
  aboutThisCompany: boolean;
  provenance: 'company-claimed' | 'independently-confirmed';
  suggestedState: string | null;
  suggestionBasis: string | null;
  /** An analyst's corrected excerpt. `quote` always keeps what the source published. */
  editedQuote: string | null;
  accessedAt: string;
  status: 'pending' | 'accepted' | 'rejected' | 'edited';
  decidedBy: string | null;
  decisionNote: string | null;
}
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
import type { CompanyNote } from '../../shared/notes';
import type {
  CompanyEnrichment, FieldCorrection, RadarEntry, RadarFilter,
} from '../../shared/enrichment';
import type { CumulativePeriod, CumulativePeriodResult, ExecutiveKpis } from '../../shared/executiveKpis';

export type UiStatus =
  | 'Connected' | 'Not connected' | 'Disconnected' | 'Configuration required' | 'Expired' | 'Error'
  // The two integrations this local build cannot run report themselves in
  // their own words — see shared/integrations.ts.
  | 'Awaiting Microsoft administrator configuration'
  | 'Not enabled for this local pilot'
  | 'Implemented — credentials required';
export type StatusMap = Record<'hubspot' | 'outlook' | 'ai' | 'refresh', { status: UiStatus; detail: string }>;

/** Which identity providers may open a session — see server/env.ts AUTH_MODE. */
export type AuthMode = 'local' | 'microsoft' | 'hybrid';
/**
 * What AUTH_MODE was set to. Includes 'auto' (the default), which
 * resolves to microsoft-only once Entra is configured and local until
 * then — so `requestedMode` and `mode` legitimately differ.
 */
export type RequestedAuthMode = AuthMode | 'auto';

export interface AuthStatus {
  /** Some provider is configured, so signing in is possible at all. */
  configured: boolean;
  authenticated: boolean;
  /** The mode actually in force (falls back to 'local' if Microsoft is incomplete). */
  mode: AuthMode;
  /** What AUTH_MODE asked for — differs from `mode` while Entra config is pending. */
  requestedMode: RequestedAuthMode;
  localLoginAvailable: boolean;
  microsoftLoginAvailable: boolean;
  /** Microsoft was requested but its variables are incomplete. */
  microsoftPending: boolean;
  microsoftPendingMessage: string | null;
  /**
   * The names of the environment variables Microsoft sign-in is still
   * waiting on — empty once SSO is fully configured. Names only, never
   * values: this is what turns "the button is missing" into a list of
   * what to go and set.
   */
  microsoftMissingRequirements: string[];
  /** True while the shared password is still the way in, pending the Entra registration. */
  awaitingSsoCutover: boolean;
  awaitingSsoCutoverMessage: string | null;
  /** The domain that will be allowed to sign in once SSO is live. */
  allowedEmailDomain: string | null;
  /** Who is signed in — for attribution. Never contains a token. */
  identity: { label: string; source: 'local-admin' | 'microsoft-sso'; email: string | null } | null;
}
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

export { ApiError } from './apiError';
import { ApiError } from './apiError';

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

const liveApi = {
  status: () => call<FullStatus>('/api/integrations/status'),

  overview: {
    kpis: () => call<ExecutiveKpis>('/api/overview/kpis'),
    cumulativePeriod: (entity: 'companies' | 'founders', period: CumulativePeriod) =>
      call<CumulativePeriodResult>(`/api/overview/kpis/cumulative?entity=${entity}&period=${period}`),
  },

  auth: {
    status: () => call<AuthStatus>('/api/auth/status'),
    login: (password: string) => call<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
    logout: () => call<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' }),
    /**
     * Begins Microsoft sign-in. Returns the Microsoft URL to navigate
     * to; the state, nonce, and PKCE verifier that secure the flow are
     * held server-side and never reach this code.
     */
    microsoftStart: () =>
      call<{ authUrl: string; message: string }>('/api/auth/microsoft/start', {
        method: 'POST',
        body: '{}',
      }),
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
    checkDuplicate: (input: { name: string; domain: string | null; founderEmails?: string[] }) =>
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
    setVertical: (candidateId: string, vertical: string, actor: string) =>
      call<{ candidate: DiscoveryCandidate }>(`/api/discovery/candidates/${candidateId}/vertical`, {
        method: 'PUT',
        body: JSON.stringify({ vertical, actor }),
      }),
    dismiss: (candidateId: string, actor: string) =>
      call<{ candidate: DiscoveryCandidate }>(`/api/discovery/candidates/${candidateId}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ actor }),
      }),
  },

  stealth: {
    signals: () => call<{ signals: StealthSignal[] }>('/api/stealth/signals'),
    addSignal: (signal: Omit<StealthSignal, 'id'>) =>
      call<StealthSignal>('/api/stealth/signals', { method: 'POST', body: JSON.stringify(signal) }),
    patchSignal: (id: string, patch: { assignedTo?: string | null; outreachStatus?: StealthSignal['outreachStatus']; verificationStatus?: StealthSignal['verificationStatus'] }) =>
      call<StealthSignal>(`/api/stealth/signals/${id}`, { method: 'POST', body: JSON.stringify(patch) }),
    hypothesis: (id: string) =>
      call<FounderHypothesis>(`/api/stealth/signals/${id}/hypothesis`, { method: 'POST', body: '{}' }),

    /**
     * The Stealth Founder Radar research workflow, over real company
     * records rather than hand-entered signals. Each entry carries the
     * evidence behind every match, the source families attempted, the
     * last-checked date, and the next recommended action.
     */
    radar: (filter: RadarFilter = 'all', limit?: number) =>
      call<{ entries: RadarEntry[]; counts: Record<RadarFilter, number> }>(
        `/api/stealth/radar?filter=${filter}${limit ? `&limit=${limit}` : ''}`,
      ),
    /** Reported, never acted on — merging stays in the possible-duplicate review workflow. */
    duplicateHints: () =>
      call<{ hints: { aId: string; aName: string; bId: string; bName: string; basis: string }[] }>(
        '/api/stealth/radar/duplicates',
      ),
    /** Confirm or reject a candidate. The automated evidence is preserved either way. */
    reviewCandidate: (candidateId: number, decision: 'confirmed' | 'rejected', reason: string) =>
      call<{ candidate: unknown; enrichment: CompanyEnrichment }>(
        `/api/stealth/radar/candidates/${candidateId}/review`,
        { method: 'POST', body: JSON.stringify({ decision, reason }) },
      ),
  },

  /** Founder / vertical / stage enrichment for a single company. */
  enrichment: {
    get: (companyId: string) =>
      call<{ enrichment: CompanyEnrichment }>(`/api/companies/${encodeURIComponent(companyId)}/enrichment`),
    /**
     * Correct a field. Layered over the automated verdict — the research
     * evidence is preserved and remains visible alongside the correction.
     */
    correct: (companyId: string, field: 'founder' | 'vertical' | 'stage', value: string, reason: string, sourceUrl: string | null) =>
      call<{ correctionId: number; enrichment: CompanyEnrichment }>(
        `/api/companies/${encodeURIComponent(companyId)}/enrichment/correct`,
        { method: 'POST', body: JSON.stringify({ field, value, reason, sourceUrl }), idempotent: true },
      ),
    corrections: (companyId: string) =>
      call<{ corrections: FieldCorrection[] }>(`/api/companies/${encodeURIComponent(companyId)}/enrichment/corrections`),
    /** "Research again" — bounded to this company and a small request budget. */
    research: (companyId: string) =>
      call<{ runId: string; requestsSpent: number; sourceErrors: { detail: string; count: number }[]; enrichment: CompanyEnrichment }>(
        `/api/companies/${encodeURIComponent(companyId)}/enrichment/research`,
        { method: 'POST', body: '{}' },
      ),
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
      /**
       * Founder / vertical / stage enrichment per company.
       *
       * Every field arrives as a resolution state plus a summary written
       * from the research record — never a null the UI would have to
       * render as "Unknown". See server/services/enrichmentView.ts.
       */
      enrichment: Record<string, CompanyEnrichment>;
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
     * Analyst traction review. The POST is rejected with 422 and a
     * `messages` array when a scoring state arrives with no source URL
     * and no substantive note — see shared/traction.ts. The caller shows
     * those reasons rather than retrying.
     */
    pendingEvidence: (id: string) =>
      call<{ companyId: string; items: PendingEvidenceItem[] }>(`/api/companies/${id}/pending-evidence`),
    decidePendingEvidence: (pendingId: number, body: { status: 'accepted' | 'rejected' | 'edited'; actor: string; note?: string | null; editedQuote?: string | null }) =>
      call<{ ok: true }>(`/api/pending-evidence/${pendingId}/decide`, { method: 'POST', body: JSON.stringify(body) }),
    tractionReview: (id: string) =>
      call<{ companyId: string; state: TractionState; history: unknown[] }>(`/api/companies/${id}/traction`),
    saveTractionReview: (id: string, body: Record<string, unknown>) =>
      call<{
        ok: true;
        scoreRowAppended: boolean;
        score: { before: number | null; after: number; provisionalBefore: boolean | null; provisionalAfter: boolean } | null;
      }>(`/api/companies/${id}/traction`, { method: 'POST', body: JSON.stringify(body) }),
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
    shortlists: () => call<ShortlistsResponse>('/api/admin/shortlists'),
    sourceAnalytics: () => call<{ sources: SourceAnalytics[] }>('/api/admin/source-analytics'),
    sourceHealth: () => call<{ sources: SourceHealth[] }>('/api/admin/source-health'),
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

  /**
   * Internal company review notes.
   *
   * Fetched per company, on demand, when a detail panel opens — never
   * bundled into /api/companies/imported. That endpoint feeds the
   * company table AND the CSV export, and a note carries candid
   * investment-team opinion that must not travel in a payload assembled
   * for facts. There is no delete: archive and restore are the only
   * lifecycle calls, so review history stays auditable.
   */
  notes: {
    list: (companyId: string, includeArchived = false) =>
      call<{ notes: CompanyNote[] }>(`/api/companies/${encodeURIComponent(companyId)}/notes?includeArchived=${includeArchived}`),
    create: (companyId: string, body: string) =>
      call<{ note: CompanyNote }>(`/api/companies/${encodeURIComponent(companyId)}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body }),
        idempotent: true,
      }),
    edit: (companyId: string, noteId: string, body: string) =>
      call<{ note: CompanyNote }>(`/api/companies/${encodeURIComponent(companyId)}/notes/${encodeURIComponent(noteId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      }),
    archive: (companyId: string, noteId: string) =>
      call<{ note: CompanyNote }>(`/api/companies/${encodeURIComponent(companyId)}/notes/${encodeURIComponent(noteId)}/archive`, {
        method: 'POST',
        body: '{}',
      }),
    restore: (companyId: string, noteId: string) =>
      call<{ note: CompanyNote }>(`/api/companies/${encodeURIComponent(companyId)}/notes/${encodeURIComponent(noteId)}/restore`, {
        method: 'POST',
        body: '{}',
      }),
  },

  duplicates: {
    /** Possible-duplicate review queue — uncertain matches surfaced during discovery/import, awaiting a human decision. */
    list: (status?: 'pending' | 'confirmed-duplicate' | 'not-duplicate') =>
      call<{ duplicates: PossibleDuplicateEntry[] }>(`/api/duplicates${status ? `?status=${status}` : ''}`),
    resolve: (id: number, resolution: 'confirmed-duplicate' | 'not-duplicate', actor: string) =>
      call<{ ok: boolean }>(`/api/duplicates/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution, actor }) }),
  },
};

/** The shape both the live and demo API clients must implement. */
export type Api = typeof liveApi;

/**
 * VITE_DEMO_MODE=true swaps every call for a fixture-backed demo client
 * that never calls fetch() — see src/lib/demoMode.ts and
 * src/lib/demoApi.ts. A build without the flag is byte-for-byte the
 * original fetch-based client; nothing about production behavior
 * changes when the flag is absent or false.
 */
import { DEMO_MODE } from './demoMode';
import { demoApi } from './demoApi';
export const api: Api = DEMO_MODE ? demoApi : liveApi;

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

export interface SourceHealth {
  sourceId: string;
  name: string;
  health: 'disabled' | 'blocked' | 'healthy' | 'degraded' | 'failed' | 'enabled';
  authOrConfigMissing: boolean;
  lastAttemptedSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  recordsInLatestRun: number | null;
  recentErrorSummary: string | null;
  failureRate: number | null;
  companiesImported: number;
}

/** Source-diversity analytics, computed server-side from persisted evidence only. */
/** Why a live deal is not on its sector's shortlist. */
export type HoldBackReason =
  | 'ranked-below-cutoff'
  | 'source-family-cap'
  | 'sector-limit'
  | 'insufficient-corroboration'
  | 'quarantined';

export interface ShortlistSelected {
  companyId: string;
  name: string;
  classification: string;
  primarySourceId: string;
  primaryTier: number;
  evidenceUrl: string;
  evidencePublishedAt: string | null;
  amountText: string | null;
  roundType: string | null;
  fitScore: number;
}

export interface ShortlistHeldBack {
  companyId: string;
  name: string;
  reasonCode: HoldBackReason;
  reason: string;
  rank: number;
  primarySourceId: string;
  classification: string;
  evidenceUrl: string;
  evidencePublishedAt: string | null;
}

export interface SectorShortlistView {
  vertical: string;
  eligible: number;
  leads: number;
  shortfall: number;
  shortageExplanation: string | null;
  selected: ShortlistSelected[];
  heldBack: ShortlistHeldBack[];
}

export interface ShortlistsResponse {
  shortlists: SectorShortlistView[];
  perSector: number;
  totalSelected: number;
  totalHeldBack: number;
}

export interface DiversityAnalytics {
  totalCompanies: number;
  totalOpportunities: number;
  companyLeads: number;
  quarantined: number;
  humanReview: number;
  byClassification: Record<string, number>;
  byPrimarySource: Record<string, number>;
  /** The same opportunities counted by source family — the level at which concentration is meaningful. */
  byFamily: Record<string, number>;
  byTier: Record<string, number>;
  byQualification: Record<string, number>;
  sharePct: Record<string, number>;
  familySharePct: Record<string, number>;
  singleSourceOpportunities: number;
  multiSourceOpportunities: number;
  perSector: { vertical: string; qualified: number; families: string[]; shortfall: number; warnings: string[] }[];
  publicCompaniesExcluded: number;
  fundsOrSpvsExcluded: number;
  warnings: string[];
}
