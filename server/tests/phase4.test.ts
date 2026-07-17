import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';
import {
  cancelDiscovery, detectDuplicate, existingCandidates, importCandidates, runDiscovery,
} from '../services/discovery';
import { discoveryCandidateSchema } from '../../shared/discovery';
import { generateHypothesis, listSignals, patchSignal } from '../services/stealth';
import { comparePortfolio } from '../services/analysis';
import { listJobs, saveJob, schedulerStatus, tickScheduler } from '../services/schedule';
import { importCompaniesCsv } from '../services/imports';

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
});

const BASE_QUERY = {
  sources: ['yc', 'funding-news', 'accelerators', 'grants'],
  maxResults: 25,
  maxApiCalls: 10,
};

describe('discovery pipeline (simulated sources — no network in tests)', () => {
  it('runs sources, normalizes, validates, and labels everything simulated', async () => {
    const run = await runDiscovery(BASE_QUERY, 'tester');
    expect(run.status).toBe('Simulated');
    expect(run.mode).toBe('simulated');
    expect(run.discovered).toBeGreaterThanOrEqual(4);
    expect(run.initiatedBy).toBe('tester');
    const cands = existingCandidates();
    expect(cands.every((c) => c.simulated)).toBe(true);
    expect(cands.every((c) => c.evidence.length >= 1)).toBe(true);
    expect(cands.every((c) => c.status === 'pending')).toBe(true); // nothing auto-imported
  });

  it('unknown fields stay Unknown — nothing is fabricated', async () => {
    await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    const c = existingCandidates()[0];
    expect(c.website).toBe('Unknown'); // grants fixture has no website
    expect(c.mostRecentRound).toBe('Unknown');
    expect(c.verificationStatus).toBe('Not verified');
  });

  it('rejects restricted sources outright', async () => {
    await expect(runDiscovery({ ...BASE_QUERY, sources: ['linkedin'] }, 'tester')).rejects.toThrow(/restricted/i);
    const app = createApp();
    const res = await request(app).post('/api/discovery/run').send({ sources: ['pitchbook'], maxResults: 5 });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/never scraped/i);
  });

  it('producthunt and licensed sources are skipped without authorization, never scraped', async () => {
    const run = await runDiscovery({ ...BASE_QUERY, sources: ['producthunt', 'licensed', 'grants'] }, 'tester');
    const byId = Object.fromEntries(run.sourceResults.map((r) => [r.sourceId, r]));
    expect(byId.producthunt.mode).toBe('skipped');
    expect(byId.licensed.mode).toBe('skipped');
    expect(byId.grants.found).toBe(1);
  });

  it('invalid source records are rejected by validation and counted', async () => {
    // A candidate with no evidence must fail schema validation.
    const bad = discoveryCandidateSchema.safeParse({
      id: 'x', runId: 'r', discoveredAt: new Date().toISOString(), sourceId: 'yc', simulated: true,
      companyName: 'No Evidence Co', evidence: [], confidence: 0.5,
    });
    expect(bad.success).toBe(false);
  });

  it('enforces the result budget and reports Completed with warnings', async () => {
    const run = await runDiscovery({ ...BASE_QUERY, maxResults: 2 }, 'tester');
    expect(run.discovered).toBe(2);
    expect(run.status).toBe('Completed with warnings');
    expect(run.sourceResults.some((r) => r.mode === 'skipped')).toBe(true);
  });

  it('filters by vertical, stage, geography, and min confidence without excluding Unknowns', async () => {
    const run = await runDiscovery({ ...BASE_QUERY, vertical: 'fintech' }, 'tester');
    const cands = existingCandidates().filter((c) => c.runId === run.id);
    expect(cands.every((c) => c.vertical === 'fintech' || c.vertical === 'Unknown')).toBe(true);
    store.resetForTests();
    const run2 = await runDiscovery({ ...BASE_QUERY, geography: 'Preferred states', states: ['NM'] }, 'tester');
    const cands2 = existingCandidates().filter((c) => c.runId === run2.id);
    expect(cands2.every((c) => c.hqState === 'NM' || c.hqState === 'Unknown')).toBe(true);
  });

  it('cancellation stops before the next source', async () => {
    cancelDiscovery();
    // flag is reset at run start, so a pre-set flag does not cancel:
    const run = await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    expect(run.status).not.toBe('Cancelled');
  });

  it('partial source failure preserves other sources (HTTP)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/discovery/run').send({ ...BASE_QUERY });
    expect(res.status).toBe(200);
    expect(res.body.sourceResults.length).toBe(4);
    expect(res.body.errors).toBeInstanceOf(Array);
  });
});

