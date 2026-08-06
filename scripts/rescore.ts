#!/usr/bin/env -S npx tsx
/**
 * npm run db:rescore              — report what is stale (writes nothing)
 * npm run db:rescore -- --preview — full old-vs-new comparison (writes nothing)
 * npm run db:rescore -- --apply   — back up, then append re-scored rows
 *
 * See server/services/rescore.ts for the append-only / resumable design.
 * `--apply` REFUSES to run without a successful backup first, and
 * verifies afterwards that every pre-existing scoring_results row is
 * still present before reporting success.
 */
import { applyRescore, findOutdatedScores, previewRescore, rescoreStatus } from '../server/services/rescore';
import { createBackup } from '../server/services/backup';
import { getDbPath } from '../server/db/client';
import { SCORING_VERSION } from '../src/lib/scoring';
import { HOT_THRESHOLD } from '../shared/scoringThresholds';

const args = process.argv.slice(2);
const wantPreview = args.includes('--preview');
const wantApply = args.includes('--apply');

function band(s: number): string {
  if (s < 2) return '1.0-1.9';
  if (s < 3) return '2.0-2.9';
  if (s < 4) return '3.0-3.9';
  if (s < 5) return '4.0-4.9';
  if (s < 6) return '5.0-5.9';
  if (s < 6.5) return '6.0-6.4';
  if (s < 7) return '6.5-6.9';
  if (s < 8) return '7.0-7.9';
  if (s < 9) return '8.0-8.9';
  return '9.0-10';
}

function distribution(scores: number[]): string[] {
  const buckets = new Map<string, number>();
  for (const s of scores) buckets.set(band(s), (buckets.get(band(s)) ?? 0) + 1);
  return [...buckets.entries()].sort().map(([b, n]) => `  ${b.padEnd(9)} ${n}`);
}

async function main(): Promise<void> {
  console.log(`Database: ${getDbPath()}`);
  console.log(`Current scoring model: ${SCORING_VERSION}\n`);

  const status = rescoreStatus();
  console.log('── Stale-score status ──────────────────────────────────');
  console.log(`  companies (active) .......... ${status.totalCompanies}`);
  console.log(`  with a stored score ......... ${status.scored}`);
  console.log(`  never scored ................ ${status.unscored}`);
  console.log(`  already on ${SCORING_VERSION} ... ${status.upToDate}`);
  console.log(`  NEEDS RE-SCORING ............ ${status.needsRescore}`);
  for (const [v, n] of Object.entries(status.staleByVersion)) console.log(`      ${n} on "${v}"`);

  if (status.needsRescore === 0) {
    console.log('\nNothing to do — every scored company is already on the current model.');
    return;
  }

  if (!wantPreview && !wantApply) {
    console.log('\nRun with --preview to see old-vs-new, or --apply to write (backs up first).');
    return;
  }

  const comparisons = previewRescore();
  const before = comparisons.map((c) => c.before.score);
  const after = comparisons.map((c) => c.after.score);
  const provBefore = comparisons.filter((c) => c.before.provisional).length;
  const provAfter = comparisons.filter((c) => c.after.provisional).length;

  console.log('\n── Preview: stored vs recomputed ───────────────────────');
  console.log('BEFORE (stored):');
  distribution(before).forEach((l) => console.log(l));
  console.log(`  provisional: ${provBefore}/${comparisons.length}`);
  console.log(`  >= ${HOT_THRESHOLD}.0 non-provisional: ${comparisons.filter((c) => c.before.score >= HOT_THRESHOLD && !c.before.provisional).length}`);
  console.log('AFTER (recomputed):');
  distribution(after).forEach((l) => console.log(l));
  console.log(`  provisional: ${provAfter}/${comparisons.length}`);
  console.log(`  >= ${HOT_THRESHOLD}.0 non-provisional: ${comparisons.filter((c) => c.after.score >= HOT_THRESHOLD && !c.after.provisional).length}`);
  console.log(`  records whose provisional flag changes: ${comparisons.filter((c) => c.provisionalChanged).length}`);

  const biggest = [...comparisons].sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta)).slice(0, 10);
  console.log('\n  largest score movements:');
  for (const c of biggest) {
    console.log(
      `    ${c.name.slice(0, 34).padEnd(34)} ${c.before.score.toFixed(1)} → ${c.after.score.toFixed(1)}`
      + ` (${c.scoreDelta >= 0 ? '+' : ''}${c.scoreDelta.toFixed(1)})`
      + `  ${c.before.provisional ? 'prov' : 'firm'} → ${c.after.provisional ? 'prov' : 'firm'}`,
    );
  }

  if (!wantApply) {
    console.log('\nPreview only — nothing was written. Re-run with --apply to commit.');
    return;
  }

  console.log('\n── Applying ────────────────────────────────────────────');
  const backup = await createBackup('cli:rescore-pre-apply');
  if (!backup.ok) {
    console.error(`Refusing to apply: backup failed (${backup.error}).`);
    process.exit(1);
  }
  console.log(`  backup: ${backup.backup.file} (${(backup.backup.sizeBytes / 1024).toFixed(1)} KB, schema v${backup.backup.schemaVersion})`);

  const result = applyRescore({ actor: `cli:${process.env.USER ?? 'unknown'}` });
  console.log(`  attempted ................... ${result.attempted}`);
  console.log(`  written (new rows appended) . ${result.written}`);
  console.log(`  batches committed ........... ${result.batches}`);
  console.log(`  skipped ..................... ${result.skipped.length}`);
  for (const s of result.skipped) console.log(`      ${s.companyId}: ${s.reason}`);
  console.log(`  scoring_results rows ........ ${result.historicalRowsBefore} → ${result.historicalRowsAfter}`);
  console.log(`  every prior row preserved ... ${result.historyPreserved ? 'yes' : 'NO — HISTORY LOSS'}`);

  const remaining = findOutdatedScores().length;
  console.log(`  still stale after apply ..... ${remaining}`);

  if (!result.historyPreserved || result.skipped.length > 0 || remaining > 0) {
    console.error('\nApply did NOT meet every check. Investigate before trusting the dashboard.');
    process.exit(1);
  }
  console.log('\nApplied. Score history preserved; the dashboard now reads the current model.');
}

main().catch((e) => {
  console.error(`Re-score failed: ${(e as Error).message}`);
  process.exit(1);
});
