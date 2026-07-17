import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';

function syncPayload() {
  return {
    company: {
      name: 'Cuadrilla', domain: 'cuadrilla.example.com', website: 'https://cuadrilla.example.com',
      city: 'San Antonio', state: 'TX', country: 'United States',
      description: 'Bilingual field-ops platform.', vertical: 'Future of Work',
      subcategory: 'Workforce tools', stage: 'Seed', accelerator: null, fundingRaised: null,
      dateFirstSurfaced: '2026-03-02', lastRefreshed: '2026-07-14',
      primarySource: 'Company About page', policyException: null,
      dealRadarId: 'c-cuadrilla', dealRadarUrl: 'http://localhost:5173/?company=c-cuadrilla',
    },
    contacts: [],
    deal: {
      companyName: 'Cuadrilla', fitScore: 9.1, recommendation: 'Prioritize',
      vertical: 'Future of Work', stage: 'Seed',
      scoreBreakdown: [], rationale: 'r', risks: 'none', evidenceQualityScore: 7,
      policyException: null, sourcingStatus: 'Surfaced', dateSurfaced: '2026-03-02',
      nextAction: 'Review', relationshipOwner: 'MG',
      dealRadarId: 'c-cuadrilla', dealRadarUrl: 'http://localhost:5173/?company=c-cuadrilla',
    },
    radarStage: 'Approved to Track',
    duplicateResolution: 'create-new',
    existingRecordId: null,
  };
}

describe('pipeline-stage mapping', () => {
  beforeEach(() => {
    store.resetForTests();
    resetIdempotencyForTests();
  });

  it('mock mode falls back to demo stage ids when no mapping exists', async () => {
    const app = createApp();
    const res = await request(app).post('/api/hubspot/sync-company').send(syncPayload());
    expect(res.status).toBe(200);
    const deal = store.raw.mockHubSpot.find((o) => o.type === 'deal')!;
    expect(deal.properties.dealstage).toBe('demo-approved-to-track');
    expect(deal.properties.pipeline).toBe('demo-pipeline');
  });

  it('a saved mapping is used for the deal stage', async () => {
    const app = createApp();
    const put = await request(app).put('/api/hubspot/pipeline-mapping').send({
      pipelineId: 'demo-pipeline',
      pipelineLabel: 'Demo',
      stages: { 'Approved to Track': 'custom-stage-42' },
    });
    expect(put.status).toBe(200);
    const res = await request(app).post('/api/hubspot/sync-company').send(syncPayload());
    expect(res.status).toBe(200);
    const deal = store.raw.mockHubSpot.find((o) => o.type === 'deal')!;
    expect(deal.properties.dealstage).toBe('custom-stage-42');
  });

  it('rejects an invalid mapping payload', async () => {
    const app = createApp();
    const res = await request(app).put('/api/hubspot/pipeline-mapping').send({ pipelineId: '', stages: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('LIVE mode blocks submission with instructions when a stage is unmapped — never guesses IDs', async () => {
    vi.resetModules();
    process.env.INTEGRATION_MODE = 'auto';
    process.env.HUBSPOT_ACCESS_TOKEN = 'fake-live-token';
    const { createApp: createLiveApp } = await import('../app');
    const { store: liveStore } = await import('../lib/store');
    const { resetIdempotencyForTests: resetIdem } = await import('../lib/guard');
    liveStore.resetForTests();
    resetIdem();
    const app = createLiveApp();
    // resolveStage throws BEFORE any HubSpot network call is attempted.
    const res = await request(app).post('/api/hubspot/sync-company').send(syncPayload());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('blocked');
    expect(res.body.message).toMatch(/no hubspot stage is mapped/i);
    expect(res.body.hint).toMatch(/pipeline mapping/i);
    process.env.INTEGRATION_MODE = 'mock';
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    vi.resetModules();
  });
});
