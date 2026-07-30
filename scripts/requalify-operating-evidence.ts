/**
 * Requalify ONLY the records whose verdict could move under the
 * operating-evidence rule.
 *
 * `scripts/qualify-all.ts` re-evaluates all 209 records, which is the
 * wrong tool here for the reason its own sibling script already
 * documents: a transient network failure mid-pass would rewrite verdicts
 * for companies the rule change does not touch, demoting a real
 * opportunity because a DNS lookup blipped.
 *
 * The affected set is derived from stored state, never from a name list:
 * a company is affected when its CURRENT verdict rests on the old rule —
 * it is qualified, or it was sent to human review — because those are the
 * verdicts that counted a website as corroboration. Everything else
 * already fails for reasons this change does not alter.
 *
 * Dry run is the default and prints the table a reviewer needs before any
 * mutation: existing evidence, proposed verdict, shortlist impact. Pass
 * --apply to write.
 *
 * Idempotent: the verdict is a pure function of stored evidence plus the
 * live page, so applying twice over unchanged inputs leaves the same
 * verdict, the same classification, and no new history rows beyond the
 * first run's.
 *
 * Usage: npx tsx scripts/requalify-operating-evidence.ts [--apply] [--offline]
 */

import { getDb } from '../server/db/client';
import { getOpportunity, reclassifyCompany } from '../server/db/repos/opportunities';
import {
  assessCorroboration, hasStrongFinancingEvidence, qualifyIssuer,
  quarantine, quarantineReasonFor, recordClassificationChange, unquarantine,
} from '../server/services/issuerQualification';
import { buildShortlists } from '../server/services/shortlist';
import { CORE_VERTICAL_IDS } from '../src/data/taxonomy';
import {
  isDisqualified, QUALIFICATION_LABELS, WEBSITE_EVIDENCE_LABELS,
  type QualificationResult,
} from '../shared/qualification';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const OFFLINE = args.includes('--offline');

/**
 * Verdicts that were reachable only because a website counted as
 * corroboration. A record holding one of these is in scope; a record that
 * already failed on a cheaper, certain signal is not.
 */
const AFFECTED_RESULTS: QualificationResult[] = [
  'qualified-operating-company',
  'human-review-required',
];

interface Target { id: string; name: string; website: string | null; result: QualificationResult }

function listTargets(): Target[] {
  const placeholders = AFFECTED_RESULTS.map(() => '?').join(', ');
  return getDb().prepare(`
    SELECT c.id, c.name, c.website, q.result
    FROM issuer_qualification q
    JOIN companies c ON c.id = q.company_id
    WHERE q.result IN (${placeholders})
    ORDER BY c.name
  `).all(...AFFECTED_RESULTS) as unknown as Target[];
}

function shortlistMembership(): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of buildShortlists(CORE_VERTICAL_IDS)) {
    for (const c of s.selected) m.set(c.companyId, `selected (${s.vertical})`);
    for (const h of s.heldBack) m.set(h.companyId, `held back (${s.vertical}: ${h.reasonCode})`);
  }
  return m;
}

function totals() {
  const lists = buildShortlists(CORE_VERTICAL_IDS);
  const liveDeals = (getDb().prepare(
    `SELECT count(*) AS n FROM company_opportunity
     WHERE classification IN ('recent-financing-signal','credible-fundraising-signal','verified-current-opportunity')`,
  ).get() as { n: number }).n;
  return {
    liveDeals,
    selected: lists.reduce((n, s) => n + s.selected.length, 0),
    heldBack: lists.reduce((n, s) => n + s.heldBack.length, 0),
  };
}

const targets = listTargets();
const before = totals();
const membershipBefore = shortlistMembership();

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'}${OFFLINE ? ' [OFFLINE]' : ' [live website checks]'}\n`);
console.log(`Baseline: ${before.liveDeals} live deals, ${before.selected} shortlisted, ${before.heldBack} held back.`);
console.log(`${targets.length} records hold a verdict that could move under the operating-evidence rule.\n`);

