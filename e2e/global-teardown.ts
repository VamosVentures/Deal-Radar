import fs from 'node:fs';
import { E2E_DATA_DIR } from './env';

/**
 * Best-effort cleanup only. Playwright's own lifecycle runs globalTeardown
 * BEFORE stopping the webServer processes, so on Windows the backend can
 * still be alive and holding the SQLite file open at this exact moment —
 * no amount of retrying here can reliably win that race, because the
 * process that needs to exit first hasn't necessarily been asked to yet.
 * The authoritative cleanup instead runs at the START of the next
 * invocation (e2e/reset-data-dir.ts, wired into the backend's own
 * webServer command in playwright.config.ts), by which point this run's
 * process is guaranteed to be long gone. A failure here is expected and
 * must never fail the whole suite over a cosmetic race — it just means
 * the next run's reset-data-dir.ts step has real cleanup work to do.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Expected on Windows; see the note above.
  }
}
