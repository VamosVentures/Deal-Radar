import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { requireAdmin } from '../lib/auth';
import { deleteJob, listJobs, runJobNow, saveJob, schedulerStatus } from '../services/schedule';

// Mounted at '/api/schedule' (not the shared '/api') so this router's
// unconditional requireAdmin gate can never intercept requests bound
// for other routers — see app.ts for the mount point.
export const scheduleRouter = Router();
// Scheduled-sourcing configuration is administrator-only end to end —
// reading it exposes the firm's sourcing configuration, and every
// mutation (save/delete/run-now) is explicitly an admin action.
scheduleRouter.use(requireAdmin);

scheduleRouter.get('/', wrap(async (_req, res) => {
  res.json({ ...schedulerStatus(), jobs: listJobs() });
}));

scheduleRouter.post('/', wrap(async (req, res) => {
  res.json(saveJob(req.body));
}));

scheduleRouter.delete('/:id', wrap(async (req, res) => {
  deleteJob(req.params.id as string);
  res.json({ ok: true });
}));

/** Administrator-only: run this schedule's search immediately. */
scheduleRouter.post('/:id/run-now', wrap(async (req, res) => {
  const { actor } = z.object({ actor: z.string().default('admin') }).parse(req.body ?? {});
  const run = await runJobNow(req.params.id as string, actor);
  res.json(run);
}));
