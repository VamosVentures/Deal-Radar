/**
 * Founder / vertical / stage enrichment.
 *
 * Researches every applicable company across the public source families
 * in shared/enrichment.ts, records what each source said (including when
 * it said nothing, and when it did not respond), and writes a resolution
 * for the founder, the sector, and the stage.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --apply. A dry run
 * still performs the research — it has to, or the preview would be
 * fiction — but the database is untouched, so you can read the summary
 * and decide.
 *
 * Usage:
 *   npx tsx scripts/enrich-companies.ts                       # dry run, all companies
 *   npx tsx scripts/enrich-companies.ts --apply               # write
 *   npx tsx scripts/enrich-companies.ts --company-id <id>     # one company (repeatable)
 *   npx tsx scripts/enrich-companies.ts --limit 25            # first N
 *   npx tsx scripts/enrich-companies.ts --resume              # only never-researched companies
 *   npx tsx scripts/enrich-companies.ts --max-requests 400    # per-run network budget
 *   npx tsx scripts/enrich-companies.ts --concurrency 8       # companies researched at once
 *   npx tsx scripts/enrich-companies.ts --quiet               # summary only
 *
 * Retry and backoff are handled inside sourcing/politeness.ts: one
 * request at a time per host, a minimum gap, honoured Retry-After,
 * bounded exponential backoff with jitter, and a hard per-run request
 * budget. This script never retries around those decisions.
 */

import os from 'node:os';
import { runEnrichment } from '../server/services/enrichment';
import {
  FOUNDER_STATUS_LABELS, SECTOR_LABELS, STAGE_LABELS, isClassified,
  type FounderResolutionStatus,
} from '../shared/enrichment';

const args = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function flagValues(name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && args[i + 1]) out.push(args[i + 1]); });
  return out;
}

const APPLY = args.includes('--apply');
const RESUME = args.includes('--resume');
const QUIET = args.includes('--quiet');
const COMPANY_IDS = flagValues('--company-id');
const LIMIT = Number(flagValue('--limit')) || undefined;
const MAX_REQUESTS = Number(flagValue('--max-requests')) || 600;
const CONCURRENCY = Number(flagValue('--concurrency')) || 8;

const initiatedBy = `cli:${os.userInfo().username}`;

const scopeText = COMPANY_IDS.length > 0
  ? `${COMPANY_IDS.length} named company id(s)`
  : RESUME ? 'resume — companies with no prior research attempt'
    : LIMIT ? `first ${LIMIT} active companies`
      : 'all active companies';

console.log('Founder / vertical / stage enrichment');
console.log(`  Mode:            ${APPLY ? 'APPLY — the database WILL be written' : 'DRY RUN — nothing will be written'}`);
console.log(`  Scope:           ${scopeText}`);
console.log(`  Request budget:  ${MAX_REQUESTS} network requests`);
console.log(`  Concurrency:     ${CONCURRENCY} companies at once (per-host politeness is unaffected)`);
console.log('');

const result = await runEnrichment({
  apply: APPLY,
  companyIds: COMPANY_IDS.length > 0 ? COMPANY_IDS : undefined,
  limit: LIMIT,
  resume: RESUME,
  maxRequests: MAX_REQUESTS,
  concurrency: CONCURRENCY,
  initiatedBy,
  onProgress: QUIET ? undefined : (line) => console.log(`  · ${line}`),
});

// ── Summary ───────────────────────────────────────────────────────
//
// Every number below is counted from what the run actually produced.
// Nothing is estimated, and a source that failed is reported as a
// failure rather than folded into a "not found" bucket.

const founderCounts = new Map<FounderResolutionStatus, number>();
for (const c of result.companies) {
  founderCounts.set(c.founderStatus, (founderCounts.get(c.founderStatus) ?? 0) + 1);
}

console.log('\n─────────────────────────────────────────────');
console.log(`Run ${result.runId} — ${result.status}`);
console.log(`Companies attempted:  ${result.totals.companiesAttempted}`);
console.log(`Network requests:     ${result.requestsSpent} of ${MAX_REQUESTS} budgeted`);

console.log('\nFounder resolution');
for (const [status, label] of Object.entries(FOUNDER_STATUS_LABELS)) {
  const n = founderCounts.get(status as FounderResolutionStatus) ?? 0;
  if (n > 0) console.log(`  ${label.padEnd(46)} ${n}`);
}

console.log('\nVertical classification');
const sectorCounts = new Map<string, number>();
for (const c of result.companies) {
  const s = c.vertical.primarySector;
  sectorCounts.set(s, (sectorCounts.get(s) ?? 0) + 1);
}
for (const [sector, n] of [...sectorCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const label = isClassified(sector as never) ? SECTOR_LABELS[sector as never] : 'Not classifiable — identity unresolved';
  const inferred = result.companies.filter((c) => c.vertical.primarySector === sector && c.vertical.basis === 'inferred').length;
  console.log(`  ${String(label).padEnd(46)} ${n}${inferred > 0 ? `  (${inferred} inferred)` : ''}`);
}

console.log('\nStage resolution');
const stageCounts = new Map<string, number>();
for (const c of result.companies) {
  stageCounts.set(c.stage.stage, (stageCounts.get(c.stage.stage) ?? 0) + 1);
}
for (const [stage, n] of [...stageCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const inferred = result.companies.filter((c) => c.stage.stage === stage && c.stage.basis === 'inferred').length;
  const label: string = STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? stage;
  console.log(`  ${label.padEnd(46)} ${n}${inferred > 0 ? `  (${inferred} inferred)` : ''}`);
}

// ── Per-source errors ─────────────────────────────────────────────
if (result.sourceErrors.length > 0) {
  console.log('\nSource errors (reported, not retried past the politeness policy)');
  for (const e of result.sourceErrors.sort((a, b) => b.count - a.count)) {
    console.log(`  ${e.count}×  ${e.detail}`);
  }
} else {
  console.log('\nSource errors: none.');
}

// ── Changed decisions ─────────────────────────────────────────────
if (APPLY) {
  const changed = result.companies.filter((c) => c.changes.length > 0);
  console.log(`\nChanged verdicts: ${changed.length} company/companies`);
  for (const c of changed.slice(0, 40)) {
    for (const ch of c.changes) {
      console.log(`  ${c.companyName}: ${ch.field} ${ch.previous ?? '(none)'} → ${ch.next}`);
    }
  }
  if (changed.length > 40) console.log(`  … and ${changed.length - 40} more (query company_founder_resolution / _vertical_classification / _stage_resolution).`);
} else {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to persist these results.');
}

// ── Remaining manual work ─────────────────────────────────────────
const manual = result.companies.filter((c) =>
  c.founderStatus === 'manual-review-required' || c.founderStatus === 'conflicting-founder-evidence');
if (manual.length > 0) {
  console.log(`\nRequiring a human: ${manual.length}`);
  for (const c of manual.slice(0, 20)) {
    console.log(`  ${c.companyName} — ${c.founderNextAction}`);
  }
  if (manual.length > 20) console.log(`  … and ${manual.length - 20} more. See the Stealth Founder Radar.`);
}

/**
 * The database is deliberately NOT closed here.
 *
 * The operational store (server/lib/store.ts) defers its write by 25ms,
 * so closing the connection on the last line raced that timer and the
 * run ended with "database is not open" — after the enrichment data had
 * been written, but before the audit entry was. Every other script in
 * this directory simply lets the process exit once the pending timer has
 * flushed, which is the behaviour that keeps the audit trail intact.
 */
