import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import {
  addExternalId, findRemovedCompany, getCompany, listCompanies, saveCompany, setCompanyMeta,
} from '../db/repos/companies';
import { deleteCompany } from '../services/companyRemoval';
import { existingCandidates, runDiscovery } from '../services/discovery';
import type { ImportedCompany } from '../services/imports';
import { installFixtureSources, uninstallFixtureSources } from './fixtures/sources';
import request from 'supertest';
import { createApp } from '../app';
import { adminAgent } from './testAuth';

/**
 * Deleting a company on purpose (2026-10-28: acquired/late-stage YC alumni
 * like WePay and Paystack were scoring as High-Fit). The company and its
 * founders/evidence go, and automated sourcing never re-adds it.
 */

function company(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: 'imported-wepay', name: 'WePay', oneLiner: 'Payments for platform businesses.', vertical: 'fintech',
    subcategory: 'Payments', stage: 'Unknown', city: 'Unknown', state: '??', foundedYear: 2009, teamSize: 1,
    website: 'https://wepay.com', accelerator: 'Y Combinator (S09)',
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Bill Clerico', role: 'Founder', background: 'Recorded.' }],
    evidence: [{ claim: 'YC listing.', source: 'Y Combinator', url: 'https://ycombinator.com/companies/wepay', date: '2026-08-01', type: 'Database record' }],
    flags: [], imported: true,
    ...over,
  } as ImportedCompany;
}

describe('deleting a company on purpose', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  it('deletes the company with its founders and evidence, and records it as removed', () => {
    saveCompany(company(), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    addExternalId('imported-wepay', 'yc', 'wepay-yc-id');

    const result = deleteCompany('imported-wepay', 'Andrew Gonzalez', 'Acquired by JPMorgan Chase');
    expect(result.ok).toBe(true);
    expect(getCompany('imported-wepay')).toBeNull();
    const db = getDb();
    expect((db.prepare("SELECT COUNT(*) AS n FROM founders WHERE company_id = 'imported-wepay'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE company_id = 'imported-wepay'").get() as { n: number }).n).toBe(0);
    expect(db.prepare("SELECT removed_by, reason FROM removed_companies WHERE company_id = 'imported-wepay'").get())
      .toEqual({ removed_by: 'Andrew Gonzalez', reason: 'Acquired by JPMorgan Chase' });
  });

  it('recognizes a removed company by name, website domain, or source id — and nothing else', () => {
    saveCompany(company(), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    addExternalId('imported-wepay', 'yc', 'wepay-yc-id');
    deleteCompany('imported-wepay', 'Andrew', null);

    expect(findRemovedCompany({ name: 'wepay' })?.name).toBe('WePay');
    expect(findRemovedCompany({ name: 'WePay, Inc.' })?.name).toBe('WePay');
    expect(findRemovedCompany({ name: 'Different Name', website: 'https://www.wepay.com/about' })?.name).toBe('WePay');
    expect(findRemovedCompany({ sourceId: 'yc', externalId: 'wepay-yc-id' })?.name).toBe('WePay');
    expect(findRemovedCompany({ name: 'WeDeliver', website: 'https://wedeliver.example.com' })).toBeNull();
    expect(findRemovedCompany({ name: 'Unknown company', website: 'Unknown' })).toBeNull();
  });

  it('refuses to delete a company already synced to HubSpot', () => {
    saveCompany(company(), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    setCompanyMeta('imported-wepay', { reviewStatus: 'Synced to HubSpot' });
    expect(deleteCompany('imported-wepay', 'Andrew', null)).toMatchObject({ ok: false, status: 409 });
    expect(getCompany('imported-wepay')).not.toBeNull();
  });

  it('reports a missing company as not found', () => {
    expect(deleteCompany('nope', 'Andrew', null)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('automated sourcing never re-adds a removed company', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
    installFixtureSources();
  });
  afterAll(() => uninstallFixtureSources());

  it('skips a removed company when discovery finds it again', async () => {
    const query = { sources: ['yc'], maxResults: 20, maxApiCalls: 10 } as const;
    // The yc fixture yields "Cosecha Labs (fictional)" and "Verdea Grid (fictional)".
    saveCompany(company({ id: 'imported-cosecha', name: 'Cosecha Labs (fictional)', website: 'https://cosecha-labs.example.com' }),
      { origin: 'user-entered', source: 'local-csv' });
    deleteCompany('imported-cosecha', 'Andrew', 'Not a target');

    await runDiscovery(query, 'tester');
    const names = existingCandidates().map((c) => c.companyName);
    expect(names).toContain('Verdea Grid (fictional)');
    expect(names).not.toContain('Cosecha Labs (fictional)');
    expect(listCompanies().map((c) => c.name)).not.toContain('Cosecha Labs (fictional)');
  });
});

describe('POST /api/companies/:id/remove', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  it('deletes for a signed-in admin, records who did it, and 404s an unknown id', async () => {
    saveCompany(company(), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    const agent = await adminAgent(createApp());

    const res = await agent.post('/api/companies/imported-wepay/remove').send({ reason: 'Acquired' });
    expect(res.status).toBe(200);
    expect(res.body.removed.name).toBe('WePay');
    expect(getCompany('imported-wepay')).toBeNull();

    expect((await agent.post('/api/companies/nope/remove').send({})).status).toBe(404);
  });

  it('requires an admin session', async () => {
    saveCompany(company(), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    const res = await request(createApp()).post('/api/companies/imported-wepay/remove').send({});
    expect(res.status).toBe(401);
    expect(getCompany('imported-wepay')).not.toBeNull();
  });
});
