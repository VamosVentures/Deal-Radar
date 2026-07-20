import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { adminAgent } from './testAuth';

/**
 * Integration tests for the REAL HubSpot client and the sync
 * routes — all network stubbed. Covers: create-once idempotency,
 * explicit-HubSpot-fields-win on update, failure recording + retry,
 * and the credentials-required admin status (no simulated success).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  vi.resetModules();
});

// ── Live client behavior (stubbed HubSpot API) ───────────────────

describe('LiveHubSpot (stubbed network)', () => {
  interface PortalState {
    companyExists: boolean;
    createCalls: number;
    patchBodies: Record<string, unknown>[];
    existingProperties: Record<string, string | null>;
  }

  function stubPortal(state: PortalState) {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/crm/v3/objects/companies/search')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const prop = body.filterGroups?.[0]?.filters?.[0]?.propertyName;
        if (prop === 'vamos_deal_radar_id' && state.companyExists) {
          return jsonResponse({ results: [{ id: 'HS-1', properties: { name: 'HubSpot Explicit Name', domain: 'explicit.example.com' } }] });
        }
        return jsonResponse({ results: [] });
      }
      if (u.includes('/crm/v3/objects/contacts/search')) return jsonResponse({ results: [] });
      if (method === 'GET' && u.includes('/crm/v3/objects/companies/HS-1')) {
        return jsonResponse({ properties: state.existingProperties });
      }
      if (method === 'PATCH' && u.includes('/crm/v3/objects/companies/HS-1')) {
        state.patchBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ id: 'HS-1' });
      }
      if (method === 'POST' && u.endsWith('/crm/v3/objects/companies')) {
        state.createCalls += 1;
        state.companyExists = true;
        return jsonResponse({ id: 'HS-1' });
      }
      if (method === 'POST' && u.endsWith('/crm/v3/objects/contacts')) return jsonResponse({ id: 'CT-1' });
      if (method === 'POST' && u.endsWith('/crm/v3/objects/deals')) return jsonResponse({ id: 'DL-1' });
      if (method === 'PUT' && u.includes('/associations/')) return jsonResponse({});
      if (u.endsWith('/crm/v3/objects/companies?limit=1')) return jsonResponse({ results: [] });
      throw new Error(`Unexpected request in test: ${method} ${u}`);
    }));
  }

  async function liveService() {
    process.env.HUBSPOT_ACCESS_TOKEN = 'test-live-token';
    vi.resetModules();
    const store = (await import('../lib/store')).store;
    store.resetForTests();
    const mod = await import('../services/hubspot');
    return mod;
  }

  const company = (over: Record<string, unknown> = {}) => ({
    name: 'Radar Derived Name', domain: 'radar.example.com', website: 'https://radar.example.com',
    city: 'Austin', state: 'TX', country: 'United States',
    description: 'Derived description.', vertical: 'Health & Wellness', subcategory: 'Care',
    stage: 'Seed', accelerator: null, fundingRaised: null,
    dateFirstSurfaced: '2026-07-01', lastRefreshed: '2026-07-18',
    primarySource: 'src', policyException: null,
    dealRadarId: 'c-live-1', dealRadarUrl: 'http://localhost:5173/?company=c-live-1',
    ...over,
  });
  const deal = () => ({
    companyName: 'Radar Derived Name', fitScore: 8, recommendation: 'Track', vertical: 'Health & Wellness',
    stage: 'Seed', scoreBreakdown: [], rationale: 'r', risks: 'none', evidenceQualityScore: 3,
    policyException: null, sourcingStatus: 'Surfaced', dateSurfaced: '2026-07-01',
    nextAction: 'Review', relationshipOwner: 'DR', dealRadarId: 'c-live-1',
    dealRadarUrl: 'http://localhost:5173/?company=c-live-1',
    scoreExplanation: 'explained', approvedBy: 'DR', approvalDate: '2026-07-18', sourceUrls: ['https://example.com/e1'],
  });

  it('creates a company exactly once — a repeated create-new call updates instead (idempotent)', async () => {
    const state: PortalState = { companyExists: false, createCalls: 0, patchBodies: [], existingProperties: {} };
    stubPortal(state);
    const { hubspotService } = await liveService();
    const svc = hubspotService();
    const args = {
      company: company(), contacts: [], deal: deal(),
      stageId: 's-1', pipelineId: 'p-1', resolution: 'create-new' as const, existingRecordId: null,
    };
    const first = await svc.syncCompany(args);
    expect(first.action).toBe('created');
    const second = await svc.syncCompany(args); // repeated click, still create-new
    expect(second.action).toBe('updated');
    expect(second.companyId).toBe(first.companyId);
    expect(state.createCalls).toBe(1); // never a duplicate company in HubSpot
  });

  it('explicit HubSpot fields win on update: geography and core fields are never overwritten', async () => {
    const state: PortalState = {
      companyExists: true,
      createCalls: 0,
      patchBodies: [],
      existingProperties: {
        name: 'HubSpot Explicit Name', domain: 'explicit.example.com', website: 'https://explicit.example.com',
        city: 'Boston', state: 'MA', country: 'United States', description: 'Explicit description written in HubSpot.',
      },
    };
    stubPortal(state);
    const { hubspotService } = await liveService();
    const result = await hubspotService().syncCompany({
      company: company({ city: 'Austin', state: 'TX' }), contacts: [], deal: deal(),
      stageId: 's-1', pipelineId: 'p-1', resolution: 'create-new', existingRecordId: null,
    });
    expect(result.action).toBe('updated');
    const patch = state.patchBodies[0].properties as Record<string, unknown>;
    // Explicit HubSpot values preserved — no inferred/derived overwrite:
    for (const preserved of ['name', 'domain', 'website', 'city', 'state', 'country', 'description']) {
      expect(patch).not.toHaveProperty(preserved);
    }
    // Our own vamos_* properties ARE refreshed:
    expect(patch.vamos_deal_radar_id).toBe('c-live-1');
    expect(patch.vamos_vertical).toBe('Health & Wellness');
  });

  it('fills empty HubSpot fields while preserving the non-empty ones', async () => {
    const state: PortalState = {
      companyExists: true,
      createCalls: 0,
      patchBodies: [],
      existingProperties: {
        name: 'HubSpot Explicit Name', domain: null, website: '', // empty → ours may fill
        city: 'Boston', state: 'MA', country: null, description: null,
      },
    };
    stubPortal(state);
    const { hubspotService } = await liveService();
    await hubspotService().syncCompany({
      company: company(), contacts: [], deal: deal(),
      stageId: 's-1', pipelineId: 'p-1', resolution: 'create-new', existingRecordId: null,
    });
    const patch = state.patchBodies[0].properties as Record<string, unknown>;
    expect(patch).not.toHaveProperty('name');   // explicit → preserved
    expect(patch).not.toHaveProperty('city');   // explicit geography → never overwritten
    expect(patch).not.toHaveProperty('state');
    expect(patch.domain).toBe('radar.example.com');   // empty → filled from recorded facts
    expect(patch.website).toBe('https://radar.example.com');
    expect(patch.description).toBe('Derived description.');
  });
});

// ── Failure recording + retry (route level, flaky fixture) ───────

describe('sync failure recording and retry', () => {
  beforeEach(async () => {
    const { store } = await import('../lib/store');
    const { resetIdempotencyForTests } = await import('../lib/guard');
    store.resetForTests();
    resetIdempotencyForTests();
  });

  it('records the failure with its payload, lists it, and retry succeeds', async () => {
    const { createApp } = await import('../app');
    const { __setHubSpotServiceForTests } = await import('../services/hubspot');
    const { installTestPipelineMapping, uninstallMockIntegrations } = await import('./mocks/install');
    const { MockHubSpot } = await import('./mocks/hubspot');

    // A fixture that fails ONCE (e.g. transient 502), then behaves.
    const inner = new MockHubSpot();
    let failures = 1;
    __setHubSpotServiceForTests(new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'syncCompany' && failures > 0) {
          return async () => {
            failures -= 1;
            throw Object.assign(new Error('HubSpot returned 502. Transient upstream error.'), { status: 502 });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }));
    installTestPipelineMapping();

    const app = createApp();
    const payload = {
      company: {
        name: 'Retry Co', domain: null, website: null, city: 'Austin', state: 'TX', country: 'United States',
        description: 'x', vertical: 'FinTech', subcategory: 'Payments', stage: 'Seed', accelerator: null,
        fundingRaised: null, dateFirstSurfaced: '2026-07-01', lastRefreshed: '2026-07-18',
        primarySource: 'src', policyException: null, dealRadarId: 'c-retry', dealRadarUrl: 'http://localhost:5173',
      },
      contacts: [],
      deal: {
        companyName: 'Retry Co', fitScore: 6, recommendation: 'Track', vertical: 'FinTech', stage: 'Seed',
        scoreBreakdown: [], rationale: '', risks: '', evidenceQualityScore: 2, policyException: null,
        sourcingStatus: 'Surfaced', dateSurfaced: '2026-07-01', nextAction: 'Review', relationshipOwner: null,
        dealRadarId: 'c-retry', dealRadarUrl: 'http://localhost:5173',
      },
      radarStage: 'Surfaced', duplicateResolution: 'create-new', existingRecordId: null,
    };

    const agent = await adminAgent(app);

    // First attempt fails — recorded honestly, nothing pretends success.
    const failed = await request(app).post('/api/hubspot/sync-company').send(payload);
    expect(failed.status).toBe(502);

    const queue = await agent.get('/api/hubspot/failed-syncs');
    expect(queue.body.failed).toHaveLength(1);
    expect(queue.body.failed[0].companyId).toBe('c-retry');
    expect(queue.body.failed[0].detail).toMatch(/502/);

    // Retry re-runs the STORED payload through the same path.
    const retried = await agent.post('/api/hubspot/retry-sync').send({ companyId: 'c-retry' });
    expect(retried.status).toBe(200);
    expect(retried.body.action).toBe('created');

    // Latest outcome is now ok → retry queue is empty.
    const queueAfter = await agent.get('/api/hubspot/failed-syncs');
    expect(queueAfter.body.failed).toHaveLength(0);

    const { listHubspotSyncHistory } = await import('../db/repos/operations');
    const history = listHubspotSyncHistory('c-retry');
    expect(history.map((h) => h.outcome)).toEqual(['ok', 'error']); // newest first

    uninstallMockIntegrations();
  });

  it('retry with no failed sync on record returns an honest 404', async () => {
    const { createApp } = await import('../app');
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/hubspot/retry-sync').send({ companyId: 'never-synced' });
    expect(res.status).toBe(404);
  });
});

// ── Admin status: credentials required, never simulated ──────────

describe('admin status without credentials', () => {
  it('shows Implemented — credentials required and presence booleans only', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).includes('api.github.com/rate_limit')) {
        return jsonResponse({ resources: { core: { remaining: 55, limit: 60, reset: 1780000000 } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { store } = await import('../lib/store');
    const { resetAdminHealthCacheForTests } = await import('../routes/admin');
    store.resetForTests();
    resetAdminHealthCacheForTests();
    const { createApp } = await import('../app');
    const app = createApp();
    const agent = await adminAgent(app);

    const res = await agent.get('/api/admin/status');
    expect(res.status).toBe(200);
    expect(res.body.database.ok).toBe(true);
    expect(res.body.database.engine).toContain('SQLite');
    // Connected ONLY after a real health check succeeded (stubbed GitHub here).
    expect(res.body.connectors.github.status).toBe('Connected');
    expect(res.body.connectors.github.detail).toContain('55/60');
    // Real implementations without credentials say so — no simulated success.
    expect(res.body.connectors.hubspot.status).toBe('Implemented — credentials required');
    expect(res.body.connectors.outlook.status).toBe('Implemented — credentials required');
    expect(res.body.connectors.ai.status).toBe('Implemented — credentials required');
    // Presence booleans only — never secret values.
    expect(res.body.credentials.hubspotPrivateAppToken).toBe(false);
    expect(res.body.credentials.microsoftEntraApp).toBe(false);
    for (const v of Object.values(res.body.credentials)) expect(typeof v).toBe('boolean');
    expect(res.body.sourcing.lastRun).toBeNull();
    expect(res.body.sourcing.recordsRetrieved).toBe(0);
  });
});