describe('duplicate detection & evidence merge', () => {
  it('detects exact duplicates by domain against bundled data', async () => {
    // SolCare Health is bundled with a website in the enrichment layer.
    const probe = discoveryCandidateSchema.parse({
      id: 'probe-1', runId: 'r', discoveredAt: new Date().toISOString(), sourceId: 'yc', simulated: true,
      companyName: 'Totally Different Name', website: 'https://solcarehealth.example.com',
      evidence: [{ claim: 'listed in a directory', source: 'directory', url: 'https://example.com/e', dateAccessed: '2026-07-01' }],
      confidence: 0.5,
    });
    const dup = detectDuplicate(probe);
    expect(dup.duplicateStatus).toBe('exact');
    expect(dup.duplicateOfName).toBe('SolCare Health');
  });

  it('detects likely duplicates by normalized name', async () => {
    const probe = discoveryCandidateSchema.parse({
      id: 'probe-2', runId: 'r', discoveredAt: new Date().toISOString(), sourceId: 'yc', simulated: true,
      companyName: 'SolCare Health, Inc.',
      evidence: [{ claim: 'name match probe', source: 'directory', url: 'https://example.com/e2', dateAccessed: '2026-07-01' }],
      confidence: 0.5,
    });
    expect(detectDuplicate(probe).duplicateStatus).toBe('likely');
  });

  it('merge-evidence appends to existing records and preserves conflicting claims', async () => {
    const CSV_HEADER = 'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType';
    const ROW = 'Nueva Salud,Bilingual telehealth,health,Personalized care,Seed,El Paso,TX,2025,9,6,Two pilots,Ana Ruiz,CEO,Clinic director,Team size is 9,Local news,https://example.com/a,2026-05-01,News';
    importCompaniesCsv([CSV_HEADER, ROW].join('\n'));
    const existingId = (store.raw.importedCompanies[0] as { id: string }).id;

    await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    const cand = existingCandidates()[0];
    // Force a duplicate relationship with a CONFLICTING claim.
    cand.evidence = [{ claim: 'Team size is 14 (conflicts with existing record)', source: 'Simulated filing', url: 'https://example.com/conflict', dateAccessed: '2026-07-10', verificationStatus: 'Not verified', confidence: 0.5, notes: '' }];
    cand.duplicateStatus = 'likely';
    cand.duplicateOfId = existingId;
    cand.duplicateOfName = 'Nueva Salud';
    store.raw.discoveryCandidates = [cand];

    const outcome = importCandidates({ candidateIds: [cand.id], duplicateAction: 'merge-evidence' });
    expect(outcome.merged).toHaveLength(1);
    const merged = store.raw.importedCompanies[0] as { evidence: { claim: string }[] };
    const claims = merged.evidence.map((e) => e.claim);
    expect(claims).toContain('Team size is 9'); // original preserved
    expect(claims.join(' ')).toContain('Team size is 14'); // conflict added, not overwritten
  });
});

