import { ApiError } from './apiError';
import { DEMO_DISABLED_MESSAGE } from './demoMode';
import {
  DEMO_COMPANIES, DEMO_NOW, DEMO_DISCOVERY_CANDIDATES, DEMO_DISCOVERY_RUNS,
  DEMO_STEALTH_SIGNALS, DEMO_RADAR_ENTRIES,
  buildDemoEnrichment, buildDemoPendingEvidence, buildDemoNotes,
} from '../demo/fixtures';
import { scoreCompany } from './scoring';
import type { Company } from '../types';
import type {
  Api, AuthStatus, FullStatus, StatusMap, ConnectorInfo, RefreshLogEntry, CompanyMeta,
  HubSpotSearchHit, AdminStatus, DiversityAnalytics, ShortlistsResponse, SourceAnalytics,
  SourceHealth, BackupMetadata, RefreshResearchResult, WebsiteConfirmationInput,
  WebsiteConfirmationPreview, WebsiteConfirmationResult, PossibleDuplicateEntry,
} from './api';
import type { CumulativePeriod, CumulativePeriodResult, EntityKpis, ExecutiveKpis, VerticalBreakdown } from '../../shared/executiveKpis';
import type { RadarEntry, RadarFilter } from '../../shared/enrichment';

const STATUS_TO_RADAR_FILTER: Record<string, RadarFilter> = {
  'verified-founder': 'verified',
  'probable-founder-candidate': 'probable',
  'conflicting-founder-evidence': 'conflicting',
  'research-exhausted': 'research-exhausted',
  'manual-review-required': 'manual-review',
};

/** Counts must reflect the actual fixture set, not a hand-typed snapshot that drifts as entries are added. */
function computeRadarCounts(entries: RadarEntry[]): Record<RadarFilter, number> {
  const counts: Record<RadarFilter, number> = { all: entries.length, verified: 0, probable: 0, conflicting: 0, 'research-exhausted': 0, 'manual-review': 0 };
  for (const e of entries) {
    const key = STATUS_TO_RADAR_FILTER[e.status];
    if (key) counts[key] += 1;
  }
  return counts;
}

/**
 * Demo (fixture-backed) implementation of the `api` client — see
 * src/lib/demoMode.ts. This module makes NO network calls whatsoever:
 * every method either returns bundled synthetic data (computed with the
 * exact same client-side scoring/derivation logic production uses) or
 * rejects immediately with a clear, demo-labelled error, before doing
 * anything else. There is no code path in this file that reaches
 * `fetch`, a real backend, a real database, or a paid third-party API.
 */

const DAY = 86_400_000;
const NOW_MS = DEMO_NOW.getTime();

/** Every mutating action in the demo rejects the same honest way. */
function disabled<T = never>(): Promise<T> {
  return Promise.reject(new ApiError(403, {
    message: DEMO_DISABLED_MESSAGE,
    hint: 'Refresh the page to return to the read-only demo view.',
  }));
}

/**
 * Session (synthetic — never a real cookie, never checked against a
 * real credential). Backed by sessionStorage so a direct-route refresh
 * keeps you signed in within the same tab, with an in-memory fallback
 * for environments with no Web Storage (the unit-test/node runner).
 *
 * Defaults to SIGNED IN. The real security boundary for this build is
 * Vercel Authentication in front of the whole deployment (see
 * DEPLOYMENT_READINESS.md §9) — anyone who reaches this bundle at all
 * has already cleared that gate, so the app's own password screen would
 * be pure friction with nothing behind it to protect. "Sign out" (in
 * Settings) still works and returns to the real sign-in screen, so it
 * remains reachable — it just isn't the default entry experience.
 */
const SESSION_KEY = 'deal-radar-demo-signed-in';
let memSignedIn = (() => {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    return stored === null ? true : stored === '1';
  } catch { return true; }
})();
function isSignedIn(): boolean {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    return stored === null ? true : stored === '1';
  } catch { return memSignedIn; }
}
function setSignedIn(v: boolean): void {
  memSignedIn = v;
  try {
    if (v) sessionStorage.setItem(SESSION_KEY, '1');
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* environment has no Web Storage — memSignedIn still tracks it */ }
}

