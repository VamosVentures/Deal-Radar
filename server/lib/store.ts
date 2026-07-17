import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env';
import type {
  FollowUpTask,
  HubSpotPipelineMapping,
  OutreachDraft,
  OutreachRecord,
  IntegrationAuditLog,
} from '../../shared/integrations';

/**
 * Development datastore. A single JSON file keeps mock CRM records,
 * outreach state, follow-ups, audit entries, and (encrypted) tokens
 * so Demo Mode survives restarts. Tests run fully in memory with
 * DATA_FILE=':memory:'. Swap for Postgres/Supabase in production —
 * the shape below is the table plan.
 */

export interface MockHubSpotObject {
  id: string;
  type: 'company' | 'contact' | 'deal' | 'note';
  properties: Record<string, string | number | null>;
  associations: string[]; // ids of associated objects
  createdAt: string;
  updatedAt: string;
}

export interface TokenRecord {
  provider: 'outlook' | 'hubspot';
  account: string;
  scopes: string[];
  /** AES-256-GCM ciphertext — never the raw token. */
  cipher: string;
  expiresAt: string;
  refreshCipher: string | null;
  connectedAt: string;
}

export interface RefreshLogEntry {
  id: string;
  at: string;
  trigger: 'manual' | 'scheduled';
  scope: string;
  status: 'ok' | 'partial' | 'failed' | 'cancelled';
  results: {
    connector: string;
    mode: 'live' | 'local' | 'simulated' | 'failed';
    records: number;
    detail: string;
  }[];
}

export interface ConnectorState {
  id: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSyncMode: 'live' | 'local' | 'simulated' | 'failed' | null;
  recordsImported: number;
  lastError: string | null;
}

interface StoreShape {
  mockHubSpot: MockHubSpotObject[];
  outreach: Record<string, OutreachRecord>;
  drafts: OutreachDraft[];
  followUps: FollowUpTask[];
  pipelineMapping: HubSpotPipelineMapping | null;
  tokens: TokenRecord[];
  audit: IntegrationAuditLog[];
  oauthStates: { state: string; expiresAt: string }[];
  counters: Record<string, number>;
  /** Cached AI outputs keyed by request hash. */
  aiCache: Record<string, { at: string; value: unknown }>;
  refreshLog: RefreshLogEntry[];
  refreshCancelRequested: boolean;
  connectors: Record<string, ConnectorState>;
  importedCompanies: unknown[];
  portfolio: unknown[];
  /** Per-company metadata updated by refresh jobs (bundled sample data is read-only). */
  companyMeta: Record<string, {
    lastRefreshed?: string;
    reviewStatus?: string;
    discoverySource?: string;
    discoveredAt?: string;
    /** Evidence merged onto existing records from discovery — never overwrites, always appends. */
    addedEvidence?: unknown[];
  }>;
  discoveryRuns: unknown[];
  discoveryCandidates: unknown[];
  discoveryCancelRequested: boolean;
  stealthSignals: unknown[];
  scheduledJobs: unknown[];
}

const EMPTY: StoreShape = {
  mockHubSpot: [],
  outreach: {},
  drafts: [],
  followUps: [],
  pipelineMapping: null,
  tokens: [],
  audit: [],
  oauthStates: [],
  counters: {},
  aiCache: {},
  refreshLog: [],
  refreshCancelRequested: false,
  connectors: {},
  importedCompanies: [],
  portfolio: [],
  companyMeta: {},
  discoveryRuns: [],
  discoveryCandidates: [],
  discoveryCancelRequested: false,
  stealthSignals: [],
  scheduledJobs: [],
};

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath =
  env.DATA_FILE && env.DATA_FILE !== ':memory:'
    ? env.DATA_FILE
    : path.join(here, '..', '.data', 'dev-store.json');
const inMemory = env.DATA_FILE === ':memory:';

let state: StoreShape = structuredClone(EMPTY);

if (!inMemory) {
  try {
    state = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch {
    /* first run — empty store */
  }
}

let writeQueued = false;
function persist() {
  if (inMemory || writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(state, null, 1));
    } catch {
      /* dev store is best-effort */
    }
  }, 50);
}

export const store = {
  get raw(): StoreShape {
    return state;
  },
  nextId(prefix: string): string {
    state.counters[prefix] = (state.counters[prefix] ?? 0) + 1;
    persist();
    return `${prefix}-${state.counters[prefix]}`;
  },
  save(): void {
    persist();
  },
  resetForTests(): void {
    state = structuredClone(EMPTY);
  },
};
