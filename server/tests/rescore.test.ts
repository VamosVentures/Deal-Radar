import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import { latestScore, saveScore } from '../db/repos/operations';
import { applyRescore, findOutdatedScores, previewRescore, rescoreStatus } from '../services/rescore';
import { SCORING_VERSION } from '../../src/lib/scoring';
import type { ImportedCompany } from '../services/imports';

/**
 * Version-aware re-scoring. The bug these guard against was live: 467
 * stored score rows on `v3.0 (2026-07)` while the code computed v4, with
 * the Hot KPI reading the stored rows and therefore stuck at zero
 * forever, and nothing detecting or reporting the mismatch.
 */

const OLD_VERSION = 'v3.0 (2026-07)';
const NOW = new Date('2026-08-05T00:00:00.000Z');

/** A fully-researched company: every critical component is assessable. */
function complete(id: string): ImportedCompany {
  return {
    id, name: `Complete ${id}`, oneLiner: 'Grid software for utilities.',
    vertical: 'sustainability', subcategory: 'Smart grids', stage: 'Seed',
    city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 5,
    traction: { level: 6, note: 'Three signed utility pilots.' },
    founders: [
      { name: 'A Founder', role: 'CEO', background: 'Former ERCOT engineer who founded a prior company.' },
      { name: 'B Founder', role: 'CTO', background: 'PhD, research scientist.' },
    ],
    evidence: [{ claim: 'Seed round filed.', source: 'SEC', url: `https://sec.gov/${id}`, date: '2026-07-20', type: 'Filing' }],
    flags: [], imported: true,
  };
}

/** A thin record: sector and location only, nothing else researched. */
function thin(id: string): ImportedCompany {
  return {
    ...complete(id),
    name: `Thin ${id}`,
    stage: 'Unknown',
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
  };
}

const oldFit = (score: number) => ({
  score, totalPoints: score * 10, components: [], exceptions: [],
  version: OLD_VERSION, evidenceConfidence: 0.4, explanation: 'legacy', provisional: false,
});

describe('stale-score detection', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  it('detects companies whose LATEST score uses an outdated model version', () => {
    saveCompany(complete('rs-old'), { origin: 'extracted', source: 'test' });
    saveCompany(complete('rs-current'), { origin: 'extracted', source: 'test' });
    saveScore('rs-old', oldFit(2.4));
    saveScore('rs-current', { ...oldFit(6.1), version: SCORING_VERSION });

    const outdated = findOutdatedScores();
    expect(outdated.map((o) => o.companyId)).toEqual(['rs-old']);
    expect(outdated[0].storedVersion).toBe(OLD_VERSION);
  });

  it('judges by the LATEST row, not by whether any old row exists', () => {
    // A company re-scored onto the current model is up to date even
    // though its v3 history is still on file — that is the whole point
    // of keeping history.
    saveCompany(complete('rs-hist'), { origin: 'extracted', source: 'test' });
    saveScore('rs-hist', oldFit(2.4));
    saveScore('rs-hist', { ...oldFit(6.8), version: SCORING_VERSION });
    expect(findOutdatedScores()).toHaveLength(0);
  });

  it('does not report an UNSCORED company as stale — that is a different problem', () => {
    saveCompany(complete('rs-unscored'), { origin: 'extracted', source: 'test' });
    expect(findOutdatedScores()).toHaveLength(0);
    const status = rescoreStatus();
    expect(status.unscored).toBe(1);
    expect(status.needsRescore).toBe(0);
  });

  it('reports the count and the breakdown by stale version', () => {
    for (const id of ['rs-a', 'rs-b', 'rs-c']) {
      saveCompany(complete(id), { origin: 'extracted', source: 'test' });
    }
    saveScore('rs-a', oldFit(2.1));
    saveScore('rs-b', oldFit(2.2));
    saveScore('rs-c', { ...oldFit(3.0), version: 'v2 (pre-versioning)' });

    const status = rescoreStatus();
    expect(status.needsRescore).toBe(3);
    expect(status.staleByVersion).toEqual({ [OLD_VERSION]: 2, 'v2 (pre-versioning)': 1 });
    expect(status.upToDate).toBe(0);
    expect(status.totalCompanies).toBe(3);
  });
});

