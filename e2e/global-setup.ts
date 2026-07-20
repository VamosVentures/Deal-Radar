import fs from 'node:fs';
import { E2E_BACKEND_PORT, E2E_DATA_DIR } from './env';

/**
 * Runs once before the E2E suite. Predictable, deterministic test
 * records are created through the REAL API (not by poking the
 * database directly) so the seed data exercises the same validation
 * path a real import would. The backend (started by Playwright's
 * `webServer`) is already up by the time global setup runs; this
 * still polls defensively in case startup is slow.
 */

const baseUrl = `http://localhost:${E2E_BACKEND_PORT}`;

async function waitForBackend(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('E2E backend did not become ready in time.');
}

const SEED_CSV = [
  'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType',
  'E2E Health Fixture Co,E2E fixture pitch for health vertical,health,Care,Seed,Austin,TX,2024,5,6,E2E fixture traction note,E2E Founder One,CEO,E2E fixture background,E2E fixture evidence claim,E2E Fixture Source,https://example.com/e2e-health-fixture,2026-01-01,News',
  'E2E FinTech Fixture Co,E2E fixture pitch for fintech vertical,fintech,Payments,Pre-seed,Denver,CO,2025,2,3,E2E fixture traction note two,E2E Founder Two,CEO,E2E fixture background two,E2E fixture evidence claim two,E2E Fixture Source,https://example.com/e2e-fintech-fixture,2026-02-01,News',
].join('\n');

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
  await waitForBackend(30_000);

  const res = await fetch(`${baseUrl}/api/companies/import-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv: SEED_CSV }),
  });
  if (!res.ok) {
    throw new Error(`E2E seed import failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  if (body.imported !== 2) {
    throw new Error(`E2E seed import expected 2 companies, got ${JSON.stringify(body)}`);
  }
}
