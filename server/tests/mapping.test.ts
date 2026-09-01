import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';
import { installMockIntegrations, uninstallMockIntegrations } from './mocks/install';
import { adminAgent } from './testAuth';

function syncPayload() {
  return {
    company: {
      name: 'Cuadrilla', domain: 'cuadrilla.example.com', website: 'https://cuadrilla.example.com',
      city: 'San Antonio', state: 'TX', country: 'United States',
      description: 'Bilingual field-ops platform.', industry: 'Future of Work',
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
    radarStage: 'To Be Reviewed',
    duplicateResolution: 'create-new',
    existingRecordId: null,
  };
}

describe('pipeline-stage mapping', () => {
  beforeEach(() => {
    store.resetForTests();
    resetIdempotencyForTests();
    installMockIntegrations();
  });
  afterAll(() => uninstallMockIntegrations());

  it('blocks submission with instructions when a stage is unmapped — never guesses IDs', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    // resolveStage throws BEFORE any HubSpot call is attempted.
    const res = await agent.post('/api/hubspot/sync-company').send(syncPayload());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('blocked');
    expect(res.body.message).toMatch(/no hubspot stage is mapped/i);
    expect(res.body.hint).toMatch(/pipeline mapping/i);
    expect(store.raw.mockHubSpot).toHaveLength(0); // nothing was written
  });

  it('a saved mapping is used for the deal stage', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const put = await agent.put('/api/hubspot/pipeline-mapping').send({
      stages: { 'To Be Reviewed': { pipelineId: 'test-pipeline', stageId: 'custom-stage-42' } },
    });
    expect(put.status).toBe(200);
    const res = await agent.post('/api/hubspot/sync-company').send(syncPayload());
    expect(res.status).toBe(200);
    const deal = store.raw.mockHubSpot.find((o) => o.type === 'deal')!;
    expect(deal.properties.dealstage).toBe('custom-stage-42');
    expect(deal.properties.pipeline).toBe('test-pipeline');
  });

  it('rejects an invalid mapping payload', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.put('/api/hubspot/pipeline-mapping').send({ stages: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('fails honestly with 503 not_connected when HubSpot has no credentials', async () => {
    uninstallMockIntegrations();
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/hubspot/sync-company').send(syncPayload());
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_connected');
    expect(res.body.message).toMatch(/not connected/i);
    expect(res.body.hint).toMatch(/HUBSPOT_ACCESS_TOKEN/);
    expect(store.raw.mockHubSpot).toHaveLength(0);
  });
});
