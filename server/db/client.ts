import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env';
import { runMigrations } from './migrations';

/**
 * Primary datastore: SQLite via the Node built-in driver (no native
 * dependencies). Replaces the old best-effort JSON file — writes are
 * transactional and survive restarts. Tests run against ':memory:'.
 *
 * `DATABASE_FILE` picks the location (defaults to
 * server/.data/deal-radar.db, which is gitignored). The legacy
 * `DATA_FILE=':memory:'` test convention is honored for compatibility.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveDbPath(): string {
  const configured = env.DATABASE_FILE ?? env.DATA_FILE;
  if (configured === ':memory:') return ':memory:';
  if (configured) return configured;
  const dir = path.join(here, '..', '.data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'deal-radar.db');
}

/** The active database file path (or ':memory:' in tests) — used by backup/restore tooling and health checks. */
export function getDbPath(): string {
  return resolveDbPath();
}

/** Open (and migrate) a database at an explicit path — used by tests to simulate restarts. */
export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

let singleton: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!singleton) singleton = openDatabase(resolveDbPath());
  return singleton;
}

/** Close the singleton connection cleanly — used by graceful shutdown. */
export function closeDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

/** Wipe every table (tests only). */
export function resetDbForTests(): void {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'migrations'")
    .all() as { name: string }[];
  db.exec('BEGIN');
  try {
    for (const t of tables) db.exec(`DELETE FROM "${t.name}"`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
