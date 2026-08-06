import { getDb } from '../db/client';
import { listRuns } from '../db/repos/operations';
import { getSourceMeta, type SourceState } from '../sourcing';

/**
 * Source-quality analytics (Phase 10) — computed entirely from
 * persisted run history (source_runs/source_run_results) and the
 * companies/scoring_results tables. Nothing here is fabricated or
 * estimated from a made-up baseline: a metric that isn't tracked at
 * this granularity (e.g. per-source duplicate detection, which is
 * only recorded at the whole-run level) is simply not included,
 * rather than approximated and presented as real.
 */
export interface SourceAnalytics {
  sourceId: string;
  name: string;
  state: SourceState;
  /** How many runs included this source at all (including skips). */
  totalAppearances: number;
  successfulRuns: number;
  failedRuns: number;
  skippedRuns: number;
  /** failed / (successful + failed) — null when the source has never actually been attempted. */
  failureRate: number | null;
  /** Real average elapsed time (ms) across attempted (live/failed) calls — null if never attempted. */
  avgResponseTimeMs: number | null;
  resultsRetrieved: number;
  companiesImported: number;
  companiesApprovedOrSynced: number;
  /** Average of the LATEST VamosVentures Fit Score for companies whose discovery_source is this source. */
  avgFitScoreOfImported: number | null;
  mostRecentSuccessfulRunAt: string | null;
  mostRecentFailedRunAt: string | null;
}

export function computeSourceAnalytics(runLimit = 500): SourceAnalytics[] {
  const runs = listRuns(runLimit);

  interface Bucket {
    appearances: number; success: number; failed: number; skipped: number;
    durations: number[]; found: number; lastSuccessAt: string | null; lastFailedAt: string | null;
  }
  const perSource = new Map<string, Bucket>();
  for (const run of runs) {
    for (const r of run.sourceResults) {
      const bucket: Bucket = perSource.get(r.sourceId) ?? {
        appearances: 0, success: 0, failed: 0, skipped: 0, durations: [], found: 0, lastSuccessAt: null, lastFailedAt: null,
      };
      bucket.appearances += 1;
      if (r.mode === 'live') {
        bucket.success += 1;
        bucket.found += r.found;
        if (!bucket.lastSuccessAt || run.at > bucket.lastSuccessAt) bucket.lastSuccessAt = run.at;
      } else if (r.mode === 'failed') {
        bucket.failed += 1;
        if (!bucket.lastFailedAt || run.at > bucket.lastFailedAt) bucket.lastFailedAt = run.at;
      } else if (r.mode === 'skipped') {
        bucket.skipped += 1;
      }
      if (r.durationMs !== undefined) bucket.durations.push(r.durationMs);
      perSource.set(r.sourceId, bucket);
    }
  }

  // Company-level attribution via the real discovery_source column —
  // no separate tracking table needed, this is the same field shown
  // on every company's fact sheet as "Discovered … via <source>".
  const db = getDb();
  const companyRows = db.prepare(`
    SELECT id, discovery_source, review_status FROM companies
    WHERE status = 'active' AND discovery_source IS NOT NULL
  `).all() as { id: string; discovery_source: string; review_status: string | null }[];
  const scoreRows = db.prepare(`
    SELECT company_id, score FROM scoring_results sr
    WHERE id = (SELECT MAX(id) FROM scoring_results WHERE company_id = sr.company_id)
  `).all() as { company_id: string; score: number }[];
  const latestScoreByCompany = new Map(scoreRows.map((r) => [r.company_id, r.score]));

  interface CompanyBucket { imported: number; approvedOrSynced: number; scores: number[] }
  const bySource = new Map<string, CompanyBucket>();
  for (const c of companyRows) {
    const bucket: CompanyBucket = bySource.get(c.discovery_source) ?? { imported: 0, approvedOrSynced: 0, scores: [] };
    bucket.imported += 1;
    if (c.review_status === 'Approved for HubSpot' || c.review_status === 'Synced to HubSpot') bucket.approvedOrSynced += 1;
    const score = latestScoreByCompany.get(c.id);
    if (score !== undefined) bucket.scores.push(score);
    bySource.set(c.discovery_source, bucket);
  }

  return getSourceMeta().map((meta): SourceAnalytics => {
    const s = perSource.get(meta.id);
    const c = bySource.get(meta.id);
    const attempts = (s?.success ?? 0) + (s?.failed ?? 0);
    const avgOf = (nums: number[]): number | null => (nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null);
    return {
      sourceId: meta.id,
      name: meta.name,
      state: meta.state,
      totalAppearances: s?.appearances ?? 0,
      successfulRuns: s?.success ?? 0,
      failedRuns: s?.failed ?? 0,
      skippedRuns: s?.skipped ?? 0,
      failureRate: attempts > 0 ? Number(((s!.failed / attempts)).toFixed(3)) : null,
      avgResponseTimeMs: s ? (avgOf(s.durations) !== null ? Math.round(avgOf(s.durations)!) : null) : null,
      resultsRetrieved: s?.found ?? 0,
      companiesImported: c?.imported ?? 0,
      companiesApprovedOrSynced: c?.approvedOrSynced ?? 0,
      avgFitScoreOfImported: c ? (avgOf(c.scores) !== null ? Number(avgOf(c.scores)!.toFixed(2)) : null) : null,
      mostRecentSuccessfulRunAt: s?.lastSuccessAt ?? null,
      mostRecentFailedRunAt: s?.lastFailedAt ?? null,
    };
  });
}
