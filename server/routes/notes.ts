import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { requireAdmin } from '../lib/auth';
import { resolveReviewer } from '../lib/reviewer';
import { audit } from '../lib/guard';
import { getCompany } from '../db/repos/companies';
import { recordReviewDecision } from '../db/repos/operations';
import { archiveNote, createNote, editNote, getNote, listNotes, restoreNote } from '../db/repos/notes';
import { noteBodySchema } from '../../shared/notes';

/**
 * Internal company review notes.
 *
 * There is deliberately NO delete route. Archive and restore are the
 * only lifecycle transitions, because the review history is the point:
 * a note that argued for passing on a company is evidence of how the
 * decision was made, and a delete button would let that quietly
 * disappear. See migration v10.
 *
 * `requireAdmin` is applied PER ROUTE rather than with a router-level
 * `.use()`. This router is mounted at the shared '/api' prefix, where an
 * unconditional gate would 401 every request that merely passes through
 * it on the way to a later router — including the login route itself
 * (see the comment on the router mounts in server/app.ts). The
 * whole-application gate already covers these paths; this is
 * defense-in-depth for the day someone changes that gate's allowlist,
 * matching how server/routes/hubspot.ts guards its admin routes.
 *
 * Note bodies are returned ONLY by these routes. They are deliberately
 * absent from /api/companies/imported, which feeds the company table and
 * the CSV export — internal opinion must not ride along in a bulk
 * payload assembled for facts.
 */

export const notesRouter = Router();

const NOT_FOUND = { error: 'not_found', message: 'Company not found.' } as const;
const NOTE_NOT_FOUND = {
  error: 'not_found',
  message: 'Note not found. It may have been written against a different company.',
} as const;

/**
 * Resolve the company AND the note together.
 *
 * The note id is checked against the company in the path, so a caller
 * cannot read or edit one company's note through another company's
 * URL — note ids are UUIDs and unguessable, but "unguessable" is not an
 * authorization check, and every route here needs the same one.
 */
function resolveTarget(companyId: string, noteId: string):
  | { ok: true }
  | { ok: false; status: number; body: typeof NOT_FOUND | typeof NOTE_NOT_FOUND } {
  if (!getCompany(companyId)) return { ok: false, status: 404, body: NOT_FOUND };
  const note = getNote(noteId);
  if (!note || note.companyId !== companyId) return { ok: false, status: 404, body: NOTE_NOT_FOUND };
  return { ok: true };
}

/**
 * List notes. Archived notes are included only when explicitly asked
 * for, so the default panel is the working set and the audit trail is
 * one deliberate click away.
 */
notesRouter.get('/companies/:id/notes', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  if (!getCompany(companyId)) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  const { includeArchived } = z
    .object({ includeArchived: z.enum(['true', 'false']).default('false') })
    .parse({ includeArchived: req.query.includeArchived ?? 'false' });
  const notes = listNotes(companyId, { includeArchived: includeArchived === 'true' });
  res.json({ notes });
}));

notesRouter.post('/companies/:id/notes', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  // Company existence is checked BEFORE the body is validated, so a
  // note written against a typo'd id says so plainly instead of
  // complaining about the note text.
  if (!getCompany(companyId)) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  const { body } = z.object({ body: noteBodySchema }).parse(req.body ?? {});
  const note = createNote(companyId, body, reviewer);
  recordReviewDecision({
    subjectType: 'company', subjectId: companyId, decision: 'note-added',
    actor: reviewer.id, reason: `Internal note ${note.id}`,
  });
  // Audit records THAT a note was written, never what it said — the
  // audit log is read by more people than the notes panel is, and a
  // note may carry a candid opinion about a founder.
  audit({
    provider: 'system', mode: 'local', action: 'company-note-add', subject: companyId, outcome: 'ok',
    detail: `Internal note ${note.id} added by ${reviewer.label} (${note.body.length} characters).`,
  });
  res.status(201).json({ note });
}));

notesRouter.patch('/companies/:id/notes/:noteId', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  const noteId = req.params.noteId as string;
  const target = resolveTarget(companyId, noteId);
  if (!target.ok) {
    res.status(target.status).json(target.body);
    return;
  }
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  const { body } = z.object({ body: noteBodySchema }).parse(req.body ?? {});
  const note = editNote(noteId, body)!;
  recordReviewDecision({
    subjectType: 'company', subjectId: companyId, decision: 'note-edited',
    actor: reviewer.id, reason: `Internal note ${noteId}`,
  });
  audit({
    provider: 'system', mode: 'local', action: 'company-note-edit', subject: companyId, outcome: 'ok',
    detail: `Internal note ${noteId} edited by ${reviewer.label} (now ${note.body.length} characters).`,
  });
  res.json({ note });
}));

/**
 * Archive — the closest thing to a delete this feature has, and
 * deliberately reversible. The note keeps its body, its author, and its
 * original creation time.
 */
notesRouter.post('/companies/:id/notes/:noteId/archive', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  const noteId = req.params.noteId as string;
  const target = resolveTarget(companyId, noteId);
  if (!target.ok) {
    res.status(target.status).json(target.body);
    return;
  }
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  const note = archiveNote(noteId)!;
  recordReviewDecision({
    subjectType: 'company', subjectId: companyId, decision: 'note-archived',
    actor: reviewer.id, reason: `Internal note ${noteId}`,
  });
  audit({
    provider: 'system', mode: 'local', action: 'company-note-archive', subject: companyId, outcome: 'ok',
    detail: `Internal note ${noteId} archived by ${reviewer.label}. Archived notes are retained, never deleted.`,
  });
  res.json({ note });
}));

notesRouter.post('/companies/:id/notes/:noteId/restore', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  const noteId = req.params.noteId as string;
  const target = resolveTarget(companyId, noteId);
  if (!target.ok) {
    res.status(target.status).json(target.body);
    return;
  }
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  const note = restoreNote(noteId)!;
  recordReviewDecision({
    subjectType: 'company', subjectId: companyId, decision: 'note-restored',
    actor: reviewer.id, reason: `Internal note ${noteId}`,
  });
  audit({
    provider: 'system', mode: 'local', action: 'company-note-restore', subject: companyId, outcome: 'ok',
    detail: `Internal note ${noteId} restored by ${reviewer.label}.`,
  });
  res.json({ note });
}));
