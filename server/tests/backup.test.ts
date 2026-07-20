import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isValidSqliteFile } from '../services/backup';

/**
 * Backup/restore needs a REAL file-backed SQLite database (VACUUM
 * INTO, directory scans) — vitest's default test env runs against
 * ':memory:', so these tests spawn real child processes against a
 * real db file, matching the established pattern in
 * server/tests/persistence.test.ts.
 */

function runScript(dir: string, dbPath: string, body: string): string {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const file = path.join(dir, `step-${Math.random().toString(36).slice(2)}.mts`);
  fs.writeFileSync(file, body);
  return execFileSync('npx', ['tsx', file], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_FILE: dbPath, DATA_FILE: dbPath.replace('.db', '-kv.db'), NODE_ENV: 'backup-test' },
    encoding: 'utf8',
  });
}

describe('SQLite backup/restore', () => {
  it('rejects a non-SQLite file without opening it as one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-backup-invalid-'));
    const garbage = path.join(dir, 'not-a-database.db');
    fs.writeFileSync(garbage, 'this is definitely not a sqlite file');
    expect(isValidSqliteFile(garbage)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a backup containing existing company records, lists it, and restore produces the same records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-backup-'));
    const projectRoot = path.resolve(__dirname, '..', '..');
    const dbPath = path.join(dir, 'active.db');

    // 1) Seed a company in the "active" database.
    runScript(dir, dbPath, `
      const { saveCompany } = await import('${projectRoot}/server/db/repos/companies');
      saveCompany({
        id: 'backup-fixture-co', name: 'Backup Fixture Co', oneLiner: 'Fixture pitch text', vertical: 'health',
        subcategory: 'Care', stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2024, teamSize: 3,
        traction: { level: 5, note: 'Fixture traction note' },
        founders: [{ name: 'Founder One', role: 'CEO', background: 'Fixture background' }],
        evidence: [{ claim: 'Fixture claim', source: 'Fixture', url: 'https://example.com/backup-fixture', date: '2026-01-01', type: 'News' }],
        flags: [], imported: true,
      }, { origin: 'user-entered', source: 'test' });
      console.log('SEEDED');
    `);

    // 2) Create a backup — must contain the seeded company.
    const backupOut = runScript(dir, dbPath, `
      const { createBackup } = await import('${projectRoot}/server/services/backup');
      const result = await createBackup('test-suite');
      console.log(JSON.stringify(result));
    `);
    const backupResult = JSON.parse(backupOut.trim().split('\n').pop()!);
    expect(backupResult.ok).toBe(true);
    expect(backupResult.backup.companyCount).toBe(1);
    expect(backupResult.backup.file).toMatch(/^deal-radar-.*\.db$/);

    // The backup file is a real, independently-readable SQLite database.
    const backupFilePath = path.join(dir, 'backups', backupResult.backup.file);
    expect(fs.existsSync(backupFilePath)).toBe(true);
    expect(isValidSqliteFile(backupFilePath)).toBe(true);

    // 3) It shows up in listBackups().
    const listOut = runScript(dir, dbPath, `
      const { listBackups } = await import('${projectRoot}/server/services/backup');
      console.log(JSON.stringify(listBackups()));
    `);
    const list = JSON.parse(listOut.trim().split('\n').pop()!);
    expect(list).toHaveLength(1);
    expect(list[0].file).toBe(backupResult.backup.file);

    // 4) Mutate the active database (simulating drift since the backup)...
    runScript(dir, dbPath, `
      const { clearCompanies } = await import('${projectRoot}/server/db/repos/companies');
      clearCompanies();
      console.log('CLEARED');
    `);
    const afterClear = runScript(dir, dbPath, `
      const { listCompanies } = await import('${projectRoot}/server/db/repos/companies');
      console.log(JSON.stringify(listCompanies().length));
    `);
    expect(Number(afterClear.trim().split('\n').pop())).toBe(0);

    // 5) ...then restore, and the original company is back.
    const restoreOut = runScript(dir, dbPath, `
      const { restoreBackup } = await import('${projectRoot}/server/services/backup');
      const result = await restoreBackup('${backupResult.backup.file}', 'test-suite');
      console.log(JSON.stringify(result));
    `);
    const restoreResult = JSON.parse(restoreOut.trim().split('\n').pop()!);
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.safetyBackup).toBeTruthy(); // existing (cleared) data was protected by a safety backup first

    const afterRestore = runScript(dir, dbPath, `
      const { listCompanies } = await import('${projectRoot}/server/db/repos/companies');
      const companies = listCompanies();
      console.log(JSON.stringify({ count: companies.length, name: companies[0]?.name }));
    `);
    const finalState = JSON.parse(afterRestore.trim().split('\n').pop()!);
    expect(finalState.count).toBe(1);
    expect(finalState.name).toBe('Backup Fixture Co');

    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('rejects a second backup while one is already in progress (overlap lock)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-backup-lock-'));
    const projectRoot = path.resolve(__dirname, '..', '..');
    const dbPath = path.join(dir, 'active.db');

    // Seed so the backups directory exists, then plant a fresh lock file directly.
    runScript(dir, dbPath, `
      const { getDb } = await import('${projectRoot}/server/db/client');
      getDb(); // ensure the db file (and thus its directory) exists
      console.log('READY');
    `);
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backups', '.lock'), JSON.stringify({ startedAt: new Date().toISOString(), pid: 999999 }));

    const out = runScript(dir, dbPath, `
      const { createBackup } = await import('${projectRoot}/server/services/backup');
      const result = await createBackup('test-suite');
      console.log(JSON.stringify(result));
    `);
    const result = JSON.parse(out.trim().split('\n').pop()!);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already in progress/i);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('refuses to restore a file that is not a valid SQLite database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-backup-badrestore-'));
    const projectRoot = path.resolve(__dirname, '..', '..');
    const dbPath = path.join(dir, 'active.db');

    runScript(dir, dbPath, `
      const { getDb } = await import('${projectRoot}/server/db/client');
      getDb();
      console.log('READY');
    `);
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    const fakeName = 'deal-radar-2026-01-01T00-00-00-000Z.db';
    fs.writeFileSync(path.join(dir, 'backups', fakeName), 'not a real sqlite file');

    const out = runScript(dir, dbPath, `
      const { restoreBackup } = await import('${projectRoot}/server/services/backup');
      const result = await restoreBackup('${fakeName}', 'test-suite');
      console.log(JSON.stringify(result));
    `);
    const result = JSON.parse(out.trim().split('\n').pop()!);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid sqlite/i);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
