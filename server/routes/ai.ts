import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { comparePortfolio, explainFit } from '../services/analysis';

export const aiRouter = Router();

aiRouter.post('/ai/explain-fit', wrap(async (req, res) => {
  res.json(await explainFit(req.body));
}));

aiRouter.post('/ai/compare-portfolio', wrap(async (req, res) => {
  const { company, portfolio } = z
    .object({ company: z.unknown(), portfolio: z.unknown().optional() })
    .parse(req.body);
  res.json(await comparePortfolio(company, portfolio ?? null));
}));
