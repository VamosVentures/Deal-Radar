#!/usr/bin/env -S npx tsx
/**
 * npm run db:restore -- <backup-file> [--yes]
 *
 * Restores a backup created by `npm run db:backup` as the active
 * database. REQUIRES THE BACKEND TO BE STOPPED FIRST — this script
 * makes a best-effort check (a request to /health/live) but cannot
 * guarantee the backend isn't running on a different host/port, so
 * --yes is a deliberate confirmation, not a substitute for actually
 * stopping the server.
 *
 * The restore algorithm itself (safety backup → replace → integrity
 * check → auto-rollback on failure) lives in
 * server/services/backup.ts#restoreBackup so it's directly testable;
 * this script only adds the human confirmation gate.
 */
import { env } from '../server/env';
import { restoreBackup } from '../server/services/backup';

async function backendLooksRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://localhost:${env.PORT}/health/live`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const file = args.find((a) => !a.startsWith('--'));

  if (!file) {
    console.error('Usage: npm run db:restore -- <backup-file> [--yes]');
    console.error('       npm run db:list-backups   (to see available files)');
    process.exit(1);
  }

  if (await backendLooksRunning()) {
    console.error(`The backend appears to be running on port ${env.PORT} (a real /health/live response was received).`);
    console.error('STOP THE BACKEND before restoring — an in-place file swap under a live process can corrupt the active connection.');
    if (!yes) {
      console.error('Re-run with --yes only after confirming the backend is actually stopped.');
      process.exit(1);
    }
    console.error('Continuing anyway because --yes was passed. This is not recommended.');
  }

  if (!yes) {
    console.error(`About to REPLACE the active database with "${file}".`);
    console.error('A safety backup of the current database will be taken first, and can be used to roll back manually:');
    console.error('  npm run db:restore -- <safety-backup-file> --yes');
    console.error('Re-run this command with --yes to proceed.');
    process.exit(1);
  }

  console.log('Taking a safety backup of the current database before replacing it...');
  const result = await restoreBackup(file, `cli:${process.env.USER ?? 'unknown'}`);

  if (!result.ok) {
    console.error(`Restore failed: ${result.error}`);
    if (result.rolledBack) console.error(`Automatically rolled back to ${result.safetyBackup} — the active database is unchanged from before this command ran.`);
    process.exit(1);
    return;
  }

  console.log(`Safety backup created: ${result.safetyBackup}`);
  console.log('Integrity check: OK.');
  console.log(`Restore complete. Active database is now "${result.restoredFrom}".`);
  console.log(`If anything looks wrong, roll back with: npm run db:restore -- ${result.safetyBackup} --yes`);
}

main().catch((e) => {
  console.error(`Restore failed: ${(e as Error).message}`);
  process.exit(1);
});
