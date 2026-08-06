import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { store } from '../lib/store';
import { saveRun } from '../db/repos/operations';
import { saveCompany } from '../db/repos/companies';
import { saveScore } from '../db/repos/operations';
import { computeSourceAnalytics } from '../services/sourceAnalytics';
import { discoveryQuerySchema, type DiscoveryRun } from '../../shared/discovery';
import { adminAgent } from './testAuth';
import { createApp } from '../app';

beforeEach(() => store.resetForTests());

const baseQuery = discoveryQuerySchema.parse({ sources: ['github'] });

function fixtureRun(over: Partial<DiscoveryRun>, id: string): DiscoveryRun {
  const startedAt = over.at ?? new Date().toISOString();
  return {
    id, at: startedAt, completedAt: over.completedAt ?? startedAt, runType: 'manual', mode: 'live',
    query: baseQuery, sourceResults: [], discovered: 0, updatedExisting: 0, duplicatesSkipped: 0,
    duplicatesIdentified: 0, filteredByPolicy: 0, filteredByThesis: 0, filteredByQuality: 0, preview: false, rejectedByValidation: 0, imported: 0, errors: [],
    apiCalls: 0, modelCalls: 0, estimatedTokens: 0, estimatedCostUsd: 0, durationMs: 0,
    status: 'Completed', initiatedBy: 'test',
    ...over,
  };
}

describe('source-quality analytics', () => {
  it('tallies success/fail/skip counts and average response time from real run history', () => {
    saveRun(fixtureRun({
      sourceResults: [
        { sourceId: 'github', mode: 'live', found: 3, detail: 'ok', durationMs: 100 },
        { sourceId: 'sec', mode: 'failed', found: 0, detail: 'timeout', failureKind: 'timeout', durationMs: 300 },
      ],
    }, 'run-1'));
    saveRun(fixtureRun({
      sourceResults: [
        { sourceId: 'github', mode: 'live', found: 5, detail: 'ok', durationMs: 200 },
        { sourceId: 'sec', mode: 'skipped', found: 0, detail: 'budget exhausted' },
      ],
    }, 'run-2'));

    const rows = computeSourceAnalytics();
    const github = rows.find((r) => r.sourceId === 'github')!;
    expect(github.totalAppearances).toBe(2);
    expect(github.successfulRuns).toBe(2);
    expect(github.failedRuns).toBe(0);
    expect(github.failureRate).toBe(0);
    expect(github.avgResponseTimeMs).toBe(150); // (100+200)/2
    expect(github.resultsRetrieved).toBe(8);

    const sec = rows.find((r) => r.sourceId === 'sec')!;
    expect(sec.totalAppearances).toBe(2);
    expect(sec.failedRuns).toBe(1);
    expect(sec.skippedRuns).toBe(1);
    expect(sec.failureRate).toBe(1); // 1 failed / (0 success + 1 failed)
    expect(sec.avgResponseTimeMs).toBe(300); // skip has no duration, excluded
  });

  it('a source never selected in any run shows honest zeros, not missing data', () => {
    saveRun(fixtureRun({ sourceResults: [{ sourceId: 'github', mode: 'live', found: 1, detail: 'ok', durationMs: 50 }] }, 'run-3'));
    const rows = computeSourceAnalytics();
    const yc = rows.find((r) => r.sourceId === 'yc')!;
    expect(yc.totalAppearances).toBe(0);
    expect(yc.failureRate).toBeNull();
    expect(yc.avgResponseTimeMs).toBeNull();
  });

  it('attributes imported companies, approval status, and average fit score by discovery_source', () => {
    saveCompany(
      {
        id: 'analytics-co-1', name: 'Analytics Co 1', oneLiner: 'Fixture pitch text', vertical: 'health',
        subcategory: 'Care', stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2024, teamSize: 3,
        traction: { level: 5, note: 'Fixture traction note' },
        founders: [{ name: 'Founder One', role: 'CEO', background: 'Fixture background' }],
        evidence: [{ claim: 'Fixture claim', source: 'Fixture', url: 'https://example.com/a1', date: '2026-01-01', type: 'News' }],
        flags: [], imported: true,
      },
      { origin: 'extracted', source: 'discovery:github', discoverySource: 'github', reviewStatus: 'Synced to HubSpot' },
    );
    saveScore('analytics-co-1', {
      score: 8.4, totalPoints: 84,
      components: [{ key: 'thesis', label: 'Thesis', points: 20, max: 20, rationale: 'x' }],
      exceptions: [], version: 'v3.0', evidenceConfidence: 0.7, explanation: 'x',
    });

    const rows = computeSourceAnalytics();
    const github = rows.find((r) => r.sourceId === 'github')!;
    expect(github.companiesImported).toBe(1);
    expect(github.companiesApprovedOrSynced).toBe(1);
    expect(github.avgFitScoreOfImported).toBe(8.4);
  });

  it('is served over HTTP, gated behind admin sign-in', async () => {
    const app = createApp();
    const denied = await request(app).get('/api/admin/source-analytics');
    expect(denied.status).toBe(401);

    const agent = await adminAgent(app);
    const ok = await agent.get('/api/admin/source-analytics');
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.sources)).toBe(true);
    expect(ok.body.sources.length).toBeGreaterThan(0);
  });
});