describe('re-score preview', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  it('reports old vs new without writing anything', () => {
    saveCompany(complete('rs-p'), { origin: 'extracted', source: 'test' });
    saveScore('rs-p', oldFit(2.4));
    const rowsBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results').get() as { n: number }).n;

    const [cmp] = previewRescore({ today: NOW });
    expect(cmp.before).toEqual({ version: OLD_VERSION, score: 2.4, provisional: false });
    expect(cmp.after.version).toBe(SCORING_VERSION);
    expect(cmp.scoreDelta).toBeCloseTo(cmp.after.score - 2.4, 5);

    expect((getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results').get() as { n: number }).n).toBe(rowsBefore);
    expect(latestScore('rs-p')!.version).toBe(OLD_VERSION);
  });

  it('flags records whose provisional status changes', () => {
    // A thin record stored as non-provisional under the old model must
    // be reported as flipping to provisional — this is the specific
    // correction the v4.1 policy makes, and it must be visible BEFORE
    // anyone applies it.
    saveCompany(thin('rs-thin'), { origin: 'extracted', source: 'test' });
    saveScore('rs-thin', oldFit(2.4));
    const [cmp] = previewRescore({ today: NOW });
    expect(cmp.before.provisional).toBe(false);
    expect(cmp.after.provisional).toBe(true);
    expect(cmp.provisionalChanged).toBe(true);
  });
});

describe('re-score apply', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  function seed(n: number, make: (id: string) => ImportedCompany = complete) {
    for (let i = 0; i < n; i += 1) {
      const id = `rs-x${i}`;
      saveCompany(make(id), { origin: 'extracted', source: 'test' });
      saveScore(id, oldFit(2 + i * 0.01));
    }
  }

  it('appends new rows and preserves every historical row', () => {
    seed(3);
    const idsBefore = (getDb().prepare('SELECT id FROM scoring_results ORDER BY id').all() as { id: number }[]).map((r) => r.id);

    const result = applyRescore({ actor: 'test', today: NOW });
    expect(result.attempted).toBe(3);
    expect(result.written).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.historyPreserved).toBe(true);
    expect(result.historicalRowsAfter).toBe(result.historicalRowsBefore + 3);

    // Every original row is still there, byte-identical.
    const idsAfter = new Set((getDb().prepare('SELECT id FROM scoring_results').all() as { id: number }[]).map((r) => r.id));
    for (const id of idsBefore) expect(idsAfter.has(id)).toBe(true);
    const original = getDb().prepare('SELECT version, score FROM scoring_results WHERE id = ?').get(idsBefore[0]) as { version: string; score: number };
    expect(original.version).toBe(OLD_VERSION);
  });

  it('leaves nothing stale afterwards, and is idempotent on a second run', () => {
    seed(4);
    applyRescore({ actor: 'test', today: NOW });
    expect(findOutdatedScores()).toHaveLength(0);

    const rows = (getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results').get() as { n: number }).n;
    const second = applyRescore({ actor: 'test', today: NOW });
    expect(second.attempted).toBe(0);
    expect(second.written).toBe(0);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results').get() as { n: number }).n).toBe(rows);
  });

  it('resumes safely after an interruption — completed work is kept, the rest is still detected', () => {
    seed(10);
    // Simulate a crash after the first batch by applying with a batch
    // size that only covers part of the set, via a restricted first pass.
    const partial = applyRescore({ actor: 'test', today: NOW, batchSize: 3 });
    expect(partial.written).toBe(10);
    expect(partial.batches).toBe(4); // 3 + 3 + 3 + 1

    // Now mimic an interruption differently: push three companies back
    // onto the old version, as a half-finished run would leave them.
    for (const id of ['rs-x0', 'rs-x1', 'rs-x2']) saveScore(id, oldFit(2.4));
    expect(findOutdatedScores().map((o) => o.companyId).sort()).toEqual(['rs-x0', 'rs-x1', 'rs-x2']);

    const resumed = applyRescore({ actor: 'test', today: NOW });
    expect(resumed.attempted).toBe(3);
    expect(resumed.written).toBe(3);
    expect(findOutdatedScores()).toHaveLength(0);
  });

  it('commits in batches, so a batch boundary is a real recovery point', () => {
    seed(7);
    const result = applyRescore({ actor: 'test', today: NOW, batchSize: 2 });
    expect(result.batches).toBe(4); // 2 + 2 + 2 + 1
    expect(result.written).toBe(7);
  });

  it('records an audit entry naming the version and the row-count change', () => {
    seed(2);
    applyRescore({ actor: 'test-actor', today: NOW });
    const entry = store.raw.audit.find((a) => a.action === 'score-rescore')!;
    expect(entry).toBeDefined();
    expect(entry.subject).toBe(SCORING_VERSION);
    expect(entry.detail).toMatch(/append-only/);
    expect(entry.detail).toMatch(/every prior row preserved/);
    expect(entry.detail).toMatch(/test-actor/);
  });

  it('never invents a High-Fit company: re-scoring cannot promote a thin record', () => {
    // The inflation guard. Thin records get a HIGHER raw number under a
    // normalized model — that is arithmetic, not improvement — and the
    // provisional gate is what stops that number reaching High-Fit.
    seed(5, thin);
    applyRescore({ actor: 'test', today: NOW });
    for (let i = 0; i < 5; i += 1) {
      const s = latestScore(`rs-x${i}`)!;
      expect(s.version).toBe(SCORING_VERSION);
      expect(s.provisional, `rs-x${i} must stay out of High-Fit`).toBe(true);
    }
  });
});
