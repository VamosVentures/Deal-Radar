/**
 * Re-evaluate every stored company against the current qualification
 * rules, quarantine what does not belong in a deal shortlist, and print
 * an audit summary.
 *
 * Nothing is deleted. A disqualified record is quarantined — its evidence
 * stays for audit, and it stops appearing as a live opportunity. Deleting
 * would lose the trail and re-import the same entity on the next run.
 *
 * Usage: npx tsx scripts/qualify-all.ts [--offline] [--limit N]
 */

import { listCompanies } from '../server/db/repos/companies';
import { getOpportunity, reclassifyCompany } from '../server/db/repos/opportunities';
import {
  getQualification, qualifyIssuer, quarantine, recordClassificationChange, unquarantine,
} from '../server/services/issuerQualification';
import {
  isDisqualified, QUALIFICATION_LABELS, explainQualification,
  type QualificationResult,
} from '../shared/qualification';

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || Infinity;

const companies = listCompanies().slice(0, LIMIT);
console.log(`Qualifying ${companies.length} companies${OFFLINE ? ' [OFFLINE — no network checks]' : ' with live SEC + website checks'}\n`);

const byResult = new Map<QualificationResult, string[]>();
const classBefore = new Map<string, number>();
const classAfter = new Map<string, number>();
let quarantined = 0;
let changed = 0;

for (const [i, c] of companies.entries()) {
  const before = getOpportunity(c.id);
  const beforeQual = getQualification(c.id);
  if (before) classBefore.set(before.classification, (classBefore.get(before.classification) ?? 0) + 1);

  const q = await qualifyIssuer(c.id, { offline: OFFLINE });
  const list = byResult.get(q.result) ?? [];
  list.push(c.name);
  byResult.set(q.result, list);

  // Quarantine or release, based purely on the fresh verdict.
  if (isDisqualified(q.result) || q.result === 'insufficient-evidence') {
    quarantine(c.id, `${QUALIFICATION_LABELS[q.result]} — ${explainQualification(q)}`);
    quarantined++;
  } else {
    unquarantine(c.id);
  }

  const after = reclassifyCompany(c.id);
  classAfter.set(after.classification, (classAfter.get(after.classification) ?? 0) + 1);

  if (before && before.classification !== after.classification) {
    changed++;
    recordClassificationChange({
      companyId: c.id,
      previousClassification: before.classification,
      newClassification: after.classification,
      previousQualification: beforeQual?.result ?? null,
      newQualification: q.result,
      reason: after.whyCurrent,
    });
  }

  if ((i + 1) % 25 === 0) process.stdout.write(`  …${i + 1}/${companies.length}\n`);
}

console.log('\n── Qualification audit ───────────────────────────────────');
const order: QualificationResult[] = [
  'qualified-operating-company', 'human-review-required',
  'company-lead-requires-corroboration', 'insufficient-evidence',
  'public-company', 'investment-fund', 'spv-or-project-entity',
  'corporate-subsidiary', 'unverified-foreign-entity',
];
for (const r of order) {
  const names = byResult.get(r) ?? [];
  if (names.length === 0) continue;
  console.log(`\n${QUALIFICATION_LABELS[r]}: ${names.length}`);
  for (const n of names.slice(0, 8)) console.log(`   · ${n}`);
  if (names.length > 8) console.log(`   … and ${names.length - 8} more`);
}

console.log('\n── Classification: before → after ────────────────────────');
const allClasses = new Set([...classBefore.keys(), ...classAfter.keys()]);
for (const k of [...allClasses].sort()) {
  console.log(`  ${k.padEnd(32)} ${String(classBefore.get(k) ?? 0).padStart(4)} → ${String(classAfter.get(k) ?? 0).padStart(4)}`);
}
console.log(`\nquarantined: ${quarantined}`);
console.log(`classification changed: ${changed}`);
