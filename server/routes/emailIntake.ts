import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { resolveReviewer } from '../lib/reviewer';
import { importedCompanySchema } from '../services/imports';
import {
  approveEmailIntakeCandidate, candidateMissingFields, discardEmailIntakeCandidate, extractEmailWithAi,
  listEmailIntakeCandidates, MAX_EMAIL_CHARS, submitEmailIntakeBatch, updateEmailIntakeCandidate,
} from '../services/emailIntake';

export const emailIntakeRouter = Router();

/** Every field optional for a PATCH — a reviewer edits one field at a time, not the whole candidate. */
const candidatePatchSchema = importedCompanySchema.partial();

emailIntakeRouter.post('/companies/import-email/batches', wrap(async (req, res) => {
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  const { reply } = z.object({ reply: z.string().min(1) }).parse(req.body);
  const result = submitEmailIntakeBatch({ reply, submittedBy: reviewer.label });
  res.json({
    batchId: result.batchId,
    skipped: result.skipped,
    candidates: result.candidates.map((c) => ({ ...c, missingFields: candidateMissingFields(c) })),
  });
}));

emailIntakeRouter.post('/companies/import-email/extract', wrap(async (req, res) => {
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  // The service refuses (413) anything over MAX_EMAIL_CHARS after
  // sanitizing; this outer bound only stops absurd payloads early.
  const { email } = z.object({ email: z.string().min(1).max(MAX_EMAIL_CHARS * 2) }).parse(req.body);
  const result = await extractEmailWithAi({ email, submittedBy: reviewer.label });
  res.json({
    batchId: result.batchId,
    skipped: result.skipped,
    candidates: result.candidates.map((c) => ({ ...c, missingFields: candidateMissingFields(c) })),
  });
}));

emailIntakeRouter.get('/companies/import-email/candidates', wrap(async (_req, res) => {
  const candidates = listEmailIntakeCandidates();
  res.json({ candidates: candidates.map((c) => ({ ...c, missingFields: candidateMissingFields(c) })) });
}));

emailIntakeRouter.patch('/companies/import-email/candidates/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const patch = candidatePatchSchema.parse(req.body ?? {});
  const result = updateEmailIntakeCandidate(id, patch);
  if (!result.ok) {
    const status = result.status ?? 404;
    res.status(status).json({ error: status === 404 ? 'not_found' : 'invalid', message: result.error });
    return;
  }
  res.json({ ok: true });
}));

emailIntakeRouter.post('/companies/import-email/candidates/:id/approve', wrap(async (req, res) => {
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  const id = Number(req.params.id);
  const result = approveEmailIntakeCandidate(id, reviewer.label);
  if (!result.ok) {
    res.status(result.status).json({
      error: result.status === 404 ? 'not_found' : result.status === 409 ? 'already_decided' : 'incomplete_candidate',
      message: result.error,
      // Surfaced as `issues` (not a bespoke key) so the existing
      // ErrorNote component renders it as a list with no special-casing.
      issues: result.missingFields,
    });
    return;
  }
  res.json({ ok: true, companyId: result.companyId, possibleDuplicate: result.possibleDuplicate });
}));

emailIntakeRouter.post('/companies/import-email/candidates/:id/discard', wrap(async (req, res) => {
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  const id = Number(req.params.id);
  const { note } = z.object({ note: z.string().max(2000).nullable().default(null) }).parse(req.body ?? {});
  const result = discardEmailIntakeCandidate(id, reviewer.label, note);
  if (!result.ok) {
    res.status(result.status ?? 404).json({ error: result.status === 409 ? 'already_decided' : 'not_found', message: result.error });
    return;
  }
  res.json({ ok: true });
}));
