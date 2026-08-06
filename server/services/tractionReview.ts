import { getDb } from '../db/client';
import { getCompany } from '../db/repos/companies';
import { recordReviewDecision, saveScore } from '../db/repos/operations';
import { audit } from '../lib/guard';
import { scoreCompany } from '../../src/lib/scoring';
import {
  tractionNoteFor, tractionReviewSchema, tractionStateLevel, tractionStateScores,
  validateTractionReview, type TractionReviewInput, type TractionReviewRecord, type TractionState,
} from '../../shared/traction';
import type { Company } from '../../src/types';

/**
 * Applying an analyst traction review.
 *
 * The invariants, in one place because they are easy to break one at a
 * time:
 *
 *  1. APPEND-ONLY HISTORY. Every review is inserted into
 *     `traction_reviews` with the state it replaced. No row is ever
 *     updated or deleted.
 *  2. NO SILENT SCORING. A state that contributes points needs a source
 *     URL or a substantive note (shared/traction.ts
 *     validateTractionReview). A review that fails is rejected with the
 *     reasons, not downgraded and quietly saved.
 *  3. NON-SCORING STATES STAY UNKNOWN. 'unknown' and
 *     'no-public-traction' write a note the existing scorer still reads
 *     as unresearched, so the traction component stays unassessable and
 *     the record stays provisional.
 *  4. APPEND, NEVER OVERWRITE, THE SCORE. A new v4.1 scoring row is
 *     inserted; earlier rows are untouched.
 *  5. NEVER AUTO-HOT. Nothing here writes a review status, moves a CRM
 *     stage, marks a company High-Fit, syncs, or contacts anyone. A
 *     company becomes High-Fit only by scoring >= 8 non-provisionally
 *     under the unchanged rubric, which is decided by scoreCompany and
 *     read by the KPI — not by this function.
 */

export interface TractionReviewResult {
  ok: true;
  review: TractionReviewRecord;
  /** Present when the review changed something the score depends on. */
  score: { before: number | null; after: number; provisionalBefore: boolean | null; provisionalAfter: boolean } | null;
  scoreRowAppended: boolean;
}
export interface TractionReviewRejection {
  ok: false;
  errors: string[];
}

/** The company's current traction state, or 'unknown' when never reviewed. */
export function currentTractionState(companyId: string): TractionState {
  const row = getDb()
    .prepare('SELECT state FROM traction_reviews WHERE company_id = ? ORDER BY id DESC LIMIT 1')
    .get(companyId) as { state: string } | undefined;
  return (row?.state as TractionState) ?? 'unknown';
}

/** Full review history, newest first. Never filtered — this is the audit trail. */
export function tractionHistory(companyId: string): TractionReviewRecord[] {
  const rows = getDb().prepare(
    `SELECT id, company_id, state, previous_state, evidence_type, customer_name, verification,
            metric_value, source_url, analyst_note, evidence_date, confidence, missing_diligence, actor, at
     FROM traction_reviews WHERE company_id = ? ORDER BY id DESC`,
  ).all(companyId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    companyId: r.company_id as string,
    state: r.state as TractionState,
    previousState: (r.previous_state as TractionState | null) ?? null,
    evidenceType: r.evidence_type as TractionReviewRecord['evidenceType'],
    customerName: (r.customer_name as string | null) ?? null,
    verification: r.verification as TractionReviewRecord['verification'],
    metricValue: (r.metric_value as string | null) ?? null,
    sourceUrl: (r.source_url as string | null) ?? null,
    analystNote: (r.analyst_note as string | null) ?? null,
    evidenceDate: (r.evidence_date as string | null) ?? null,
    confidence: r.confidence as TractionReviewRecord['confidence'],
    missingDiligence: (r.missing_diligence as string | null) ?? null,
    actor: r.actor as string,
    at: r.at as string,
  }));
}

export function applyTractionReview(raw: unknown): TractionReviewResult | TractionReviewRejection {
  const parsed = tractionReviewSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const input: TractionReviewInput = parsed.data;

  const validation = validateTractionReview(input);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const company = getCompany(input.companyId);
  if (!company) return { ok: false, errors: [`No active company with id "${input.companyId}".`] };

  const db = getDb();
  const previousState = currentTractionState(input.companyId);
  const level = tractionStateLevel(input.state);
  const note = tractionNoteFor(input);
  const at = new Date().toISOString();

  const before = scoreCompany(company as unknown as Company);

  // One transaction: the review row, the company's current value, and
  // the review timestamp move together or not at all.
  db.exec('BEGIN');
  let reviewId: number;
  try {
    db.prepare(
      `INSERT INTO traction_reviews
        (company_id, state, previous_state, level, evidence_type, customer_name, verification,
         metric_value, source_url, analyst_note, evidence_date, confidence, missing_diligence, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.companyId, input.state, previousState, level, input.evidenceType, input.customerName,
      input.verification, input.metricValue, input.sourceUrl, input.analystNote, input.evidenceDate,
      input.confidence, input.missingDiligence, input.actor, at,
    );
    reviewId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

    db.prepare(
      'UPDATE companies SET traction_level = ?, traction_note = ?, traction_reviewed_at = ?, updated_at = ? WHERE id = ?',
    ).run(level, note, at, at, input.companyId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, errors: [`Failed to record the review: ${(e as Error).message}`] };
  }

  // Re-score from the UPDATED record, and APPEND. `saveScore` inserts;
  // no earlier scoring row is touched.
  const updated = getCompany(input.companyId)!;
  const after = scoreCompany(updated as unknown as Company);
  const changed = after.score !== before.score || after.provisional !== before.provisional;
  if (changed) {
    saveScore(input.companyId, after, updated.evidence.map((e) => e.url));
  }

  // A traction review is a deliberate, per-company human action, so it
  // belongs in the same log as a status change — which is also what
  // stamps companies.last_reviewed_at (see migration 14).
  recordReviewDecision({
    subjectType: 'company',
    subjectId: input.companyId,
    decision: 'traction-review',
    actor: input.actor,
    reason: `${previousState} → ${input.state} (${input.verification})`,
  });

  audit({
    provider: 'system', mode: 'local', action: 'traction-review',
    subject: input.companyId, outcome: 'ok',
    detail: `${company.name}: traction ${previousState} → ${input.state} (level ${level}/10, ${input.verification}, `
      + `confidence ${input.confidence}${input.sourceUrl ? `, source ${input.sourceUrl}` : ', no source URL'}). `
      + `Score ${before.score.toFixed(1)}${before.provisional ? ' provisional' : ''} → `
      + `${after.score.toFixed(1)}${after.provisional ? ' provisional' : ''}`
      + `${changed ? ' — new scoring row appended.' : ' — unchanged, no scoring row written.'} `
      + `Recorded by "${input.actor}" (unauthenticated actor string, not a verified identity). `
      + 'No CRM stage, sync, or outreach was triggered.',
  });

  return {
    ok: true,
    review: { ...input, id: reviewId, previousState, at },
    score: {
      before: before.score, after: after.score,
      provisionalBefore: before.provisional, provisionalAfter: after.provisional,
    },
    scoreRowAppended: changed,
  };
}

/** Does the traction component currently count toward this company's score? */
export function tractionCountsForScoring(companyId: string): boolean {
  return tractionStateScores(currentTractionState(companyId));
}
