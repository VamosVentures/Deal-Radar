import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import { setConfig } from '../db/repos/operations';
import { stageDecisionsFor } from '../db/repos/stageDecisions';
import { buildDealProperties } from '../services/hubspot';
import { MockHubSpot } from './mocks/hubspot';
import {
  companySyncRequestSchema, isPassRevisitStage, PASS_REVISIT_REASONS, RADAR_HUBSPOT_STAGES,
  type HubSpotDealRecord,
} from '../../shared/integrations';
import type { ImportedCompany } from '../services/imports';

/**
 * In HubSpot, moving a deal into any Passed/Revisit Deals Pipeline stage
 * requires a "Pass/Revisit Reasons" choice plus optional free-text context
 * (Andrew, 2026-11-19). Deal Radar asks the same question at the same
 * moment, writes both to HubSpot's own properties, and keeps every stage
 * decision to learn from — every company goes to HubSpot, fit or not, so
 * the stage (not "synced") is the fit signal.
 */

beforeEach(() => {
  store.resetForTests();
  resetDbForTests();
});

const deal = (over: Partial<HubSpotDealRecord> = {}): HubSpotDealRecord => ({
  companyName: 'Acme Health', fitScore: 6, recommendation: 'Track', vertical: 'Health & Wellness',
  stage: 'Seed', scoreBreakdown: [], rationale: 'x', risks: '', evidenceQualityScore: 5, policyException: null,
  sourcingStatus: 'Surfaced by Deal Radar', dateSurfaced: '2026-11-19', dealRadarId: 'co-1',
  dealRadarUrl: 'https://radar.local/co-1', scoreExplanation: '', approvedBy: null, approvalDate: null, sourceUrls: [],
  ...over,
});

const request = (radarStage: string, over: Partial<HubSpotDealRecord> = {}) => ({
  company: {
    dealRadarId: 'co-1', name: 'Acme Health', domain: 'acmehealth.com', website: 'https://acmehealth.com',
    industry: 'Health & Wellness', city: 'Austin', state: 'TX', description: 'A company.', dealRadarUrl: 'https://radar.local/co-1',
  },
  contacts: [],
  deal: deal(over),
  radarStage,
  duplicateResolution: 'create-new',
  existingRecordId: null,
});

describe('the reason list and the stages that need it', () => {
  it('mirrors HubSpot\'s own Pass/Revisit Reasons options (values as HubSpot stores them)', () => {
    expect(PASS_REVISIT_REASONS.map((r) => r.value)).toEqual([
      'Traction', 'Market', 'Product', 'Team', 'Business Model', 'Exit', 'Geography', 'Competition', 'Industry',
    ]);
  });

  it('applies to exactly the four Passed/Revisit Deals Pipeline stages', () => {
    expect(RADAR_HUBSPOT_STAGES.filter(isPassRevisitStage)).toEqual(['Not A Fit', 'Revisit in 6 months', 'Revisit in 1 year', 'Revisit in + 1 year']);
  });
});

describe('the sync request', () => {
  it('refuses a Passed/Revisit stage with no reason', () => {
    const r = companySyncRequestSchema.safeParse(request('Not A Fit'));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/pass\/revisit reason/);
  });

  it('accepts one with a reason, and keeps the context', () => {
    const r = companySyncRequestSchema.parse(request('Revisit in 6 months', { passRevisitReason: 'Traction', passRevisitNotes: 'No revenue yet; check back after pilots.' }));
    expect(r.deal).toMatchObject({ passRevisitReason: 'Traction', passRevisitNotes: 'No revenue yet; check back after pilots.' });
  });

  it('drops a reason sent with a Live Deals stage, so HubSpot never gets a stale one', () => {
    const r = companySyncRequestSchema.parse(request('Intro Meeting', { passRevisitReason: 'Market', passRevisitNotes: 'old' }));
    expect(r.deal).toMatchObject({ passRevisitReason: null, passRevisitNotes: null });
  });

  it('writes HubSpot\'s own pass/revisit properties, and nothing when there is no reason', () => {
    expect(buildDealProperties(deal({ passRevisitReason: 'Team', passRevisitNotes: 'Solo technical founder.' }), 's', 'p')).toMatchObject({
      pass_revisit_reasons: 'Team', additional_notes_for_pass___revisit_reasons: 'Solo technical founder.',
    });
    const live = buildDealProperties(deal(), 's', 'p');
    expect(live).not.toHaveProperty('pass_revisit_reasons');
    expect(live).not.toHaveProperty('additional_notes_for_pass___revisit_reasons');
  });
});

