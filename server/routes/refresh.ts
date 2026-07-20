import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { requireAdmin } from '../lib/auth';
import {
  cancelRefresh, listConnectors, refreshLog, refreshRequestSchema,
  runRefresh, setConnectorEnabled,
} from '../services/refresh';

// Mounted at '/api/refresh' (not the shared '/api') so this router's
// unconditional requireAdmin gate can never intercept requests bound
// for other routers — see app.ts for the mount point.
export const refreshRouter = Router();
// Connector management and refresh runs live entirely under Settings
// — administrator-only, same as scheduled sourcing.
refreshRouter.use(requireAdmin);

refreshRouter.get('/connectors', wrap(async (_req, res) => {
  res.json({ connectors: listConnectors() });
}));

refreshRouter.post('/connectors/:id/enabled', wrap(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  res.json(setConnectorEnabled(req.params.id as string, enabled));
}));

refreshRouter.post('/run', wrap(async (req, res) => {
  res.json(await runRefresh(refreshRequestSchema.parse(req.body ?? {})));
}));

refreshRouter.post('/cancel', wrap(async (_req, res) => {
  cancelRefresh();
  res.json({ ok: true, message: 'Cancellation requested — the run stops before the next connector.' });
}));

refreshRouter.get('/log', wrap(async (_req, res) => {
  res.json({ log: refreshLog() });
}));
