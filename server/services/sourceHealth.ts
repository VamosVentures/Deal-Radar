import { getDb } from '../db/client';
import { computeSourceAnalytics } from './sourceAnalytics';
import { getSourceMeta } from '../sourcing';
import type { DiscoverySourceId } from '../../shared/discovery';

/**
 * One combined source-health status per intended source, for the
 * Settings → Data Sources health view. Built entirely from
 * getSourceMeta() (static config state) and computeSourceAnalytics()
 * (real run history) — no new tracking, just one payload instead of
 * two separate calls the UI had to reconcile itself.
 *
 * Never exposes a token, credential value, or raw stack trace — only
 * the same descriptive `detail` strings already written to
 * source_run_results by the adapters themselves (e.g. "HTTP 429" or
 * "The request exceeded the timeout"), never an Error's `.stack`.
 */
export type SourceHealthStatus = 'disabled' | 'blocked' | 'healthy' | 'degraded' | 'failed' | 'enabled';

export interface SourceHealth {
  sourceId: string;
  name: string;
  health: SourceHealthStatus;
  /** True when the source's own config (getSourceMeta().needs) requires something not currently set. */
  authOrConfigMissing: boolean;
  lastAttemptedSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  /** Records returned across the source's appearances in the most recent run it took part in. */
  recordsInLatestRun: number | null;
  /** Descriptive message only — never a stack trace or credential value. */
  recentErrorSummary: string | null;
  failureRate: number | null;
  companiesImported: number;
}

function healthFor(state: 'live' | 'credentials-required' | 'planned' | 'unavailable', analytics: {
  totalAppearances: number; failureRate: number | null; mostRecentSuccessfulRunAt: string | null; mostRecentFailedRunAt: string | null;
}): SourceHealthStatus {
  if (state === 'planned' || state === 'unavailable') return 'disabled';
  if (state === 'credentials-required') return 'blocked';
  if (analytics.totalAppearances === 0) return 'enabled'; // capable, never actually exercised yet
  if (analytics.failureRate === null || analytics.failureRate === 0) return 'healthy';
  if (analytics.failureRate >= 1) return 'failed';
  // A failure more recent than the last success reads as currently
  // struggling even if the historical rate looks mixed.
  if (analytics.mostRecentFailedRunAt && (!analytics.mostRecentSuccessfulRunAt || analytics.mostRecentFailedRunAt > analytics.mostRecentSuccessfulRunAt)) {
    return 'degraded';
  }
  return analytics.failureRate > 0 ? 'degraded' : 'healthy';
}

/** The most recent failed source_run_results.detail for this source — message only. */
function recentErrorDetail(sourceId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT srr.detail FROM source_run_results srr
    JOIN source_runs sr ON sr.id = srr.run_id
    WHERE srr.source_id = ? AND srr.mode = 'failed'
    ORDER BY sr.at DESC LIMIT 1
  `).get(sourceId) as { detail: string } | undefined;
  return row?.detail ?? null;
}

export function computeSourceHealth(runLimit = 500): SourceHealth[] {
  const analytics = computeSourceAnalytics(runLimit);
  const metaById = new Map(getSourceMeta().map((m) => [m.id, m]));

  return analytics.map((a): SourceHealth => {
    const meta = metaById.get(a.sourceId as DiscoverySourceId);
    const lastAttemptedSyncAt = [a.mostRecentSuccessfulRunAt, a.mostRecentFailedRunAt]
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null;
    return {
      sourceId: a.sourceId,
      name: a.name,
      health: healthFor(a.state, a),
      authOrConfigMissing: a.state === 'credentials-required',
      lastAttemptedSyncAt,
      lastSuccessfulSyncAt: a.mostRecentSuccessfulRunAt,
      recordsInLatestRun: a.totalAppearances > 0 ? a.resultsRetrieved : null,
      recentErrorSummary: a.state === 'live' ? recentErrorDetail(a.sourceId) : (meta?.needs ?? null),
      failureRate: a.failureRate,
      companiesImported: a.companiesImported,
    };
  });
}
