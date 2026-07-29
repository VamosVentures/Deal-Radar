/**
 * Go looking for a SECOND independent source for companies that only
 * have one.
 *
 * The rule that a live opportunity needs two independent sources is
 * correct, but it is only useful if somebody actually goes looking. This
 * script does that: for every company below the corroboration threshold
 * it asks the accelerator directory whether it knows the company, and
 * tries to find and confirm the company's own website.
 *
 * Only ADDS evidence. Nothing is deleted, no classification is forced,
 * and a company that stays uncorroborated stays a lead — which is the
 * honest outcome, not a failure of the script.
 *
 * Usage: npx tsx scripts/corroborate-all.ts [--source funding-news] [--limit N]
 */

import { listCompanies, discoverySourceOf } from '../server/db/repos/companies';
import { listDealEvidence, reclassifyCompany, getOpportunity } from '../server/db/repos/opportunities';
import { corroborateCompany, corroborateViaWebsite } from '../server/services/corroborate';
import { assessCorroboration, qualifyIssuer } from '../server/services/issuerQualification';
import { MIN_INDEPENDENT_SOURCES } from '../shared/qualification';

const args = process.argv.slice(2);
const SOURCE = args.includes('--source') ? args[args.indexOf('--source') + 1] : null;
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || Infinity;

const candidates = listCompanies()
  .filter((c) => listDealEvidence(c.id).length > 0)
  .filter((c) => assessCorroboration(c.id).independentFamilies.length < MIN_INDEPENDENT_SOURCES)
  .filter((c) => (SOURCE ? discoverySourceOf(c.id) === SOURCE : true))
  .slice(0, LIMIT);

console.log(`${candidates.length} company/companies have fewer than ${MIN_INDEPENDENT_SOURCES} independent sources`);
if (SOURCE) console.log(`Filtered to discovery source: ${SOURCE}`);
console.log();

let gainedFamily = 0;
let foundWebsite = 0;
let promoted = 0;

for (const c of candidates) {
  const before = getOpportunity(c.id)?.classification ?? 'unclassified';
  const familiesBefore = assessCorroboration(c.id).independentFamilies.length;

  const notes: string[] = [];

  // 1. The accelerator directory — a different organisation with its own
  //    reason to publish.
  const attempt = await corroborateCompany(c.id);
  for (const f of attempt.found) notes.push(`${f.family} via ${f.sourceId}: ${f.detail}`);
  if (attempt.discoveredWebsite) notes.push(`website from directory: ${attempt.discoveredWebsite}`);

  // 2. The company's own site — proves it is an operating business, and
  //    nothing more. It cannot verify a financing amount.
  if (!c.website) {
    const site = await corroborateViaWebsite(c.id);
    if (site.url) { foundWebsite += 1; notes.push(`website confirmed: ${site.url}`); }
    else notes.push(`website: ${site.detail}`);
  }

  await qualifyIssuer(c.id);
  reclassifyCompany(c.id);

  const familiesAfter = assessCorroboration(c.id).independentFamilies.length;
  const after = getOpportunity(c.id)?.classification ?? 'unclassified';
  if (familiesAfter > familiesBefore) gainedFamily += 1;
  if (before !== after) promoted += 1;

  const changed = familiesAfter > familiesBefore || before !== after;
  console.log(`${changed ? '✓' : '·'} ${c.name}`);
  console.log(`    sources ${familiesBefore} → ${familiesAfter}   class ${before}${before !== after ? ` → ${after}` : ''}`);
  for (const n of notes.slice(0, 3)) console.log(`    ${n.slice(0, 150)}`);
}

console.log('\n── Result ────────────────────────────────────────────────');
console.log(`Companies examined            ${candidates.length}`);
console.log(`Gained an independent source  ${gainedFamily}`);
console.log(`Website found and confirmed   ${foundWebsite}`);
console.log(`Classification changed        ${promoted}`);
console.log('\nCompanies that gained nothing remain company leads. That is the correct');
console.log('outcome for a company only one source has written about.');
