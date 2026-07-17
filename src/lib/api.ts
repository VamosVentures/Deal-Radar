import type {
  CompanySyncRequest,
  DuplicateMatch,
  EmailGenContext,
  FitExplainContext,
  FitExplanation,
  FollowUpTask,
  GeneratedEmail,
  HubSpotPipelineInfo,
  HubSpotPipelineMapping,
  IntegrationsStatus,
  OutreachRecord,
  PortfolioCompany,
  PortfolioComparison,
  SyncResult,
} from '../../shared/integrations';
import type {
  DiscoveryCandidate, DiscoveryQuery, DiscoveryRun, FounderHypothesis,
  ScheduledJob, StealthSignal,
} from '../../shared/discovery';

export type UiStatus = 'Connected' | 'Disconnected' | 'Configuration required' | 'Expired' | 'Error' | 'Local Mode';
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
  addedEvidence?: { claim: string; source: string; url: string; date: string; type: string }[];
}

export interface HubSpotSearchHit {
  recordId: string;
  type: 'company' | 'contact';
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

  hubspot: {
    connect: () => call<{ authUrl: string | null; demo: boolean; message: string }>('/api/hubspot/connect', { method: 'POST', body: '{}' }),
    disconnect: () => call<{ ok: boolean }>('/api/hubspot/disconnect', { method: 'POST', body: '{}' }),
    verify: () => call<{ ok: boolean; detail: string; mode: 'mock' | 'live' }>('/api/hubspot/verify', { method: 'POST', body: '{}' }),
    search: (query: string, type: 'companies' | 'contacts') =>
      call<{ hits: HubSpotSearchHit[]; demo: boolean }>('/api/hubspot/search', {
        method: 'POST',
        body: JSON.stringify({ query, type }),
      }),
    checkDuplicate: (name: string, domain: string | null) =>
      call<{ matches: DuplicateMatch[]; demo: boolean }>('/api/hubspot/check-duplicate', {
        method: 'POST',
        body: JSON.stringify({ name, domain }),
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
  },

  outlook: {
    status: () =>
      call<{ mode: 'mock' | 'live'; connected: boolean; account: string | null; permissions: string[]; lastConnectedAt: string | null; detail: string }>('/api/outlook/status'),
    connect: () =>
      call<{ authUrl: string | null; demo: boolean; message: string }>('/api/outlook/connect', {
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
    syncStatus: (companyId: string, actor: string) =>
      call<{ status: { found: boolean; isDraft: boolean; sentAt: string | null; demo: boolean; detail: string }; record: OutreachRecord }>('/api/outlook/sync-status', {
        method: 'POST',
        body: JSON.stringify({ companyId, actor }),
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
    sources: () => call<{ sources: { id: string; name: string; liveCapable: boolean; needs: string }[] }>('/api/discovery/sources'),
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
  },

  imports: {
    importCsv: (csv: string) =>
      call<{ imported: number; skipped: { row: number; issues: string[] }[]; total: number }>('/api/companies/import-csv', {
        method: 'POST',
        body: JSON.stringify({ csv }),
      }),
    imported: () => call<{ companies: unknown[]; companyMeta: Record<string, CompanyMeta> }>('/api/companies/imported'),
    clear: () => call<{ ok: boolean }>('/api/companies/imported/clear', { method: 'POST', body: '{}' }),
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
    records: () =>
      call<{ records: OutreachRecord[]; followUps: { dueToday: OutreachRecord[]; overdue: OutreachRecord[]; dueThisWeek: OutreachRecord[]; draftsNeverSent: OutreachRecord[] } }>('/api/outreach/records'),
    setStatus: (companyId: string, status: string, actor: string) =>
      call<OutreachRecord>('/api/outreach/status', {
        method: 'POST',
        body: JSON.stringify({ companyId, status, actor }),
      }),
    markSent: (companyId: string, actor: string) =>
      call<OutreachRecord>('/api/outreach/mark-sent', {
        method: 'POST',
        body: JSON.stringify({ companyId, actor }),
        idempotent: true,
      }),
    setFollowUp: (companyId: string, dueDate: string, note: string, actor: string) =>
      call<FollowUpTask>('/api/outreach/follow-up', {
        method: 'POST',
        body: JSON.stringify({ companyId, dueDate, note, actor }),
      }),
  },
};
