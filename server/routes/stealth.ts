import { Router } from 'express';
import { wrap } from './helpers';
import { addSignal, generateHypothesis, listSignals, patchSignal } from '../services/stealth';

export const stealthRouter = Router();

stealthRouter.get('/stealth/signals', wrap(async (_req, res) => {
  res.json({ signals: listSignals() });
}));

stealthRouter.post('/stealth/signals', wrap(async (req, res) => {
  res.json(addSignal(req.body));
}));

stealthRouter.post('/stealth/signals/:id', wrap(async (req, res) => {
  res.json(patchSignal(req.params.id as string, req.body));
}));

stealthRouter.post('/stealth/signals/:id/hypothesis', wrap(async (req, res) => {
  res.json(generateHypothesis(req.params.id as string));
}));
