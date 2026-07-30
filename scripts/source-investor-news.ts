/**
 * Live-verify the investor-primary pipeline against real current data.
 *
 * Prints the numbers that actually prove whether it works: items
 * retrieved per firm, how many were investor-primary financing events,
 * why the rest were not, which companies resolved, whether each one
 * attached to a company we already had, and — the number this source
 * exists to move — how many source families each company ends up with.
 *
 * "The tests pass" is not evidence that this source is live. A real
 * announcement, on a real investor's domain, becoming real evidence is,
 * which is why this script talks to the real feeds.
 *
 * Usage: npx tsx scripts/source-investor-news.ts [--dry-run] [--max 60]
 */

import { runInvestorNews } from '../server/services/investorNews';
import { configuredInvestorFeeds } from '../server/sourcing/adapters/investorNews';
import { INVESTOR_REASON_TEXT, type InvestorReasonCode } from '../server/sourcing/investorAnnouncement';
import { EXCLUDED_INVESTOR_FEEDS, investorForUrl } from '../server/sourcing/investorRegistry';
import { listCompanies } from '../server/db/repos/companies';
import { listDealEvidence, getOpportunity } from '../server/db/repos/opportunities';
import { assessCorroboration } from '../server/services/issuerQualification';
import { isLiveDeal } from '../shared/opportunity';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MAX = Number(args[args.indexOf('--max') + 1]) || 60;

const feeds = configuredInvestorFeeds();
console.log(`Investor-primary live verification${DRY_RUN ? ' [DRY RUN — nothing is written]' : ''}`);
console.log(`${feeds.length} registered investor feed(s):`);
for (const f of feeds) console.log(`   ${(investorForUrl(f)?.name ?? '?').padEnd(28)} ${f}`);
console.log('\nProbed and deliberately not registered:');
for (const x of EXCLUDED_INVESTOR_FEEDS) console.log(`   ${x.host}\n      ${x.reason}`);
console.log();

const before = listCompanies().length;
const run = await runInvestorNews({ dryRun: DRY_RUN, maxResults: MAX, onProgress: (l) => console.log(`  · ${l.slice(0, 200)}`) });

console.log('\n── Per investor feed ─────────────────────────────────────');
for (const f of run.report.feeds) {
  if (f.status === 'failed') {
    console.log(`  ✗ ${(f.investor ?? f.host).padEnd(28)} ${f.failure ?? 'failed'} — ${f.detail.slice(0, 70)}`);
    continue;
  }
  console.log(`  ✓ ${(f.investor ?? f.host).padEnd(28)} ${String(f.items).padStart(3)} items → ${String(f.events).padStart(2)} investor-primary events  [${f.format}]`);
}
for (const dead of run.report.deadFeeds) console.log(`  ! dead or empty: ${dead}`);

console.log('\n── Pipeline counts ───────────────────────────────────────');
const rows: [string, string | number][] = [
  ['Items retrieved', run.report.itemsRetrieved],
  ['Investor-primary financing events', run.report.eventsExtracted],
  ['Items rejected', run.report.itemsRetrieved - run.report.eventsExtracted],
  ['Duplicate announcements merged', run.report.mergedArticles],
  ['Distinct events after merge', run.report.eventsAfterMerge],
  ['Events with conflicting details', run.report.conflicted],
  ['Rejected — not an operating company', run.entityRejected.length],
  ['Rejected — no sector signal', run.sectorRejected.length],
  ['Official websites verified', run.websiteResolved],
  ['Websites unresolved', run.websiteUnresolved.length],
  ['Events stored', run.imported.length],
  ['  … attached to an existing company', run.imported.filter((e) => e.attachedToExisting).length],
  ['  … new company records', run.imported.filter((e) => !e.attachedToExisting).length],
  ['Network requests made', run.requests],
];
for (const [label, value] of rows) console.log(`  ${label.padEnd(38)} ${value}`);

console.log('\n── Rejections by reason ──────────────────────────────────');
for (const [code, n] of Object.entries(run.report.rejections).sort((a, b) => b[1] - a[1])) {
  const text = INVESTOR_REASON_TEXT[code as InvestorReasonCode] ?? '';
  console.log(`  ${String(n).padStart(3)}  ${code.padEnd(30)} ${text}`);
}

console.log('\n── Events ────────────────────────────────────────────────');
if (run.imported.length === 0) {
  console.log('  none — see the rejection reasons above. This is a real result, not a placeholder.');
}
for (const e of run.imported) {
  const corr = DRY_RUN ? null : assessCorroboration(e.companyId);
  const opp = DRY_RUN ? null : getOpportunity(e.companyId);
  console.log(`\n  ${e.companyName}  [${e.sector}]${e.attachedToExisting ? '   ← already on record (corroboration)' : '   ← new company'}`);
  console.log(`     event      ${e.announcedAt}  ${e.amountText ?? 'amount not stated'}  ${e.roundType ?? 'round not stated'}`);
  for (const i of e.investors) {
    console.log(`     investor   ${i.name} (${i.domain})`);
    console.log(`                ${i.url}`);
    console.log(`                participation: "${i.participation.slice(0, 110)}"`);
  }
  console.log(`     website    ${e.website ?? 'unresolved'}${e.websiteMethod ? ` (${e.websiteMethod})` : ''}`);
  console.log(`     families   ${e.familiesAfter.join(', ')}`);
  if (corr) console.log(`     corrob.    ${corr.independentFamilies.join(', ')} (${corr.independentFamilies.length} independent)`);
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
if (run.entityRejected.length > 0) {
  console.log('\n── Not an operating company ──────────────────────────────');
  for (const s of run.entityRejected) console.log(`  ${s.company} — ${s.reason}`);
}

console.log('\n── Events by sector (investor-primary, this run) ──────────');
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
