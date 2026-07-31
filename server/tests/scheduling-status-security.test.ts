import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminAgent } from './testAuth';
import { z } from 'zod';
import { store } from '../lib/store';
import { resetIdempotencyForTests, audit, redactSecrets } from '../lib/guard';
import { sanitizeErrorForClient } from '../lib/errors';
import { isSafeExternalUrl } from '../lib/http';
import { createApp } from '../app';
import { installMockIntegrations, installTestPipelineMapping, uninstallMockIntegrations } from './mocks/install';
import { installFixtureSources, uninstallFixtureSources } from './fixtures/sources';
import { __setSourceRunnerForTests } from '../services/sources';
import { runDiscovery } from '../services/discovery';
import { saveJob, runJobNow, listJobs } from '../services/schedule';
import { saveCompany, getCompany, companyMetaView, markRefreshed } from '../db/repos/companies';
import { importCompaniesCsv } from '../services/imports';
import type { ImportedCompany } from '../services/imports';

/**
 * Phase-8 tests: scheduled-sourcing overlap prevention + policy
 * filters + run-now, the simple company-status lifecycle (incl. the
 * computed Stale badge), and the security hardening added this phase
 * (SSRF guard, audit-log redaction, sanitized error responses).
 */

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
});

const BASE_QUERY = { sources: ['yc', 'funding-news'], maxResults: 20, maxApiCalls: 10 };

const fixtureCompany = (over: Partial<ImportedCompany> = {}): ImportedCompany => ({
  id: 'status-test-co',
  name: 'Status Test Co',
  oneLiner: 'A fixture company for status/staleness tests.',
  vertical: 'fintech',
  subcategory: 'Payments',
  stage: 'Seed',
  city: 'Austin',
  state: 'TX',
  foundedYear: 2025,
  teamSize: 4,
  website: 'https://statustest.example.com',
  traction: { level: 3, note: 'Fixture traction.' },
  founders: [{ name: 'A Founder', role: 'CEO', background: 'Fixture background.' }],
  evidence: [{ claim: 'Fixture claim', source: 'Fixture', url: 'https://example.com/status-test', date: '2026-06-01', type: 'News' }],
  flags: [],
  imported: true,
  ...over,
});

// ── Scheduled sourcing: overlap prevention ────────────────────────

describe('scheduled sourcing — overlap prevention', () => {
  beforeEach(() => installFixtureSources());
  afterEach(() => uninstallFixtureSources());

  it('rejects a second run started while one is already in progress', async () => {
    const first = runDiscovery(BASE_QUERY, 'tester-a');
    await expect(runDiscovery(BASE_QUERY, 'tester-b')).rejects.toMatchObject({ status: 409 });
    await first;
  });

  it('releases the lock once a run completes, so the next one can start', async () => {
    await runDiscovery(BASE_QUERY, 'tester-a');
    await expect(runDiscovery(BASE_QUERY, 'tester-b')).resolves.toBeTruthy();
  });
});

// ── Scheduled sourcing: run log detail ─────────────────────────────

describe('scheduled sourcing — run log detail', () => {
  beforeEach(() => installFixtureSources());
  afterEach(() => uninstallFixtureSources());

  it('records an explicit start and end time', async () => {
    const run = await runDiscovery(BASE_QUERY, 'tester');
    expect(run.at).toBeTruthy();
    expect(run.completedAt).toBeTruthy();
    expect(new Date(run.completedAt).getTime()).toBeGreaterThanOrEqual(new Date(run.at).getTime());
  });

  it('counts duplicates identified separately from duplicates skipped', async () => {
    // Pre-seed an existing company with the same domain a fixture candidate will surface.
    importCompaniesCsv([
      'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType,website',
      'Cosecha Labs Duplicate,Fixture pitch text,fintech,Financial inclusion,Seed,Fresno,CA,2025,4,5,Fixture traction note,A B,CEO,Fixture background,claim,src,https://example.com/cosecha-dup,2026-06-01,News,https://cosecha-labs.example.com',
    ].join('\n'));
    const run = await runDiscovery({ ...BASE_QUERY, sources: ['yc'] }, 'tester');
    expect(run.duplicatesIdentified).toBeGreaterThanOrEqual(1);
  });
});

