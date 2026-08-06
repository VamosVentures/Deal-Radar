import { getDb } from '../db/client';
import { listCompanies } from '../db/repos/companies';
import { saveScore } from '../db/repos/operations';
import { audit } from '../lib/guard';
import { scoreCompany, SCORING_VERSION } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

/**
 * Version-aware re-scoring.
 *
 * The failure this exists to prevent, found on the live dev database:
 * all 467 stored `scoring_results` rows carried version `v3.0 (2026-07)`
 * while the code had long since moved to v4. The Executive Overview
 * "Hot" KPI reads STORED rows, and the stored distribution topped out at
 * 3.9 — so the dashboard was mathematically incapable of ever showing a
 * High-Fit company, and nothing anywhere reported that the numbers on
 * screen were computed by a model the codebase no longer contained.
 *
 * Nothing re-scored existing companies when the model version changed,
 * and nothing detected that they needed it.
 *
 * DESIGN NOTES
 *
 * Append-only. `scoring_results` is never updated or deleted here. A
 * re-score INSERTs a new row; every historical v3 row survives exactly
 * as written, and `latestScore`/`latestScoresForAllCompanies` pick up
 * the new one because they read MAX(id) per company.
 *
 * Resumable by construction. "Needs re-scoring" is defined as *the
 * latest row's version differs from the current one*, so a company that
 * has already been re-scored drops out of the set the moment its row
 * lands. An interrupted run is resumed simply by running it again —
 * there is no cursor, no checkpoint table, and no way for a crash to
 * leave a company scored twice or skipped.
 *
 * Transactional in batches. Each batch commits as a unit, so a crash
 * mid-run leaves whole batches applied and the remainder detectable.
 * A single giant transaction would roll back hours of work; per-row
 * commits would make a partially-applied batch invisible.
 */

export interface OutdatedScore {
  companyId: string;
  name: string;
  storedVersion: string;
  storedScore: number;
  storedProvisional: boolean;
  computedAt: string;
}

/** Latest stored score per company, whatever its version. */
function latestRows(): Map<string, { version: string; score: number; provisional: number; computed_at: string }> {
  const rows = getDb().prepare(`
    SELECT sr.company_id, sr.version, sr.score, sr.provisional, sr.computed_at
    FROM scoring_results sr
    WHERE sr.id = (SELECT MAX(id) FROM scoring_results WHERE company_id = sr.company_id)
  `).all() as { company_id: string; version: string; score: number; provisional: number; computed_at: string }[];
  return new Map(rows.map((r) => [r.company_id, r]));
}

/**
 * Companies whose newest stored score was produced by a model version
 * other than the one this build computes.
 *
 * A company with NO score at all is deliberately excluded: it is not
 * "stale", it is unscored, which is a different problem with a different
 * fix (score it during import). Reporting the two together would hide
 * whichever was smaller.
 */
export function findOutdatedScores(currentVersion: string = SCORING_VERSION): OutdatedScore[] {
  const latest = latestRows();
  const out: OutdatedScore[] = [];
  for (const c of listCompanies()) {
    const row = latest.get(c.id);
    if (!row || row.version === currentVersion) continue;
    out.push({
      companyId: c.id,
      name: c.name,
      storedVersion: row.version,
      storedScore: row.score,
      storedProvisional: row.provisional === 1,
      computedAt: row.computed_at,
    });
  }
  return out;
}

export interface RescoreStatus {
  currentVersion: string;
  totalCompanies: number;
  scored: number;
  unscored: number;
  upToDate: number;
  needsRescore: number;
  /** How many stale rows each outdated version accounts for. */
  staleByVersion: Record<string, number>;
}

/** The count the UI/CLI shows before anyone decides to run anything. */
export function rescoreStatus(currentVersion: string = SCORING_VERSION): RescoreStatus {
  const companies = listCompanies();
  const latest = latestRows();
  const outdated = findOutdatedScores(currentVersion);
  const staleByVersion: Record<string, number> = {};
  for (const o of outdated) staleByVersion[o.storedVersion] = (staleByVersion[o.storedVersion] ?? 0) + 1;
  const scored = companies.filter((c) => latest.has(c.id)).length;
  return {
    currentVersion,
    totalCompanies: companies.length,
    scored,
    unscored: companies.length - scored,
    upToDate: scored - outdated.length,
    needsRescore: outdated.length,
    staleByVersion,
  };
}

export interface RescoreComparison {
  companyId: string;
  name: string;
  before: { version: string; score: number; provisional: boolean };
  after: { version: string; score: number; provisional: boolean; completeness: number; assessablePoints: number };
  scoreDelta: number;
  /** True when the record moves from "assessed" to "provisional" (or back). */
  provisionalChanged: boolean;
}

