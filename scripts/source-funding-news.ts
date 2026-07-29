/**
 * Live-verify the funding-news (RSS) pipeline against real current data.
 *
 * Prints the numbers that actually prove whether the pipeline works:
 * articles retrieved, candidate events, non-events rejected by reason,
 * companies resolved, domains verified, events corroborated, duplicates
 * merged, conflicts found, opportunities imported, opportunities by
 * sector, and failures by reason.
 *
 * "The tests pass" is not evidence that RSS is live. A successful real
 * event import is, which is why this script exists and why it talks to
 * the real feeds.
 *
 * Usage: npx tsx scripts/source-funding-news.ts [--dry-run] [--max 60]
 */

import { runFundingNews } from '../server/services/fundingNews';
import { configuredFeeds } from '../server/sourcing/adapters/rss';
import { RSS_REASON_TEXT, type RssReasonCode } from '../server/sourcing/fundingEvent';
import { listCompanies } from '../server/db/repos/companies';
import { listDealEvidence, getOpportunity } from '../server/db/repos/opportunities';
import { assessCorroboration } from '../server/services/issuerQualification';
import { isLiveDeal } from '../shared/opportunity';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MAX = Number(args[args.indexOf('--max') + 1]) || 60;

const feeds = configuredFeeds();
console.log(`Funding-news live verification${DRY_RUN ? ' [DRY RUN — nothing is written]' : ''}`);
console.log(`${feeds.length} configured feed(s):`);
for (const f of feeds) console.log(`   ${f}`);
console.log();

const before = listCompanies().length;
const run = await runFundingNews({ dryRun: DRY_RUN, maxResults: MAX, onProgress: (l) => console.log(`  · ${l.slice(0, 160)}`) });

console.log('\n── Per feed ──────────────────────────────────────────────');
for (const f of run.report.feeds) {
  if (f.status === 'failed') {
    console.log(`  ✗ ${f.host.padEnd(22)} ${f.failure ?? 'failed'} — ${f.detail.slice(0, 80)}`);
    continue;
  }
  console.log(`  ✓ ${f.host.padEnd(22)} ${String(f.items).padStart(3)} items → ${String(f.events).padStart(2)} events   ${Math.round(f.failureRate * 100)}% not financing events  [${f.format}]`);
}
for (const dead of run.report.deadFeeds) console.log(`  ! dead or empty: ${dead}`);

console.log('\n── Pipeline counts ───────────────────────────────────────');
const rows: [string, string | number][] = [
  ['Articles retrieved', run.report.articlesRetrieved],
  ['Candidate funding events detected', run.report.eventsExtracted],
  ['Non-events rejected', run.report.articlesRetrieved - run.report.eventsExtracted],
  ['Duplicate articles merged', run.report.mergedArticles],
  ['Distinct events after merge', run.report.eventsAfterMerge],
  ['Events with conflicting details', run.report.conflicted],
  ['Rejected — unapproved publisher', run.publisherRejected.length],
  ['Rejected — not an operating company', run.entityRejected.length],
  ['Rejected — no sector signal', run.sectorRejected.length],
  ['Official websites verified', run.websiteResolved],
  ['Websites unresolved', run.websiteUnresolved.length],
  ['Opportunities imported', run.imported.length],
  ['Network requests made', run.requests],
];
for (const [label, value] of rows) console.log(`  ${label.padEnd(38)} ${value}`);

console.log('\n── Non-events by reason ──────────────────────────────────');
for (const [code, n] of Object.entries(run.report.rejections).sort((a, b) => b[1] - a[1])) {
  const text = RSS_REASON_TEXT[code as RssReasonCode] ?? '';
  console.log(`  ${String(n).padStart(3)}  ${code.padEnd(32)} ${text}`);
}

console.log('\n── Imported events ───────────────────────────────────────');
if (run.imported.length === 0) {
  console.log('  none — see the rejection reasons above. This is a real result, not a placeholder.');
}
for (const e of run.imported) {
  const corr = DRY_RUN ? null : assessCorroboration(e.companyId);
  const opp = DRY_RUN ? null : getOpportunity(e.companyId);
  console.log(`\n  ${e.companyName}  [${e.sector}]`);
  console.log(`     event      ${e.announcedAt}  ${e.amountUsd ? `$${e.amountUsd.toLocaleString('en-US')}` : 'amount undisclosed'}  ${e.roundType ?? 'round unstated'}`);
  console.log(`     publishers ${e.publishers.join(', ')}`);
  console.log(`     website    ${e.website ?? 'unresolved'}${e.websiteMethod ? ` (${e.websiteMethod})` : ''}`);
  if (corr) console.log(`     sources    ${corr.independentFamilies.join(', ')} (${corr.independentFamilies.length} independent)`);
  if (opp) console.log(`     class      ${opp.classification}${isLiveDeal(opp.classification) ? '  ← LIVE DEAL' : ''}`);
  if (e.conflicts.length > 0) console.log(`     CONFLICT   ${e.conflicts.join('; ')}`);
  if (!DRY_RUN) console.log(`     evidence   ${listDealEvidence(e.companyId).length} row(s) stored`);
}

if (run.websiteUnresolved.length > 0) {
  console.log('\n── Websites left for human lookup ────────────────────────');
  for (const w of run.websiteUnresolved) console.log(`  ${w.company}: ${w.detail.slice(0, 130)}`);
}
if (run.sectorRejected.length > 0) {
  console.log('\n── No sector signal (kept out of every shortlist) ────────');
  for (const s of run.sectorRejected) console.log(`  ${s.company} — ${s.url}`);
}

console.log('\n── Opportunities by sector (RSS-derived, this run) ────────');
const bySector = new Map<string, string[]>();
for (const e of run.imported) {
  const list = bySector.get(e.sector ?? 'unknown') ?? [];
  list.push(e.companyName);
  bySector.set(e.sector ?? 'unknown', list);
}
if (bySector.size === 0) console.log('  none');
for (const [sector, names] of [...bySector.entries()].sort()) {
  console.log(`  ${sector.padEnd(16)} ${names.length}  (${names.join(', ')})`);
}

console.log(`\nCompanies in database: ${before} → ${listCompanies().length}`);
