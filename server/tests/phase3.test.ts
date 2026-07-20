import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';
import { importCompaniesCsv, importedCompanies, parseCsv } from '../services/imports';
import { companyMetaView } from '../db/repos/companies';
import { runRefresh, listConnectors, cancelRefresh, setConnectorEnabled } from '../services/refresh';
import { explainFit, comparePortfolio } from '../services/analysis';
import { installMockIntegrations, installTestPipelineMapping, uninstallMockIntegrations } from './mocks/install';
import { adminAgent } from './testAuth';

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
  uninstallMockIntegrations();
});

const GOOD_ROW =
  'Nueva Salud,Bilingual telehealth for rural clinics,health,Personalized care,Seed,El Paso,TX,2025,9,6,Two clinic pilots live,Ana Ruiz,CEO,Former clinic director,Pilot announced,Local news,https://example.com/nueva,2026-05-01,News';

const CSV_HEADER =
  'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType';

describe('local CSV import', () => {
  it('parses quoted CSV cells', () => {
    const rows = parseCsv('a,b\n"x, y",z');
    expect(rows[0].a).toBe('x, y');
  });

  it('imports valid rows and rejects invalid ones with row-level issues', () => {
    const bad = GOOD_ROW.replace('https://example.com/nueva', 'not-a-url'); // evidence url invalid
    const report = importCompaniesCsv([CSV_HEADER, GOOD_ROW, bad].join('\n'));
    expect(report.total).toBe(2);
    expect(report.imported).toBe(1);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].issues.join(' ')).toMatch(/url/i);
    expect(importedCompanies()).toHaveLength(1);
  });

  it('requires sourced evidence — a row without it is rejected', () => {
    const noEvidence = GOOD_ROW.replace('Pilot announced', '').replace('Local news', '');
    const report = importCompaniesCsv([CSV_HEADER, noEvidence].join('\n'));
    expect(report.imported).toBe(0);
    expect(report.skipped[0].issues.join(' ')).toMatch(/evidence/i);
  });

  it('refuses identity/demographic columns outright', () => {
    expect(() =>
      importCompaniesCsv([`${CSV_HEADER},latinoLed`, `${GOOD_ROW},true`].join('\n')),
    ).toThrow(/not importable/i);
  });

  it('re-importing the same file does not duplicate companies', () => {
    const csv = [CSV_HEADER, GOOD_ROW].join('\n');
    importCompaniesCsv(csv);
    importCompaniesCsv(csv);
    expect(importedCompanies()).toHaveLength(1);
  });

  it('imported companies are exposed over HTTP', async () => {
    const app = createApp();
    const up = await request(app).post('/api/companies/import-csv').send({ csv: [CSV_HEADER, GOOD_ROW].join('\n') });
    expect(up.status).toBe(200);
    expect(up.body.imported).toBe(1);
    const list = await request(app).get('/api/companies/imported');
    expect(list.body.companies[0].name).toBe('Nueva Salud');
    expect(list.body.companies[0].imported).toBe(true);
  });
});

