import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { latestMigrationVersion, runMigrations, MIGRATIONS } from '../db/migrations';

/**
 * Migration 13 (run-attribution-and-score-completeness) added nullable
 * columns to existing tables — this is the safe, reversible shape a
 * migration on live data should take (additive, no backfill, no
 * NOT NULL without a default). These tests run against a throwaway
 * in-memory DB, never the real one.
 */
describe('migrations', () => {
  it('applies cleanly on a fresh database and is idempotent (safe to run twice)', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow(); // rerun must no-op, not fail or duplicate
    const applied = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number };
    expect(applied.n).toBe(latestMigrationVersion());
  });

  it('migration 13 adds nullable, non-breaking columns — existing insert paths that omit them still work', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);

    // A company insert that doesn't mention discovery_run_id at all
    // (the shape every pre-migration-13 insert used) must still succeed,
    // and the new column must read back NULL rather than erroring or
    // defaulting to a fabricated value.
    const now = new Date().toISOString();
    expect(() => db.prepare(`
      INSERT INTO companies (id, name, normalized_name, domain, website, one_liner, vertical, subcategory, stage,
        city, state, founded_year, team_size, traction_level, traction_note, flags, status, created_at, updated_at)
      VALUES ('mig-test-co', 'Mig Test', 'mig test', NULL, NULL, 'x', 'health', 'x', 'Seed', 'x', 'TX', 2024, 1, 0, 'x', '[]', 'active', ?, ?)
    `).run(now, now)).not.toThrow();
    const row = db.prepare('SELECT discovery_run_id FROM companies WHERE id = ?').get('mig-test-co') as { discovery_run_id: string | null };
    expect(row.discovery_run_id).toBeNull();

    // scoring_results.provisional defaults to 0 (not provisional) for any
    // insert that predates the column, rather than leaving it NULL —
    // matches the migration's explicit DEFAULT 0.
    expect(() => db.prepare(`
      INSERT INTO scoring_results (company_id, score, total_points, components, exceptions, version, evidence_confidence, explanation, supporting_evidence, computed_at)
      VALUES ('mig-test-co', 5, 50, '[]', '[]', 'v1', 0.5, 'x', '[]', ?)
    `).run(now)).not.toThrow();
    const score = db.prepare('SELECT provisional, completeness, assessable_points FROM scoring_results WHERE company_id = ?').get('mig-test-co') as
      { provisional: number; completeness: number | null; assessable_points: number | null };
    expect(score.provisional).toBe(0);
    expect(score.completeness).toBeNull();
  });

  it('founder_candidates.discovered_run_id is nullable and does not block existing insert shapes', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO companies (id, name, normalized_name, domain, website, one_liner, vertical, subcategory, stage,
        city, state, founded_year, team_size, traction_level, traction_note, flags, status, created_at, updated_at)
      VALUES ('mig-test-co-2', 'Mig Test 2', 'mig test 2', NULL, NULL, 'x', 'health', 'x', 'Seed', 'x', 'TX', 2024, 1, 0, 'x', '[]', 'active', ?, ?)
    `).run(now, now);
    expect(() => db.prepare(`
      INSERT INTO founder_candidates (company_id, person_key, full_name, title, source_url, source_family, source_type,
        published_at, retrieved_at, supporting_text, match_signals, match_score, confidence, status, first_seen_at, last_checked_at)
      VALUES ('mig-test-co-2', 'jane-doe', 'Jane Doe', NULL, 'https://example.com', 'company-site', 'about-page', NULL, ?, 'x', '[]', 0.9, 0.9, 'verified-founder', ?, ?)
    `).run(now, now, now)).not.toThrow();
    const row = db.prepare("SELECT discovered_run_id FROM founder_candidates WHERE person_key = 'jane-doe'").get() as { discovered_run_id: string | null };
    expect(row.discovered_run_id).toBeNull();
  });

  it('migration 14 backfills last_reviewed_at ONLY from trustworthy human review_decisions — excludes the known scripted actor', () => {
    // Regression test for a real bug found while independently verifying
    // this migration against the dev database: ALL of that database's
    // historical 'refresh-research' review_decisions were attributed to
    // actor='phase11-refresh' — a single automated batch script from an
    // earlier development phase, not genuine per-company human review.
    // A naive "backfill from every review_decisions row" would have
    // repeated the exact automated-action-mistaken-for-review bug this
    // migration exists to fix. This runs migrations 1-13, seeds
    // review_decisions exactly like the real database had them, then
    // runs the ACTUAL migration 14 SQL (imported from source, not
    // duplicated here) to prove the shipped migration excludes it.
    const db = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS.filter((mig) => mig.version < 14)) {
      db.exec(m.sql);
    }
    const now = new Date().toISOString();
    for (const id of ['co-scripted', 'co-genuine', 'co-neither']) {
      db.prepare(`
        INSERT INTO companies (id, name, normalized_name, domain, website, one_liner, vertical, subcategory, stage,
          city, state, founded_year, team_size, traction_level, traction_note, flags, status, created_at, updated_at)
        VALUES (?, ?, ?, NULL, NULL, 'x', 'health', 'x', 'Seed', 'x', 'TX', 2024, 1, 0, 'x', '[]', 'active', ?, ?)
      `).run(id, id, id, now, now);
    }
    db.prepare(`INSERT INTO review_decisions (subject_type, subject_id, decision, actor, reason, at)
      VALUES ('company', 'co-scripted', 'refresh-research', 'phase11-refresh', '', ?)`).run(now);
    db.prepare(`INSERT INTO review_decisions (subject_type, subject_id, decision, actor, reason, at)
      VALUES ('company', 'co-genuine', 'Awaiting Review', 'team', '', ?)`).run(now);
    // co-neither has no review_decisions row at all.

    const v14 = MIGRATIONS.find((m) => m.version === 14)!;
    db.exec(v14.sql);

    const rows = db.prepare('SELECT id, last_reviewed_at FROM companies ORDER BY id').all() as { id: string; last_reviewed_at: string | null }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.last_reviewed_at]));
    expect(byId['co-scripted']).toBeNull(); // the scripted actor must not count as review
    expect(byId['co-genuine']).toBe(now); // a real status-change action does count
    expect(byId['co-neither']).toBeNull(); // no history at all stays null, never defaulted to migration time
  });

  it('hard-deleting a company cascade-deletes its founder_candidates rows — Founders Cumulative cannot recover them', () => {
    // Proves, rather than assumes, the caveat documented in
    // computeFounderKpis: founder_candidates.company_id REFERENCES
    // companies(id) ON DELETE CASCADE, and the real app runs with
    // PRAGMA foreign_keys = ON (server/db/client.ts) — this test enables
    // the same pragma explicitly, since a bare `new DatabaseSync` does
    // not turn it on by default.
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO companies (id, name, normalized_name, domain, website, one_liner, vertical, subcategory, stage,
        city, state, founded_year, team_size, traction_level, traction_note, flags, status, created_at, updated_at)
      VALUES ('cascade-co', 'Cascade Co', 'cascade co', NULL, NULL, 'x', 'health', 'x', 'Seed', 'x', 'TX', 2024, 1, 0, 'x', '[]', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO founder_candidates (company_id, person_key, full_name, title, source_url, source_family, source_type,
        published_at, retrieved_at, supporting_text, match_signals, match_score, confidence, status, first_seen_at, last_checked_at)
      VALUES ('cascade-co', 'cascade-founder', 'Cascade Founder', NULL, 'https://example.com', 'company-site', 'about-page', NULL, ?, 'x', '[]', 0.9, 0.9, 'verified-founder', ?, ?)
    `).run(now, now, now);

    expect((db.prepare('SELECT COUNT(*) as n FROM founder_candidates').get() as { n: number }).n).toBe(1);
    db.exec("DELETE FROM companies WHERE id = 'cascade-co'"); // the same statement clearCompanies() runs, scoped to one row here
    expect((db.prepare('SELECT COUNT(*) as n FROM founder_candidates').get() as { n: number }).n).toBe(0);
  });
});

