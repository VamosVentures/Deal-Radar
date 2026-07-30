/**
 * Qualify ONLY the companies that have no qualification verdict yet.
 *
 * `scripts/qualify-all.ts` re-evaluates all 209 records. That is the right
 * tool when the RULES change, and the wrong tool when a batch of imports
 * simply never got a verdict: it spends hundreds of live requests, and a
 * transient network failure during the pass would rewrite a verdict for a
 * company that was previously verified — demoting a real opportunity
 * because a DNS lookup blipped.
 *
 * So this script is deliberately narrow. It selects the companies with no
 * row in `issuer_qualification`, live-checks those and only those, and
 * never writes to a company that already has a verdict. Absence of a
 * verdict is the one state that cannot be made worse by re-deriving it.
 *
 * Usage: npx tsx scripts/qualify-pending.ts [--offline] [--dry-run]
 */

import { getDb } from '../server/db/client';
import { getOpportunity, reclassifyCompany } from '../server/db/repos/opportunities';
import {
  getQualification, qualifyIssuer, quarantine, quarantineReasonFor,
  recordClassificationChange, unquarantine,
} from '../server/services/issuerQualification';
import {
  isDisqualified, QUALIFICATION_LABELS, type QualificationResult,
} from '../shared/qualification';

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const DRY_RUN = args.includes('--dry-run');

interface Pending { id: string; name: string; website: string | null }

/** Companies with no verdict row. Derived from persisted state, never a name list. */
function listPending(): Pending[] {
  return getDb().prepare(`
    SELECT c.id, c.name, c.website
    FROM companies c
    WHERE NOT EXISTS (SELECT 1 FROM issuer_qualification q WHERE q.company_id = c.id)
    ORDER BY c.name
  `).all() as unknown as Pending[];
}

const pending = listPending();
const totalCompanies = (getDb().prepare('SELECT count(*) AS c FROM companies').get() as { c: number }).c;

console.log(`${totalCompanies} companies in the database.`);
console.log(`${pending.length} have no qualification verdict and will be checked${OFFLINE ? ' [OFFLINE]' : ' live'}.`);
console.log(`${totalCompanies - pending.length} already have a verdict and will NOT be touched.\n`);

if (pending.length === 0) {
  console.log('Nothing to do — every company already has a verdict.');
  process.exit(0);
}
for (const p of pending) console.log(`  · ${p.name}${p.website ? '' : '  (no website on record)'}`);

if (DRY_RUN) {
  console.log('\n--dry-run: no changes written.');
  process.exit(0);
}

const byResult = new Map<QualificationResult, string[]>();
let quarantined = 0;
let changed = 0;
const failures: string[] = [];

console.log('');
for (const [i, c] of pending.entries()) {
  const before = getOpportunity(c.id);
  const beforeQual = getQualification(c.id);

  let q;
  try {
    q = await qualifyIssuer(c.id, { offline: OFFLINE });
  } catch (err) {
    // A thrown check is not a verdict. Leaving the row absent keeps the
    // cautious default (never a live opportunity) rather than persisting a
    // verdict derived from an error.
    failures.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${c.name} — check failed, no verdict written`);
    continue;
  }

  const list = byResult.get(q.result) ?? [];
  list.push(c.name);
  byResult.set(q.result, list);

  if (isDisqualified(q.result) || q.result === 'insufficient-evidence') {
    quarantine(c.id, quarantineReasonFor(c.id, q));
    quarantined++;
  } else {
    unquarantine(c.id);
  }

  const after = reclassifyCompany(c.id);
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

  console.log(`  ${i + 1}/${pending.length} ${c.name} → ${QUALIFICATION_LABELS[q.result]}`
    + ` (confidence ${q.operatingConfidence}, ${q.corroboratingSources.length} independent source(s))`);
}

console.log('\n── Verdicts ──────────────────────────────────────────────');
const order: QualificationResult[] = [
  'qualified-operating-company', 'human-review-required',
  'company-lead-requires-corroboration', 'insufficient-evidence',
  'public-company', 'investment-fund', 'spv-or-project-entity',
  'corporate-subsidiary', 'unverified-foreign-entity', 'not-a-company-name',
];
for (const r of order) {
  const names = byResult.get(r) ?? [];
  if (names.length === 0) continue;
  console.log(`\n${QUALIFICATION_LABELS[r]}: ${names.length}`);
  for (const n of names) console.log(`   · ${n}`);
}

console.log(`\nquarantined: ${quarantined}`);
console.log(`classification changed: ${changed}`);
if (failures.length > 0) {
  console.log(`\ncheck failures (no verdict written, still pending): ${failures.length}`);
  for (const f of failures) console.log(`   · ${f}`);
}

const stillPending = listPending().length;
console.log(`\nremaining without a verdict: ${stillPending}`);
if (stillPending > 0) process.exitCode = 1;
