import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { closeDb, getDb, getDbPath, openDatabase } from '../db/client';
import { getConfig, setConfig } from '../db/repos/operations';
import { audit } from '../lib/guard';

/**
 * SQLite backup/restore tooling (Phase 10). Backups use `VACUUM INTO`,
 * which produces a single, consistent, fully-checkpointed snapshot
 * file (WAL-pending writes included) without stopping the server or
 * taking a write lock for longer than the vacuum itself. Files live in
 * a `backups/` directory next to the active database, never inside
 * it, with a JSON metadata sidecar per file (counts and timestamps
 * only — never row data, so there's nothing to redact).
 */

export const backupSettingsSchema = z.object({
  /** Keep at most this many backups (oldest pruned first). Conservative default. */
  maxBackups: z.number().int().min(1).max(500).default(14),
  /** Prune any backup older than this many days, regardless of count. */
  maxBackupAgeDays: z.number().int().min(1).max(3650).default(30),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
const BACKUP_SETTINGS_KEY = 'backup-settings';
export function getBackupSettings(): BackupSettings {
  return getConfig(BACKUP_SETTINGS_KEY, backupSettingsSchema, backupSettingsSchema.parse({}));
}
export function setBackupSettings(patch: Partial<BackupSettings>): BackupSettings {
  const merged = backupSettingsSchema.parse({ ...getBackupSettings(), ...patch });
  setConfig(BACKUP_SETTINGS_KEY, merged);
  return merged;
}

export interface BackupMetadata {
  file: string;
  createdAt: string;
  sizeBytes: number;
  schemaVersion: number;
  companyCount: number;
  triggeredBy: string;
}
export type BackupResult = { ok: true; backup: BackupMetadata } | { ok: false; error: string };

function backupsDir(): string {
  const dbPath = getDbPath();
  if (dbPath === ':memory:') throw Object.assign(new Error('Cannot back up an in-memory database (test mode).'), { status: 400 });
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const LOCK_STALE_MS = 10 * 60_000;

function acquireBackupLock(dir: string): void {
  const lockPath = path.join(dir, '.lock');
  if (fs.existsSync(lockPath)) {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < LOCK_STALE_MS) {
      throw Object.assign(new Error('A backup is already in progress. Wait for it to finish, or try again in a few minutes.'), { status: 409 });
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));
}
function releaseBackupLock(dir: string): void {
  const lockPath = path.join(dir, '.lock');
  fs.rmSync(lockPath, { force: true });
}

/** Timestamped, filesystem-safe backup filename. */
function backupFilename(now: Date): string {
  return `deal-radar-${now.toISOString().replace(/[:.]/g, '-')}.db`;
}

export async function createBackup(triggeredBy: string): Promise<BackupResult> {
  const dir = backupsDir();
  try {
    acquireBackupLock(dir);
  } catch (e) {
    // Lock held by another run — a graceful result, not a crash, and
    // NOT released in a finally below since we never acquired it.
    return { ok: false, error: (e as Error).message };
  }
  try {
    const now = new Date();
    const filename = backupFilename(now);
    const target = path.join(dir, filename);
    const db = getDb();

    db.prepare('VACUUM INTO ?').run(target);

    const companyCount = (db.prepare("SELECT COUNT(*) AS n FROM companies WHERE status = 'active'").get() as { n: number }).n;
    const schemaVersion = (db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null }).v ?? 0;
    const sizeBytes = fs.statSync(target).size;

    const metadata: BackupMetadata = { file: filename, createdAt: now.toISOString(), sizeBytes, schemaVersion, companyCount, triggeredBy };
    fs.writeFileSync(path.join(dir, `${filename}.meta.json`), JSON.stringify(metadata, null, 2));

    audit({ provider: 'system', mode: 'local', action: 'db-backup', subject: filename, outcome: 'ok', detail: `Backup created by ${triggeredBy}: ${companyCount} companies, ${sizeBytes} bytes, schema v${schemaVersion}.` });
    pruneOldBackups(dir);
    return { ok: true, backup: metadata };
  } catch (e) {
    audit({ provider: 'system', mode: 'local', action: 'db-backup', subject: 'backup', outcome: 'error', detail: `Backup failed: ${(e as Error).message}` });
    return { ok: false, error: (e as Error).message };
  } finally {
    releaseBackupLock(dir);
  }
}

export function listBackups(): BackupMetadata[] {
  const dir = backupsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  const rows: BackupMetadata[] = [];
  for (const f of files) {
    try {
      rows.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as BackupMetadata);
    } catch {
      // A corrupt/missing sidecar is skipped, not fatal to listing the rest.
    }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getBackupMetadata(file: string): BackupMetadata | null {
  return listBackups().find((b) => b.file === file) ?? null;
}

/** Absolute path to a backup file — for a server operator to retrieve via the filesystem, never streamed over HTTP. */
export function getBackupPath(file: string): string {
  if (!/^deal-radar-[0-9T:.Z-]+\.db$/.test(file)) throw Object.assign(new Error('Invalid backup filename.'), { status: 400 });
  const full = path.join(backupsDir(), file);
  if (!fs.existsSync(full)) throw Object.assign(new Error('Backup not found.'), { status: 404 });
  return full;
}

function pruneOldBackups(dir: string): void {
  const settings = getBackupSettings();
  const all = listBackups();
  const now = Date.now();
  const tooOld = all.filter((b) => (now - new Date(b.createdAt).getTime()) / 86_400_000 > settings.maxBackupAgeDays);
  const overCount = all.length > settings.maxBackups ? all.slice(settings.maxBackups) : [];
  const toRemove = new Set([...tooOld, ...overCount].map((b) => b.file));
  for (const file of toRemove) {
    fs.rmSync(path.join(dir, file), { force: true });
    fs.rmSync(path.join(dir, `${file}.meta.json`), { force: true });
  }
  if (toRemove.size > 0) {
    audit({ provider: 'system', mode: 'local', action: 'db-backup-retention', subject: `${toRemove.size} file(s)`, outcome: 'ok', detail: `Pruned ${toRemove.size} backup(s) beyond retention (max ${settings.maxBackups} backups / ${settings.maxBackupAgeDays} days).` });
  }
}

/** The first 16 bytes of every valid SQLite file — used to reject a non-database file before ever opening it as one. */
const SQLITE_MAGIC = 'SQLite format 3\0';

export function isValidSqliteFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    return buf.toString('utf8') === SQLITE_MAGIC;
  } finally {
    fs.closeSync(fd);
  }
}