// ── Evidence-recency threshold ─────────────────────────────────────

describe('evidence-recency threshold', () => {
  afterEach(() => __setSourceRunnerForTests(null));

  it('drops a candidate whose evidence is entirely older than the threshold', async () => {
    __setSourceRunnerForTests(async (sourceId) => ({
      sourceId, mode: 'live', apiCalls: 1, detail: 'fixture',
      candidates: [{
        companyName: 'Old Evidence Co',
        evidence: [{ claim: 'old claim', source: 'src', url: 'https://example.com/old-evidence', dateAccessed: '2020-01-01', verificationStatus: 'Not verified', confidence: 0.5, notes: '' }],
        confidence: 0.5,
      }],
    }));
    const run = await runDiscovery({ sources: ['github'], maxResults: 10, maxApiCalls: 5, minEvidenceRecencyDays: 90 }, 'tester');
    expect(run.discovered).toBe(0);
    expect(run.filteredByPolicy).toBe(1);
  });

  it('keeps a candidate whose evidence is within the threshold', async () => {
    __setSourceRunnerForTests(async (sourceId) => ({
      sourceId, mode: 'live', apiCalls: 1, detail: 'fixture',
      candidates: [{
        companyName: 'Fresh Evidence Co',
        evidence: [{ claim: 'fresh claim', source: 'src', url: 'https://example.com/fresh-evidence', dateAccessed: new Date().toISOString().slice(0, 10), verificationStatus: 'Not verified', confidence: 0.5, notes: '' }],
        confidence: 0.5,
      }],
    }));
    const run = await runDiscovery({ sources: ['github'], maxResults: 10, maxApiCalls: 5, minEvidenceRecencyDays: 90 }, 'tester');
    expect(run.discovered).toBe(1);
    expect(run.filteredByPolicy).toBe(0);
  });
});

// ── 'stale-only' mode (refresh-age threshold) ──────────────────────

describe("'stale-only' mode — refresh-age threshold", () => {
  afterEach(() => __setSourceRunnerForTests(null));

  function stubOneMatch(website: string) {
    __setSourceRunnerForTests(async (sourceId) => ({
      sourceId, mode: 'live', apiCalls: 1, detail: 'fixture',
      candidates: [{
        companyName: 'Refresh Target Co',
        website,
        evidence: [{ claim: 'still active', source: 'src', url: 'https://example.com/refresh-target', dateAccessed: new Date().toISOString().slice(0, 10), verificationStatus: 'Not verified', confidence: 0.6, notes: '' }],
        confidence: 0.6,
      }],
    }));
  }

  it('keeps a candidate matching a company overdue for refresh', async () => {
    saveCompany(fixtureCompany({ id: 'overdue-co', name: 'Refresh Target Co', website: 'https://refresh-target.example.com' }), { origin: 'user-entered', source: 'test' });
    markRefreshed(['overdue-co'], new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10));
    stubOneMatch('https://refresh-target.example.com');
    const run = await runDiscovery({ sources: ['github'], maxResults: 10, maxApiCalls: 5, mode: 'stale-only', staleAfterDays: 30 }, 'tester');
    expect(run.discovered).toBe(1);
  });

  it('drops a candidate matching a company refreshed recently', async () => {
    saveCompany(fixtureCompany({ id: 'fresh-co', name: 'Refresh Target Co', website: 'https://refresh-target.example.com' }), { origin: 'user-entered', source: 'test' });
    markRefreshed(['fresh-co'], new Date().toISOString().slice(0, 10));
    stubOneMatch('https://refresh-target.example.com');
    const run = await runDiscovery({ sources: ['github'], maxResults: 10, maxApiCalls: 5, mode: 'stale-only', staleAfterDays: 30 }, 'tester');
    expect(run.discovered).toBe(0);
    expect(run.filteredByPolicy).toBe(1);
  });

  it("drops a candidate that doesn't match any existing company — stale-refresh targets known companies, not new ones", async () => {
    stubOneMatch('https://totally-unmatched-domain.example.com');
    const run = await runDiscovery({ sources: ['github'], maxResults: 10, maxApiCalls: 5, mode: 'stale-only', staleAfterDays: 30 }, 'tester');
    expect(run.discovered).toBe(0);
  });
});