function authStatus(): AuthStatus {
  const authenticated = isSignedIn();
  return {
    configured: true,
    authenticated,
    mode: 'local',
    requestedMode: 'auto',
    localLoginAvailable: true,
    microsoftLoginAvailable: false,
    microsoftPending: false,
    microsoftPendingMessage: null,
    microsoftMissingRequirements: [],
    // Mirrors the real application's current honest state: the shared
    // password works today only because Entra is not registered yet.
    awaitingSsoCutover: true,
    awaitingSsoCutoverMessage:
      'Sign-in will move to Microsoft single sign-on, limited to @vamosventures.com accounts. '
      + 'The shared password works until the Entra app registration is complete, and stops working automatically once it is.',
    allowedEmailDomain: 'vamosventures.com',
    identity: authenticated ? { label: 'Demo Analyst', source: 'local-admin', email: null } : null,
  };
}

// ── Companies / scoring ──────────────────────────────────────────────

function companiesWithMeta(): { companies: Company[]; meta: Record<string, CompanyMeta> } {
  const companies: Company[] = [];
  const meta: Record<string, CompanyMeta> = {};
  for (const c of DEMO_COMPANIES) {
    const { _demo, ...company } = c;
    companies.push(company);
    const lastReviewed = _demo.lastReviewedOffsetDays === null
      ? null
      : new Date(NOW_MS + _demo.lastReviewedOffsetDays * DAY).toISOString();
    const staleFixed7 = lastReviewed
      ? NOW_MS - new Date(lastReviewed).getTime() > 7 * DAY
      : NOW_MS - new Date(NOW_MS + _demo.discoveredAtOffsetDays * DAY).getTime() > 7 * DAY;
    meta[c.id] = {
      lastRefreshed: company.lastRefreshed,
      reviewStatus: _demo.reviewStatus,
      discoverySource: _demo.discoverySource,
      discoveredAt: new Date(NOW_MS + _demo.discoveredAtOffsetDays * DAY).toISOString(),
      stale: staleFixed7 && !['Passed', 'Synced to HubSpot'].includes(_demo.reviewStatus),
      provenance: {},
      addedEvidence: [],
    };
  }
  return { companies, meta };
}

function breakdown(companies: (Company & { _demo: typeof DEMO_COMPANIES[number]['_demo'] })[]): VerticalBreakdown {
  const byVertical: Record<string, number> = { health: 0, fintech: 0, fow: 0, sustainability: 0, frontier: 0 };
  for (const c of companies) byVertical[c.vertical] = (byVertical[c.vertical] ?? 0) + 1;
  return { total: companies.length, byVertical, unassigned: 0 };
}

function computeKpis(): ExecutiveKpis {
  const all = DEMO_COMPANIES;
  const discoveredThisWeek = all.filter((c) => NOW_MS - (NOW_MS + c._demo.discoveredAtOffsetDays * DAY) <= 7 * DAY);
  const awaitingReview = all.filter((c) => ['New', 'Awaiting Review'].includes(c._demo.reviewStatus));
  const stale = all.filter((c) => {
    if (['Passed', 'Synced to HubSpot'].includes(c._demo.reviewStatus)) return false;
    const lastTouch = c._demo.lastReviewedOffsetDays ?? c._demo.discoveredAtOffsetDays;
    return -lastTouch * DAY > 7 * DAY;
  });
  const hot = all.filter((c) => {
    const { _demo, ...company } = c;
    const fit = scoreCompany(company, DEMO_NOW);
    return !fit.provisional && fit.score >= 8;
  });

  const entity = (list: typeof all): EntityKpis => ({
    lastRun: {
      ...breakdown(list), runId: 'demo-run-1', runType: 'discovery', runLabel: 'Company-sourcing run (demo/synthetic)',
      runStatus: 'Completed', runCompletedAt: new Date(NOW_MS - 2 * DAY).toISOString(), isPartial: false, warningCount: 0, affectedSources: [],
    },
    discoveredThisWeek: {
      ...breakdown(discoveredThisWeek), weekStart: new Date(NOW_MS - 7 * DAY).toISOString(), weekEnd: DEMO_NOW.toISOString(),
    },
    awaitingReview: breakdown(awaitingReview),
    stale: breakdown(stale),
    hot: breakdown(hot),
    cumulative: breakdown(all),
  });

  return {
    companies: entity(all),
    founders: entity(all), // demo build has no separate founder-candidate KPI set; mirrors company breakdown honestly
    lastUpdated: DEMO_NOW.toISOString(),
    partial: false,
    errors: [],
  };
}