export type RestoreResult =
  | { ok: true; restoredFrom: string; safetyBackup: string }
  | { ok: false; error: string; safetyBackup?: string; rolledBack?: boolean };

/**
 * The restore algorithm itself (extracted from the CLI script so it's
 * directly testable): validate the requested backup, take a safety
 * backup of whatever is currently active, replace the active file,
 * clear stale WAL/SHM sidecars, run an integrity check, and roll back
 * automatically if that check fails. The CLI (scripts/db-restore.ts)
 * only adds the human-facing confirmation gate and the best-effort
 * "is the backend still running" check — both irrelevant to a test
 * calling this directly against an isolated file.
 */
export async function restoreBackup(file: string, triggeredBy: string): Promise<RestoreResult> {
  const dbPath = getDbPath();
  if (dbPath === ':memory:') return { ok: false, error: 'Cannot restore into an in-memory database (test mode).' };

  let backupPath: string;
  try {
    backupPath = getBackupPath(file);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!isValidSqliteFile(backupPath)) {
    return { ok: false, error: `"${file}" does not look like a valid SQLite database file (header magic mismatch). Refusing to restore it.` };
  }

  const safety = await createBackup(`${triggeredBy}:pre-restore-safety`);
  if (!safety.ok) return { ok: false, error: `Could not create a safety backup — aborting rather than proceeding without one: ${safety.error}` };

  // The safety backup just opened the active db via the module
  // singleton — close it before swapping the file out from under that
  // handle, or the fresh connection integrity-check opens next can
  // find the file "locked" by our own still-open, now-stale handle.
  closeDb();

  fs.copyFileSync(backupPath, dbPath);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

  const integrity = checkIntegrity(dbPath);
  if (!integrity.ok) {
    const safetyPath = path.join(backupsDir(), safety.backup.file);
    fs.copyFileSync(safetyPath, dbPath);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    audit({ provider: 'system', mode: 'local', action: 'db-restore', subject: file, outcome: 'error', detail: `Restore failed integrity check (${integrity.detail}); rolled back to safety backup ${safety.backup.file}.` });
    return { ok: false, error: `Integrity check failed after restore: ${integrity.detail}`, safetyBackup: safety.backup.file, rolledBack: true };
  }

  audit({ provider: 'system', mode: 'local', action: 'db-restore', subject: file, outcome: 'ok', detail: `Restored by ${triggeredBy}; safety backup ${safety.backup.file} available for manual rollback.` });
  return { ok: true, restoredFrom: file, safetyBackup: safety.backup.file };
}

/**
 * PRAGMA integrity_check against an arbitrary db file path (used by
 * both the CLI restore flow and the db:integrity script). Note:
 * openDatabase() always self-migrates, so checking a backup file this
 * way also brings it up to the current schema — the intended
 * behavior when this runs as part of a restore, and a no-op when
 * checking the already-current active database.
 */
export function checkIntegrity(dbPath: string): { ok: boolean; detail: string } {
  if (!isValidSqliteFile(dbPath)) return { ok: false, detail: 'Not a valid SQLite database file (header magic mismatch).' };
  try {
    const db = openDatabase(dbPath);
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    db.close();
    const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
    return { ok, detail: ok ? 'ok' : rows.map((r) => r.integrity_check).join('; ') };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