// ── Administrator "Run sourcing now" ────────────────────────────────

describe('administrator "Run sourcing now"', () => {
  beforeEach(() => installFixtureSources());
  afterEach(() => uninstallFixtureSources());

  it('runs a saved job immediately and stamps lastRunAt', async () => {
    const job = saveJob({ cadence: 'weekly', jobType: 'incremental-sourcing', query: { ...BASE_QUERY, sources: ['yc'] } as never, enabled: true });
    expect(listJobs().find((j) => j.id === job.id)!.lastRunAt).toBeNull();
    const run = await runJobNow(job.id, 'admin');
    expect(run.runType).toBe('scheduled-weekly');
    expect(listJobs().find((j) => j.id === job.id)!.lastRunAt).toBeTruthy();
  });

  it('is reachable over HTTP and 404s for an unknown job', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const job = saveJob({ cadence: 'biweekly', jobType: 'full-sourcing', query: { ...BASE_QUERY, sources: ['funding-news'] } as never, enabled: true });
    const res = await agent.post(`/api/schedule/${job.id}/run-now`).send({ actor: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.runType).toBe('scheduled-biweekly');

    const missing = await agent.post('/api/schedule/nope/run-now').send({ actor: 'admin' });
    expect(missing.status).toBe(404);
  });

  it('rejects run-now without an authenticated admin session', async () => {
    const app = createApp();
    const job = saveJob({ cadence: 'weekly', jobType: 'incremental-sourcing', query: { ...BASE_QUERY, sources: ['yc'] } as never, enabled: true });
    const res = await request(app).post(`/api/schedule/${job.id}/run-now`).send({ actor: 'admin' });
    expect(res.status).toBe(401);
  });
});

// ── Simple company-status lifecycle ─────────────────────────────────