function cumulativeForPeriod(period: CumulativePeriod): CumulativePeriodResult {
  if (period === 'all-time') return { ...breakdown(DEMO_COMPANIES), period, from: null, to: null };
  // Simple, honest demo behaviour: every fixture record falls inside
  // "this-month"/"this-year"; earlier periods report zero rather than
  // guessing a boundary that would misstate synthetic dates as real ones.
  const empty = { total: 0, byVertical: { health: 0, fintech: 0, fow: 0, sustainability: 0, frontier: 0 }, unassigned: 0 };
  if (period === 'this-month' || period === 'this-year') {
    return { ...breakdown(DEMO_COMPANIES), period, from: null, to: DEMO_NOW.toISOString() };
  }
  return { ...empty, period, from: null, to: null };
}

const enrichment = buildDemoEnrichment();
const pendingEvidenceByCompany = buildDemoPendingEvidence();
const notesByCompany = buildDemoNotes();

const NOT_CONNECTED_STATUS = { status: 'Implemented — credentials required' as const, detail: 'The full client is implemented in this codebase; it requires a connected account, which is not configured for this demo build. Nothing is simulated as connected.' };

export const demoApi: Api = {
  status: () => Promise.resolve<FullStatus>({
    mode: 'disconnected',
    hubspot: { provider: 'hubspot', mode: 'disconnected', connected: false, account: null, detail: 'Not connected in this demo build.', permissions: [], lastConnectedAt: null },
    outlook: { provider: 'outlook', mode: 'disconnected', connected: false, account: null, detail: 'Not connected in this demo build.', permissions: [], lastConnectedAt: null },
    ai: { provider: 'ai', mode: 'disconnected', connected: false, account: null, detail: 'Not connected in this demo build — outreach drafting uses a local template.', permissions: [], lastConnectedAt: null },
    statuses: {
      hubspot: NOT_CONNECTED_STATUS,
      outlook: NOT_CONNECTED_STATUS,
      ai: { status: 'Implemented — credentials required', detail: 'Outreach drafting uses a deterministic local template in this demo build; no model is called.' },
      refresh: { status: 'Not enabled for this local pilot', detail: 'Refresh runs are disabled in this demo build.' },
    } satisfies StatusMap,
  }),

  overview: {
    kpis: () => Promise.resolve(computeKpis()),
    cumulativePeriod: (_entity, period) => Promise.resolve(cumulativeForPeriod(period)),
  },

  auth: {
    status: () => Promise.resolve(authStatus()),
    login: () => { setSignedIn(true); return Promise.resolve({ ok: true }); },
    logout: () => { setSignedIn(false); return Promise.resolve({ ok: true }); },
    microsoftStart: () => disabled(),
  },

  hubspot: {
    connect: () => disabled(),
    disconnect: () => disabled(),
    verify: () => disabled(),
    search: () => Promise.resolve<{ hits: HubSpotSearchHit[]; demo: boolean }>({ hits: [], demo: true }),
    checkDuplicate: () => Promise.resolve({ matches: [], demo: true }),
    pipelines: () => Promise.resolve({
      pipelines: [{
        id: 'demo-pipeline', label: 'Deal Radar Pipeline (demo/synthetic)',
        stages: [
          { id: 'surfaced', label: 'Surfaced' }, { id: 'needs-review', label: 'Needs Review' },
          { id: 'approved-to-track', label: 'Approved to Track' }, { id: 'outreach-approved', label: 'Outreach Approved' },
          { id: 'outreach-drafted', label: 'Outreach Drafted' }, { id: 'founder-contacted', label: 'Founder Contacted' },
          { id: 'meeting-scheduled', label: 'Meeting Scheduled' }, { id: 'active-diligence', label: 'Active Diligence' },
          { id: 'monitor', label: 'Monitor' }, { id: 'passed', label: 'Passed' },
        ],
      }],
      demo: true,
    }),
    getMapping: () => Promise.resolve({ mapping: null, radarStages: ['Surfaced', 'Needs Review', 'Approved to Track', 'Outreach Approved', 'Outreach Drafted', 'Founder Contacted', 'Meeting Scheduled', 'Active Diligence', 'Monitor', 'Passed'] }),
    saveMapping: () => disabled(),
    syncCompany: () => disabled(),
    logActivity: () => disabled(),
    failedSyncs: () => Promise.resolve({ failed: [] }),
    retrySync: () => disabled(),
  },

  outlook: {
    status: () => Promise.resolve({ mode: 'disconnected', connected: false, account: null, permissions: [], lastConnectedAt: null, detail: 'Not connected in this demo build. Requesting only Mail.ReadWrite and User.Read — never Mail.Send, matching the real application.' }),
    connect: () => disabled(),
    disconnect: () => disabled(),
    saveDraft: () => disabled(),
  },

  ai: {
    explainFit: () => disabled(),
    comparePortfolio: () => disabled(),
  },

  refresh: {
    connectors: () => Promise.resolve<{ connectors: ConnectorInfo[] }>({
      connectors: [
        { meta: { id: 'yc', name: 'Y Combinator directory', what: 'Public accelerator directory.', needs: 'None.', setup: 'Always available.', kind: 'public' }, state: { id: 'yc', enabled: true, lastSyncAt: new Date(NOW_MS - 2 * DAY).toISOString(), lastSyncMode: 'live', recordsImported: 2, lastError: null } },
        { meta: { id: 'hubspot', name: 'HubSpot CRM', what: 'Verifies the CRM connection.', needs: 'HUBSPOT_ACCESS_TOKEN or OAuth.', setup: 'Not available in this demo build.', kind: 'integration' }, state: { id: 'hubspot', enabled: false, lastSyncAt: null, lastSyncMode: null, recordsImported: 0, lastError: 'Not connected in this demo build.' } },
      ],
    }),
    setEnabled: () => disabled(),
    run: () => disabled(),
    cancel: () => disabled(),
    log: () => Promise.resolve<{ log: RefreshLogEntry[] }>({ log: [] }),
  },

  discovery: {
    sources: () => Promise.resolve({
      sources: [
        { id: 'yc', name: 'Y Combinator directory', state: 'live', liveCapable: true, needs: 'None' },
        { id: 'github', name: 'GitHub', state: 'live', liveCapable: true, needs: 'None (optional token raises rate limits)' },
        { id: 'sec', name: 'SEC EDGAR (Form D)', state: 'live', liveCapable: true, needs: 'None' },
        { id: 'funding-news', name: 'Funding press (RSS)', state: 'live', liveCapable: true, needs: 'None' },
        { id: 'investor-news', name: 'Investor announcements', state: 'live', liveCapable: true, needs: 'None' },
        { id: 'research', name: 'arXiv', state: 'live', liveCapable: true, needs: 'None' },
        { id: 'grants', name: 'SBIR/STTR awards', state: 'live', liveCapable: true, needs: 'None (intermittently unavailable — government API)' },
        { id: 'producthunt', name: 'Product Hunt', state: 'credentials-required', liveCapable: false, needs: 'PRODUCTHUNT_TOKEN' },
      ],
    }),
    estimate: () => Promise.resolve({ estimatedTokens: 0, estimatedCostUsd: 0, note: 'Sourcing runs are disabled in this demo build.' }),
    run: () => disabled(),
    cancel: () => disabled(),
    candidates: () => Promise.resolve({ candidates: DEMO_DISCOVERY_CANDIDATES }),
    import: () => disabled(),
    runs: () => Promise.resolve({ runs: DEMO_DISCOVERY_RUNS }),
  },

  stealth: {
    signals: () => Promise.resolve({ signals: DEMO_STEALTH_SIGNALS }),
    addSignal: () => disabled(),
    patchSignal: () => disabled(),
    hypothesis: () => disabled(),
    radar: (filter = 'all', limit) => {
      const filtered = filter === 'all'
        ? DEMO_RADAR_ENTRIES
        : DEMO_RADAR_ENTRIES.filter((e) => STATUS_TO_RADAR_FILTER[e.status] === filter);
      return Promise.resolve({
        entries: limit ? filtered.slice(0, limit) : filtered,
        counts: computeRadarCounts(DEMO_RADAR_ENTRIES),
      });
    },
    duplicateHints: () => Promise.resolve({ hints: [] }),
    reviewCandidate: () => disabled(),
  },

  enrichment: {
    get: (companyId) => {
      const e = enrichment[companyId];
      if (!e) return Promise.reject(new ApiError(404, { message: 'Unknown demo company id.' }));
      return Promise.resolve({ enrichment: e });
    },
    correct: () => disabled(),
    corrections: () => Promise.resolve({ corrections: [] }),
    research: () => disabled(),
  },

  schedule: {
    get: () => Promise.resolve({ active: false, label: 'Configured but inactive — sourcing runs are disabled in this demo build.', jobs: [] }),
    save: () => disabled(),
    remove: () => disabled(),
    runNow: () => disabled(),
  },

  imports: {
    importCsv: () => disabled(),
    imported: () => {
      const { companies, meta } = companiesWithMeta();
      return Promise.resolve({
        companies, companyMeta: meta, opportunities: {}, qualifications: {}, dealEvidence: {}, quarantine: {},
        enrichment,
      });
    },
    clear: () => disabled(),
    setStatus: () => disabled(),
    refresh: () => disabled(),
    refreshResearch: () => disabled<RefreshResearchResult>(),
    pendingEvidence: (id) => Promise.resolve({ companyId: id, items: pendingEvidenceByCompany[id] ?? [] }),
    decidePendingEvidence: () => disabled(),
    tractionReview: (id) => {
      const c = DEMO_COMPANIES.find((x) => x.id === id);
      return Promise.resolve({ companyId: id, state: c && c.traction.level > 0 ? 'named-customer' : 'unknown', history: [] });
    },
    saveTractionReview: () => disabled(),
    previewWebsiteConfirmation: () => disabled<WebsiteConfirmationPreview>(),
    confirmWebsite: () => disabled<WebsiteConfirmationResult>(),
    bulkStatus: () => disabled(),
    getPortfolio: () => Promise.resolve({ portfolio: [] }),
    savePortfolio: () => disabled(),
    addPortfolioCompany: () => disabled(),
    importPortfolioCsv: () => disabled(),
  },

  outreach: {
    // Draft generation only, via a local template — no model call, no send.
    // Matches the real application's own no-AI-configured fallback, so
    // this is not a special demo behaviour but the honest current state.
    generate: (context) => Promise.resolve({
      subject: `Introduction — ${context.companyName || 'your company'} (demo/synthetic)`,
      body: `Hi ${context.founderFirstName || 'there'} — (demo/synthetic draft, template-generated, no AI model called). `
        + 'This is a read-only demonstration; nothing is ever sent from here. Saving to Outlook Drafts is disabled in this demo build.',
      rationale: 'Template-generated (demo/synthetic) — no AI model was called.',
      sources: context.sourceLinks ?? [],
      weakEvidence: false,
      warnings: ['This is a demo draft. No email can be sent or saved from this build.'],
      demo: true,
    }),
    regenerate: (context) => Promise.resolve({
      subject: `Introduction — ${context.companyName || 'your company'} (demo/synthetic)`,
      body: 'Hi — (demo/synthetic regenerated draft, template-generated, no AI model called).',
      rationale: 'Template-generated (demo/synthetic) — no AI model was called.',
      sources: context.sourceLinks ?? [],
      weakEvidence: false,
      warnings: ['This is a demo draft. No email can be sent or saved from this build.'],
      demo: true,
    }),
  },

  admin: {
    status: () => Promise.resolve<AdminStatus>({
      database: { ok: true, engine: 'in-memory demo fixtures', location: 'bundled with this build', companies: DEMO_COMPANIES.length, migrationVersion: 20 },
      connectors: {
        github: { status: 'Connected', detail: 'Public API — always available.' },
        hubspot: NOT_CONNECTED_STATUS,
        outlook: NOT_CONNECTED_STATUS,
        ai: { status: 'Implemented — credentials required', detail: 'Local template used in this demo build.' },
      },
      credentials: {},
      sourcing: {
        lastRun: { at: new Date(NOW_MS - 2 * DAY).toISOString(), status: 'Completed', initiatedBy: 'demo' },
        lastSuccessfulRun: { at: new Date(NOW_MS - 2 * DAY).toISOString(), status: 'Completed' },
        lastFailedRun: null,
        recordsRetrieved: 2, recordsCreated: 0, recordsUpdated: 0, recentErrors: [], rateLimited: [],
      },
      hubspotFailedSyncs: [],
    }),
    diversityAnalytics: () => Promise.resolve<DiversityAnalytics>({
      totalCompanies: DEMO_COMPANIES.length, totalOpportunities: 0, companyLeads: DEMO_COMPANIES.length, quarantined: 0, humanReview: 0,
      byClassification: {}, byPrimarySource: {}, byFamily: {}, byTier: {}, byQualification: {}, sharePct: {}, familySharePct: {},
      singleSourceOpportunities: 0, multiSourceOpportunities: 0, perSector: [], publicCompaniesExcluded: 0, fundsOrSpvsExcluded: 0, warnings: [],
    }),
    shortlists: () => Promise.resolve<ShortlistsResponse>({ shortlists: [], perSector: 0, totalSelected: 0, totalHeldBack: 0 }),
    sourceAnalytics: () => Promise.resolve<{ sources: SourceAnalytics[] }>({ sources: [] }),
    sourceHealth: () => Promise.resolve<{ sources: SourceHealth[] }>({ sources: [] }),
    backups: {
      list: () => Promise.resolve<{ backups: BackupMetadata[]; settings: { maxBackups: number; maxBackupAgeDays: number } }>({ backups: [], settings: { maxBackups: 10, maxBackupAgeDays: 30 } }),
      create: () => disabled<BackupMetadata>(),
    },
  },

  staleSettings: {
    get: () => Promise.resolve({
      staleAfterDays: 30, monitorGoesStale: true, researchNeededGoesStale: true,
      showStaleOnOverview: true, maxStaleOnOverview: 50, defaultStaleFilter: 'all' as const,
    }),
    update: () => disabled(),
  },

  notes: {
    list: (companyId) => Promise.resolve({ notes: notesByCompany[companyId] ?? [] }),
    create: () => disabled(),
    edit: () => disabled(),
    archive: () => disabled(),
    restore: () => disabled(),
  },

  duplicates: {
    list: () => Promise.resolve<{ duplicates: PossibleDuplicateEntry[] }>({ duplicates: [] }),
    resolve: () => disabled(),
  },
};

// Types imported only for signature-matching are re-exported so tsc
// treats every import above as used even where only the type matters.
export type { WebsiteConfirmationInput };
