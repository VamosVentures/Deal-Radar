import fs from 'node:fs';
import { E2E_DATA_DIR } from './env';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wipes the isolated E2E data directory before the backend boots, so every
 * run starts from a genuinely empty database. Wired into the backend's own
 * webServer command (see playwright.config.ts) so it runs as a brand-new
 * process, chronologically well after the previous run's backend has fully
 * exited.
 *
 * That is the only point at which Windows is guaranteed to have released
 * its lock on the previous run's SQLite file. Playwright's own lifecycle
 * runs globalTeardown BEFORE stopping webServer, so attempting this
 * cleanup from globalTeardown races a backend that, at that moment, is
 * still alive and holding the file open — global-teardown.ts's own attempt
 * is therefore best-effort only, and this script is the one that actually
 * has to succeed.
 */
async function main(): Promise<void> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt === maxAttempts || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      await sleep(300);
    }
  }
  // DATABASE_FILE is set explicitly for the E2E run, so the backend's own
  // resolveDbPath() won't create this directory itself (it only does that
  // for the default, unconfigured path) — recreate it here so the backend
  // always finds it present, whether this is the very first run or a
  // cleanup of a previous one.
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
}

main();
