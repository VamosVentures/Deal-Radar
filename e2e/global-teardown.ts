import fs from 'node:fs';
import { E2E_DATA_DIR } from './env';

/** Removes the isolated E2E database (and WAL/SHM sidecars) — never the developer's real database. */
export default async function globalTeardown(): Promise<void> {
  fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true });
}
