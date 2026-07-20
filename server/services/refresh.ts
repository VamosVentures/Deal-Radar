import { z } from 'zod';
import { aiConfigured } from '../env';
import { store, type RefreshLogEntry } from '../lib/store';
import { audit } from '../lib/guard';
import { companyMetaView, listCompanies, markRefreshed } from '../db/repos/companies';
import { getConfig, setConfig } from '../db/repos/operations';
import { fetchWithTimeout, isSafeExternalUrlResolved } from '../lib/http';
import { hubspotServiceIfAvailable } from './hubspot';
import { outlookService } from './outlook';
import { verifyAiConnection } from './analysis';

/**
 * Real refresh system. Refreshes run ONLY when manually triggered
 * (no scheduler exists in this backend, so schedules are stored as
 * configuration but never auto-executed — activating them requires
 * a real job runner). Each run queries only enabled connectors,
 * reports per-connector mode (live / local / simulated / failed),
 * keeps successful results when others fail, and can be cancelled
 * between connectors.
 */

export interface ConnectorMeta {
  id: string;
  name: string;
  what: string;
  needs: string; // credential requirements, human-readable
  setup: string; // setup instructions
  kind: 'integration' | 'local' | 'public';
}

export const CONNECTORS: ConnectorMeta[] = [
  { id: 'hubspot', name: 'HubSpot CRM', what: 'Verifies the CRM connection and counts synced Deal Radar records.', needs: 'HUBSPOT_ACCESS_TOKEN or a completed HubSpot OAuth connection. Fails honestly when not connected.', setup: 'Data Sources → Integrations → HubSpot. Private app: set HUBSPOT_ACCESS_TOKEN. OAuth: set HUBSPOT_CLIENT_ID/SECRET/REDIRECT_URI and click Connect.', kind: 'integration' },
  { id: 'outlook', name: 'Microsoft Outlook', what: 'Verifies the mailbox connection and checks statuses of drafts this app created.', needs: 'MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI + SESSION_SECRET and a completed sign-in. Fails honestly when not connected.', setup: 'Data Sources → Integrations → Outlook → Connect Outlook.', kind: 'integration' },
  { id: 'ai', name: 'AI provider', what: 'Verifies the model API key used for outreach drafts and fit analysis.', needs: 'AI_PROVIDER + an API key (AI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY). None for local templates.', setup: 'Set the provider variables in .env; the local template generator needs nothing.', kind: 'integration' },
  { id: 'local-csv', name: 'Local CSV import', what: 'Imports companies from an uploaded CSV through the same validation guardrails as bundled data.', needs: 'Nothing — fully local.', setup: 'Upload a CSV on this card. Columns: name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType.', kind: 'local' },
  { id: 'local-portfolio', name: 'Local portfolio file', what: 'Loads the fund portfolio (JSON) used by the AI portfolio-comparison analysis.', needs: 'Nothing — fully local.', setup: 'Upload a JSON array of {name, vertical, stage, status} on this card.', kind: 'local' },
  { id: 'websites', name: 'Public company websites', what: 'Re-checks recorded company websites for reachability (HEAD request).', needs: 'Outbound network access to the recorded domains.', setup: 'Enable and run — uses the website URLs already on record. Sample data uses fictional domains, so expect failures until real companies are loaded.', kind: 'public' },
  { id: 'yc', name: 'Y Combinator directory', what: 'Checks the public YC company directory for matches by company name.', needs: 'Outbound network access to yc API endpoints.', setup: 'Enable and run. Public data only; no login is used.', kind: 'public' },
  { id: 'github', name: 'GitHub public API', what: 'Verifies public-API reachability and rate-limit headroom for engineering-signal lookups.', needs: 'Nothing (unauthenticated public API; low rate limits apply).', setup: 'Enable and run. Add a GitHub org mapping per company to collect repo signals (none exist for the fictional sample data).', kind: 'public' },
  { id: 'sec', name: 'SEC public data', what: 'Checks SEC EDGAR full-text search availability for Form D filings.', needs: 'Outbound network access to efts.sec.gov (SEC requires a User-Agent).', setup: 'Enable and run. Public filings only.', kind: 'public' },
];