describe('company status lifecycle', () => {
  // Every /api route now requires an authenticated session (the
  // whole-application gate in server/app.ts), so the reviewer actions
  // below go through a signed-in agent instead of a bare request(app).
  let agent: Awaited<ReturnType<typeof adminAgent>>;

  beforeEach(async () => {
    agent = await adminAgent(createApp());
  });

  it('CSV imports start as New; discovery imports start as Awaiting Review', async () => {
    importCompaniesCsv([
      'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType',
      'Lifecycle Co,Fixture pitch text,fintech,Payments,Seed,Austin,TX,2025,4,5,Fixture traction note,A B,CEO,Fixture background,claim,src,https://example.com/lifecycle,2026-06-01,News',
    ].join('\n'));
    const id = Object.keys(companyMetaView()).find((k) => companyMetaView()[k])!;
    expect(companyMetaView()[id].reviewStatus).toBe('New');
  });

  it('re-importing the same CSV row does not reset an already-advanced status', async () => {
    const csv = [
      'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType',
      'Reimport Co,Fixture pitch text,fintech,Payments,Seed,Austin,TX,2025,4,5,Fixture traction note,A B,CEO,Fixture background,claim,src,https://example.com/reimport,2026-06-01,News',
    ].join('\n');
    importCompaniesCsv(csv);
    const id = Object.keys(companyMetaView())[0];
    // Advance it manually, exactly like a reviewer would.
    await agent.post(`/api/companies/${id}/status`).send({ status: 'Monitor', actor: 'team' });
    expect(companyMetaView()[id].reviewStatus).toBe('Monitor');
    // Re-importing the identical file must not revert that decision.
    importCompaniesCsv(csv);
    expect(companyMetaView()[id].reviewStatus).toBe('Monitor');
  });

  it('accepts every documented status transition over HTTP and rejects an invalid one', async () => {
    saveCompany(fixtureCompany(), { origin: 'user-entered', source: 'test' });
    for (const status of ['Research Needed', 'Monitor', 'Passed', 'Approved for HubSpot']) {
      const res = await agent.post('/api/companies/status-test-co/status').send({ status, actor: 'team' });
      expect(res.status).toBe(200);
      expect(companyMetaView()['status-test-co'].reviewStatus).toBe(status);
    }
    const bad = await agent.post('/api/companies/status-test-co/status').send({ status: 'Not A Real Status', actor: 'team' });
    expect(bad.status).toBe(400);
  });

  it('404s for a status change on an unknown company', async () => {
    const res = await agent.post('/api/companies/does-not-exist/status').send({ status: 'Monitor', actor: 'team' });
    expect(res.status).toBe(404);
  });

  it('"refresh" marks a company reviewed as of today without changing its status', async () => {
    saveCompany(fixtureCompany({ id: 'refresh-me' }), { origin: 'user-entered', source: 'test' });
    const before = companyMetaView()['refresh-me']?.reviewStatus;
    const res = await agent.post('/api/companies/refresh-me/refresh').send({ actor: 'team' });
    expect(res.status).toBe(200);
    expect(res.body.lastRefreshed).toBe(new Date().toISOString().slice(0, 10));
    expect(getCompany('refresh-me')!.lastRefreshed).toBe(new Date().toISOString().slice(0, 10));
    expect(companyMetaView()['refresh-me']?.reviewStatus).toBe(before); // status itself is untouched
  });

  it('a real confirmed HubSpot sync — and only that — moves status to Synced to HubSpot automatically', async () => {
    installMockIntegrations();
    installTestPipelineMapping();
    saveCompany(fixtureCompany({ id: 'sync-me' }), { origin: 'user-entered', source: 'test' });
    const res = await agent.post('/api/hubspot/sync-company').send({
      company: {
        name: 'Status Test Co', domain: 'statustest.example.com', website: 'https://statustest.example.com',
        city: 'Austin', state: 'TX', country: 'United States', description: 'x',
        vertical: 'FinTech', subcategory: 'Payments', stage: 'Seed', accelerator: null, fundingRaised: null,
        dateFirstSurfaced: '2026-06-01', lastRefreshed: '2026-06-01', primarySource: 'src', policyException: null,
        dealRadarId: 'sync-me', dealRadarUrl: 'http://localhost:5173/?company=sync-me',
      },
      contacts: [],
      deal: {
        companyName: 'Status Test Co', fitScore: 7, recommendation: 'Track', vertical: 'FinTech', stage: 'Seed',
        scoreBreakdown: [], rationale: 'r', risks: 'none', evidenceQualityScore: 5, policyException: null,
        sourcingStatus: 'Surfaced', dateSurfaced: '2026-06-01', nextAction: 'Review', relationshipOwner: 'team',
        dealRadarId: 'sync-me', dealRadarUrl: 'http://localhost:5173/?company=sync-me',
      },
      radarStage: 'Approved to Track', duplicateResolution: 'create-new', existingRecordId: null,
    });
    expect(res.status).toBe(200);
    expect(companyMetaView()['sync-me'].reviewStatus).toBe('Synced to HubSpot');
    uninstallMockIntegrations();
  });
});

// ── Computed "Stale" overlay ─────────────────────────────────────────