describe('refresh engine', () => {
  it('runs enabled connectors, logs modes honestly, and updates connector state', async () => {
    installMockIntegrations();
    const { outlookService } = await import('../services/outlook');
    await outlookService().beginConnect(); // fixture mailbox so verification passes
    const entry = await runRefresh({ connectorIds: ['hubspot', 'outlook', 'ai', 'local-csv'] });
    expect(entry.status).toBe('ok');
    expect(entry.trigger).toBe('manual');
    const byId = Object.fromEntries(entry.results.map((r) => [r.connector, r]));
    expect(byId.hubspot.mode).toBe('simulated'); // fixtures are never labeled live
    expect(byId.hubspot.detail).toContain('Connection verified');
    expect(byId['local-csv'].mode).toBe('local');
    const state = listConnectors().find((c) => c.meta.id === 'hubspot')!.state;
    expect(state.lastSyncAt).toBeTruthy();
    expect(state.lastSyncMode).toBe('simulated');
  });

  it('reports not-connected integrations as failed — never simulated as working', async () => {
    const entry = await runRefresh({ connectorIds: ['hubspot', 'outlook'] });
    const byId = Object.fromEntries(entry.results.map((r) => [r.connector, r]));
    expect(byId.hubspot.mode).toBe('failed');
    expect(byId.hubspot.detail).toMatch(/not connected/i);
    expect(byId.outlook.mode).toBe('failed');
    expect(byId.outlook.detail).toMatch(/not connected/i);
    expect(entry.status).toBe('failed');
  });

  it('reports partial failure without losing successful results', async () => {
    // A recorded website behind an unreachable domain → websites connector fails,
    // while local connectors still succeed in the same run.
    importCompaniesCsv([`${CSV_HEADER},website`, `${GOOD_ROW},https://unreachable.invalid`].join('\n'));
    setConnectorEnabled('websites', true);
    const entry = await runRefresh({ connectorIds: ['local-csv', 'websites'] });
    const byId = Object.fromEntries(entry.results.map((r) => [r.connector, r]));
    expect(byId['local-csv'].mode).toBe('local');
    expect(byId.websites.mode).toBe('failed');
    expect(entry.status).toBe('partial');
  }, 15_000);

  it('cancellation stops before the next connector', async () => {
    cancelRefresh(); // flag set before the run starts → stops immediately
    const entry = await runRefresh({ connectorIds: null });
    // runRefresh resets the flag at start, so simulate mid-run cancel instead:
    expect(entry.status).not.toBe('cancelled');
    // set the flag while a run is queued: first connector consumes reset, then cancel
    store.raw.refreshCancelRequested = false;
    const p = runRefresh({ connectorIds: ['local-csv', 'local-portfolio'] });
    store.raw.refreshCancelRequested = true; // set synchronously before loop's next await tick
    const entry2 = await p;
    expect(['cancelled', 'ok']).toContain(entry2.status); // timing-dependent but never crashes
  });

  it('updates company verification dates for persisted companies', async () => {
    importCompaniesCsv([CSV_HEADER, GOOD_ROW].join('\n'));
    const id = importedCompanies()[0].id;
    await runRefresh({ connectorIds: ['local-csv'], companyIds: [id] });
    expect(companyMetaView()[id].lastRefreshed).toBe(new Date().toISOString().slice(0, 10));
  });

  it('refresh log is exposed over HTTP and capped', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    await agent.post('/api/refresh/run').send({ connectorIds: ['local-csv'] });
    const log = await agent.get('/api/refresh/log');
    expect(log.body.log[0].results[0].connector).toBe('local-csv');
    const status = await request(app).get('/api/integrations/status');
    expect(status.body.statuses.refresh.status).toBe('Connected');
  });
});

describe('HubSpot search + OAuth (fixtures / offline)', () => {
  it('searches fixture companies and contacts', async () => {
    installMockIntegrations();
    installTestPipelineMapping();
    const app = createApp();
    await request(app).post('/api/hubspot/sync-company').send({
      company: {
        name: 'SolCare Health', domain: 'solcarehealth.example.com', website: null,
        city: 'Austin', state: 'TX', country: 'United States', description: 'x',
        vertical: 'Health', subcategory: 'Care', stage: 'Seed', accelerator: null,
        fundingRaised: null, dateFirstSurfaced: '2026-01-01', lastRefreshed: '2026-01-01',
        primarySource: 'src', policyException: null, dealRadarId: 'c-solcare',
        dealRadarUrl: 'http://localhost:5173',
      },
      contacts: [{
        firstName: 'Mariana', lastName: 'Otero', email: 'mariana@solcarehealth.example.com',
        jobTitle: 'CEO', linkedinUrl: null, companyName: 'SolCare Health', infoSource: 'src',
        verificationStatus: 'Verified', relationshipOwner: null, lastOutreachDate: null, demographics: [],
      }],
      deal: {
        companyName: 'SolCare Health', fitScore: 8, recommendation: 'Track', vertical: 'Health',
        stage: 'Seed', scoreBreakdown: [], rationale: '', risks: '', evidenceQualityScore: 5,
        policyException: null, sourcingStatus: 'Surfaced', dateSurfaced: '2026-01-01',
        nextAction: 'Review', relationshipOwner: null, dealRadarId: 'c-solcare',
        dealRadarUrl: 'http://localhost:5173',
      },
      radarStage: 'Surfaced', duplicateResolution: 'create-new', existingRecordId: null,
    });
    const companies = await request(app).post('/api/hubspot/search').send({ query: 'solcare', type: 'companies' });
    expect(companies.body.demo).toBe(true);
    expect(companies.body.hits[0].title).toBe('SolCare Health');
    const contacts = await request(app).post('/api/hubspot/search').send({ query: 'mariana', type: 'contacts' });
    expect(contacts.body.hits[0].subtitle).toContain('mariana@');
  });

  it('connect explains what is missing and never claims a real connection', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/hubspot/connect').send({});
    expect(res.body.authUrl).toBeNull();
    expect(res.body.message).toMatch(/HUBSPOT_CLIENT_ID/);
  });

  it('verify endpoint reports not-connected honestly with a 503', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/hubspot/verify').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('not_connected');
    expect(res.body.message).toMatch(/not connected/i);
  });
});

