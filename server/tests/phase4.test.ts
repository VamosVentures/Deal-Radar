import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';
import {
  cancelDiscovery, detectDuplicate, discoveryRuns, existingCandidates, importCandidates, runDiscovery,
  setCandidateVertical,
} from '../services/discovery';
import { discoveryCandidateSchema } from '../../shared/discovery';
import { generateHypothesis, listSignals, patchSignal } from '../services/stealth';
import { adminAgent } from './testAuth';
import { comparePortfolio } from '../services/analysis';
import { listJobs, saveJob, schedulerStatus, tickScheduler } from '../services/schedule';
import { importCompaniesCsv, importedCompanies } from '../services/imports';
import { companyMetaView } from '../db/repos/companies';
import { addSignal } from '../services/stealth';
import { installFixtureSources, uninstallFixtureSources } from './fixtures/sources';
import { afterAll } from 'vitest';

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
  installFixtureSources();
});
afterAll(() => uninstallFixtureSources());

const BASE_QUERY = {
  // Three sources and twenty results are the per-run ceilings — see
  // MAX_SOURCES_PER_RUN / MAX_RESULTS_PER_RUN in shared/discovery.ts.
  sources: ['yc', 'funding-news', 'accelerators'],
  maxResults: 20,
  maxApiCalls: 10,
};

describe('discovery pipeline (fixture sources injected — no network in tests)', () => {
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
    const agent = await adminAgent(app);
    const res = await agent.post('/api/discovery/run').send({ sources: ['pitchbook'], maxResults: 5 });
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

  /**
   * Per-run cost ceilings.
   *
   * Enforced on the REQUEST, not on the internal query shape, because a
   * per-company refresh legitimately sweeps every source that might
   * mention one company (services/companyRefresh.ts). Capping both would
   * have degraded that for no saving — the expensive operation is the
   * wide net, and this is where the wide net is cast.
   */
  it('refuses a run asking for more than the source cap', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/discovery/run')
      .send({ ...BASE_QUERY, sources: ['yc', 'funding-news', 'accelerators', 'grants'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at most 3 sources/i);
  });

  it('refuses a run asking for more than the result cap', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/discovery/run').send({ ...BASE_QUERY, maxResults: 200 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at most 20 candidates/i);
  });

  it('defaults an unspecified result count to the cap rather than a larger legacy value', async () => {
    const { discoveryRequestSchema, MAX_RESULTS_PER_RUN } = await import('../../shared/discovery');
    const parsed = discoveryRequestSchema.parse({ sources: ['yc'] });
    expect(parsed.maxResults).toBe(MAX_RESULTS_PER_RUN);
  });

  it('accepts a run exactly at both caps', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/discovery/run')
      .send({ ...BASE_QUERY, sources: ['yc', 'funding-news', 'accelerators'], maxResults: 20 });
    expect(res.status).toBe(200);
  });

  /**
   * The estimate must be refused on the same terms as the run. A quote
   * for a run the server would reject is a quote for something you
   * cannot buy.
   */
  it('refuses to estimate a run that exceeds the caps', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/discovery/estimate')
      .send({ ...BASE_QUERY, sources: ['yc', 'funding-news', 'accelerators', 'grants'] });
    expect(res.status).toBe(400);
  });

  /**
   * A per-company refresh is deliberately NOT capped: its cost is bounded
   * by the single company and its own API-call budget, and breadth is the
   * whole point of re-checking a record we already hold.
   */
  it('leaves the per-company refresh free to sweep every source', async () => {
    const { discoveryQuerySchema } = await import('../../shared/discovery');
    const wide = discoveryQuerySchema.parse({
      sources: ['github', 'sec', 'grants', 'yc', 'funding-news', 'research', 'producthunt'],
      maxResults: 10,
    });
    expect(wide.sources).toHaveLength(7);
  });

  it('partial source failure preserves other sources (HTTP)', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/discovery/run').send({ ...BASE_QUERY });
    expect(res.status).toBe(200);
    // One result per requested source — BASE_QUERY asks for the
    // maximum a run may query (MAX_SOURCES_PER_RUN).
    expect(res.body.sourceResults.length).toBe(BASE_QUERY.sources.length);
    expect(res.body.errors).toBeInstanceOf(Array);
  });

  /**
   * By explicit request: a manual run from the Discovery page (the HTTP
   * route, not the runDiscovery() service call other tests use directly)
   * no longer waits on a human import click — it auto-imports its own
   * new, non-duplicate candidates the same way a scheduled run already
   * did. Contrast the very first test in this file, which calls
   * runDiscovery() directly and still asserts nothing auto-imports —
   * that invariant is unchanged; only the HTTP route gained this step.
   */
  it('a manual run via the HTTP route auto-imports its own new candidates to Awaiting Review', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/discovery/run').send({ ...BASE_QUERY, actor: 'andrew' });
    expect(res.status).toBe(200);
    const runId = res.body.id;

    const stillPending = existingCandidates().filter((c) => c.runId === runId && c.status === 'pending');
    // Anything left pending must be a duplicate awaiting a human decision
    // (merge / import-anyway) — never a plain new candidate.
    expect(stillPending.every((c) => c.duplicateStatus !== 'none')).toBe(true);

    const meta = Object.values(companyMetaView());
    const imported = existingCandidates().filter((c) => c.runId === runId && c.status === 'imported');
    expect(imported.length).toBeGreaterThan(0);
    expect(meta.filter((m) => m.reviewStatus === 'Awaiting Review').length).toBeGreaterThanOrEqual(imported.length);
  });
});

