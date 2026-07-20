import { getDb, resetDbForTests } from '../db/client';
import type {
  OutreachDraft,
  IntegrationAuditLog,
} from '../../shared/integrations';

/**
 * Operational state store, persisted in the SAME SQLite database as
 * the domain repositories (server/db/) — the old best-effort JSON
 * file is gone. Collections here are working state (outreach tracker,
 * drafts, encrypted tokens, audit log, pending discovery candidates);
 * companies, founders, evidence, runs, scores, review decisions,
 * sync history, health, and sourcing config live in real tables via
 * server/db/repos/*.
 *
 * The mockHubSpot collection exists solely for the test fixtures.
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

interface StoreShape {
  mockHubSpot: MockHubSpotObject[];
  drafts: OutreachDraft[];
  tokens: TokenRecord[];
  audit: IntegrationAuditLog[];
  oauthStates: { state: string; expiresAt: string }[];
  counters: Record<string, number>;
  /** Cached AI outputs keyed by request hash. */
  aiCache: Record<string, { at: string; value: unknown }>;
  refreshLog: RefreshLogEntry[];
  refreshCancelRequested: boolean;
  discoveryCandidates: unknown[];
  discoveryCancelRequested: boolean;
  stealthSignals: unknown[];
  portfolio: unknown[];
}

const EMPTY: StoreShape = {
  mockHubSpot: [],
  drafts: [],
  tokens: [],
  audit: [],
  oauthStates: [],
  counters: {},
  aiCache: {},
  refreshLog: [],
  refreshCancelRequested: false,
  discoveryCandidates: [],
  discoveryCancelRequested: false,
  stealthSignals: [],
  portfolio: [],
};

function loadState(): StoreShape {
  const state = structuredClone(EMPTY);
  try {
    const rows = getDb().prepare('SELECT collection, value FROM kv').all() as { collection: string; value: string }[];
    for (const row of rows) {
      if (row.collection in state) {
        (state as unknown as Record<string, unknown>)[row.collection] = JSON.parse(row.value);
      }
    }
  } catch {
    /* first run — empty state */
  }
  return state;
}

let state: StoreShape = loadState();

let writeQueued = false;
function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    flush();
  }, 25);
}

/** Transactional write of every collection. */
function flush() {
  const db = getDb();
  const upsert = db.prepare('INSERT INTO kv (collection, value) VALUES (?, ?) ON CONFLICT (collection) DO UPDATE SET value = excluded.value');
  db.exec('BEGIN');
  try {
    for (const [collection, value] of Object.entries(state)) {
      upsert.run(collection, JSON.stringify(value));
    }
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
  }
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
  /** Write pending changes immediately (used at shutdown). */
  flush(): void {
    flush();
  },
  resetForTests(): void {
    state = structuredClone(EMPTY);
    resetDbForTests();
  },
};