/**
 * Migration 15 (five-approved-verticals) — the taxonomy consolidation:
 * Robotics + Space Tech → Frontier (mechanical), General AI retired with
 * a per-company reassignment (two evidence-based exceptions, everything
 * else defaults to Future of Work), audited in
 * vertical_reclassification_log before each row changes.
 */
describe('migration 15: five approved verticals', () => {
  function seedCompany(db: DatabaseSync, id: string, name: string, vertical: string) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO companies (id, name, normalized_name, domain, website, one_liner, vertical, subcategory, stage,
        city, state, founded_year, team_size, traction_level, traction_note, flags, status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, 'x', ?, 'x', 'Seed', 'x', 'TX', 2024, 1, 0, 'x', '[]', 'active', ?, ?)
    `).run(id, name, id, vertical, now, now);
  }

  function seedFounder(db: DatabaseSync, companyId: string, personKey: string) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO founder_candidates (company_id, person_key, full_name, title, source_url, source_family, source_type,
        published_at, retrieved_at, supporting_text, match_signals, match_score, confidence, status, first_seen_at, last_checked_at)
      VALUES (?, ?, ?, NULL, 'https://example.com', 'company-site', 'about-page', NULL, ?, 'x', '[]', 0.9, 0.9, 'verified-founder', ?, ?)
    `).run(companyId, personKey, personKey, now, now, now);
  }

  function seedVerticalClassification(db: DatabaseSync, companyId: string, primary: string, secondary: string | null) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO company_vertical_classification (company_id, primary_sector, secondary_sector, subvertical, reason,
        source_url, confidence, basis, evidence_gap, classified_at, version)
      VALUES (?, ?, ?, NULL, 'x', NULL, 0.5, 'inferred', NULL, ?, 'test')
    `).run(companyId, primary, secondary, now);
  }

  function freshDbThroughV14(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS.filter((mig) => mig.version < 15)) db.exec(m.sql);
    return db;
  }

  it('applies cleanly on a fresh database (no robotics/spacetech/ai/aoi rows exist yet)', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow(); // idempotent — already-applied versions are skipped
    const applied = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number };
    expect(applied.n).toBe(latestMigrationVersion());
    expect((db.prepare('SELECT COUNT(*) AS n FROM vertical_reclassification_log').get() as { n: number }).n).toBe(0);
  });

  it('converts robotics and spacetech companies.vertical to frontier, and logs the reason', () => {
    const db = freshDbThroughV14();
    seedCompany(db, 'co-robot', 'Robot Co', 'robotics');
    seedCompany(db, 'co-space', 'Space Co', 'spacetech');
    seedCompany(db, 'co-health', 'Health Co', 'health'); // untouched control

    const v15 = MIGRATIONS.find((m) => m.version === 15)!;
    db.exec(v15.sql);

    const rows = db.prepare('SELECT id, vertical FROM companies ORDER BY id').all() as { id: string; vertical: string }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.vertical]));
    expect(byId['co-robot']).toBe('frontier');
    expect(byId['co-space']).toBe('frontier');
    expect(byId['co-health']).toBe('health'); // never touched

    const log = db.prepare('SELECT company_id, previous_vertical, new_vertical FROM vertical_reclassification_log ORDER BY company_id').all() as
      { company_id: string; previous_vertical: string; new_vertical: string }[];
    expect(log).toEqual([
      { company_id: 'co-robot', previous_vertical: 'robotics', new_vertical: 'frontier' },
      { company_id: 'co-space', previous_vertical: 'spacetech', new_vertical: 'frontier' },
    ]);
  });

  it('also consolidates company_vertical_classification.primary_sector/secondary_sector for robotics/spacetech', () => {
    const db = freshDbThroughV14();
    seedCompany(db, 'co-robot', 'Robot Co', 'sustainability'); // companies.vertical already valid; classification disagrees
    seedVerticalClassification(db, 'co-robot', 'robotics', 'spacetech');

    const v15 = MIGRATIONS.find((m) => m.version === 15)!;
    db.exec(v15.sql);

    const row = db.prepare('SELECT primary_sector, secondary_sector FROM company_vertical_classification WHERE company_id = ?')
      .get('co-robot') as { primary_sector: string; secondary_sector: string };
    expect(row.primary_sector).toBe('frontier');
    expect(row.secondary_sector).toBe('frontier');
  });

  it('reassigns the two evidence-based AI exceptions by their real company_id, before the generic fallback runs', () => {
    const db = freshDbThroughV14();
    seedCompany(db, 'news-greyparrot', 'Greyparrot', 'ai');
    seedCompany(db, 'opp-mireye', 'Mireye', 'ai');
    seedCompany(db, 'opp-generic-ai', 'Generic Horizontal AI Co', 'ai');

    const v15 = MIGRATIONS.find((m) => m.version === 15)!;
    db.exec(v15.sql);

    const rows = db.prepare('SELECT id, vertical FROM companies ORDER BY id').all() as { id: string; vertical: string }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.vertical]));
    expect(byId['news-greyparrot']).toBe('sustainability'); // recycling — domain-specific
    expect(byId['opp-mireye']).toBe('frontier'); // geospatial/earth observation — domain-specific
    expect(byId['opp-generic-ai']).toBe('fow'); // horizontal AI — the documented default

    const log = db.prepare('SELECT company_id, new_vertical, reason FROM vertical_reclassification_log ORDER BY company_id').all() as
      { company_id: string; new_vertical: string; reason: string }[];
    const byLogId = Object.fromEntries(log.map((r) => [r.company_id, r]));
    expect(byLogId['news-greyparrot'].new_vertical).toBe('sustainability');
    expect(byLogId['news-greyparrot'].reason).toMatch(/recycling/i);
    expect(byLogId['opp-mireye'].new_vertical).toBe('frontier');
    expect(byLogId['opp-mireye'].reason).toMatch(/geospatial|earth.observation/i);
    expect(byLogId['opp-generic-ai'].new_vertical).toBe('fow');
    expect(byLogId['opp-generic-ai'].reason).toMatch(/horizontal/i);
    // Each of the three logged exactly once — the per-id exceptions did
    // not ALSO get caught and re-logged by the generic fallback.
    expect(log).toHaveLength(3);
  });

  it('never assigns a retained company/founder the legacy ai/robotics/spacetech vertical after migration', () => {
    const db = freshDbThroughV14();
    seedCompany(db, 'co-a', 'Co A', 'ai');
    seedCompany(db, 'co-b', 'Co B', 'robotics');
    seedCompany(db, 'co-c', 'Co C', 'spacetech');
    seedFounder(db, 'co-a', 'founder-a');
    seedFounder(db, 'co-b', 'founder-b');

    const v15 = MIGRATIONS.find((m) => m.version === 15)!;
    db.exec(v15.sql);

    const verticals = (db.prepare('SELECT vertical FROM companies').all() as { vertical: string }[]).map((r) => r.vertical);
    for (const v of verticals) expect(['ai', 'robotics', 'spacetech']).not.toContain(v);

    // No company or founder was lost.
    expect((db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS n FROM founder_candidates').get() as { n: number }).n).toBe(2);
  });

  it('is safe to run twice in the same transaction shape (no duplicate log rows on a repeat UPDATE pass)', () => {
    // Not a claim that the migration framework re-runs an applied
    // version (it never does — see the "idempotent" test above); this
    // proves the SQL itself does not double-count if it were ever
    // re-executed against already-migrated rows, since the WHERE clauses
    // key off the OLD vertical values which no longer match post-migration.
    const db = freshDbThroughV14();
    seedCompany(db, 'co-robot', 'Robot Co', 'robotics');
    const v15 = MIGRATIONS.find((m) => m.version === 15)!;
    db.exec(v15.sql);
    expect(() => db.exec(v15.sql)).not.toThrow();
    const log = db.prepare('SELECT COUNT(*) AS n FROM vertical_reclassification_log').get() as { n: number };
    expect(log.n).toBe(1); // still just the one real change, not two
  });
});
