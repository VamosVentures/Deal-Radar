import { Router } from 'express';
import { z } from 'zod';
import { computeCumulativePeriod, computeExecutiveKpis } from '../services/executiveKpis';
import { CUMULATIVE_PERIODS } from '../../shared/executiveKpis';

/**
 * Executive Overview KPIs — Companies and Stealth Founders, each broken
 * down by vertical. Mounted alongside the other /api routers, so it
 * inherits the same session gate every other company/discovery
 * endpoint already requires; there is nothing admin-specific about it.
 */
export const overviewRouter = Router();

overviewRouter.get('/overview/kpis', (_req, res) => {
  // computeExecutiveKpis never throws — a failure computing one half is
  // caught internally and surfaced as `partial`/`errors`, so the other
  // half's real numbers still reach the client instead of a blank 500.
  const kpis = computeExecutiveKpis();
  res.json(kpis);
});

const cumulativeQuerySchema = z.object({
  entity: z.enum(['companies', 'founders']),
  period: z.enum(CUMULATIVE_PERIODS),
});

/**
 * Time-filtered Cumulative, for the breakdown modal's period selector.
 * Always a fresh, full-database query (see computeCumulativePeriod) —
 * never a filter over already-loaded client rows.
 */
overviewRouter.get('/overview/kpis/cumulative', (req, res) => {
  const parsed = cumulativeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_failed', message: parsed.error.issues.map((i) => i.message).join('; ') });
    return;
  }
  const result = computeCumulativePeriod(parsed.data.entity, parsed.data.period);
  res.json(result);
});
