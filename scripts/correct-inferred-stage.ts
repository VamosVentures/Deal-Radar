#!/usr/bin/env -S npx tsx
/**
 * Undo an unsourced stage inference that was scoring itself.
 *
 *   npm run db:correct-stage -- --dry-run    # report only, writes nothing
 *   npm run db:correct-stage                 # apply
 *
 * WHAT WENT WRONG
 *
 * `stageResolver` falls back to `early-stage-round-not-disclosed` when
 * nothing on record names a round, and says so in its own explanation:
 * "Recorded as early-stage with the round undisclosed because the company
 * is in an early-stage pipeline, not because any evidence establishes
 * it." The enrichment pass then stamped that label onto `companies.stage`
 * — the column the scorer reads — where it is worth 9/15 and counts as
 * `assessable`, which ALSO removed `stage` from `missingCritical` and
 * helped companies clear the non-provisional gate.
 *
 * On this database that was 195 of 209 companies, every one from an
 * `inferred` resolution and not one from an explicit source. In effect a
 * founding year, a team size and an accelerator batch were being
 * converted into most of a stage score across 93% of the portfolio.
 *
 * server/services/enrichment.ts no longer stamps it. This corrects the
 * rows already written by the old behaviour.
 *
 * WHAT THIS DOES AND DOES NOT TOUCH
 *
 * Corrects a row only when ALL of these hold:
 *   - `companies.stage` is the residual label;
 *   - the stored resolution for that company is `inferred`, not explicit;
 *   - the field provenance for `stage` is machine-written (`extracted`),
 *     never `user-entered` or `verified`.
 *
 * So an analyst's correction and a human-confirmed stage both survive
 * untouched — the provenance check is enforced by `applyFieldUpdate`
 * itself, not re-implemented here.
 *
 * The inference is NOT deleted. It stays in `company_stage_resolution`
 * with its confidence and explanation, and stays visible to an analyst,
 * who can record the real stage. What it stops doing is scoring itself.
 *
 * Scores are re-computed APPEND-ONLY: a new `scoring_results` row per
 * company, no UPDATE and no DELETE, so every historical score survives
 * exactly as written. Re-running is a no-op, because a corrected row no
 * longer carries the residual label.
 */
import { getDb } from '../server/db/client';
import { applyFieldUpdate, getProvenance, listCompanies } from '../server/db/repos/companies';
import { saveScore, latestScore } from '../server/db/repos/operations';
import { audit } from '../server/lib/guard';
import { scoreCompany } from '../src/lib/scoring';
import { STAGE_LABELS } from '../shared/enrichment';
import type { Company } from '../src/types';

const DRY_RUN = process.argv.includes('--dry-run');
const RESIDUAL_LABEL = STAGE_LABELS['early-stage-round-not-disclosed'];

interface Candidate {
  id: string;
  name: string;
  basis: string;
  confidence: number;
  provenanceOrigin: string;
}

