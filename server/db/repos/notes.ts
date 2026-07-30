import crypto from 'node:crypto';
import { getDb } from '../client';
import { normalizeNoteBody, type CompanyNote, type Reviewer, type ReviewerSource } from '../../../shared/notes';

/**
 * Internal company review notes.
 *
 * Notes are the investment team's own opinion about a company, kept
 * apart from `evidence` (which is sourced, cited, and append-only) both
 * conceptually and physically — see migration v10. Nothing here is ever
 * deleted: `archive` and `restore` move a note between two states, so a
 * note that shaped a decision is still readable afterwards.
 *
 * Every function takes already-validated input. Normalization and the
 * length limit are enforced by shared/notes.ts at the route boundary so
 * the browser's character counter counts the same thing the database
 * stores; `create`/`edit` normalize again anyway, because a repository
 * that trusts its caller to have done that is one refactor away from
 * storing whatever it is handed.
 */

const now = () => new Date().toISOString();

interface NoteRow {
  id: string;
  company_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  archived: number;
  archived_at: string | null;
  reviewer_id: string;
  reviewer_label: string;
  reviewer_source: string;
}

function rowToNote(row: NoteRow): CompanyNote {
  return {
    id: row.id,
    companyId: row.company_id,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    archivedAt: row.archived_at,
    reviewer: {
      id: row.reviewer_id,
      label: row.reviewer_label,
      // Widened at the boundary rather than trusted: a row written by a
      // future build under an identity provider this build has never
      // heard of is still readable, not a parse failure that hides the
      // whole company's review history.
      source: row.reviewer_source as ReviewerSource,
    },
  };
}

/**
 * Notes for a company, newest first.
 *
 * Archived notes are excluded unless asked for. They are never dropped
 * from the result silently in a way a reader could mistake for "there
 * are no notes" — the UI shows the archived count either way.
 */
export function listNotes(companyId: string, opts: { includeArchived?: boolean } = {}): CompanyNote[] {
  const db = getDb();
  const rows = (opts.includeArchived
    ? db.prepare('SELECT * FROM company_notes WHERE company_id = ? ORDER BY created_at DESC, id DESC').all(companyId)
    : db.prepare('SELECT * FROM company_notes WHERE company_id = ? AND archived = 0 ORDER BY created_at DESC, id DESC').all(companyId)
  ) as unknown as NoteRow[];
  return rows.map(rowToNote);
}

export function getNote(id: string): CompanyNote | null {
  const row = getDb().prepare('SELECT * FROM company_notes WHERE id = ?').get(id) as unknown as NoteRow | undefined;
  return row ? rowToNote(row) : null;
}

/** How many notes a company has, split by state — cheap enough to call per render. */
export function countNotes(companyId: string): { active: number; archived: number } {
  const row = getDb().prepare(`
    SELECT
      SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived
    FROM company_notes WHERE company_id = ?
  `).get(companyId) as { active: number | null; archived: number | null };
  return { active: row.active ?? 0, archived: row.archived ?? 0 };
}

export function createNote(companyId: string, body: string, reviewer: Reviewer): CompanyNote {
  const ts = now();
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO company_notes (id, company_id, body, created_at, updated_at, archived, archived_at,
      reviewer_id, reviewer_label, reviewer_source)
    VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
  `).run(id, companyId, normalizeNoteBody(body), ts, ts, reviewer.id, reviewer.label, reviewer.source);
  return getNote(id)!;
}

/**
 * Replace a note's body. `updated_at` moves; `created_at` and the
 * original author do NOT — an edit does not transfer authorship, and a
 * note's age is part of how a reader weighs it.
 */
export function editNote(id: string, body: string): CompanyNote | null {
  const existing = getNote(id);
  if (!existing) return null;
  getDb().prepare('UPDATE company_notes SET body = ?, updated_at = ? WHERE id = ?')
    .run(normalizeNoteBody(body), now(), id);
  return getNote(id)!;
}

/**
 * Archive (never delete). Idempotent: archiving an already-archived
 * note leaves the original `archived_at` alone rather than rewriting
 * when it happened.
 *
 * `updated_at` deliberately does NOT move. It means "when the text last
 * changed", which is what the panel renders as "edited" — and archiving
 * a note does not edit it. Bumping it here put an "edited" label on
 * notes nobody had revised, which is a false statement in a history kept
 * specifically to be audited. When the archive happened is recorded in
 * `archived_at`, and who did it in the audit log and review decisions,
 * so nothing is lost by keeping this field to one meaning.
 */
export function archiveNote(id: string): CompanyNote | null {
  const existing = getNote(id);
  if (!existing) return null;
  if (existing.archived) return existing;
  getDb().prepare('UPDATE company_notes SET archived = 1, archived_at = ? WHERE id = ?').run(now(), id);
  return getNote(id)!;
}

/** Bring an archived note back. Also idempotent, and likewise not an edit. */
export function restoreNote(id: string): CompanyNote | null {
  const existing = getNote(id);
  if (!existing) return null;
  if (!existing.archived) return existing;
  getDb().prepare('UPDATE company_notes SET archived = 0, archived_at = NULL WHERE id = ?').run(id);
  return getNote(id)!;
}
