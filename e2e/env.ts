import path from 'node:path';
import os from 'node:os';

/**
 * Shared constants for the isolated E2E environment — imported by
 * playwright.config.ts, global-setup, and global-teardown so they
 * always agree on the same ports/paths/credentials. Different ports
 * than the normal dev server (8787/5173) so an E2E run can never
 * collide with (or accidentally reuse) a developer's real dev server
 * or real database.
 */
export const E2E_BACKEND_PORT = 8788;
export const E2E_FRONTEND_PORT = 5183;
export const E2E_ADMIN_PASSWORD = 'e2e-test-admin-password';
export const E2E_SESSION_SECRET = 'e2e-test-session-secret-at-least-32-chars-long';

const dataDir = path.join(os.tmpdir(), 'vamos-deal-radar-e2e');
export const E2E_DB_PATH = path.join(dataDir, 'e2e.db');
export const E2E_KV_PATH = path.join(dataDir, 'e2e-kv.db');
export const E2E_DATA_DIR = dataDir;

export const E2E_BACKEND_ENV = {
  PORT: String(E2E_BACKEND_PORT),
  FRONTEND_URL: `http://localhost:${E2E_FRONTEND_PORT}`,
  DATABASE_FILE: E2E_DB_PATH,
  DATA_FILE: E2E_KV_PATH,
  ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
  SESSION_SECRET: E2E_SESSION_SECRET,
  RUN_SCHEDULER: 'false',
  NODE_ENV: 'test',
};

/** Where global-setup writes the signed-in session for all specs to reuse. */
export const E2E_STORAGE_STATE = path.join(dataDir, 'storage-state.json');
