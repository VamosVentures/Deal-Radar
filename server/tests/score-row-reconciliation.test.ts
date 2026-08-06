import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import { latestScore, latestScoresForAllCompanies, saveScore } from '../db/repos/operations';
import type { ImportedCompany } from '../services/imports';

/**
 * `scoring_results` counts mean three DIFFERENT things, and the previous
 * report conflated two of them — it described "209 stored scoring_results
 * rows" when 209 was the number of distinct scored companies and the
 * table actually held 467 rows.
 *
 * The table is APPEND-ONLY by design: every scoring pass inserts a new
 * row and no earlier row is ever updated or deleted, so score history
 * survives. That makes these three numbers permanently different from
 * each other, and any report or KPI that treats them as interchangeable
 * is wrong:
 *
 *   total historical rows    every scoring pass ever recorded  (467)
 *   distinct scored companies  companies with >= 1 row         (209)
 *   latest rows                MAX(id) per company             (209)
 *
 * The last two coincide by definition — one latest row per scored
 * company — but neither equals the first whenever anything has been
 * re-scored. On the live database at the time of writing, companies had
 * between 1 and 6 historical rows each.
 */

function fixture(id: string): ImportedCompany {
  return {
    id, name: `Co ${id}`, oneLiner: 'x', vertical: 'health', subcategory: 'Cancer',
    stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 3,
    traction: { level: 5, note: 'Rated.' },
    founders: [{ name: 'F', role: 'CEO', background: 'Engineer.' }],
    evidence: [{ claim: 'c', source: 's', url: `https://example.com/${id}`, date: '2026-07-01', type: 'News' }],
    flags: [], imported: true,
  };
}

const fit = (score: number, version: string) => ({
  score, totalPoints: score * 10, components: [], exceptions: [],
  version, evidenceConfidence: 0.5, explanation: 'x', provisional: false,
});

function counts() {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    totalHistoricalRows: one('SELECT COUNT(*) AS n FROM scoring_results'),
    distinctScoredCompanies: one('SELECT COUNT(DISTINCT company_id) AS n FROM scoring_results'),
    latestRows: one(
      'SELECT COUNT(*) AS n FROM scoring_results sr WHERE sr.id = (SELECT MAX(id) FROM scoring_results WHERE company_id = sr.company_id)',
    ),
  };
}

describe('scoring_results row-count reconciliation', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  it('distinguishes total rows from scored companies from latest rows', () => {
    saveCompany(fixture('rc-1'), { origin: 'extracted', source: 'test' });
    saveCompany(fixture('rc-2'), { origin: 'extracted', source: 'test' });

    // rc-1 scored three times, rc-2 once.
    saveScore('rc-1', fit(3.1, 'v3.0 (2026-07)'));
    saveScore('rc-1', fit(3.4, 'v3.0 (2026-07)'));
    saveScore('rc-1', fit(6.8, 'v4.1 (2026-08, evidence-gated provisional)'));
    saveScore('rc-2', fit(5.0, 'v3.0 (2026-07)'));

    expect(counts()).toEqual({
      totalHistoricalRows: 4,
      distinctScoredCompanies: 2,
      latestRows: 2,
    });
  });

  it('latest rows always equals distinct scored companies, and both are <= total rows', () => {
    for (let i = 0; i < 5; i += 1) {
      saveCompany(fixture(`rc-m${i}`), { origin: 'extracted', source: 'test' });
      for (let j = 0; j <= i; j += 1) saveScore(`rc-m${i}`, fit(4 + j * 0.1, 'v3.0 (2026-07)'));
    }
    const c = counts();
    expect(c.latestRows).toBe(c.distinctScoredCompanies);
    expect(c.distinctScoredCompanies).toBeLessThanOrEqual(c.totalHistoricalRows);
    expect(c.totalHistoricalRows).toBe(1 + 2 + 3 + 4 + 5);
    expect(c.distinctScoredCompanies).toBe(5);
  });

  it('scoring is append-only: re-scoring never updates or deletes an earlier row', () => {
    saveCompany(fixture('rc-append'), { origin: 'extracted', source: 'test' });
    saveScore('rc-append', fit(2.5, 'v3.0 (2026-07)'));
    const first = getDb().prepare('SELECT id, score, version FROM scoring_results WHERE company_id = ?')
      .all('rc-append') as { id: number; score: number; version: string }[];
    expect(first).toHaveLength(1);

    saveScore('rc-append', fit(7.2, 'v4.1 (2026-08, evidence-gated provisional)'));
    const after = getDb().prepare('SELECT id, score, version FROM scoring_results WHERE company_id = ? ORDER BY id')
      .all('rc-append') as { id: number; score: number; version: string }[];

    expect(after).toHaveLength(2);
    // The original row is byte-identical — history is preserved.
    expect(after[0]).toEqual(first[0]);
    expect(after[1].score).toBe(7.2);
  });

  it('the readers used by KPIs return the LATEST row, never an aggregate over history', () => {
    saveCompany(fixture('rc-latest'), { origin: 'extracted', source: 'test' });
    saveScore('rc-latest', fit(2.0, 'v3.0 (2026-07)'));
    saveScore('rc-latest', fit(9.5, 'v3.0 (2026-07)'));
    saveScore('rc-latest', fit(6.1, 'v4.1 (2026-08, evidence-gated provisional)'));

    expect(latestScore('rc-latest')!.score).toBe(6.1);
    expect(latestScore('rc-latest')!.version).toBe('v4.1 (2026-08, evidence-gated provisional)');
    const all = latestScoresForAllCompanies();
    expect(all.size).toBe(1);
    expect(all.get('rc-latest')!.score).toBe(6.1);
  });
});