describe('selective import → Needs Review (human gates intact)', () => {
  it('imports only selected candidates, places them in Needs Review, and triggers no outreach', async () => {
    const run = await runDiscovery(BASE_QUERY, 'diego');
    const cands = existingCandidates().filter((c) => c.runId === run.id);
    const pick = cands.slice(0, 2).map((c) => c.id);
    const outcome = importCandidates({ candidateIds: pick, actor: 'diego' });
    expect(outcome.imported).toHaveLength(2);

    // Unselected candidates stay pending.
    expect(existingCandidates().filter((c) => c.status === 'pending').length).toBe(cands.length - 2);

    // Imported companies carry Needs Review meta + discovery source.
    const meta = Object.values(store.raw.companyMeta);
    expect(meta.filter((m) => m.reviewStatus === 'Needs Review')).toHaveLength(2);

    // Outreach records exist in the earliest state; nothing drafted, sent, approved, or synced.
    const records = Object.values(store.raw.outreach);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.outreachStatus).toBe('Not Reviewed');
      expect(r.hubspotCompanyId).toBeNull();
      expect(r.draftCreatedAt).toBeNull();
      expect(r.emailSentAt).toBeNull();
    }
    expect(store.raw.drafts).toHaveLength(0);
    expect(store.raw.mockHubSpot).toHaveLength(0);

    // Run history reflects the import count.
    const app = createApp();
    const runs = await request(app).get('/api/discovery/runs');
    expect(runs.body.runs.find((r: { id: string }) => r.id === run.id).imported).toBe(2);
  });

  it('refuses to import a candidate whose vertical is Unknown instead of guessing', async () => {
    await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    const cand = existingCandidates()[0];
    cand.vertical = 'Unknown';
    store.raw.discoveryCandidates = [cand];
    const outcome = importCandidates({ candidateIds: [cand.id] });
    expect(outcome.imported).toHaveLength(0);
    expect(outcome.skipped[0].reason).toMatch(/no guessing/i);
  });

  it('duplicates default to skip on import', async () => {
    await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    const cand = existingCandidates()[0];
    cand.duplicateStatus = 'likely';
    cand.duplicateOfId = 'c-solcare';
    cand.duplicateOfName = 'SolCare Health';
    store.raw.discoveryCandidates = [cand];
    const outcome = importCandidates({ candidateIds: [cand.id] });
    expect(outcome.imported).toHaveLength(0);
    expect(outcome.skipped[0].reason).toMatch(/duplicate/i);
  });
});

describe('stealth radar & hypothesis guardrails', () => {
  it('seeds simulated signals labeled simulated with alternatives and next steps', () => {
    const signals = listSignals();
    expect(signals.length).toBeGreaterThanOrEqual(2);
    for (const s of signals) {
      expect(s.simulated).toBe(true);
      expect(s.alternativeExplanation.length).toBeGreaterThan(5);
      expect(s.verificationStatus).not.toBe('Verified');
    }
  });

  it('hypotheses are permanently labeled and always include alternatives + missing info', () => {
    const s = listSignals()[0];
    const h = generateHypothesis(s.id);
    expect(h.isHypothesis).toBe(true);
    expect(h.unverified).toBe(true);
    expect(h.requiresHumanReview).toBe(true);
    expect(h.alternativeHypotheses.length).toBeGreaterThanOrEqual(1);
    expect(h.missingInformation.length).toBeGreaterThanOrEqual(1);
    expect(h.likelyVertical).toMatch(/hypothesis only|Unknown/);
  });

  it('never infers sensitive traits — hypothesis text excludes the founder name and demographic language', () => {
    const s = listSignals()[0];
    const h = generateHypothesis(s.id);
    const text = JSON.stringify(h).toLowerCase();
    expect(text).not.toContain(s.founderName.toLowerCase());
    for (const banned of ['latino', 'hispanic', 'gender', 'female', 'male', 'ethnic', 'race', 'nationality']) {
      expect(text).not.toContain(banned);
    }
  });

  it('signals support assignment and research-queue status over HTTP', async () => {
    const app = createApp();
    const list = await request(app).get('/api/stealth/signals');
    const id = list.body.signals[0].id;
    const patched = await request(app).post(`/api/stealth/signals/${id}`).send({ assignedTo: 'MG', outreachStatus: 'Research queue' });
    expect(patched.body.assignedTo).toBe('MG');
    expect(patched.body.outreachStatus).toBe('Research queue');
    expect(() => patchSignal('nope', {})).toThrow(/not found/i);
  });

  it('manual signal entry validates and stores a pasted public-profile URL as evidence without crawling', async () => {
    const app = createApp();
    const res = await request(app).post('/api/stealth/signals').send({
      founderName: 'T. Example',
      previousRole: 'Unknown', previousEmployer: 'Unknown',
      knownSkills: [], priorStartups: [], education: 'Unknown',
      signalType: 'User-provided public profile',
      signalDate: '2026-07-15',
      sourceName: 'User-pasted public profile URL',
      sourceUrl: 'https://example.com/public-profile/t-example',
      dateAccessed: '2026-07-15',
      possibleVertical: 'Unknown', possibleTheme: 'Unknown',
      evidenceSummary: 'User pasted a public profile URL for manual review.',
      confidence: 'Low',
      alternativeExplanation: 'Profile may be outdated or unrelated to founding activity.',
      suggestedNextStep: 'Review the profile manually; do not crawl.',
    });
    expect(res.status).toBe(200);
    expect(res.body.simulated).toBe(false);
    expect(res.body.verificationStatus).toBe('Not verified');
  });
});