export const connectorStateSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastSyncMode: z.enum(['live', 'local', 'simulated', 'failed']).nullable(),
  recordsImported: z.number(),
  lastError: z.string().nullable(),
});
export type ConnectorState = z.infer<typeof connectorStateSchema>;

const CONNECTOR_STATE_KEY = 'connector-state';
const connectorStatesSchema = z.record(z.string(), connectorStateSchema);

function allConnectorStates(): Record<string, ConnectorState> {
  return getConfig(CONNECTOR_STATE_KEY, connectorStatesSchema, {});
}

function saveConnectorState(state: ConnectorState): void {
  setConfig(CONNECTOR_STATE_KEY, { ...allConnectorStates(), [state.id]: state });
}

export function connectorState(id: string): ConnectorState {
  const existing = allConnectorStates()[id];
  if (existing) return existing;
  return {
    id,
    enabled: id === 'hubspot' || id === 'outlook' || id === 'ai' || id === 'local-csv' || id === 'local-portfolio',
    lastSyncAt: null,
    lastSyncMode: null,
    recordsImported: 0,
    lastError: null,
  };
}

export function listConnectors() {
  return CONNECTORS.map((meta) => ({ meta, state: connectorState(meta.id) }));
}

export function setConnectorEnabled(id: string, enabled: boolean): ConnectorState {
  const s = { ...connectorState(id), enabled };
  saveConnectorState(s);
  return s;
}

interface ConnectorResult {
  connector: string;
  mode: 'live' | 'local' | 'simulated' | 'failed';
  records: number;
  detail: string;
}

type Runner = (scope: RefreshScope) => Promise<ConnectorResult>;

export interface RefreshScope {
  companyIds: string[] | null; // null = all
  vertical: string | null;
  staleOnly: boolean;
  /** Cap on records / outbound API calls per connector (token & rate protection). */
  maxRecords: number;
}