/**
 * What a re-score WOULD do. Pure: computes the new score in memory and
 * writes nothing, so this is safe to run against the live database and
 * is what the dry run and the UI preview both call.
 */
export function previewRescore(
  opts: { currentVersion?: string; today?: Date; limit?: number } = {},
): RescoreComparison[] {
  const currentVersion = opts.currentVersion ?? SCORING_VERSION;
  const today = opts.today ?? new Date();
  const outdated = findOutdatedScores(currentVersion);
  const byId = new Map(listCompanies().map((c) => [c.id, c]));
  const slice = opts.limit ? outdated.slice(0, opts.limit) : outdated;

  const out: RescoreComparison[] = [];
  for (const o of slice) {
    const company = byId.get(o.companyId);
    if (!company) continue;
    const fit = scoreCompany(company as unknown as Company, today);
    out.push({
      companyId: o.companyId,
      name: o.name,
      before: { version: o.storedVersion, score: o.storedScore, provisional: o.storedProvisional },
      after: {
        version: fit.version,
        score: fit.score,
        provisional: fit.provisional,
        completeness: fit.completeness,
        assessablePoints: fit.assessablePoints,
      },
      scoreDelta: Math.round((fit.score - o.storedScore) * 10) / 10,
      provisionalChanged: fit.provisional !== o.storedProvisional,
    });
  }
  return out;
}

export interface RescoreResult {
  attempted: number;
  written: number;
  skipped: { companyId: string; reason: string }[];
  batches: number;
  historicalRowsBefore: number;
  historicalRowsAfter: number;
  /** Every prior row must still be present afterwards. */
  historyPreserved: boolean;
}

/**
 * Apply the re-score. APPEND-ONLY and idempotent: running it twice in a
 * row leaves the second run with nothing to do.
 *
 * The caller is responsible for taking a backup first — see
 * scripts/rescore.ts, which refuses to apply without one.
 */
export function applyRescore(
  opts: { actor: string; currentVersion?: string; today?: Date; batchSize?: number } ,
): RescoreResult {
  const currentVersion = opts.currentVersion ?? SCORING_VERSION;
  const today = opts.today ?? new Date();
  const batchSize = opts.batchSize ?? 50;
  const db = getDb();

  const countRows = () => (db.prepare('SELECT COUNT(*) AS n FROM scoring_results').get() as { n: number }).n;
  const historicalRowsBefore = countRows();

  // Snapshot every existing row id, so "history preserved" is verified
  // against reality rather than asserted in a comment.
  const idsBefore = new Set(
    (db.prepare('SELECT id FROM scoring_results').all() as { id: number }[]).map((r) => r.id),
  );

  const outdated = findOutdatedScores(currentVersion);
  const byId = new Map(listCompanies().map((c) => [c.id, c]));
  const skipped: RescoreResult['skipped'] = [];
  let written = 0;
  let batches = 0;

  for (let i = 0; i < outdated.length; i += batchSize) {
    const batch = outdated.slice(i, i + batchSize);
    db.exec('BEGIN');
    try {
      for (const o of batch) {
        const company = byId.get(o.companyId);
        if (!company) {
          skipped.push({ companyId: o.companyId, reason: 'company row disappeared between detection and apply' });
          continue;
        }
        const fit = scoreCompany(company as unknown as Company, today);
        saveScore(o.companyId, fit, company.evidence.map((e) => e.url));
        written += 1;
      }
      db.exec('COMMIT');
      batches += 1;
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Re-score batch starting at ${i} failed and was rolled back: ${(e as Error).message}`);
    }
  }

  const idsAfter = new Set(
    (db.prepare('SELECT id FROM scoring_results').all() as { id: number }[]).map((r) => r.id),
  );
  const historyPreserved = [...idsBefore].every((id) => idsAfter.has(id));

  const result: RescoreResult = {
    attempted: outdated.length,
    written,
    skipped,
    batches,
    historicalRowsBefore,
    historicalRowsAfter: countRows(),
    historyPreserved,
  };

  audit({
    provider: 'system',
    mode: 'local',
    action: 'score-rescore',
    subject: currentVersion,
    outcome: historyPreserved && skipped.length === 0 ? 'ok' : 'error',
    detail: `Re-scored ${written}/${outdated.length} company/companies onto ${currentVersion} in ${batches} batch(es). `
      + `scoring_results rows ${historicalRowsBefore} → ${result.historicalRowsAfter} (append-only; `
      + `${historyPreserved ? 'every prior row preserved' : 'HISTORY LOSS DETECTED'}). `
      + `${skipped.length} skipped. Initiated by ${opts.actor}.`,
  });

  return result;
}
