import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import {
  cancelDiscovery, discoveryRuns, estimateCost, existingCandidates,
  importCandidates, runDiscovery,
} from '../services/discovery';
import { getSourceMeta } from '../services/sources';
import { discoveryQuerySchema } from '../../shared/discovery';

export const discoveryRouter = Router();

discoveryRouter.get('/discovery/sources', wrap(async (_req, res) => {
  res.json({ sources: getSourceMeta() });
}));

discoveryRouter.post('/discovery/estimate', wrap(async (req, res) => {
  const q = discoveryQuerySchema.parse(req.body);
  res.json(estimateCost(q));
}));

discoveryRouter.post('/discovery/run', wrap(async (req, res) => {
  const actor = z.object({ actor: z.string().default('team') }).parse({ actor: req.body?.actor }).actor;
  const run = await runDiscovery(req.body?.query ?? req.body, actor);
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

discoveryRouter.get('/discovery/runs', wrap(async (_req, res) => {
  res.json({ runs: discoveryRuns() });
}));