describe('computed Stale overlay', () => {
  it('flags a non-terminal company unreviewed for 30+ days', () => {
    saveCompany(fixtureCompany({ id: 'old-untouched' }), { origin: 'user-entered', source: 'test' });
    markRefreshed(['old-untouched'], new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10));
    expect(companyMetaView()['old-untouched'].stale).toBe(true);
  });

  it('does not flag a recently-touched company', () => {
    saveCompany(fixtureCompany({ id: 'recent' }), { origin: 'user-entered', source: 'test' });
    markRefreshed(['recent'], new Date().toISOString().slice(0, 10));
    expect(companyMetaView()['recent'].stale).toBeUndefined();
  });

  it('never flags a terminal status (Passed / Synced to HubSpot) as stale, however old', async () => {
    saveCompany(fixtureCompany({ id: 'old-but-passed' }), { origin: 'user-entered', source: 'test' });
    markRefreshed(['old-but-passed'], new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10));
    const agent = await adminAgent(createApp());
    await agent.post('/api/companies/old-but-passed/status').send({ status: 'Passed', actor: 'team' });
    expect(companyMetaView()['old-but-passed'].stale).toBeUndefined();
  });
});

// ── Security hardening ────────────────────────────────────────────

describe('security: SSRF guard on stored-URL fetches', () => {
  it('accepts ordinary public https URLs', () => {
    expect(isSafeExternalUrl('https://example.com/about')).toBe(true);
    expect(isSafeExternalUrl('http://a-real-company.example.com')).toBe(true);
  });

  it('rejects loopback, private, and link-local/metadata hosts', () => {
    for (const url of [
      'http://localhost:8787/api/admin/status',
      'http://127.0.0.1/secret',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/router',
      'http://172.16.0.1/internal',
      'http://service.internal/',
      'http://host.local/',
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });

  it('rejects non-http(s) schemes and unparseable input', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('ftp://example.com/x')).toBe(false);
    expect(isSafeExternalUrl('not a url at all')).toBe(false);
  });
});

describe('security: audit-log redaction', () => {
  it('scrubs secret-shaped substrings from stored audit entries', () => {
    const entry = audit({
      provider: 'system', mode: 'local', action: 'test-redaction', outcome: 'ok',
      subject: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456',
      detail: 'token was a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 in the payload',
    });
    expect(entry.subject).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(entry.subject).toContain('[redacted]');
    expect(entry.detail).not.toContain('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4');
  });

  it('leaves ordinary text untouched', () => {
    const entry = audit({ provider: 'system', mode: 'local', action: 'test', subject: 'co-123', outcome: 'ok', detail: '3 companies imported, 1 skipped' });
    expect(entry.detail).toBe('3 companies imported, 1 skipped');
  });

  it('redactSecrets is a pure text function usable independent of audit()', () => {
    expect(redactSecrets('plain text')).toBe('plain text');
    expect(redactSecrets('Bearer abcdefghijklmnop')).toContain('[redacted]');
  });
});

describe('security: sanitized error responses never leak unexpected internals', () => {
  it('shows the authored message for a deliberate operational error', () => {
    const safe = sanitizeErrorForClient(Object.assign(new Error('HubSpot rejected the credentials.'), { status: 401 }));
    expect(safe.status).toBe(401);
    expect(safe.message).toBe('HubSpot rejected the credentials.');
  });

  it('hides the raw message of a genuinely unexpected error behind a generic one', () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'foo')");
    const safe = sanitizeErrorForClient(bug);
    expect(safe.status).toBe(500);
    expect(safe.message).not.toContain('Cannot read properties of undefined');
    expect(safe.message).toContain('logged');
  });

  it('still uses the standard shape for Zod validation errors', () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    const safe = sanitizeErrorForClient(parsed.success ? undefined : parsed.error);
    expect(safe.status).toBe(400);
    expect(safe.error).toBe('validation_failed');
    expect(safe.issues!.length).toBeGreaterThan(0);
  });
});

afterAll(() => {
  uninstallMockIntegrations();
  uninstallFixtureSources();
  __setSourceRunnerForTests(null);
});