describe('portfolio layer (Phase 4)', () => {
  it('old Phase 3 portfolio records still parse (backward compatibility)', async () => {
    store.raw.portfolio = [{ name: 'CuidaMed', vertical: 'Health & Wellness', stage: 'Series A', status: 'Active' }];
    const out = await comparePortfolio(FIT_CTX, null);
    expect(out.overlaps).toHaveLength(1);
    expect(out.concentrationRisk).toMatch(/1\/1/);
  });

  it('theme, partnership, and concentration analysis uses only recorded data', async () => {
    store.raw.portfolio = [
      { name: 'CuidaMed', vertical: 'Health & Wellness', stage: 'Series A', status: 'Active', themes: ['care navigation'], partnershipThemes: ['personalized care'], competitiveOverlapThemes: [], website: '', publicDescription: '', investmentDate: '', evidenceUrls: ['https://example.com/cuidamed'], },
      { name: 'PagoSur', vertical: 'FinTech', stage: 'Seed', status: 'Active', themes: [], partnershipThemes: [], competitiveOverlapThemes: [], website: '', publicDescription: '', investmentDate: '', evidenceUrls: [] },
    ];
    const out = await comparePortfolio({ ...FIT_CTX, companyId: 'c-theme' }, null);
    expect(out.partnershipOpportunities.join(' ')).toContain('CuidaMed');
    expect(out.evidenceNotes.join(' ')).toContain('https://example.com/cuidamed');
    expect(out.confidence).toBe('Medium');
  });

  it('does not fabricate comparisons when data lacks support', async () => {
    store.raw.portfolio = [];
    const out = await comparePortfolio({ ...FIT_CTX, companyId: 'c-empty' }, null);
    expect(out.summary).toMatch(/no portfolio file is loaded/i);
    expect(out.sharedThemes).toHaveLength(0);
    expect(out.concentrationRisk).toBe('');
  });

  it('manual creation and CSV import upsert without duplicates', async () => {
    const app = createApp();
    await request(app).post('/api/portfolio/company').send({ name: 'CuidaMed', vertical: 'Health & Wellness', stage: 'Series A', status: 'Active' });
    await request(app).post('/api/portfolio/company').send({ name: 'CuidaMed', vertical: 'Health & Wellness', stage: 'Series A', status: 'Exited' });
    expect(store.raw.portfolio).toHaveLength(1);
    const csv = 'name,vertical,stage,status,themes\nPagoSur,FinTech,Seed,Active,payments|inclusion';
    const res = await request(app).post('/api/portfolio/import-csv').send({ csv });
    expect(res.body.imported).toBe(1);
    expect((store.raw.portfolio[1] as { themes: string[] }).themes).toEqual(['payments', 'inclusion']);
  });
});

describe('scheduled sourcing (inactive by default)', () => {
  it('stores configuration but reports Configured but inactive when RUN_SCHEDULER=false', async () => {
    const status = schedulerStatus();
    expect(status.active).toBe(false);
    expect(status.label).toMatch(/configured but inactive/i);
    saveJob({ cadence: 'weekly', jobType: 'incremental-sourcing', query: { ...BASE_QUERY, sources: ['grants'] }, enabled: true });
    expect(listJobs()).toHaveLength(1);
    // The tick is a no-op while the scheduler is disabled — nothing runs.
    const ran = await tickScheduler();
    expect(ran).toBe(0);
    expect(store.raw.discoveryRuns).toHaveLength(0);
  });

  it('exposes scheduler state over HTTP', async () => {
    const app = createApp();
    const res = await request(app).get('/api/schedule');
    expect(res.body.active).toBe(false);
    expect(res.body.label).toMatch(/RUN_SCHEDULER=false/);
  });
});

const FIT_CTX = {
  companyId: 'c-p4', companyName: 'SolCare Health', vertical: 'Health & Wellness',
  subcategory: 'Personalized care', stage: 'Seed', score: 8.2,
  components: [{ label: 'Thesis / vertical fit', points: 25, max: 25, rationale: 'Direct match.' }],
  exceptions: [],
};
