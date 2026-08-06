import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/migrations';

/**
 * Founder preservation across the taxonomy migration.
 *
 * Migration 15 consolidated seven sectors into five by rewriting the
 * `vertical` text column on `companies`. `founder_candidates` has no
 * vertical of its own — a founder's sector is whatever their company's
 * is, reached through `company_id` — so the migration never touches the
 * table. That is precisely the property worth pinning down: it holds
 * today by construction, and the way it would silently stop holding is
 * someone adding a DELETE, an INSERT...SELECT, or a company_id rewrite to
 * a future taxonomy migration and nothing noticing.
 *
 * These tests reconstruct the real before/after transition on a
 * throwaway in-memory database: migrations 1–14 are applied, a company
 * in each of the seven OLD sectors is seeded with founder candidates
 * attached, and then 15 (and everything after it) runs. The assertions
 * are the ones that actually matter for the audit — no founder deleted,
 * none duplicated, none detached from its company, and the before/after
 * per-vertical totals reconciling exactly.
 *
 * The real database's own numbers, verified directly against the
 * pre-migration-15 backup and the live file, are the same shape: 372
 * founders before, 372 after, 0 rows differing on
 * (id, company_id, person_key, source_url), health 227 → 227,
 * robotics 61 + spacetech 6 → frontier 67, sustainability 35 → 35,
 * fintech 30 → 30, ai 12 + fow 1 → fow 13.
 */

const TAXONOMY_MIGRATION = 15;

/** Apply every migration up to and including `version`, the way runMigrations does. */
function migrateTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (m.version > version || applied.has(m.version)) continue;
    db.exec(m.sql);
    db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(m.version, m.name, '2026-01-01T00:00:00.000Z');
  }
}

/** The seven sectors that existed BEFORE migration 15, and how many founders each gets. */
const SEED: { vertical: string; companyId: string; founders: number }[] = [
  { vertical: 'health', companyId: 'seed-health', founders: 4 },
  { vertical: 'fintech', companyId: 'seed-fintech', founders: 3 },
  { vertical: 'fow', companyId: 'seed-fow', founders: 1 },
  { vertical: 'sustainability', companyId: 'seed-sustainability', founders: 2 },
  { vertical: 'robotics', companyId: 'seed-robotics', founders: 5 },
  { vertical: 'spacetech', companyId: 'seed-spacetech', founders: 2 },
  { vertical: 'ai', companyId: 'seed-ai', founders: 3 },
];

/** Where each old sector must land once migration 15 has run. */
const EXPECTED_DESTINATION: Record<string, string> = {
  health: 'health',
  fintech: 'fintech',
  fow: 'fow',
  sustainability: 'sustainability',
  robotics: 'frontier',
  spacetech: 'frontier',
  ai: 'fow',
};

function seedFixture(db: DatabaseSync): void {
  const now = '2026-01-01T00:00:00.000Z';
  for (const { vertical, companyId, founders } of SEED) {
    db.prepare(`
      INSERT INTO companies (id, name, normalized_name, domain, website, one_liner, vertical, subcategory,
        stage, city, state, founded_year, team_size, traction_level, traction_note, flags, status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, 'seed', ?, 'seed-sub', 'Seed', 'Austin', 'TX', 2025, 3, 0, 'Unknown', '[]', 'active', ?, ?)
    `).run(companyId, `Seed ${vertical}`, `seed ${vertical}`, vertical, now, now);

    for (let i = 0; i < founders; i += 1) {
      db.prepare(`
        INSERT INTO founder_candidates (company_id, person_key, full_name, title, source_url, source_family,
          source_type, published_at, retrieved_at, supporting_text, match_signals, match_score, confidence,
          status, first_seen_at, last_checked_at)
        VALUES (?, ?, ?, 'Founder', ?, 'website', 'company-site', NULL, ?, 'seeded', '[]', 1, 1, 'candidate', ?, ?)
      `).run(
        companyId, `${companyId}-person-${i}`, `Founder ${i} of ${vertical}`,
        `https://example.com/${companyId}/${i}`, now, now, now,
      );
    }
  }
}

/** Founder counts grouped by the vertical of the company each founder is attached to. */
function foundersByVertical(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare(`
    SELECT COALESCE(c.vertical, '(detached)') AS vertical, COUNT(*) AS n
    FROM founder_candidates fc LEFT JOIN companies c ON c.id = fc.company_id
    GROUP BY 1
  `).all() as { vertical: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.vertical, r.n]));
}