interface Row {
  name: string;
  before: QualificationResult;
  after: QualificationResult;
  financing: string;
  operating: string;
  detail: string;
  shortlistBefore: string;
}
const rows: Row[] = [];

for (const t of targets) {
  const corr = assessCorroboration(t.id);
  const strong = hasStrongFinancingEvidence(t.id);
  const financing = [
    strong ? 'strong' : 'none',
    corr.independentFamilies.length > 0 ? corr.independentFamilies.join(' + ') : '(no independent family)',
    corr.selfPublished.length > 0 ? `[${corr.selfPublished.length} self-published excluded]` : '',
  ].filter(Boolean).join(' · ');

  const q = await qualifyIssuer(t.id, { offline: OFFLINE, dryRun: !APPLY });

  rows.push({
    name: t.name,
    before: t.result,
    after: q.result,
    financing,
    operating: WEBSITE_EVIDENCE_LABELS[q.operatingEvidence.level],
    detail: q.operatingEvidence.detail,
    shortlistBefore: membershipBefore.get(t.id) ?? '—',
  });

  if (APPLY) {
    const opportunityBefore = getOpportunity(t.id);
    if (isDisqualified(q.result) || q.result === 'insufficient-evidence') {
      quarantine(t.id, quarantineReasonFor(t.id, q));
    } else {
      unquarantine(t.id);
    }
    const opportunity = reclassifyCompany(t.id);
    if (opportunityBefore?.classification !== opportunity.classification || t.result !== q.result) {
      recordClassificationChange({
        companyId: t.id,
        previousClassification: opportunityBefore?.classification ?? null,
        newClassification: opportunity.classification,
        previousQualification: t.result,
        newQualification: q.result,
        reason:
          'Requalified under the operating-evidence rule (q2.0): a company\'s own website is no longer an '
          + 'independent financing source, and qualification now requires the issuer to describe an actual '
          + `operating business. Operating evidence: ${WEBSITE_EVIDENCE_LABELS[q.operatingEvidence.level]}. `
          + q.operatingEvidence.detail,
      });
    }
  }
}

// ── The table ────────────────────────────────────────────────────

const changed = rows.filter((r) => r.before !== r.after);
const unchanged = rows.filter((r) => r.before === r.after);

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
console.log(
  `${pad('COMPANY', 32)}${pad('BEFORE', 30)}${pad('AFTER', 30)}${pad('FINANCING', 40)}${pad('OPERATING EVIDENCE', 32)}SHORTLIST (BEFORE)`,
);
console.log('-'.repeat(196));
for (const r of [...changed, ...unchanged]) {
  console.log(
    pad(r.name, 32)
    + pad(QUALIFICATION_LABELS[r.before], 30)
    + pad(QUALIFICATION_LABELS[r.after], 30)
    + pad(r.financing, 40)
    + pad(r.operating, 32)
    + r.shortlistBefore,
  );
}

console.log(`\n${changed.length} of ${rows.length} verdicts change; ${unchanged.length} stay as they are.`);

const byTransition = new Map<string, number>();
for (const r of changed) {
  const k = `${QUALIFICATION_LABELS[r.before]} → ${QUALIFICATION_LABELS[r.after]}`;
  byTransition.set(k, (byTransition.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byTransition].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`);

console.log('\nWhy each changed record moved:');
for (const r of changed) console.log(`  ${r.name}: ${r.detail}`);

if (APPLY) {
  const after = totals();
  console.log(`\nLive deals   ${before.liveDeals} → ${after.liveDeals}`);
  console.log(`Shortlisted  ${before.selected} → ${after.selected}`);
  console.log(`Held back    ${before.heldBack} → ${after.heldBack}`);
} else {
  console.log('\nNothing was written. Re-run with --apply to persist.');
}
