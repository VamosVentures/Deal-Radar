#!/usr/bin/env -S npx tsx
/** npm run db:integrity — PRAGMA integrity_check against the active database. */
import { getDbPath } from '../server/db/client';
import { checkIntegrity } from '../server/services/backup';

const dbPath = getDbPath();
if (dbPath === ':memory:') {
  console.log('Active database is in-memory (test mode) — nothing to check.');
  process.exit(0);
}

const result = checkIntegrity(dbPath);
console.log(`Database: ${dbPath}`);
console.log(`Integrity: ${result.ok ? 'OK' : 'FAILED'}`);
if (!result.ok) {
  console.error(result.detail);
  process.exit(1);
}
