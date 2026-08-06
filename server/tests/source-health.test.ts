import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { saveRun } from '../db/repos/operations';
import { computeSourceHealth } from '../services/sourceHealth';
import { discoveryQuerySchema, type DiscoveryRun } from '../../shared/discovery';

beforeEach(() => store.resetForTests());

const baseQuery = discoveryQuerySchema.parse({ sources: ['github'] });

function fixtureRun(id: string, over: Partial<DiscoveryRun> = {}): DiscoveryRun {
  const at = over.at ?? new Date().toISOString();
  return {
    id, at, completedAt: over.completedAt ?? at, runType: 'manual', mode: 'live',
    query: baseQuery, sourceResults: [], discovered: 0, updatedExisting: 0, duplicatesSkipped: 0,
    duplicatesIdentified: 0, filteredByPolicy: 0, filteredByThesis: 0, filteredByQuality: 0, preview: false, rejectedByValidation: 0, imported: 0, errors: [],
    apiCalls: 0, modelCalls: 0, estimatedTokens: 0, estimatedCostUsd: 0, durationMs: 0,
    status: 'Completed', initiatedBy: 'test',
    ...over,
  };
}

describe('Source health', () => {
  it('a source with no adapter (planned/unavailable) is always "disabled", never "blocked"', () => {
    const rows = computeSourceHealth();
    const patents = rows.find((r) => r.sourceId === 'patents')!;
    expect(patents.health).toBe('disabled');
    const hackathons = rows.find((r) => r.sourceId === 'hackathons')!;
    expect(hackathons.health).toBe('disabled');
  });

  it('a live source that has never actually run is "enabled", not falsely "healthy"', () => {
    const rows = computeSourceHealth();
    const investorNews = rows.find((r) => r.sourceId === 'investor-news')!;
    expect(investorNews.health).toBe('enabled');
    expect(investorNews.lastAttemptedSyncAt).toBeNull();
  });

  it('a live source with a clean run history is "healthy"', () => {
    saveRun(fixtureRun('run-1', {
      sourceResults: [{ sourceId: 'github', mode: 'live', found: 5, detail: 'ok', durationMs: 100 }],
    }));
    const rows = computeSourceHealth();
    const github = rows.find((r) => r.sourceId === 'github')!;
    expect(github.health).toBe('healthy');
    expect(github.recentErrorSummary).toBeNull();
  });

  it('a live source failing every attempt is "failed", with the real error message surfaced', () => {
    saveRun(fixtureRun('run-1', {
      sourceResults: [{ sourceId: 'github', mode: 'failed', found: 0, detail: 'HTTP 500', failureKind: 'http-error', durationMs: 50 }],
    }));
    const rows = computeSourceHealth();
    const github = rows.find((r) => r.sourceId === 'github')!;
    expect(github.health).toBe('failed');
    expect(github.recentErrorSummary).toBe('HTTP 500');
  });

  it('a live source with a mix of success and failure, most recently a failure, is "degraded"', () => {
    saveRun(fixtureRun('run-1', {
      at: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:00:00.000Z',
      sourceResults: [{ sourceId: 'github', mode: 'live', found: 5, detail: 'ok', durationMs: 100 }],
    }));
    saveRun(fixtureRun('run-2', {
      at: '2026-08-02T00:00:00.000Z', completedAt: '2026-08-02T00:00:00.000Z',
      sourceResults: [{ sourceId: 'github', mode: 'failed', found: 0, detail: 'timed out', failureKind: 'timeout', durationMs: 8000 }],
    }));
    const rows = computeSourceHealth();
    const github = rows.find((r) => r.sourceId === 'github')!;
    expect(github.health).toBe('degraded');
    expect(github.lastAttemptedSyncAt).toBe('2026-08-02T00:00:00.000Z');
  });

  it('never exposes a credential value — only the descriptive `needs` text for a blocked source', () => {
    const rows = computeSourceHealth();
    const producthunt = rows.find((r) => r.sourceId === 'producthunt')!;
    expect(producthunt.health).toBe('blocked');
    expect(producthunt.authOrConfigMissing).toBe(true);
    expect(producthunt.recentErrorSummary).not.toMatch(/[A-Za-z0-9_-]{20,}/); // no token-shaped string
  });
});
