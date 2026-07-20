import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { __setSourceRunnerForTests } from '../services/sources';
import { refreshCompanyResearch } from '../services/companyRefresh';
import { saveCompany, applyFieldUpdate, getCompany } from '../db/repos/companies';
import { latestScore } from '../db/repos/operations';
import type { SourceRunResult } from '../sourcing/runlog';
import type { DiscoveryQuery, DiscoverySourceId } from '../../shared/discovery';
import type { ImportedCompany } from '../services/imports';

/**
 * True per-company live research refresh. All network access is
 * stubbed via __setSourceRunnerForTests — see the established pattern
 * in server/tests/sourcing.test.ts and fixtures/sources.ts.
 */

beforeEach(() => store.resetForTests());
afterEach(() => __setSourceRunnerForTests(null));

function fixtureCompany(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: 'refresh-co-1', name: 'Voltaic Robotics', oneLiner: 'Fixture pitch text', vertical: 'sustainability',
    subcategory: 'Energy transition software', stage: 'Seed', city: 'Denver', state: 'CO',
    foundedYear: 2024, teamSize: 4, website: 'https://voltaicrobotics.example.com',
    traction: { level: 5, note: 'Fixture traction note' },
    founders: [{ name: 'Founder One', role: 'CEO', background: 'Fixture background' }],
    evidence: [{ claim: 'Original fixture claim', source: 'Fixture', url: 'https://example.com/original', date: '2026-01-01', type: 'News' }],
    flags: [], imported: true,
    ...over,
  };
}

/** A runner that returns a fixed result per sourceId, defaulting to skipped for anything unlisted. */
function runnerFor(results: Partial<Record<DiscoverySourceId, SourceRunResult>>) {
  return async (sourceId: DiscoverySourceId, _q: DiscoveryQuery, _budget: number): Promise<SourceRunResult> =>
    results[sourceId] ?? { sourceId, mode: 'skipped', candidates: [], apiCalls: 0, detail: 'not exercised in this test' };
}