function findAffected(): { correctable: Candidate[]; protectedByProvenance: Candidate[]; explicit: Candidate[] } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.id, c.name, r.basis, r.confidence
    FROM companies c
    LEFT JOIN company_stage_resolution r ON r.company_id = c.id
    WHERE c.stage = ?
    ORDER BY c.id
  `).all(RESIDUAL_LABEL) as { id: string; name: string; basis: string | null; confidence: number | null }[];

  const correctable: Candidate[] = [];
  const protectedByProvenance: Candidate[] = [];
  const explicit: Candidate[] = [];

  for (const r of rows) {
    const prov = getProvenance(r.id, 'stage');
    const c: Candidate = {
      id: r.id, name: r.name,
      basis: r.basis ?? 'no-resolution-on-record',
      confidence: r.confidence ?? 0,
      provenanceOrigin: prov?.origin ?? 'none',
    };
    // An explicitly resolved stage that happens to carry this label was
    // stated by a source. Left alone.
    if (r.basis === 'explicit') { explicit.push(c); continue; }
    // A human's value is never rewritten by a script.
    if (prov && (prov.origin === 'user-entered' || prov.origin === 'verified')) {
      protectedByProvenance.push(c);
      continue;
    }
    correctable.push(c);
  }
  return { correctable, protectedByProvenance, explicit };
}

function main() {
  const { correctable, protectedByProvenance, explicit } = findAffected();

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Unsourced stage correction — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
  console.log('='.repeat(72));
  console.log(`Rows carrying "${RESIDUAL_LABEL}": ${correctable.length + protectedByProvenance.length + explicit.length}`);
  console.log(`  correctable (inferred + machine-written) .. ${correctable.length}`);
  console.log(`  left alone (explicit resolution) ......... ${explicit.length}`);
  console.log(`  left alone (human provenance) ............ ${protectedByProvenance.length}`);

  if (correctable.length === 0) {
    console.log('\nNothing to correct. (Re-running this script is a no-op by design.)');
    return;
  }

  if (DRY_RUN) {
    console.log('\nFirst 10 that would be corrected:');
    for (const c of correctable.slice(0, 10)) {
      const before = latestScore(c.id);
      console.log(`  ${c.id.padEnd(22)} ${c.name.slice(0, 28).padEnd(30)} basis=${c.basis} conf=${c.confidence} `
        + `score=${before ? `${before.score}${before.provisional ? ' (provisional)' : ''}` : 'none'}`);
    }
    console.log('\nNothing was written.');
    return;
  }

  const db = getDb();
  const skipped: { id: string; reason: string }[] = [];
  let corrected = 0;
  const before = new Map<string, { score: number; provisional: boolean }>();
  const after = new Map<string, { score: number; provisional: boolean }>();

  for (const c of correctable) {
    const prev = latestScore(c.id);
    if (prev) before.set(c.id, { score: prev.score, provisional: prev.provisional });

    /**
     * `applyFieldUpdate` is the gate, not a convenience: it re-checks
     * provenance precedence and writes the new provenance row, so a
     * human value cannot be clobbered even if the query above were wrong.
     */
    const res = applyFieldUpdate(
      c.id, 'stage', 'Unknown', 'extracted',
      'correction: stage was an unsourced inference (stageResolver residual, basis=inferred) and must not score itself',
    );
    if (!res.applied) {
      skipped.push({ id: c.id, reason: res.reason ?? 'not applied' });
      continue;
    }
    corrected += 1;
  }

  /**
   * Re-score after every stage correction has landed, in one transaction
   * per batch. Append-only: `saveScore` INSERTs, so the pre-correction
   * row remains the historical record of what the dashboard used to show.
   */
  const companies = listCompanies().filter((c) => correctable.some((x) => x.id === c.id));
  db.exec('BEGIN');
  try {
    for (const company of companies) {
      const fit = scoreCompany(company as unknown as Company);
      saveScore(company.id, fit, company.evidence.map((e) => e.url));
      after.set(company.id, { score: fit.score, provisional: fit.provisional });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // ── Report ──────────────────────────────────────────────────────
  let becameProvisional = 0;
  let totalDelta = 0;
  let counted = 0;
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) continue;
    if (!b.provisional && a.provisional) becameProvisional += 1;
    totalDelta += a.score - b.score;
    counted += 1;
  }

  console.log(`\nCorrected .................. ${corrected}`);
  console.log(`Skipped .................... ${skipped.length}`);
  console.log(`Re-scored (append-only) .... ${after.size}`);
  const mean = counted > 0 ? totalDelta / counted : 0;
  console.log(`Mean score change .......... ${counted > 0 ? mean.toFixed(2) : 'n/a'}`);
  console.log(`Became provisional ......... ${becameProvisional}`);

  /**
   * Report the measured direction rather than asserting one.
   *
   * The intuition here is wrong, and worth writing down: removing a
   * component worth 9/15 does NOT necessarily lower the score, because
   * the score is normalised over ASSESSABLE points. Dropping `stage`
   * shrinks the numerator and the denominator together, so a company
   * scoring near 60% on that component barely moves. Measured on this
   * database the mean change was about +0.02 and no company's provisional
   * status changed — every one was already provisional for other missing
   * components.
   *
   * So the fix matters for CORRECTNESS (an unsourced inference was
   * feeding the scorer and marking a required component assessable), not
   * because it deflates a leaderboard. Claiming a deflation that did not
   * happen would be its own false statement.
   */
  console.log(
    `\n${Math.abs(mean) < 0.05
      ? 'Scores barely moved: the score normalises over ASSESSABLE points, so dropping a component '
        + 'shrinks numerator and denominator together. The correction is about not scoring an unsourced '
        + 'inference, and about `stage` correctly counting as a GAP again — not about moving the ranking.'
      : `Mean score moved by ${mean.toFixed(2)} now that a stage nobody stated no longer scores itself.`}`,
  );
  console.log(`Companies whose stage is now an honest gap: ${corrected}.`);
  for (const s of skipped.slice(0, 10)) console.log(`  skipped ${s.id}: ${s.reason}`);

  audit({
    provider: 'system', mode: 'local', action: 'stage-inference-correction',
    subject: `${corrected} company/companies`, outcome: 'ok',
    detail: `Cleared the unsourced residual stage label from ${corrected} company row(s) and re-scored them `
      + `append-only. ${explicit.length} explicit resolution(s) and ${protectedByProvenance.length} human-provenance `
      + 'value(s) were left untouched. The inference remains in company_stage_resolution with its confidence and '
      + 'explanation; it simply no longer feeds the score.',
  });
}

try {
  main();
} catch (e) {
  console.error(`\nCorrection failed: ${(e as Error).message}`);
  process.exit(1);
}
