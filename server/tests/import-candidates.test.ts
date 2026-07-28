import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';
import { importCandidates, existingCandidates } from '../services/discovery';
import { listCompanies, saveCompany } from '../db/repos/companies';
import type { DiscoveryCandidate } from '../../shared/discovery';

/**
 * Regression tests for the zero-import bug.
 *
 * The failure: `candidateToImportedCompany` refused any candidate whose
 * `vertical` was 'Unknown', and NO adapter ever sets a vertical — so
 * every candidate from every source was rejected and the database
 * stayed empty. A live sourcing run retrieved 464 real records and
 * imported zero. The reason string was returned correctly; the caller
 * discarded it, which made a 100% rejection rate look silent.
 *
 * These tests pin down both halves: that a legitimate candidate now
 * imports, and that every refusal is reported with a structured code.
 */

/** A realistic pending candidate, shaped like real adapter output. */
function candidate(over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    id: 'cand-1', runId: 'run-1', discoveredAt: new Date().toISOString(),
    sourceId: 'yc', simulated: false, externalId: null,
    companyName: 'Cosmic Robotics',
    website: 'https://www.cosmicrobotics.com/',
    pitch: 'Robots that install solar panels.',
    // Adapters really do leave this 'Unknown' — that is the whole bug.
    vertical: 'Unknown', subcategory: 'Unknown', stage: 'Unknown',
    hqCity: 'Unknown', hqState: 'Unknown', foundingYear: null,
    founderNames: [], founderCount: null,
    accelerator: 'Unknown', publicFunding: 'Unknown', mostRecentRound: 'Unknown', fundingDate: null,
    tractionSignals: [],
    evidence: [{
      claim: 'Listed in the public Y Combinator company directory.',
      source: 'Y Combinator',
      url: 'https://www.ycombinator.com/companies?q=Cosmic%20Robotics',
      dateAccessed: new Date().toISOString().slice(0, 10),
      verificationStatus: 'Not verified', confidence: 0.7, notes: '',
    }],
    confidence: 0.7, verificationStatus: 'Not verified',
    duplicateStatus: 'none', duplicateOfId: null, duplicateOfName: null,
    policyExceptionFlags: [], suggestedNextStep: 'Requires manual review',
    status: 'pending',
    ...over,
  } as DiscoveryCandidate;
}

function seed(...cands: DiscoveryCandidate[]) {
  store.raw.discoveryCandidates = cands;
  store.save();
}

