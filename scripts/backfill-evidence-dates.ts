/**
 * Fill publication dates the pre-Phase-14 RSS parser never stored.
 *
 * Re-reads the configured feeds and writes back the publisher's own
 * <pubDate> for any stored funding-news evidence row whose date is NULL.
 * Nothing is inferred: an article that has rolled off its feed keeps its
 * NULL, and the company stays honestly un-current.
 *
 * Idempotent — a second run finds nothing left to fill.
 *
 * Usage: npx tsx scripts/backfill-evidence-dates.ts [--dry-run]
 */

import { backfillPublicationDates } from '../server/services/evidenceDates';
import { getQualification, qualifyIssuer, recordClassificationChange } from '../server/services/issuerQualification';
import { getOpportunity, reclassifyCompany } from '../server/db/repos/opportunities';

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

const result = await backfillPublicationDates({
  dryRun: DRY_RUN,
  onProgress: (l) => console.log(`  · ${l}`),
});

console.log(`\nUndated funding-news evidence rows: ${result.considered.length}`);
if (result.considered.length === 0) {
  console.log('Nothing to backfill.');
  process.exit(0);
}
console.log(`Feeds read: ${result.feedsRead} (${result.requests} request(s))\n`);

console.log('── Dates recovered from the publisher ────────────────────');
if (result.filled.length === 0) console.log('  none');
for (const f of result.filled) {
  console.log(`  ${f.companyName.padEnd(20)} ${f.publishedAt}  ${f.url}`);
}

if (result.unresolved.length > 0) {
  console.log('\n── Still undated ─────────────────────────────────────────');
  for (const u of result.unresolved) console.log(`  ${u.companyName}: ${u.detail}`);
}

if (DRY_RUN || result.filled.length === 0) process.exit(0);

// A date is the input to currency, so anything that gained one has to be
// re-judged. Done here rather than left to the next full pass, so the
// backfill never leaves the database in a state where the evidence and
// the verdict disagree.
console.log('\n── Re-qualified and re-classified ────────────────────────');
for (const id of [...new Set(result.filled.map((f) => f.companyId))]) {
  const before = getOpportunity(id);
  const qualBefore = getQualification(id);
  const qual = await qualifyIssuer(id);
  const after = reclassifyCompany(id);
  const moved = before && before.classification !== after.classification;
  console.log(`  ${id.padEnd(24)} ${before?.classification ?? 'unclassified'} → ${after.classification}   [${qual.result}]`);
  if (moved) {
    recordClassificationChange({
      companyId: id,
      previousClassification: before.classification,
      newClassification: after.classification,
      previousQualification: qualBefore?.result ?? null,
      newQualification: qual.result,
      reason: `Publication date recovered from the publisher's own feed. ${after.whyCurrent}`,
    });
  }
}