describe('Add to HubSpot, end to end', () => {
  afterEach(async () => {
    const { __setHubSpotServiceForTests } = await import('../services/hubspot');
    __setHubSpotServiceForTests(null);
  });

  async function setup() {
    const { createApp } = await import('../app');
    const { adminAgent } = await import('./testAuth');
    const { __setHubSpotServiceForTests } = await import('../services/hubspot');
    __setHubSpotServiceForTests(new MockHubSpot());
    const agent = await adminAgent(createApp());
    setConfig('hubspot-pipeline-mapping', {
      stages: Object.fromEntries(RADAR_HUBSPOT_STAGES.map((st) => [st, { pipelineId: isPassRevisitStage(st) ? 'p-pass' : 'p-live', stageId: `s-${st}` }])),
    });
    saveCompany({
      id: 'co-1', name: 'Acme Health', oneLiner: 'Remote patient monitoring.', vertical: 'health', subcategory: 'Remote patient monitoring',
      stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2022, teamSize: 5, website: 'https://acmehealth.com',
      traction: { level: 3, note: 'Two pilots.' },
      founders: [{ name: 'Jane Doe', role: 'CEO', background: 'Former product lead.' }],
      evidence: [{ claim: 'Pilots announced.', source: 'Acme', url: 'https://acmehealth.com/news', date: '2026-11-01', type: 'News' }],
      flags: [], imported: true,
    } as ImportedCompany, { origin: 'user-entered', source: 'local-csv' });
    return agent;
  }

  const hubspotDeal = () => store.raw.mockHubSpot.find((o) => o.type === 'deal')!;

  it('a Passed/Revisit stage sends the reason and context to HubSpot and records the decision in Deal Radar', async () => {
    const agent = await setup();
    const res = await agent.post('/api/hubspot/sync-company')
      .send(request('Not A Fit', { passRevisitReason: 'Market', passRevisitNotes: 'Market too small for a fund-returner.' }));
    expect(res.status).toBe(200);
    expect(hubspotDeal().properties).toMatchObject({
      dealstage: 's-Not A Fit', pass_revisit_reasons: 'Market',
      additional_notes_for_pass___revisit_reasons: 'Market too small for a fund-returner.',
    });
    expect(stageDecisionsFor('co-1')).toEqual([expect.objectContaining({
      hubspotStage: 'Not A Fit', passReason: 'Market', passNotes: 'Market too small for a fund-returner.',
    })]);
    expect(stageDecisionsFor('co-1')[0].decidedBy).toBeTruthy();
  });

  it('refuses the sync — creating nothing in HubSpot — when the reason is missing', async () => {
    const agent = await setup();
    const res = await agent.post('/api/hubspot/sync-company').send(request('Revisit in 1 year'));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(store.raw.mockHubSpot).toHaveLength(0);
    expect(stageDecisionsFor('co-1')).toEqual([]);
  });

  it('a Live Deals stage is recorded too, with no reason, so both outcomes can be learned from', async () => {
    const agent = await setup();
    const res = await agent.post('/api/hubspot/sync-company').send(request('Intro Meeting'));
    expect(res.status).toBe(200);
    expect(hubspotDeal().properties).not.toHaveProperty('pass_revisit_reasons');
    expect(stageDecisionsFor('co-1')).toEqual([expect.objectContaining({ hubspotStage: 'Intro Meeting', passReason: null, passNotes: null })]);
  });

  it('the standalone deal route applies the same rule', async () => {
    const agent = await setup();
    const res = await agent.post('/api/hubspot/deal').send({ deal: deal(), radarStage: 'Not A Fit' });
    expect(res.status).toBe(422);
    expect(store.raw.mockHubSpot).toHaveLength(0);
  });
});