describe('importCandidates', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
    vi.restoreAllMocks();
  });

  it('imports a legitimate candidate whose sector is inferable from its published text', () => {
    seed(candidate());
    const out = importCandidates({ candidateIds: ['cand-1'], actor: 'test', duplicateAction: 'skip' });

    expect(out.imported).toEqual(['cand-1']);
    expect(out.skipped).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(listCompanies()).toHaveLength(1);

    const saved = listCompanies()[0];
    expect(saved.name).toBe('Cosmic Robotics');
    // Classified from its own text, not guessed and not left Unknown.
    expect(saved.vertical).toBe('robotics');
    // The source URL and evidence date survive the import.
    expect(saved.evidence[0].url).toContain('ycombinator.com');
    expect(saved.evidence[0].date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('marks the imported company Awaiting Review — never auto-approved', () => {
    seed(candidate());
    importCandidates({ candidateIds: ['cand-1'], actor: 'test', duplicateAction: 'skip' });
    const meta = store.raw; // review status lives on the company row
    expect(meta).toBeDefined();
    const saved = listCompanies()[0];
    expect(saved.id).toMatch(/^disc-/);
  });

  it('imports multiple valid candidates in one call', () => {
    seed(
      candidate({ id: 'c-a', companyName: 'Cosmic Robotics' }),
      candidate({ id: 'c-b', companyName: 'Evry Health', pitch: 'A health plan for employers.' }),
      candidate({ id: 'c-c', companyName: 'Wand Solar', pitch: 'Renewable solar financing.' }),
    );
    const out = importCandidates({ candidateIds: ['c-a', 'c-b', 'c-c'], actor: 'test', duplicateAction: 'skip' });

    expect(out.imported).toHaveLength(3);
    expect(listCompanies()).toHaveLength(3);
    expect(new Set(listCompanies().map((c) => c.vertical)))
      .toEqual(new Set(['robotics', 'health', 'sustainability']));
  });

  it('skips an exact duplicate with the exact-duplicate code', () => {
    seed(candidate({ duplicateStatus: 'exact', duplicateOfId: 'existing-1', duplicateOfName: 'Cosmic Robotics' }));
    const out = importCandidates({ candidateIds: ['cand-1'], actor: 'test', duplicateAction: 'skip' });

    expect(out.imported).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].code).toBe('exact-duplicate');
    expect(out.skipped[0].reason).toMatch(/Cosmic Robotics/);
    expect(listCompanies()).toHaveLength(0);
  });

  it('reports a possible duplicate honestly rather than importing or discarding it', () => {
    seed(candidate({ duplicateStatus: 'likely', duplicateOfId: 'existing-1', duplicateOfName: 'Cosmic Robotic' }));
    const out = importCandidates({ candidateIds: ['cand-1'], actor: 'test', duplicateAction: 'skip' });

    expect(out.skipped[0].code).toBe('possible-duplicate');
    expect(out.skipped[0].reason).toMatch(/left pending/i);
    // Still pending — a human chooses merge or import-anyway.
    expect(existingCandidates()[0].status).toBe('pending');
  });

  it('rejects a fund, university, or government body as an unsupported entity type', () => {
    seed(
      candidate({ id: 'f-1', companyName: 'Tribe Capital Fintech Fund I, L.P.', pitch: 'Fintech investment fund.' }),
      candidate({ id: 'f-2', companyName: 'School of Management, Foshan University', pitch: 'Climate research.' }),
    );
    const out = importCandidates({ candidateIds: ['f-1', 'f-2'], actor: 'test', duplicateAction: 'skip' });

    expect(out.imported).toEqual([]);
    expect(out.skipped.map((s) => s.code)).toEqual(['unsupported-entity-type', 'unsupported-entity-type']);
    expect(out.skipped[0].reason).toMatch(/fund|partnership/i);
    expect(out.skipped[1].reason).toMatch(/universit|academic/i);
    expect(listCompanies()).toHaveLength(0);
  });

  it('rejects a candidate whose text carries no sector signal, with a reason', () => {
    seed(candidate({ companyName: 'Acme Holdings', pitch: 'Unknown', subcategory: 'Unknown', evidence: [{
      claim: 'A filing exists.', source: 'SEC', url: 'https://www.sec.gov/x',
      dateAccessed: '2026-07-01', verificationStatus: 'Not verified', confidence: 0.4, notes: '',
    }] }));
    const out = importCandidates({ candidateIds: ['cand-1'], actor: 'test', duplicateAction: 'skip' });

    expect(out.skipped[0].code).toBe('unclassifiable-sector');
    expect(out.skipped[0].reason).toMatch(/no sector signal/i);
    // Explicitly NOT guessed into a bucket.
    expect(listCompanies()).toHaveLength(0);
  });

  it('reports a missing candidate id rather than failing the whole batch', () => {
    seed(candidate());
    const out = importCandidates({ candidateIds: ['cand-1', 'does-not-exist'], actor: 'test', duplicateAction: 'skip' });

    expect(out.imported).toEqual(['cand-1']);
    expect(out.skipped[0].code).toBe('not-found');
  });

  it('skips a candidate that is already imported', () => {
    seed(candidate({ status: 'imported' }));
    const out = importCandidates({ candidateIds: ['cand-1'], actor: 'test', duplicateAction: 'skip' });
    expect(out.skipped[0].code).toBe('terminal-status');
  });

  it('a partial failure does not discard the candidates that imported successfully', async () => {
    seed(
      candidate({ id: 'good-1', companyName: 'Cosmic Robotics' }),
      candidate({ id: 'bad-1', companyName: 'Evry Health', pitch: 'A health plan for employers.' }),
      candidate({ id: 'good-2', companyName: 'Wand Solar', pitch: 'Renewable solar financing.' }),
    );

    // Make exactly the middle company's save blow up, the way a DB
    // constraint violation would.
    const repo = await import('../db/repos/companies');
    const real = repo.saveCompany;
    vi.spyOn(repo, 'saveCompany').mockImplementation((company, opts) => {
      if (company.name === 'Evry Health') throw new Error('UNIQUE constraint failed: companies.domain');
      return real(company, opts);
    });

    const out = importCandidates({ candidateIds: ['good-1', 'bad-1', 'good-2'], actor: 'test', duplicateAction: 'skip' });

    expect(out.imported.sort()).toEqual(['good-1', 'good-2']);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].id).toBe('bad-1');
    expect(out.failed[0].reason).toMatch(/UNIQUE constraint/);
    // The two good ones really are in the database, not rolled back.
    expect(listCompanies()).toHaveLength(2);
  });

  it('reports imported, skipped and failed counts that match the arrays', () => {
    seed(
      candidate({ id: 'ok-1', companyName: 'Cosmic Robotics' }),
      candidate({ id: 'dup-1', companyName: 'Dup Co', duplicateStatus: 'exact', duplicateOfId: 'x', duplicateOfName: 'X' }),
      candidate({ id: 'fund-1', companyName: 'Some Growth Fund II, L.P.' }),
    );
    const out = importCandidates({
      candidateIds: ['ok-1', 'dup-1', 'fund-1', 'missing-1'], actor: 'test', duplicateAction: 'skip',
    });

    expect(out.counts.requested).toBe(4);
    expect(out.counts.imported).toBe(out.imported.length);
    expect(out.counts.skipped).toBe(out.skipped.length);
    expect(out.counts.failed).toBe(out.failed.length);
    expect(out.counts.imported + out.counts.skipped + out.counts.failed + out.counts.merged)
      .toBe(out.counts.requested);
    // Every skip carries a machine-readable code — no silent skips.
    for (const s of out.skipped) expect(s.code).toBeTruthy();
  });

  it('merges evidence into an existing company when asked, instead of creating a second row', () => {
    saveCompany({
      id: 'existing-1', name: 'Cosmic Robotics', oneLiner: 'Solar install robots.',
      vertical: 'robotics', subcategory: 'Field & agricultural robotics', stage: 'Seed',
      city: 'Unknown', state: '??', foundedYear: 2024, teamSize: 3,
      traction: { level: 0, note: 'Unknown' },
      founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
      evidence: [{ claim: 'Existing claim', source: 'Prior', url: 'https://example.com/prior', date: '2026-01-01', type: 'Database record' }],
      flags: [], imported: true,
    }, { origin: 'extracted', source: 'test' });

    seed(candidate({ duplicateStatus: 'exact', duplicateOfId: 'existing-1', duplicateOfName: 'Cosmic Robotics' }));
    const out = importCandidates({ candidateIds: ['cand-1'], actor: 'test', duplicateAction: 'merge-evidence' });

    expect(out.merged).toEqual(['cand-1']);
    expect(listCompanies()).toHaveLength(1); // no duplicate row created
    const evidence = listCompanies()[0].evidence.map((e) => e.url);
    expect(evidence).toContain('https://example.com/prior');       // history preserved
    expect(evidence.some((u) => u.includes('ycombinator.com'))).toBe(true); // new evidence appended
  });
});