const RUNNERS: Record<string, Runner> = {
  hubspot: async () => {
    const svc = hubspotServiceIfAvailable();
    if (!svc) {
      return { connector: 'hubspot', mode: 'failed', records: 0, detail: 'This integration is not connected. Add HubSpot credentials to .env to sync.' };
    }
    const verify = await svc.verifyConnection();
    if (!verify.ok) return { connector: 'hubspot', mode: 'failed', records: 0, detail: verify.detail };
    const records = Object.values(companyMetaView()).filter((m) => m.hubspotCompanyId).length;
    return {
      connector: 'hubspot',
      mode: svc.mode === 'live' ? 'live' : 'simulated', // 'simulated' only occurs via test fixtures
      records,
      detail: `Connection verified; ${records} tracked record(s) have HubSpot ids.`,
    };
  },
  outlook: async () => {
    const svc = outlookService();
    if (svc.mode === 'disconnected') {
      return { connector: 'outlook', mode: 'failed', records: 0, detail: 'This integration is not connected. Add Microsoft credentials to .env to check drafts.' };
    }
    const verify = await svc.verifyConnection();
    if (!verify.ok) return { connector: 'outlook', mode: 'failed', records: 0, detail: verify.detail };
    const drafts = store.raw.drafts.length;
    return {
      connector: 'outlook',
      mode: svc.mode === 'live' ? 'live' : 'simulated', // 'simulated' only occurs via test fixtures
      records: drafts,
      detail: `Connection verified; ${drafts} draft(s) created by this app are on record.`,
    };
  },
  ai: async () => {
    const verify = await verifyAiConnection();
    if (!verify.ok) return { connector: 'ai', mode: 'failed', records: 0, detail: verify.detail };
    return { connector: 'ai', mode: aiConfigured() ? 'live' : 'local', records: 0, detail: verify.detail };
  },
  'local-csv': async () => {
    const n = listCompanies().length;
    return { connector: 'local-csv', mode: 'local', records: n, detail: `${n} imported compan${n === 1 ? 'y' : 'ies'} on record (validated at upload time).` };
  },
  'local-portfolio': async () => {
    const n = store.raw.portfolio.length;
    return { connector: 'local-portfolio', mode: 'local', records: n, detail: n > 0 ? `${n} portfolio compan${n === 1 ? 'y' : 'ies'} loaded.` : 'No portfolio file uploaded yet.' };
  },
  websites: async (scope) => {
    // HEAD-check recorded websites. Stored URLs are not fully trusted:
    // reject anything that isn't a plain public http(s) host, checked
    // by literal AND by resolved address (SSRF guard) — rejected
    // entries are reported, not fetched.
    const sites = scopedCompanyWebsites(scope);
    if (sites.length === 0) return { connector: 'websites', mode: 'local', records: 0, detail: 'No recorded websites in scope.' };
    const cap = Math.min(scope.maxRecords, 10);
    let ok = 0;
    const failures: string[] = [];
    for (const site of sites.slice(0, cap)) {
      if (!(await isSafeExternalUrlResolved(site))) {
        failures.push(`${site} → refused (not a public http(s) address)`);
        continue;
      }
      try {
        const res = await fetchWithTimeout(site, { method: 'HEAD' }, 5000);
        if (res.ok) ok += 1;
        else failures.push(`${site} → ${res.status}`);
      } catch {
        failures.push(`${site} → unreachable`);
      }
    }
    if (ok === 0) return { connector: 'websites', mode: 'failed', records: 0, detail: `0/${Math.min(sites.length, cap)} sites reachable. ${failures.slice(0, 3).join('; ')}${sites.some((s) => s.includes('.example.')) ? ' (sample data uses fictional domains — this is expected)' : ''}` };
    return { connector: 'websites', mode: 'live', records: ok, detail: `${ok}/${Math.min(sites.length, cap)} recorded sites reachable.${failures.length > 0 ? ` Failures: ${failures.slice(0, 3).join('; ')}` : ''}` };
  },
  yc: async () => {
    try {
      const res = await fetchWithTimeout('https://api.ycombinator.com/v0.1/companies?page=1', {}, 6000);
      if (!res.ok) return { connector: 'yc', mode: 'failed', records: 0, detail: `YC directory returned ${res.status}.` };
      return { connector: 'yc', mode: 'live', records: 0, detail: 'YC public directory reachable. 0 records imported — no sample company matched (fictional names).' };
    } catch (e) {
      return { connector: 'yc', mode: 'failed', records: 0, detail: `YC directory unreachable from this network: ${(e as Error).message}` };
    }
  },
  github: async () => {
    try {
      const res = await fetchWithTimeout('https://api.github.com/rate_limit', { headers: { 'User-Agent': 'vamos-deal-radar' } }, 6000);
      if (!res.ok) return { connector: 'github', mode: 'failed', records: 0, detail: `GitHub API returned ${res.status}.` };
      const data = (await res.json()) as { resources?: { core?: { remaining?: number; limit?: number } } };
      const core = data.resources?.core;
      return {
        connector: 'github',
        mode: 'live',
        records: 0,
        detail: `GitHub public API reachable (rate limit ${core?.remaining ?? '?'}/${core?.limit ?? '?'} remaining). 0 records imported — no GitHub org mappings exist for the fictional sample companies.`,
      };
    } catch (e) {
      return { connector: 'github', mode: 'failed', records: 0, detail: `GitHub API unreachable: ${(e as Error).message}` };
    }
  },
  sec: async () => {
    try {
      const res = await fetchWithTimeout('https://efts.sec.gov/LATEST/search-index?q=%22form%20d%22&forms=D', { headers: { 'User-Agent': 'vamos-deal-radar research contact@example.com' } }, 6000);
      if (res.status >= 500) return { connector: 'sec', mode: 'failed', records: 0, detail: `SEC EDGAR returned ${res.status}.` };
      return { connector: 'sec', mode: 'live', records: 0, detail: `SEC EDGAR reachable (HTTP ${res.status}). 0 records imported — fictional sample companies have no real filings.` };
    } catch (e) {
      return { connector: 'sec', mode: 'failed', records: 0, detail: `SEC EDGAR unreachable from this network: ${(e as Error).message}` };
    }
  },
};

