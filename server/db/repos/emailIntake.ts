import { getDb } from '../client';

/**
 * Email-intake staging queue: a batch per paste-back submission, one
 * candidate row per company Claude reported inside it. See
 * server/services/emailIntake.ts for how a candidate gets here and how
 * it's promoted into a real company.
 */

const now = () => new Date().toISOString();

export type EmailIntakeCandidateStatus = 'pending' | 'promoted' | 'discarded';

export interface EmailIntakeCandidate {
  id: number;
  batchId: string;
  /** Claude's reported fields for this candidate, as later edited by a reviewer. Shaped like a partial ImportedCompany. */
  extracted: Record<string, unknown>;
  status: EmailIntakeCandidateStatus;
  promotedCompanyId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

function rowToCandidate(r: Record<string, unknown>): EmailIntakeCandidate {
  return {
    id: r.id as number,
    batchId: r.batch_id as string,
    extracted: JSON.parse(r.extracted_json as string) as Record<string, unknown>,
    status: r.status as EmailIntakeCandidateStatus,
    promotedCompanyId: (r.promoted_company_id as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export function createBatch(id: string, submittedBy: string): void {
  getDb().prepare('INSERT INTO email_intake_batches (id, submitted_by, submitted_at) VALUES (?, ?, ?)')
    .run(id, submittedBy, now());
}

export function insertCandidate(batchId: string, extracted: Record<string, unknown>): EmailIntakeCandidate {
  const db = getDb();
  const res = db.prepare(`
    INSERT INTO email_intake_candidates (batch_id, extracted_json, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `).run(batchId, JSON.stringify(extracted), now());
  return getCandidate(Number(res.lastInsertRowid))!;
}

export function getCandidate(id: number): EmailIntakeCandidate | null {
  const row = getDb().prepare('SELECT * FROM email_intake_candidates WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : null;
}

export function listCandidates(status?: EmailIntakeCandidateStatus): EmailIntakeCandidate[] {
  const db = getDb();
  const rows = (status
    ? db.prepare('SELECT * FROM email_intake_candidates WHERE status = ? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM email_intake_candidates ORDER BY id DESC').all()) as Record<string, unknown>[];
  return rows.map(rowToCandidate);
}

/** Merge a reviewer's edits into the candidate's extracted fields. Only 'pending' candidates may be edited. */
export function updateCandidateExtracted(id: number, extracted: Record<string, unknown>): { ok: boolean; error?: string } {
  const existing = getCandidate(id);
  if (!existing) return { ok: false, error: `No email-intake candidate with id ${id}.` };
  if (existing.status !== 'pending') {
    return { ok: false, error: `Candidate ${id} is already ${existing.status} — only a pending candidate can be edited.` };
  }
  getDb().prepare('UPDATE email_intake_candidates SET extracted_json = ? WHERE id = ?')
    .run(JSON.stringify(extracted), id);
  return { ok: true };
}

/**
 * Record promote/discard. Refuses to overwrite a decision already made —
 * same rule as `resolvePossibleDuplicate` in companies.ts, and for the
 * same reason: a second call must not silently erase the first reviewer's
 * decision.
 */
export function decideCandidate(
  id: number,
  status: 'promoted' | 'discarded',
  actor: string,
  opts: { promotedCompanyId?: string; note?: string | null } = {},
): { ok: boolean; error?: string; candidate?: EmailIntakeCandidate } {
  const existing = getCandidate(id);
  if (!existing) return { ok: false, error: `No email-intake candidate with id ${id}.` };
  if (existing.status !== 'pending') {
    return { ok: false, error: `Candidate ${id} was already ${existing.status}.` };
  }
  getDb().prepare(`
    UPDATE email_intake_candidates
    SET status = ?, promoted_company_id = ?, decided_by = ?, decided_at = ?, decision_note = ?
    WHERE id = ?
  `).run(status, opts.promotedCompanyId ?? null, actor, now(), opts.note ?? null, id);
  return { ok: true, candidate: getCandidate(id)! };
}
