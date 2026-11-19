import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { resolveReviewer } from '../lib/reviewer';
import { importedCompanySchema } from '../services/imports';
import {
  approveEmailIntakeCandidate, approveReadyInBatch, candidateMissingFields, discardEmailIntakeCandidate, extractEmailWithAi,
  listEmailIntakeCandidates, MAX_EMAIL_CHARS, submitEmailIntakeBatch, updateEmailIntakeCandidate,
} from '../services/emailIntake';
import { fileImportStatus, previewFileImport, startFileImport } from '../services/fileImport';

export const emailIntakeRouter = Router();

/**
 * An uploaded spreadsheet as the browser parsed it: raw rows of cells.
 * Generous structural bounds only — the service does the real cleaning
 * and enforces the row limit with a clear message.
 */
const fileBodySchema = z.object({
  fileName: z.string().min(1).max(500),
  rows: z.array(
    z.array(z.union([z.string().max(100_000), z.number(), z.boolean(), z.null()])).max(500),
  ).min(1).max(20_000),
});

emailIntakeRouter.post('/companies/import-file/preview', wrap(async (req, res) => {
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  res.json(previewFileImport(fileBodySchema.parse(req.body)));
}));

emailIntakeRouter.post('/companies/import-file/start', wrap(async (req, res) => {
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  res.json(startFileImport({ ...fileBodySchema.parse(req.body), submittedBy: reviewer.label }));
}));

emailIntakeRouter.get('/companies/import-file/:batchId', wrap(async (req, res) => {
  const status = fileImportStatus(String(req.params.batchId));
  if (!status) {
    res.status(404).json({ error: 'not_found', message: 'No file import with that id.' });
    return;
  }
  res.json(status);
}));

emailIntakeRouter.post('/companies/import-email/batches/:batchId/approve-ready', wrap(async (req, res) => {
  const reviewer = resolveReviewer(req);
  if (!reviewer) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
    return;
  }
  res.json(approveReadyInBatch(String(req.params.batchId), reviewer.label));
}));

/** Every field optional for a PATCH — a reviewer edits one field at a time, not the whole candidate. */
const candidatePatchSchema = importedCompanySchema.partial().extend({
  // A reviewer may only REMOVE identity a file stated (null) — never type
  // one in here; identity always carries the file's own provenance.
  identity: z.null().optional(),
});

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