describe('refresh live research', () => {
  it('finds new evidence, applies a field update, and recomputes the score', async () => {
    saveCompany(fixtureCompany(), { origin: 'extracted', source: 'test' });
    __setSourceRunnerForTests(runnerFor({
      github: {
        sourceId: 'github', mode: 'live', apiCalls: 1, detail: 'found a match',
        candidates: [{
          companyName: 'Voltaic Robotics', accelerator: 'Fixture Accelerator Batch 9',
          evidence: [{ claim: 'New GitHub org activity', source: 'GitHub', url: 'https://github.com/voltaic-robotics', dateAccessed: '2026-07-01', verificationStatus: 'Not verified', confidence: 0.4, notes: '' }],
          confidence: 0.4,
        }],
      },
    }));

    const result = await refreshCompanyResearch('refresh-co-1', 'tester');
    expect(result.newEvidenceCount).toBe(1);
    expect(result.newEvidence[0].url).toBe('https://github.com/voltaic-robotics');
    expect(result.updatedFields).toEqual([{ field: 'Accelerator', from: 'Missing', to: 'Fixture Accelerator Batch 9', source: 'GitHub' }]);
    expect(result.conflictingFields).toHaveLength(0);
    expect(result.sourcesRan.map((s) => s.sourceId)).toContain('github');
    expect(result.newScore.version).toBeTruthy();

    const stored = latestScore('refresh-co-1');
    expect(stored?.score).toBe(result.newScore.score);
  });

  it('reports no changes when the source confirms exactly what is already on record', async () => {
    saveCompany(fixtureCompany(), { origin: 'extracted', source: 'test' });
    __setSourceRunnerForTests(runnerFor({
      github: {
        sourceId: 'github', mode: 'live', apiCalls: 1, detail: 'found a match, nothing new',
        candidates: [{
          companyName: 'Voltaic Robotics', hqCity: 'Denver', hqState: 'CO',
          evidence: [{ claim: 'Original fixture claim', source: 'Fixture', url: 'https://example.com/original', dateAccessed: '2026-01-01', verificationStatus: 'Not verified', confidence: 0.5, notes: '' }],
          confidence: 0.5,
        }],
      },
    }));

    const result = await refreshCompanyResearch('refresh-co-1', 'tester');
    expect(result.newEvidenceCount).toBe(0); // same URL as already on record
    expect(result.updatedFields).toHaveLength(0); // city/state already match
    expect(result.conflictingFields).toHaveLength(0);
  });

  it('flags conflicting evidence and keeps the verified value, requiring human review', async () => {
    saveCompany(fixtureCompany(), { origin: 'extracted', source: 'test' });
    // Seed a VERIFIED city so a weaker 'extracted' update must be refused.
    applyFieldUpdate('refresh-co-1', 'city', 'Denver', 'verified', 'test-verified-seed');

    __setSourceRunnerForTests(runnerFor({
      github: {
        sourceId: 'github', mode: 'live', apiCalls: 1, detail: 'found a conflicting location',
        candidates: [{
          companyName: 'Voltaic Robotics', hqCity: 'Boulder',
          evidence: [{ claim: 'Conflicting location claim', source: 'GitHub', url: 'https://github.com/voltaic-robotics/conflict', dateAccessed: '2026-07-01', verificationStatus: 'Not verified', confidence: 0.4, notes: '' }],
          confidence: 0.4,
        }],
      },
    }));

    const result = await refreshCompanyResearch('refresh-co-1', 'tester');
    expect(result.conflictingFields).toHaveLength(1);
    expect(result.conflictingFields[0]).toMatchObject({ field: 'City', existing: 'Denver', attempted: 'Boulder' });
    expect(result.fieldsRequiringHumanReview.join(' ')).toMatch(/City/);
    expect(getCompany('refresh-co-1')!.city).toBe('Denver'); // never overwritten
  });

  it('reports a partial failure without losing the other sources’ results', async () => {
    saveCompany(fixtureCompany(), { origin: 'extracted', source: 'test' });
    __setSourceRunnerForTests(runnerFor({
      github: {
        sourceId: 'github', mode: 'live', apiCalls: 1, detail: 'ok',
        candidates: [{ companyName: 'Voltaic Robotics', evidence: [{ claim: 'GH claim', source: 'GitHub', url: 'https://github.com/voltaic/partial', dateAccessed: '2026-07-01', verificationStatus: 'Not verified', confidence: 0.4, notes: '' }], confidence: 0.4 }],
      },
      sec: { sourceId: 'sec', mode: 'failed', candidates: [], apiCalls: 1, detail: 'timed out', failureKind: 'timeout' },
    }));

    const result = await refreshCompanyResearch('refresh-co-1', 'tester');
    expect(result.sourcesRan.map((s) => s.sourceId)).toContain('github');
    expect(result.sourcesFailed.map((s) => s.sourceId)).toContain('sec');
    expect(result.newEvidenceCount).toBe(1); // github's result still made it through
  });

  it('reports a complete failure honestly — zero new evidence, no crash', async () => {
    saveCompany(fixtureCompany(), { origin: 'extracted', source: 'test' });
    __setSourceRunnerForTests(async (sourceId): Promise<SourceRunResult> => ({
      sourceId, mode: 'failed', candidates: [], apiCalls: 1, detail: 'network unreachable', failureKind: 'network',
    }));

    const result = await refreshCompanyResearch('refresh-co-1', 'tester');
    expect(result.sourcesRan).toHaveLength(0);
    expect(result.sourcesFailed.length).toBeGreaterThan(0);
    expect(result.newEvidenceCount).toBe(0);
    expect(result.updatedFields).toHaveLength(0);
  });

  it('never adds the same evidence URL twice across repeated refreshes', async () => {
    saveCompany(fixtureCompany(), { origin: 'extracted', source: 'test' });
    __setSourceRunnerForTests(runnerFor({
      github: {
        sourceId: 'github', mode: 'live', apiCalls: 1, detail: 'ok',
        candidates: [{ companyName: 'Voltaic Robotics', evidence: [{ claim: 'Repeated claim', source: 'GitHub', url: 'https://github.com/voltaic/repeat', dateAccessed: '2026-07-01', verificationStatus: 'Not verified', confidence: 0.4, notes: '' }], confidence: 0.4 }],
      },
    }));

    const first = await refreshCompanyResearch('refresh-co-1', 'tester');
    expect(first.newEvidenceCount).toBe(1);
    const second = await refreshCompanyResearch('refresh-co-1', 'tester');
    expect(second.newEvidenceCount).toBe(0); // same URL — not duplicated
    expect(getCompany('refresh-co-1')!.evidence.filter((e) => e.url === 'https://github.com/voltaic/repeat')).toHaveLength(1);
  });

  it('preserves all historical evidence — nothing is ever removed', async () => {
    saveCompany(fixtureCompany(), { origin: 'extracted', source: 'test' });
    __setSourceRunnerForTests(runnerFor({
      github: {
        sourceId: 'github', mode: 'live', apiCalls: 1, detail: 'ok',
        candidates: [{ companyName: 'Voltaic Robotics', evidence: [{ claim: 'New claim', source: 'GitHub', url: 'https://github.com/voltaic/new', dateAccessed: '2026-07-01', verificationStatus: 'Not verified', confidence: 0.4, notes: '' }], confidence: 0.4 }],
      },
    }));
    await refreshCompanyResearch('refresh-co-1', 'tester');
    const urls = getCompany('refresh-co-1')!.evidence.map((e) => e.url);
    expect(urls).toContain('https://example.com/original'); // the original row is still there
    expect(urls).toContain('https://github.com/voltaic/new');
  });

  it('stops querying once the per-company API-call budget is exhausted', async () => {
    saveCompany(fixtureCompany(), { origin: 'extracted', source: 'test' });
    let calls = 0;
    __setSourceRunnerForTests(async (sourceId): Promise<SourceRunResult> => {
      calls += 1;
      // Each call reports a large cost, exhausting the small per-company budget quickly.
      return { sourceId, mode: 'live', candidates: [], apiCalls: 5, detail: 'ok, expensive call' };
    });

    const result = await refreshCompanyResearch('refresh-co-1', 'tester');
    const attempted = result.sourcesRan.length + result.sourcesFailed.length;
    expect(attempted).toBeLessThan(7); // fewer than all COMPANY_LEVEL_SOURCES were attempted
    expect(result.sourcesSkipped.some((s) => /budget/i.test(s.detail))).toBe(true);
    expect(calls).toBeLessThan(7);
  });

  it('404s honestly for an unknown company', async () => {
    await expect(refreshCompanyResearch('does-not-exist', 'tester')).rejects.toMatchObject({ status: 404 });
  });
});
