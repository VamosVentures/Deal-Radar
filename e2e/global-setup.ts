import fs from 'node:fs';
import path from 'node:path';
import { E2E_ADMIN_PASSWORD, E2E_BACKEND_PORT, E2E_DATA_DIR, E2E_FRONTEND_PORT, E2E_STORAGE_STATE } from './env';

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

/**
 * Enrichment fixtures for the two seeded companies.
 *
 * Written straight into the E2E database rather than through the
 * pipeline, because the pipeline's job is to fetch other people's web
 * pages and an E2E run must not depend on the public internet being up,
 * or hit third-party servers every time somebody runs the suite. The
 * pipeline's own logic is covered by server/tests/enrichment.test.ts,
 * which is where that belongs.
 *
 * What these fixtures exist to exercise is the part only a browser can
 * check: that a verified founder and an unconfirmed candidate render
 * differently, that a conflict is displayed rather than resolved, and
 * that the reviewer workflow round-trips.
 *
 * This writes ONLY to the isolated E2E database under the OS temp
 * directory (see env.ts) — never to a real one.
 */
async function seedEnrichment(cookiePair: string): Promise<void> {
  const listed = await fetch(`${baseUrl}/api/companies/imported`, { headers: { Cookie: cookiePair } });
  if (!listed.ok) throw new Error(`E2E enrichment seed could not list companies: ${listed.status}`);
  const { companies } = await listed.json() as { companies: { id: string; name: string }[] };
  const health = companies.find((c) => c.name === 'E2E Health Fixture Co');
  const fintech = companies.find((c) => c.name === 'E2E FinTech Fixture Co');
  if (!health || !fintech) throw new Error('E2E enrichment seed could not find the seeded companies.');

  const { openDatabase } = await import('../server/db/client');
  const { E2E_DB_PATH } = await import('./env');
  const db = openDatabase(E2E_DB_PATH);
  const at = new Date().toISOString();
  const version = 'e2e-fixture';

  const candidate = db.prepare(`
    INSERT INTO founder_candidates (
      company_id, person_key, full_name, title, source_url, source_family, source_type,
      published_at, retrieved_at, supporting_text, match_signals, match_score, confidence,
      status, first_seen_at, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const attempt = db.prepare(`
    INSERT INTO founder_research_attempts (company_id, run_id, source_family, url, attempted_at, outcome, detail, candidates_found)
    VALUES (?, 'e2e-seed', ?, ?, ?, ?, ?, ?)
  `);
  const resolution = db.prepare(`
    INSERT INTO company_founder_resolution (company_id, status, resolved_person_key, resolved_name, resolved_title, summary, next_action, sources_attempted, researched_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const vertical = db.prepare(`
    INSERT INTO company_vertical_classification (company_id, primary_sector, secondary_sector, subvertical, reason, source_url, confidence, basis, evidence_gap, classified_at, version)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const stage = db.prepare(`
    INSERT INTO company_stage_resolution (company_id, stage, basis, confidence, evidence_url, evidence_date, explanation, conflicts, last_checked_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
  `);

  // ── Health fixture: a VERIFIED founder ──────────────────────────
  candidate.run(
    health.id, 'e2e verified founder', 'E2E Verified Founder', 'Co-Founder & CEO',
    'https://example.com/e2e-health-fixture/team', 'company-site', 'Company team page',
    '2026-01-01', at, 'E2E Verified Founder — Co-Founder & CEO',
    JSON.stringify(['statement-on-company-domain', 'title-stated-in-source']), 7, 0.85,
    'verified-founder', at, at,
  );
  attempt.run(health.id, 'company-site', 'https://example.com/e2e-health-fixture/team', at, 'found-candidate', '1 page(s) attempted: 1 read.', 1);
  attempt.run(health.id, 'sec-form-d', null, at, 'no-source-url-known', 'No SEC filing on record.', 0);
  resolution.run(
    health.id, 'verified-founder', 'e2e verified founder', 'E2E Verified Founder', 'Co-Founder & CEO',
    'E2E Verified Founder — Co-Founder & CEO, attributed to Company website.',
    'No action required.', JSON.stringify(['company-site', 'sec-form-d']), at, version,
  );
  vertical.run(health.id, 'health', 'virtual care delivery',
    'Health & Wellness: the record describes patient care sold to health systems.',
    'https://example.com/e2e-health-fixture', 0.8, 'explicit', at, version);
  stage.run(health.id, 'Seed', 'explicit', 0.8, 'https://example.com/e2e-health-fixture', '2026-01-01',
    'Seed stated explicitly by funding press on 2026-01-01.', at, version);

  // ── FinTech fixture: CONFLICTING evidence ───────────────────────
  candidate.run(
    fintech.id, 'e2e candidate one', 'E2E Candidate One', 'CEO',
    'https://example.com/e2e-fintech-a', 'company-site', 'Company about page',
    '2026-02-01', at, 'E2E Candidate One — CEO',
    JSON.stringify(['statement-on-company-domain', 'title-stated-in-source']), 7, 0.7,
    'conflicting-founder-evidence', at, at,
  );
  candidate.run(
    fintech.id, 'e2e candidate two', 'E2E Candidate Two', 'Chief Executive Officer',
    'https://example.com/e2e-fintech-b', 'accelerator', 'Accelerator profile',
    '2026-03-01', at, 'E2E Candidate Two — Chief Executive Officer',
    JSON.stringify(['accelerator-profile-for-company', 'title-stated-in-source']), 6, 0.6,
    'conflicting-founder-evidence', at, at,
  );
  attempt.run(fintech.id, 'company-site', 'https://example.com/e2e-fintech-a', at, 'found-candidate', '1 page(s) attempted: 1 read.', 1);
  attempt.run(fintech.id, 'accelerator', 'https://example.com/e2e-fintech-b', at, 'found-candidate', '1 page(s) attempted: 1 read.', 1);
  resolution.run(
    fintech.id, 'conflicting-founder-evidence', null, null, null,
    'Sources disagree about who holds the CEO role at E2E FinTech Fixture Co: E2E Candidate One and '
    + 'E2E Candidate Two are each named by a different source. No person has been selected.',
    'Open the candidate evidence, compare the source dates, and confirm or reject each candidate.',
    JSON.stringify(['company-site', 'accelerator']), at, version,
  );
  vertical.run(fintech.id, 'fintech', 'payments infrastructure',
    'FinTech: the record describes payments sold to merchants.',
    'https://example.com/e2e-fintech-fixture', 0.45, 'inferred', at, version);
  stage.run(fintech.id, 'early-stage-round-not-disclosed', 'inferred', 0.35, null, null,
    'No source names a round. Bounded to early-stage because the only financing evidence is an SEC Form D, '
    + 'which reports that an exempt offering occurred but never names a venture round.', at, version);

  db.close();
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });
  await waitForBackend(30_000);

  // The whole application is gated now, so even seeding goes through a
  // real sign-in — which is itself worth exercising once per run.
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: E2E_ADMIN_PASSWORD }),
  });
  if (!login.ok) {
    throw new Error(`E2E admin sign-in failed: ${login.status} ${await login.text()}`);
  }
  const setCookie = login.headers.get('set-cookie');
  if (!setCookie) throw new Error('E2E sign-in returned no session cookie.');
  const cookiePair = setCookie.split(';')[0];
  const [cookieName, ...rest] = cookiePair.split('=');
  const cookieValue = rest.join('=');

  const res = await fetch(`${baseUrl}/api/companies/import-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
    body: JSON.stringify({ csv: SEED_CSV }),
  });
  if (!res.ok) {
    throw new Error(`E2E seed import failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  if (body.imported !== 2) {
    throw new Error(`E2E seed import expected 2 companies, got ${JSON.stringify(body)}`);
  }

  await seedEnrichment(cookiePair);

  // Persist the session so specs start signed in. Specs that test the
  // gate itself opt out with an empty storageState (see auth.spec.ts).
  fs.mkdirSync(path.dirname(E2E_STORAGE_STATE), { recursive: true });
  fs.writeFileSync(E2E_STORAGE_STATE, JSON.stringify({
    cookies: [{
      name: cookieName,
      value: cookieValue,
      domain: 'localhost',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    }],
    origins: [],
  }, null, 2));
  void E2E_FRONTEND_PORT;
}