describe('duplicate detection & evidence merge', () => {
  const DUP_HEADER = `${'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType'},website`;
  const DUP_ROW = 'Nueva Salud,Bilingual telehealth,health,Personalized care,Seed,El Paso,TX,2025,9,6,Two pilots,Ana Ruiz,CEO,Clinic director,Pilot announced,Local news,https://example.com/nueva,2026-05-01,News,https://nuevasalud.example.com';

  it('detects exact duplicates by domain against previously imported companies', async () => {
    importCompaniesCsv([DUP_HEADER, DUP_ROW].join('\n'));
    const probe = discoveryCandidateSchema.parse({
      id: 'probe-1', runId: 'r', discoveredAt: new Date().toISOString(), sourceId: 'yc', simulated: true,
      companyName: 'Totally Different Name', website: 'https://www.nuevasalud.example.com',
      evidence: [{ claim: 'listed in a directory', source: 'directory', url: 'https://example.com/e', dateAccessed: '2026-07-01' }],
      confidence: 0.5,
    });
    const dup = detectDuplicate(probe);
    expect(dup.duplicateStatus).toBe('exact');
    expect(dup.duplicateOfName).toBe('Nueva Salud');
  });

  it('detects likely duplicates by normalized name', async () => {
    importCompaniesCsv([DUP_HEADER, DUP_ROW].join('\n'));
    const probe = discoveryCandidateSchema.parse({
      id: 'probe-2', runId: 'r', discoveredAt: new Date().toISOString(), sourceId: 'yc', simulated: true,
      companyName: 'Nueva Salud, Inc.',
      evidence: [{ claim: 'name match probe', source: 'directory', url: 'https://example.com/e2', dateAccessed: '2026-07-01' }],
      confidence: 0.5,
    });
    expect(detectDuplicate(probe).duplicateStatus).toBe('likely');
  });

  it('merge-evidence appends to existing records and preserves conflicting claims', async () => {
    const CSV_HEADER = 'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType';
    const ROW = 'Nueva Salud,Bilingual telehealth,health,Personalized care,Seed,El Paso,TX,2025,9,6,Two pilots,Ana Ruiz,CEO,Clinic director,Team size is 9,Local news,https://example.com/a,2026-05-01,News';
    importCompaniesCsv([CSV_HEADER, ROW].join('\n'));
    const existingId = importedCompanies()[0].id;

    await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    const cand = existingCandidates()[0];
    // Force a duplicate relationship with a CONFLICTING claim.
    cand.evidence = [{ claim: 'Team size is 14 (conflicts with existing record)', source: 'Simulated filing', url: 'https://example.com/conflict', dateAccessed: '2026-07-10', publishedAt: null, verificationStatus: 'Not verified' as const, assertionType: 'fact' as const, confidence: 0.5, notes: '' }];
    cand.duplicateStatus = 'likely';
    cand.duplicateOfId = existingId;
    cand.duplicateOfName = 'Nueva Salud';
    store.raw.discoveryCandidates = [cand];

    const outcome = importCandidates({ candidateIds: [cand.id], duplicateAction: 'merge-evidence' });
    expect(outcome.merged).toHaveLength(1);
    const merged = importedCompanies().find((c) => c.id === existingId)!;
    const claims = merged.evidence.map((e) => e.claim);
    expect(claims).toContain('Team size is 9'); // original preserved
    expect(claims.join(' ')).toContain('Team size is 14'); // conflict added, not overwritten
  });
});

