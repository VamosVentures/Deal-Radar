#!/usr/bin/env -S npx tsx
/**
 * Correct fabricated `founded_year` values on already-imported companies.
 *
 *   npm run db:backfill-founded-year -- --dry-run    # report only, writes nothing
 *   npm run db:backfill-founded-year                 # apply
 *
 * WHAT WENT WRONG
 *
 * No source this app scrapes (YC's directory, SEC filings, GitHub, SBIR,
 * RSS, Product Hunt, investor news) publishes a company's actual founding
 * date. Three code paths papered over that with a number that looked like
 * a fact:
 *
 *   - `candidateToImportedCompany` (services/discovery.ts) fell through to
 *     `new Date().getFullYear()`, stamping every company with whatever the
 *     current calendar year was at import time. A company from YC's Winter
 *     2020 batch was recorded as "founded 2026".
 *   - `persistEvent` (services/fundingNews.ts) and `persistInvestorEvent`
 *     (services/investorNews.ts) used the ANNOUNCEMENT date's year, so a
 *     company that raised in 2026 was recorded as founded in 2026.
 *
 * All three wrote provenance `extracted` — the same origin as a genuinely
 * sourced field — so nothing downstream could tell the invented years from
 * the real ones. That mattered beyond display: `resolveStage` weighs
 * `companyAgeYears`, derived from this column.
 *
 * THE TWO CORRECTIONS THIS APPLIES
 *
 * 1. YC companies: derive the real proxy from the batch code ("W20" ->
 *    2020) and write it as `extracted`. Founders apply to YC within
 *    roughly a year of starting the company, so the batch year is a
 *    genuine, if approximate, signal — not a guess.
 *
 * 2. Everything else with an invented year (SEC, funding-news,
 *    investor-news — no batch code, nothing to derive from): the value is
 *    replaced with PLACEHOLDER_FOUNDED_YEAR and its provenance is set to
 *    `missing`, which is what the UI reads to render "Missing" instead of
 *    a year. `missing` is the lowest precedence, so any later real value
 *    overwrites it automatically.
 *
 * WHAT THIS DOES AND DOES NOT TOUCH
 *
 * A row is only ever touched when its founded_year is one of the two
 * fabrication signatures — the current calendar year (discovery fallback)
 * or the year of its own `last_funding_date` (the news services' bug).
 * A year that matches neither was established some other way and is left
 * alone. `verified` and `user-entered` provenance is never overwritten:
 * that guard lives in `applyFieldUpdate`, not re-implemented here.
 *
 * Re-running is a no-op: corrected rows no longer match either signature.
 */
import { getDb } from '../server/db/client';
import { applyFieldUpdate, getProvenance } from '../server/db/repos/companies';
import { batchToYear } from '../server/sourcing/adapters/ycombinator';
import { PLACEHOLDER_FOUNDED_YEAR } from '../server/services/imports';
import { audit } from '../server/lib/guard';

const DRY_RUN = process.argv.includes('--dry-run');
const CURRENT_YEAR = new Date().getFullYear();

function extractYcBatch(accelerator: string | null | undefined): string | null {
  const m = accelerator?.match(/\(([A-Za-z]+\d{2})\)/);
  return m ? m[1] : null;
}

interface Row {
  id: string;
  name: string;
  founded_year: number;
  accelerator: string | null;
  discovery_source: string | null;
  last_funding_date: string | null;
}

