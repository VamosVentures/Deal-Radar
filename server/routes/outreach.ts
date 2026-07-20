import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { emailGenerator } from '../services/ai';
import { emailGenContextSchema } from '../../shared/integrations';

/**
 * Outreach = draft generation only. There is no internal outreach
 * tracker or pipeline stages — relationship management lives in
 * HubSpot, and sending always happens manually from Outlook.
 */
export const outreachRouter = Router();

outreachRouter.post('/outreach/generate', wrap(async (req, res) => {
  const context = emailGenContextSchema.parse(req.body);
  res.json(await emailGenerator().generateOutreachEmail(context));
}));

outreachRouter.post('/outreach/regenerate', wrap(async (req, res) => {
  const { context, instructions } = z
    .object({ context: emailGenContextSchema, instructions: z.string().default('') })
    .parse(req.body);
  res.json(await emailGenerator().regenerateOutreachEmail(context, instructions));
}));