describe('selective import → Awaiting Review (human gates intact)', () => {
  it('imports only selected candidates, places them in Awaiting Review, and triggers no outreach', async () => {
    const run = await runDiscovery(BASE_QUERY, 'diego');
    const cands = existingCandidates().filter((c) => c.runId === run.id);
    const pick = cands.slice(0, 2).map((c) => c.id);
    const outcome = importCandidates({ candidateIds: pick, actor: 'diego' });
    expect(outcome.imported).toHaveLength(2);

    // Unselected candidates stay pending.
    expect(existingCandidates().filter((c) => c.status === 'pending').length).toBe(cands.length - 2);

    // Imported companies carry Awaiting Review meta + discovery source.
    const meta = Object.values(companyMetaView());
    expect(meta.filter((m) => m.reviewStatus === 'Awaiting Review')).toHaveLength(2);

    // Nothing was drafted, synced, or contacted — import only persists companies.
    expect(store.raw.drafts).toHaveLength(0);
    expect(store.raw.mockHubSpot).toHaveLength(0);

    // Run history reflects the import count.
    const app = createApp();
    const agent = await adminAgent(app);
    const runs = await agent.get('/api/discovery/runs');
    expect(runs.body.runs.find((r: { id: string }) => r.id === run.id).imported).toBe(2);
  });

  it('refuses to import a candidate whose text carries no sector signal, instead of guessing', async () => {
    // The rule being protected is "never invent a sector". It used to be
    // expressed as "reject vertical === Unknown", but since NO adapter
    // ever sets a vertical, that rejected 100% of candidates and nothing
    // could be imported at all (see server/tests/import-candidates.test.ts).
    // The rule now bites where it should: a candidate whose own published
    // text says nothing about a sector is still refused.
    await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    const cand = existingCandidates()[0];
    cand.vertical = 'Unknown';
    cand.companyName = 'Generic Holdings';
    cand.pitch = 'Unknown';
    cand.subcategory = 'Unknown';
    cand.evidence = [{
      claim: 'A record exists.', source: 'Test', url: 'https://example.com/record',
      dateAccessed: '2026-07-01', publishedAt: null, verificationStatus: 'Not verified' as const, assertionType: 'fact' as const, confidence: 0.4, notes: '',
    }];
    store.raw.discoveryCandidates = [cand];
    const outcome = importCandidates({ candidateIds: [cand.id] });
    expect(outcome.imported).toHaveLength(0);
    expect(outcome.skipped[0].code).toBe('unclassifiable-sector');
    expect(outcome.skipped[0].reason).toMatch(/no sector signal/i);
  });

  describe('manual vertical assignment (the only way an unclassifiable candidate becomes importable)', () => {
    it('a human assigning a vertical unlocks import for a candidate the classifier refused', async () => {
      await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
      const cand = existingCandidates()[0];
      cand.vertical = 'Unknown';
      cand.companyName = 'Generic Holdings';
      cand.pitch = 'Unknown';
      cand.subcategory = 'Unknown';
      store.raw.discoveryCandidates = [cand];

      // Confirm it's genuinely refused first.
      expect(importCandidates({ candidateIds: [cand.id] }).skipped[0].code).toBe('unclassifiable-sector');

      const set = setCandidateVertical(cand.id, 'fintech', 'andrew');
      expect(set.vertical).toBe('fintech');

      const outcome = importCandidates({ candidateIds: [cand.id] });
      expect(outcome.imported).toHaveLength(1);
      expect(outcome.skipped).toHaveLength(0);
    });

    it('refuses to reclassify a candidate that already imported or merged', async () => {
      await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
      const cand = existingCandidates()[0];
      cand.pitch = 'Robots that install solar panels.';
      store.raw.discoveryCandidates = [cand];
      importCandidates({ candidateIds: [cand.id] });
      expect(existingCandidates()[0].status).toBe('imported');

      expect(() => setCandidateVertical(cand.id, 'health', 'andrew')).toThrow(/already imported/i);
    });

    it('rejects an unknown candidate id', () => {
      expect(() => setCandidateVertical('does-not-exist', 'health', 'andrew')).toThrow(/not found/i);
    });

    it('is audited as a human decision, distinct from the automated classifier', async () => {
      await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
      const cand = existingCandidates()[0];
      cand.vertical = 'Unknown';
      store.raw.discoveryCandidates = [cand];
      setCandidateVertical(cand.id, 'sustainability', 'andrew');

      const app = createApp();
      const agent = await adminAgent(app);
      const audit = await agent.get('/api/audit');
      const entry = audit.body.find((e: { action: string }) => e.action === 'candidate-set-vertical');
      expect(entry.detail).toMatch(/andrew/);
      expect(entry.detail).toMatch(/human decision/i);
    });

    it('HTTP: PUT /discovery/candidates/:id/vertical rejects a value outside the five approved verticals', async () => {
      await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
      const cand = existingCandidates()[0];
      const app = createApp();
      const agent = await adminAgent(app);
      const res = await agent.put(`/api/discovery/candidates/${cand.id}/vertical`).send({ vertical: 'not-a-real-vertical' });
      expect(res.status).toBe(400);
    });

    it('HTTP: a full round trip through the route makes the candidate importable', async () => {
      await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
      const cand = existingCandidates()[0];
      cand.vertical = 'Unknown';
      cand.pitch = 'Unknown';
      cand.subcategory = 'Unknown';
      store.raw.discoveryCandidates = [cand];

      const app = createApp();
      const agent = await adminAgent(app);
      const setRes = await agent.put(`/api/discovery/candidates/${cand.id}/vertical`).send({ vertical: 'frontier', actor: 'andrew' });
      expect(setRes.status).toBe(200);
      expect(setRes.body.candidate.vertical).toBe('frontier');

      const importRes = await agent.post('/api/discovery/import').send({ candidateIds: [cand.id], actor: 'andrew' });
      expect(importRes.body.imported).toHaveLength(1);
    });
  });

  it('DOES import a candidate whose published text plainly states its sector', async () => {
    // The other half of the same rule: reading "robotics" out of a
    // company's own description is not guessing.
    await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    const cand = existingCandidates()[0];
    cand.vertical = 'Unknown';
    cand.companyName = 'Cosmic Robotics';
    cand.pitch = 'Robots that install solar panels.';
    store.raw.discoveryCandidates = [cand];
    const outcome = importCandidates({ candidateIds: [cand.id] });
    expect(outcome.imported).toHaveLength(1);
    expect(outcome.skipped).toHaveLength(0);
  });

  it('duplicates default to skip on import', async () => {
    await runDiscovery({ ...BASE_QUERY, sources: ['grants'] }, 'tester');
    const cand = existingCandidates()[0];
    cand.duplicateStatus = 'likely';
    cand.duplicateOfId = 'imported-nueva-salud';
    cand.duplicateOfName = 'Nueva Salud';
    store.raw.discoveryCandidates = [cand];
    const outcome = importCandidates({ candidateIds: [cand.id] });
    expect(outcome.imported).toHaveLength(0);
    expect(outcome.skipped[0].reason).toMatch(/duplicate/i);
  });
});

