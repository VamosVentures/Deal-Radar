import { getDb } from '../client';

/**
 * Intake staging queue: a batch per submission — a forwarded email, or
 * (since migration 26) an uploaded CSV/Excel file read by "Import with
 * Claude" — and one candidate row per company Claude reported inside it.
 * See server/services/emailIntake.ts for how a candidate gets here and
 * how it's promoted into a real company, and server/services/fileImport.ts
 * for file batches.
 */

const now = () => new Date().toISOString();

export type EmailIntakeCandidateStatus = 'pending' | 'promoted' | 'discarded';
export type IntakeBatchSource = 'email' | 'file';
export type IntakeBatchStatus = 'done' | 'running' | 'failed' | 'interrupted';

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
  /** Where the candidate's batch came from: a forwarded email or an uploaded CSV/Excel file. */
  source: IntakeBatchSource;
  /** The uploaded file's name, for a 'file' batch. */
  fileName: string | null;
}

export interface IntakeBatch {
  id: string;
  submittedBy: string;
  submittedAt: string;
  source: IntakeBatchSource;
  fileName: string | null;
  status: IntakeBatchStatus;
  chunksTotal: number;
  chunksDone: number;
  error: string | null;
  finishedAt: string | null;
  summary: Record<string, unknown> | null;
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
    source: (r.batch_source as IntakeBatchSource | null) ?? 'email',
    fileName: (r.batch_file_name as string | null) ?? null,
  };
}

function rowToBatch(r: Record<string, unknown>): IntakeBatch {
  return {
    id: r.id as string,
    submittedBy: r.submitted_by as string,
    submittedAt: r.submitted_at as string,
    source: (r.source as IntakeBatchSource) ?? 'email',
    fileName: (r.file_name as string | null) ?? null,
    status: (r.status as IntakeBatchStatus) ?? 'done',
    chunksTotal: Number(r.chunks_total ?? 0),
    chunksDone: Number(r.chunks_done ?? 0),
    error: (r.error as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    summary: r.summary_json ? JSON.parse(r.summary_json as string) as Record<string, unknown> : null,
  };
}

const CANDIDATE_SELECT = `
  SELECT c.*, b.source AS batch_source, b.file_name AS batch_file_name
  FROM email_intake_candidates c
  LEFT JOIN email_intake_batches b ON b.id = c.batch_id
`;

export function createBatch(
  id: string,
  submittedBy: string,
  opts: {
    source?: IntakeBatchSource;
    fileName?: string | null;
    status?: IntakeBatchStatus;
    chunksTotal?: number;
    summary?: Record<string, unknown>;
  } = {},
): void {
  getDb().prepare(`
    INSERT INTO email_intake_batches (id, submitted_by, submitted_at, source, file_name, status, chunks_total, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, submittedBy, now(), opts.source ?? 'email', opts.fileName ?? null, opts.status ?? 'done',
    opts.chunksTotal ?? 0, opts.summary ? JSON.stringify(opts.summary) : null,
  );
}

export function getBatch(id: string): IntakeBatch | null {
  const row = getDb().prepare('SELECT * FROM email_intake_batches WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToBatch(row) : null;
}

/** Append a line to a batch's error log (newest last) — a reviewer needs to know which rows were not read. */
function appendError(id: string, error: string): void {
  getDb().prepare(`
    UPDATE email_intake_batches
    SET error = CASE WHEN error IS NULL THEN ? ELSE error || char(10) || ? END
    WHERE id = ?
  `).run(error, error, id);
}

/** Record one more chunk of a file batch as processed — successfully, or with the error that stopped it. */
export function recordBatchChunkDone(id: string, error?: string | null): void {
  getDb().prepare('UPDATE email_intake_batches SET chunks_done = chunks_done + 1 WHERE id = ?').run(id);
  if (error) appendError(id, error);
}

export function finishBatch(id: string, status: Exclude<IntakeBatchStatus, 'running'>, error?: string | null): void {
  getDb().prepare('UPDATE email_intake_batches SET status = ?, finished_at = ? WHERE id = ?').run(status, now(), id);
  if (error) appendError(id, error);
}

/** File batches still marked running. */
export function listRunningBatchIds(): string[] {
  return (getDb().prepare("SELECT id FROM email_intake_batches WHERE status = 'running'").all() as { id: string }[])
    .map((r) => r.id);
}

export function countCandidatesInBatch(batchId: string): number {
  return Number((getDb().prepare('SELECT COUNT(*) AS n FROM email_intake_candidates WHERE batch_id = ?').get(batchId) as { n: number }).n);
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
  const row = getDb().prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : null;
}

export function listCandidates(status?: EmailIntakeCandidateStatus): EmailIntakeCandidate[] {
  const db = getDb();
  const rows = (status
    ? db.prepare(`${CANDIDATE_SELECT} WHERE c.status = ? ORDER BY c.id DESC`).all(status)
    : db.prepare(`${CANDIDATE_SELECT} ORDER BY c.id DESC`).all()) as Record<string, unknown>[];
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
