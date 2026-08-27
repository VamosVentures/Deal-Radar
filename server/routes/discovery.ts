import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import {
  cancelDiscovery, discoveryRuns, dismissCandidate, estimateCost, existingCandidates,
  importCandidates, runDiscovery, setCandidateVertical,
} from '../services/discovery';
import { getSourceMeta } from '../services/sources';
import { discoveryRequestSchema } from '../../shared/discovery';
import { VERTICAL_ID_VALUES } from '../../src/types';
import { autoImportRun } from '../services/schedule';

export const discoveryRouter = Router();

discoveryRouter.get('/discovery/sources', wrap(async (_req, res) => {
  res.json({ sources: getSourceMeta() });
}));

discoveryRouter.post('/discovery/estimate', wrap(async (req, res) => {
  // The request schema, so an estimate can never be produced for a run
  // the server would refuse — a quote for something you cannot buy.
  const q = discoveryRequestSchema.parse(req.body);
  res.json(estimateCost(q));
}));

discoveryRouter.post('/discovery/run', wrap(async (req, res) => {
  const actor = z.object({ actor: z.string().default('team') }).parse({ actor: req.body?.actor }).actor;
  const run = await runDiscovery(req.body?.query ?? req.body, actor);
  // By explicit request: every discovery run auto-imports its new,
  // non-duplicate candidates straight to Awaiting Review — a manual
  // search from the Discovery page no longer requires a separate
  // human "import" click, matching what scheduled runs already do.
  autoImportRun(run, actor);
  res.json(run);
}));

discoveryRouter.post('/discovery/cancel', wrap(async (_req, res) => {
  cancelDiscovery();
  res.json({ ok: true, message: 'Cancellation requested — the run stops before the next source.' });
}));

discoveryRouter.get('/discovery/candidates', wrap(async (req, res) => {
  const { runId, status } = z.object({ runId: z.string().optional(), status: z.string().optional() }).parse(req.query);
  let candidates = existingCandidates();
  if (runId) candidates = candidates.filter((c) => c.runId === runId);
  if (status) candidates = candidates.filter((c) => c.status === status);
  res.json({ candidates });
}));

discoveryRouter.post('/discovery/import', wrap(async (req, res) => {
  res.json(importCandidates(req.body));
}));

discoveryRouter.put('/discovery/candidates/:id/vertical', wrap(async (req, res) => {
  const body = z.object({
    vertical: z.enum(VERTICAL_ID_VALUES),
    actor: z.string().default('team'),
  }).parse(req.body);
  const candidate = setCandidateVertical(req.params.id as string, body.vertical, body.actor);
  res.json({ candidate });
}));

discoveryRouter.post('/discovery/candidates/:id/dismiss', wrap(async (req, res) => {
  const { actor } = z.object({ actor: z.string().default('team') }).parse({ actor: req.body?.actor });
  const candidate = dismissCandidate(req.params.id as string, actor);
  res.json({ candidate });
}));

discoveryRouter.get('/discovery/runs', wrap(async (_req, res) => {
  res.json({ runs: discoveryRuns() });
}));