function main() {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, name, founded_year, accelerator, discovery_source, last_funding_date FROM companies')
    .all() as unknown as Row[];

  const derivable: { row: Row; batch: string; year: number }[] = [];
  const unknowable: Row[] = [];

  for (const row of rows) {
    // Already corrected by a previous run — its provenance says so.
    if (getProvenance(row.id, 'foundedYear')?.origin === 'missing') continue;

    const fundingYear = row.last_funding_date ? Number(row.last_funding_date.slice(0, 4)) : null;
    const fabricated = row.founded_year === CURRENT_YEAR
      || (fundingYear !== null && row.founded_year === fundingYear);
    if (!fabricated) continue;

    const batch = extractYcBatch(row.accelerator);
    const year = batch ? batchToYear(batch) : null;
    if (batch && year !== null) {
      // A batch year equal to the current year is right, not fabricated.
      if (year !== row.founded_year) derivable.push({ row, batch, year });
      continue;
    }
    unknowable.push(row);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Founded-year correction — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
  console.log('='.repeat(72));
  console.log(`Companies scanned .............................. ${rows.length}`);
  console.log(`  derivable from a YC batch code .............. ${derivable.length}`);
  console.log(`  unknowable -> placeholder + 'missing' ....... ${unknowable.length}`);

  const bySource = new Map<string, number>();
  for (const r of unknowable) bySource.set(r.discovery_source ?? 'none', (bySource.get(r.discovery_source ?? 'none') ?? 0) + 1);
  for (const [src, n] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`      ${src.padEnd(16)} ${n}`);

  /**
   * `team_size` from the two news services, same class of bug.
   *
   * `persistEvent`/`persistInvestorEvent` hardcode `teamSize: 1` — a
   * funding article never states a headcount. Scoped to those two
   * sources on purpose: discovery's `Math.max(1, c.founderCount ?? 1)`
   * yields a REAL 1 whenever the source did list one founder, and
   * blanking those would destroy a fact rather than a fabrication.
   */
  const teamSizeTargets = (db
    .prepare("SELECT id, team_size, discovery_source FROM companies WHERE discovery_source IN ('funding-news', 'investor-news')")
    .all() as { id: string; team_size: number; discovery_source: string }[])
    .filter((row) => {
      if (row.team_size !== 1) return false; // something else established it
      const existing = getProvenance(row.id, 'teamSize');
      if (existing?.origin === 'missing') return false;
      return !(existing && (existing.origin === 'verified' || existing.origin === 'user-entered'));
    });
  console.log(`  team size -> 'missing' (news sources only) .. ${teamSizeTargets.length}`);

  if (derivable.length === 0 && unknowable.length === 0 && teamSizeTargets.length === 0) {
    console.log('\nNothing to correct. (Re-running this script is a no-op by design.)');
    return;
  }

  if (DRY_RUN) {
    console.log('\nFirst 10 derivable:');
    for (const { row, batch, year } of derivable.slice(0, 10)) {
      console.log(`  ${row.id.padEnd(16)} ${row.name.slice(0, 26).padEnd(28)} ${row.founded_year} -> ${year}  (batch ${batch})`);
    }
    console.log('\nFirst 10 marked unknown:');
    for (const row of unknowable.slice(0, 10)) {
      console.log(`  ${row.id.padEnd(16)} ${row.name.slice(0, 26).padEnd(28)} ${row.founded_year} -> MISSING  (${row.discovery_source})`);
    }
    console.log('\nNothing was written.');
    return;
  }

  const skipped: { id: string; reason: string }[] = [];
  let corrected = 0;
  for (const { row, batch, year } of derivable) {
    const res = applyFieldUpdate(
      row.id, 'foundedYear', year, 'extracted',
      `correction: founded_year was fabricated by an import fallback; derived from YC batch ${batch}`,
    );
    if (res.applied) corrected += 1;
    else skipped.push({ id: row.id, reason: res.reason ?? 'not applied' });
  }

  let markedMissing = 0;
  for (const row of unknowable) {
    const existing = getProvenance(row.id, 'foundedYear');
    if (existing && (existing.origin === 'verified' || existing.origin === 'user-entered')) {
      skipped.push({ id: row.id, reason: `kept ${existing.origin} value` });
      continue;
    }
    db.prepare('UPDATE companies SET founded_year = ?, updated_at = ? WHERE id = ?')
      .run(PLACEHOLDER_FOUNDED_YEAR, new Date().toISOString(), row.id);
    db.prepare(`
      INSERT INTO field_provenance (company_id, field, origin, source, updated_at)
      VALUES (?, 'foundedYear', 'missing', ?, ?)
      ON CONFLICT (company_id, field) DO UPDATE SET origin = excluded.origin, source = excluded.source, updated_at = excluded.updated_at
    `).run(row.id, `correction: no source stated a founding year (${row.discovery_source ?? 'unknown source'})`, new Date().toISOString());
    markedMissing += 1;
  }

  let teamSizeMarked = 0;
  for (const row of teamSizeTargets) {
    db.prepare(`
      INSERT INTO field_provenance (company_id, field, origin, source, updated_at)
      VALUES (?, 'teamSize', 'missing', ?, ?)
      ON CONFLICT (company_id, field) DO UPDATE SET origin = excluded.origin, source = excluded.source, updated_at = excluded.updated_at
    `).run(row.id, `correction: no source stated a team size (${row.discovery_source})`, new Date().toISOString());
    teamSizeMarked += 1;
  }

  console.log(`\nDerived from batch code .... ${corrected}`);
  console.log(`Marked missing ............. ${markedMissing}`);
  console.log(`Team size marked missing ... ${teamSizeMarked}`);
  console.log(`Skipped .................... ${skipped.length}`);
  for (const s of skipped.slice(0, 10)) console.log(`  skipped ${s.id}: ${s.reason}`);

  audit({
    provider: 'system', mode: 'local', action: 'founded-year-correction',
    subject: `${corrected + markedMissing} company/companies`, outcome: 'ok',
    detail: `Corrected fabricated founded_year values: ${corrected} derived from a YC batch code, `
      + `${markedMissing} replaced with a placeholder and recorded as 'missing' provenance because no source `
      + `stated a founding year. ${skipped.length} skipped (human-provenance values are never overwritten).`,
  });
}

try {
  main();
} catch (e) {
  console.error(`\nCorrection failed: ${(e as Error).message}`);
  process.exit(1);
}