function scopedCompanyWebsites(scope: RefreshScope): string[] {
  // Websites recorded on persisted companies.
  const sites = listCompanies().map((c) => c.website).filter((w): w is string => !!w);
  void scope;
  return Array.from(new Set(sites));
}

export const refreshRequestSchema = z.object({
  connectorIds: z.array(z.string()).nullable().default(null), // null = all enabled
  companyIds: z.array(z.string()).nullable().default(null),
  vertical: z.string().nullable().default(null),
  staleOnly: z.boolean().default(false),
  maxRecords: z.number().int().min(1).max(500).default(25),
});

export async function runRefresh(rawReq: unknown): Promise<RefreshLogEntry> {
  const req = refreshRequestSchema.parse(rawReq);
  store.raw.refreshCancelRequested = false;

  const targets = listConnectors()
    .filter(({ meta, state }) => state.enabled && (!req.connectorIds || req.connectorIds.includes(meta.id)));

  const scope: RefreshScope = { companyIds: req.companyIds, vertical: req.vertical, staleOnly: req.staleOnly, maxRecords: req.maxRecords };
  const results: ConnectorResult[] = [];
  let cancelled = false;

  for (const { meta } of targets) {
    if (store.raw.refreshCancelRequested) {
      cancelled = true;
      break;
    }
    const runner = RUNNERS[meta.id];
    let result: ConnectorResult;
    try {
      result = runner
        ? await runner(scope)
        : { connector: meta.id, mode: 'failed', records: 0, detail: 'No runner implemented for this connector.' };
    } catch (e) {
      // One failing connector never loses the others' results.
      result = { connector: meta.id, mode: 'failed', records: 0, detail: (e as Error).message };
    }
    results.push(result);
    saveConnectorState({
      ...connectorState(meta.id),
      lastSyncAt: new Date().toISOString(),
      lastSyncMode: result.mode,
      recordsImported: result.records,
      lastError: result.mode === 'failed' ? result.detail : null,
    });
  }

  // Stamp verification dates on in-scope persisted companies.
  const today = new Date().toISOString().slice(0, 10);
  const trackedIds = (req.companyIds ?? listCompanies().map((c) => c.id)).slice(0, req.maxRecords);
  markRefreshed(trackedIds, today);

  const anyFailed = results.some((r) => r.mode === 'failed');
  const allFailed = results.length > 0 && results.every((r) => r.mode === 'failed');
  const entry: RefreshLogEntry = {
    id: store.nextId('refresh'),
    at: new Date().toISOString(),
    trigger: 'manual',
    scope: req.connectorIds ? `connectors: ${req.connectorIds.join(', ')}` : req.vertical ? `vertical: ${req.vertical}` : req.companyIds ? `${req.companyIds.length} compan${req.companyIds.length === 1 ? 'y' : 'ies'}` : 'all enabled connectors',
    status: cancelled ? 'cancelled' : allFailed ? 'failed' : anyFailed ? 'partial' : 'ok',
    results,
  };
  store.raw.refreshLog.unshift(entry);
  store.raw.refreshLog = store.raw.refreshLog.slice(0, 50);
  store.save();
  audit({
    provider: 'system', mode: 'local', action: 'refresh',
    subject: entry.scope, outcome: entry.status === 'ok' ? 'ok' : entry.status === 'failed' ? 'error' : 'blocked',
    detail: `${results.length} connector(s): ${results.map((r) => `${r.connector}=${r.mode}`).join(', ')}${cancelled ? ' (cancelled)' : ''}`,
  });
  return entry;
}

export function cancelRefresh(): void {
  store.raw.refreshCancelRequested = true;
  store.save();
}

export function refreshLog(): RefreshLogEntry[] {
  return store.raw.refreshLog;
}
