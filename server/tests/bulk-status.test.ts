import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';
import { adminAgent } from './testAuth';
import { saveCompany, companyMetaView } from '../db/repos/companies';
import { listReviewDecisions } from '../db/repos/operations';
import type { ImportedCompany } from '../services/imports';

let app: ReturnType<typeof createApp>;
let agent: Awaited<ReturnType<typeof adminAgent>>;

beforeEach(async () => {
  store.resetForTests();
  resetIdempotencyForTests();
  // Every /api route is behind the whole-application session gate now,
  // so each test drives a signed-in agent instead of a bare request().
  app = createApp();
  agent = await adminAgent(app);
});

function fixtureCompany(id: string, over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id, name: `Bulk Test ${id}`, oneLiner: 'Fixture pitch text', vertical: 'health',
    subcategory: 'Care', stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2024, teamSize: 3,
    traction: { level: 5, note: 'Fixture traction note' },
    founders: [{ name: 'Founder One', role: 'CEO', background: 'Fixture background' }],
    evidence: [{ claim: 'Fixture claim', source: 'Fixture', url: `https://example.com/${id}`, date: '2026-01-01', type: 'News' }],
    flags: [], imported: true,
    ...over,
  };
}

describe('bulk review-queue status changes', () => {
  it('updates every valid company and creates a review decision + audit entry each', async () => {
    saveCompany(fixtureCompany('bulk-1'), { origin: 'user-entered', source: 'test' });
    saveCompany(fixtureCompany('bulk-2'), { origin: 'user-entered', source: 'test' });
    const res = await agent.post('/api/companies/bulk-status').send({ ids: ['bulk-1', 'bulk-2'], status: 'Monitor', actor: 'reviewer-a' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(['bulk-1', 'bulk-2']);
    expect(res.body.skipped).toHaveLength(0);
    expect(companyMetaView()['bulk-1'].reviewStatus).toBe('Monitor');
    expect(companyMetaView()['bulk-2'].reviewStatus).toBe('Monitor');

    const decisions1 = listReviewDecisions('bulk-1');
    expect(decisions1[0]).toMatchObject({ decision: 'Monitor', actor: 'reviewer-a' });

    const audit = await agent.get('/api/audit');
    expect(JSON.stringify(audit.body)).toContain('company-bulk-status');
  });

  it('reports unknown ids honestly instead of silently dropping them', async () => {
    saveCompany(fixtureCompany('bulk-3'), { origin: 'user-entered', source: 'test' });
    const res = await agent.post('/api/companies/bulk-status').send({ ids: ['bulk-3', 'does-not-exist'], status: 'Passed', actor: 'team' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(['bulk-3']);
    expect(res.body.skipped).toEqual([{ id: 'does-not-exist', reason: 'Company not found.' }]);
  });

  it('never bulk-changes a company already Synced to HubSpot', async () => {
    saveCompany(fixtureCompany('bulk-synced'), { origin: 'user-entered', source: 'test', reviewStatus: 'Synced to HubSpot' });
    const res = await agent.post('/api/companies/bulk-status').send({ ids: ['bulk-synced'], status: 'Monitor', actor: 'team' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(0);
    expect(res.body.skipped[0].reason).toMatch(/synced to hubspot/i);
    expect(companyMetaView()['bulk-synced'].reviewStatus).toBe('Synced to HubSpot'); // untouched
  });

  it('rejects HubSpot-facing statuses — bulk sync is never allowed', async () => {
    saveCompany(fixtureCompany('bulk-4'), { origin: 'user-entered', source: 'test' });
    const res = await agent.post('/api/companies/bulk-status').send({ ids: ['bulk-4'], status: 'Approved for HubSpot', actor: 'team' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('validates input — empty id list and oversized list are rejected', async () => {
    const empty = await agent.post('/api/companies/bulk-status').send({ ids: [], status: 'Monitor' });
    expect(empty.status).toBe(400);
    const tooMany = await agent.post('/api/companies/bulk-status').send({ ids: Array.from({ length: 201 }, (_, i) => `id-${i}`), status: 'Monitor' });
    expect(tooMany.status).toBe(400);
  });

  it('requires a session — the whole-application gate covers reviewer routes too', async () => {
    saveCompany(fixtureCompany('bulk-5'), { origin: 'user-entered', source: 'test' });
    // No cookie at all: the central /api gate rejects before the handler runs.
    const anonymous = await request(app).post('/api/companies/bulk-status').send({ ids: ['bulk-5'], status: 'Passed', actor: 'team' });
    expect(anonymous.status).toBe(401);
    expect(companyMetaView()['bulk-5'].reviewStatus).not.toBe('Passed'); // nothing was written
    // Same call, signed in: still a plain reviewer action, still succeeds.
    const res = await agent.post('/api/companies/bulk-status').send({ ids: ['bulk-5'], status: 'Passed', actor: 'team' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(['bulk-5']);
  });
});