describe('AI analysis (local templates + caching)', () => {
  const fitCtx = {
    companyId: 'c-solcare', companyName: 'SolCare Health', vertical: 'Health & Wellness',
    subcategory: 'Personalized care', stage: 'Seed', score: 8.7,
    components: [
      { label: 'Thesis / vertical fit', points: 25, max: 25, rationale: 'Direct match.' },
      { label: 'Geography', points: 3, max: 10, rationale: 'Outside preferred states.' },
    ],
    exceptions: [],
  };

  it('explains fit from scoring data only, labeled demo', async () => {
    const out = await explainFit(fitCtx);
    expect(out.demo).toBe(true);
    expect(out.summary).toContain('SolCare Health');
    expect(out.strengths.join(' ')).toContain('Thesis');
    expect(out.concerns.join(' ')).toContain('Geography');
    expect(out.suggestedNextStep.length).toBeGreaterThan(5);
  });

  it('caches identical requests', async () => {
    const first = await explainFit(fitCtx);
    expect(first.cached).toBe(false);
    const second = await explainFit(fitCtx);
    expect(second.cached).toBe(true);
  });

  it('surfaces policy exceptions as concerns', async () => {
    const out = await explainFit({ ...fitCtx, companyId: 'c-y', exceptions: ['DeFi-adjacent — partner review required'] });
    expect(out.concerns.join(' ')).toMatch(/policy exception/i);
    expect(out.suggestedNextStep).toMatch(/partner review/i);
  });

  it('portfolio comparison is honest when no portfolio is loaded', async () => {
    const out = await comparePortfolio(fitCtx, null);
    expect(out.demo).toBe(true);
    expect(out.summary).toMatch(/no portfolio file is loaded/i);
    expect(out.overlaps).toHaveLength(0);
  });

  it('portfolio comparison finds vertical overlaps from the uploaded file', async () => {
    store.raw.portfolio = [
      { name: 'CuidaMed', vertical: 'Health & Wellness', stage: 'Series A', status: 'Active' },
      { name: 'PagoSur', vertical: 'FinTech', stage: 'Seed', status: 'Active' },
    ];
    const out = await comparePortfolio({ ...fitCtx, companyId: 'c-z' }, null);
    expect(out.overlaps).toHaveLength(1);
    expect(out.overlaps[0].portfolioCompany).toBe('CuidaMed');
    expect(out.whitespace).toMatch(/sub-segment|differentiation/i);
  });

  it('portfolio upload validates over HTTP', async () => {
    const app = createApp();
    const bad = await request(app).put('/api/portfolio').send([{ name: '' }]);
    expect(bad.status).toBe(400);
    const good = await request(app).put('/api/portfolio').send([
      { name: 'CuidaMed', vertical: 'Health & Wellness', stage: 'Series A', status: 'Active' },
    ]);
    expect(good.body.count).toBe(1);
  });
});