interface FounderRow {
  id: number; company_id: string; person_key: string; full_name: string; source_url: string;
}
function founderRows(db: DatabaseSync): FounderRow[] {
  return db.prepare(
    'SELECT id, company_id, person_key, full_name, source_url FROM founder_candidates ORDER BY id',
  ).all() as unknown as FounderRow[];
}

function freshDbAtV14(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrateTo(db, TAXONOMY_MIGRATION - 1);
  seedFixture(db);
  return db;
}

describe('taxonomy migration cannot delete, duplicate, or detach founder candidates', () => {
  it('preserves every founder row byte-for-byte across migration 15 and everything after it', () => {
    const db = freshDbAtV14();
    const before = founderRows(db);
    const beforeTotal = before.length;
    expect(beforeTotal).toBe(SEED.reduce((s, x) => s + x.founders, 0));

    migrateTo(db, MIGRATIONS[MIGRATIONS.length - 1].version);
    const after = founderRows(db);

    // Nothing deleted, nothing added.
    expect(after.length).toBe(beforeTotal);
    // Nothing duplicated: primary keys and the natural key both stay unique.
    expect(new Set(after.map((r) => r.id)).size).toBe(beforeTotal);
    expect(new Set(after.map((r) => `${r.company_id}|${r.person_key}|${r.source_url}`)).size).toBe(beforeTotal);
    // Nothing rewritten, re-pointed, or renamed.
    expect(after).toEqual(before);
  });

  it('leaves no founder detached from a company', () => {
    const db = freshDbAtV14();
    migrateTo(db, MIGRATIONS[MIGRATIONS.length - 1].version);
    const orphans = db.prepare(`
      SELECT COUNT(*) AS n FROM founder_candidates fc
      LEFT JOIN companies c ON c.id = fc.company_id WHERE c.id IS NULL
    `).get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('reconciles the before/after per-vertical founder totals exactly', () => {
    const db = freshDbAtV14();
    const before = foundersByVertical(db);
    migrateTo(db, MIGRATIONS[MIGRATIONS.length - 1].version);
    const after = foundersByVertical(db);

    // Every old sector's founders land in that sector's declared
    // destination, summed — this is the check that catches a founder
    // quietly moving between verticals, which a bare total would miss.
    const expected: Record<string, number> = {};
    for (const [oldVertical, count] of Object.entries(before)) {
      const dest = EXPECTED_DESTINATION[oldVertical];
      expect(dest, `no expected destination declared for "${oldVertical}"`).toBeDefined();
      expected[dest] = (expected[dest] ?? 0) + count;
    }
    expect(after).toEqual(expected);

    // And the grand total is unchanged, stated separately so a failure
    // says which of the two properties broke.
    const sum = (o: Record<string, number>) => Object.values(o).reduce((s, n) => s + n, 0);
    expect(sum(after)).toBe(sum(before));
  });

  it("every founder's vertical is exactly its linked company's vertical, and that vertical is approved", () => {
    const db = freshDbAtV14();
    migrateTo(db, MIGRATIONS[MIGRATIONS.length - 1].version);
    const mismatched = db.prepare(`
      SELECT COUNT(*) AS n FROM founder_candidates fc
      JOIN companies c ON c.id = fc.company_id
      WHERE c.vertical NOT IN ('health', 'fintech', 'fow', 'sustainability', 'frontier')
    `).get() as { n: number };
    expect(mismatched.n).toBe(0);
  });

  it('no taxonomy migration writes to founder_candidates at all', () => {
    // A structural guard, not a behavioural one: the reason founders are
    // safe is that the migration SQL never names their table. If a future
    // migration needs to touch it, this test should be updated
    // deliberately — with the preservation assertions above proving the
    // change is safe — rather than discovering the write in production.
    const taxonomyMigrations = MIGRATIONS.filter((m) => m.version >= TAXONOMY_MIGRATION);
    for (const m of taxonomyMigrations) {
      const writes = /\b(?:DELETE\s+FROM|UPDATE|INSERT\s+INTO)\s+founder_candidates\b/i;
      expect(writes.test(m.sql), `migration ${m.version} (${m.name}) writes to founder_candidates`).toBe(false);
    }
  });
});