describe('stealth radar & hypothesis guardrails', () => {
  const SIGNAL_FIXTURE = {
    founderName: 'J. Almeida (fictional)',
    previousRole: 'Staff engineer, payments team',
    previousEmployer: 'Unknown',
    knownSkills: ['payments infrastructure', 'ledger systems'],
    priorStartups: [],
    education: 'Unknown',
    signalType: 'New GitHub organization/repository',
    signalDate: '2026-06-20',
    sourceName: 'GitHub public activity',
    sourceUrl: 'https://example.com/fix/github/almeida-labs',
    dateAccessed: '2026-07-17',
    possibleVertical: 'fintech',
    possibleTheme: 'ledger tooling',
    evidenceSummary: 'New public org "almeida-labs" with two ledger-related repositories created in June 2026.',
    confidence: 'Medium',
    verificationStatus: 'Not verified',
    alternativeExplanation: 'Could be a personal side project or open-source contribution unrelated to a company.',
    suggestedNextStep: 'Watch repo activity for org growth; check for a public announcement before any outreach.',
    assignedTo: null,
    outreachStatus: 'None',
  };

  it('starts empty — no seeded or simulated signals in the running app', () => {
    expect(listSignals()).toHaveLength(0);
  });

  it('rejects a stealth lead without a real source URL or evidence reason', () => {
    expect(() => addSignal({ ...SIGNAL_FIXTURE, sourceUrl: 'not-a-url' })).toThrow();
    expect(() => addSignal({ ...SIGNAL_FIXTURE, sourceUrl: undefined })).toThrow();
    expect(() => addSignal({ ...SIGNAL_FIXTURE, evidenceSummary: '' })).toThrow();
    expect(() => addSignal({ ...SIGNAL_FIXTURE, signalDate: 'sometime' })).toThrow();
    expect(listSignals()).toHaveLength(0); // nothing invalid was stored
  });

  it('records suspected geography and defaults honestly to Unknown', () => {
    const withGeo = addSignal({ ...SIGNAL_FIXTURE, suspectedGeography: 'Brooklyn, NY' });
    expect(withGeo.suspectedGeography).toBe('Brooklyn, NY');
    const without = addSignal({ ...SIGNAL_FIXTURE, founderName: 'B. Second (fictional)' });
    expect(without.suspectedGeography).toBe('Unknown'); // never guessed
  });

  it('accepts the newly permitted signal types', () => {
    const hiring = addSignal({ ...SIGNAL_FIXTURE, founderName: 'C. Third (fictional)', signalType: 'Hiring announcement' });
    expect(hiring.signalType).toBe('Hiring announcement');
    const filing = addSignal({ ...SIGNAL_FIXTURE, founderName: 'D. Fourth (fictional)', signalType: 'Public filing' });
    expect(filing.signalType).toBe('Public filing');
  });

  it('hypotheses are permanently labeled and always include alternatives + missing info', () => {
    const s = addSignal(SIGNAL_FIXTURE);
    const h = generateHypothesis(s.id);
    expect(h.isHypothesis).toBe(true);
    expect(h.unverified).toBe(true);
    expect(h.requiresHumanReview).toBe(true);
    expect(h.alternativeHypotheses.length).toBeGreaterThanOrEqual(1);
    expect(h.missingInformation.length).toBeGreaterThanOrEqual(1);
    expect(h.likelyVertical).toMatch(/hypothesis only|Unknown/);
  });

  it('never infers sensitive traits — hypothesis text excludes the founder name and demographic language', () => {
    const s = addSignal(SIGNAL_FIXTURE);
    const h = generateHypothesis(s.id);
    const text = JSON.stringify(h).toLowerCase();
    expect(text).not.toContain(s.founderName.toLowerCase());
    for (const banned of ['latino', 'hispanic', 'gender', 'female', 'male', 'ethnic', 'race', 'nationality']) {
      expect(text).not.toContain(banned);
    }
  });

  it('signals support assignment and research-queue status over HTTP', async () => {
    addSignal(SIGNAL_FIXTURE);
    const app = createApp();
    const agent = await adminAgent(app);
    const list = await agent.get('/api/stealth/signals');
    const id = list.body.signals[0].id;
    const patched = await agent.post(`/api/stealth/signals/${id}`).send({ assignedTo: 'MG', outreachStatus: 'Research queue' });
    expect(patched.body.assignedTo).toBe('MG');
    expect(patched.body.outreachStatus).toBe('Research queue');
    expect(() => patchSignal('nope', {})).toThrow(/not found/i);
  });

  it('manual signal entry validates and stores a pasted public-profile URL as evidence without crawling', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.post('/api/stealth/signals').send({
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
    const agent = await adminAgent(app);
    await agent.post('/api/portfolio/company').send({ name: 'CuidaMed', vertical: 'Health & Wellness', stage: 'Series A', status: 'Active' });
    await agent.post('/api/portfolio/company').send({ name: 'CuidaMed', vertical: 'Health & Wellness', stage: 'Series A', status: 'Exited' });
    expect(store.raw.portfolio).toHaveLength(1);
    const csv = 'name,vertical,stage,status,themes\nPagoSur,FinTech,Seed,Active,payments|inclusion';
    const res = await agent.post('/api/portfolio/import-csv').send({ csv });
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
    expect(discoveryRuns()).toHaveLength(0);
  });

  it('exposes scheduler state over HTTP', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const res = await agent.get('/api/schedule');
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
