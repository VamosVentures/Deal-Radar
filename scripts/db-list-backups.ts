#!/usr/bin/env -S npx tsx
/** npm run db:list-backups — list all backups with metadata, newest first. */
import { listBackups, getBackupSettings } from '../server/services/backup';

const backups = listBackups();
const settings = getBackupSettings();

if (backups.length === 0) {
  console.log('No backups on record yet. Run `npm run db:backup` to create one.');
} else {
  console.log(`${backups.length} backup(s) — retention: max ${settings.maxBackups} files / ${settings.maxBackupAgeDays} days\n`);
  for (const b of backups) {
    console.log(`${b.file}`);
    console.log(`  Created:  ${b.createdAt}`);
    console.log(`  Size:     ${(b.sizeBytes / 1024).toFixed(1)} KB`);
    console.log(`  Schema:   v${b.schemaVersion}`);
    console.log(`  Companies: ${b.companyCount}`);
    console.log(`  Triggered by: ${b.triggeredBy}`);
    console.log('');
  }
}
