#!/usr/bin/env -S npx tsx
/**
 * Downgrade placeholder values wrongly stamped `user-entered` to `missing`.
 *
 *   npm run db:backfill-placeholder-provenance -- --dry-run    # report only
 *   npm run db:backfill-placeholder-provenance                 # apply
 *
 * WHAT WENT WRONG
 *
 * `importCompaniesCsv` (server/services/imports.ts) stamped EVERY field on
 * a new company `user-entered` unconditionally — the second-highest
 * provenance tier, beaten only by `verified`. That conflates two very
 * different claims: "a human entered this row" (true of every CSV import)
 * and "a human confirmed this specific value" (false whenever the value is
 * just a schema-satisfying placeholder an analyst had no information for —
 * a blank website, a subcategory typed as "Unclassified — requires manual
 * review", the stage enum's own "Unknown" option — OR a real Vamos
 * taxonomy label imported for the WRONG sector, which is no less unstated
 * for being real text (Podium's own subcategory, 'consumer wellness',
 * belongs only to `health`'s taxonomy while its vertical is `fintech`).
 *
 * `applyFieldUpdate` refuses to let an automated `extracted` write replace
 * anything stamped `user-entered` or higher. So once a placeholder landed
 * with that provenance, no later enrichment run — however correct — could
 * ever write the real value: it was rejected exactly as if a human had
 * verified the placeholder itself. This is what kept a live production
 * company (Podium) showing a wrong, already-fixed-in-code subcategory, and
 * kept a freshly-rediscovered website from ever reaching the row.
 *
 * `importCompaniesCsv` now computes this at import time
 * (`placeholderFieldsFor`, server/services/imports.ts) for every NEW
 * import. This script corrects the companies that were already imported
 * before that existed.
 *
 * WHAT THIS DOES AND DOES NOT TOUCH
 *
 * A field on a company is only ever touched when BOTH hold:
 *   - its stored provenance origin is exactly `user-entered` (`verified`,
 *     and anything already `missing`, are left alone unconditionally);
 *   - its CURRENT value still matches the same placeholder signature
 *     `placeholderFieldsFor` checks at import time.
 *
 * A field whose value has since been corrected to something real is
 * therefore left untouched even if it still carries `user-entered`
 * provenance — this only downgrades rows that still look exactly like the
 * unstated placeholder they were on the day they were imported. Re-running
 * is a no-op, because a corrected field's provenance is `missing`, not
 * `user-entered`, on the second pass.
 *
 * This never touches the VALUE stored in `companies` — a placeholder stays
 * exactly what it was. It only downgrades the provenance record so a real
 * value can reach the row the next time enrichment runs.
 */
import { getDb } from '../server/db/client';
import { getProvenance } from '../server/db/repos/companies';
import { EMPTY_CATEGORY, subverticalLabelsForSector } from '../server/enrichment/verticalClassifier';
import { PLACEHOLDER_FOUNDED_YEAR } from '../server/services/imports';
import { PRIMARY_SECTORS, type PrimarySector } from '../shared/enrichment';
import { audit } from '../server/lib/guard';

const DRY_RUN = process.argv.includes('--dry-run');

interface Row {
  id: string;
  name: string;
  website: string | null;
  vertical: string;
  subcategory: string;
  stage: string;
  city: string;
  state: string;
  founded_year: number;
  accelerator: string | null;
  raising: string | null;
  last_funding_date: string | null;
}

function isPrimarySector(v: string): v is PrimarySector {
  return (PRIMARY_SECTORS as readonly string[]).includes(v);
}

/**
 * A subcategory can fail to be a stated fact two ways: it is a
 * placeholder shape (EMPTY_CATEGORY), or it is a real Vamos taxonomy
 * label imported for the WRONG sector — Podium's own 'consumer wellness'
 * belongs only to `health`'s taxonomy while its vertical is `fintech`.
 * Either way nobody actually asserted "this subcategory is correct for
 * this company."
 */
function subcategoryUnstated(row: Row): boolean {
  if (EMPTY_CATEGORY.test(row.subcategory)) return true;
  if (!isPrimarySector(row.vertical)) return false;
  return !subverticalLabelsForSector(row.vertical).has(row.subcategory.trim().toLowerCase());
}

/** field -> (column, "does this current value still look like a placeholder?") */
const CHECKS: [string, string, (row: Row) => boolean][] = [
  ['website', 'website', (r) => !r.website],
  ['subcategory', 'subcategory', subcategoryUnstated],
  ['stage', 'stage', (r) => r.stage === 'Unknown'],
  ['city', 'city', (r) => /^unknown$/i.test(r.city)],
  ['state', 'state', (r) => r.state === '??' || /^unknown$/i.test(r.state)],
  ['foundedYear', 'founded_year', (r) => r.founded_year === PLACEHOLDER_FOUNDED_YEAR],
  ['accelerator', 'accelerator', (r) => !r.accelerator],
  ['raising', 'raising', (r) => !r.raising],
  ['lastFundingDate', 'last_funding_date', (r) => !r.last_funding_date],
];

function main() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, website, vertical, subcategory, stage, city, state, founded_year,
           accelerator, raising, last_funding_date
    FROM companies
  `).all() as unknown as Row[];

  const targets: { id: string; name: string; field: string }[] = [];
  for (const row of rows) {
    for (const [field, , stillPlaceholder] of CHECKS) {
      const prov = getProvenance(row.id, field);
      if (prov?.origin !== 'user-entered') continue;
      if (!stillPlaceholder(row)) continue;
      targets.push({ id: row.id, name: row.name, field });
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Placeholder-provenance correction — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
  console.log('='.repeat(72));
  console.log(`Companies scanned .......................... ${rows.length}`);
  console.log(`Fields to downgrade to 'missing' ........... ${targets.length}`);

  const byField = new Map<string, number>();
  for (const t of targets) byField.set(t.field, (byField.get(t.field) ?? 0) + 1);
  for (const [field, n] of [...byField].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${field.padEnd(16)} ${n}`);
  }

  if (targets.length === 0) {
    console.log("\nNothing to correct. (Re-running this script is a no-op by design.)");
    return;
  }

  if (DRY_RUN) {
    console.log('\nFirst 15:');
    for (const t of targets.slice(0, 15)) {
      console.log(`  ${t.id.padEnd(28)} ${t.name.slice(0, 26).padEnd(28)} ${t.field}`);
    }
    console.log('\nNothing was written.');
    return;
  }

  const ts = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO field_provenance (company_id, field, origin, source, updated_at)
    VALUES (?, ?, 'missing', ?, ?)
    ON CONFLICT (company_id, field) DO UPDATE SET origin = excluded.origin, source = excluded.source, updated_at = excluded.updated_at
  `);
  for (const t of targets) {
    stmt.run(t.id, t.field, "correction: 'user-entered' was stamped unconditionally at import; this value is still the unstated placeholder", ts);
  }

  console.log(`\nDowngraded to 'missing' .................... ${targets.length}`);

  audit({
    provider: 'system', mode: 'local', action: 'placeholder-provenance-correction',
    subject: `${targets.length} field/company pairs`, outcome: 'ok',
    detail: `Downgraded ${targets.length} field(s) across ${new Set(targets.map((t) => t.id)).size} `
      + "company/companies from 'user-entered' to 'missing' provenance — each still held the exact "
      + 'placeholder value it was imported with, so it was never actually stated by a human. '
      + 'A real value from a later enrichment run can now reach the row.',
  });
}

try {
  main();
} catch (e) {
  console.error(`\nCorrection failed: ${(e as Error).message}`);
  process.exit(1);
}
