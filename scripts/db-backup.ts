#!/usr/bin/env -S npx tsx
/**
 * npm run db:backup — create a timestamped, consistent SQLite backup
 * of the active database using VACUUM INTO. Safe to run while the
 * server is up (VACUUM INTO does not require an exclusive lock for
 * longer than the copy itself). See server/services/backup.ts.
 */
import { createBackup } from '../server/services/backup';

async function main() {
  const result = await createBackup(`cli:${process.env.USER ?? 'unknown'}`);
  if (!result.ok) {
    console.error(`Backup failed: ${result.error}`);
    process.exit(1);
  }
  const b = result.backup;
  console.log(`Backup created: ${b.file}`);
  console.log(`  Created at:     ${b.createdAt}`);
  console.log(`  Size:           ${(b.sizeBytes / 1024).toFixed(1)} KB`);
  console.log(`  Schema version: v${b.schemaVersion}`);
  console.log(`  Companies:      ${b.companyCount}`);
}

main().catch((e) => {
  console.error(`Backup failed: ${(e as Error).message}`);
  process.exit(1);
});
