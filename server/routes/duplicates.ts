import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { audit } from '../lib/guard';
import { getCompany, listPossibleDuplicates, resolvePossibleDuplicate } from '../db/repos/companies';
import { recordReviewDecision } from '../db/repos/operations';

/**
 * Possible-duplicate review queue. Uncertain matches (fuzzy names,
 * founder-overlap evidence) land here and BOTH records stay active
 * until a human decides. 'confirmed-duplicate' merges evidence into
 * the existing record and marks the newer one merged; 'not-duplicate'
 * keeps both.
 */
export const duplicatesRouter = Router();

duplicatesRouter.get('/duplicates', wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['pending', 'confirmed-duplicate', 'not-duplicate']).optional() }).parse(req.query);
  const items = listPossibleDuplicates(status).map((d) => ({
    ...d,
    company: getCompany(d.companyId),
    otherCompany: d.otherCompanyId ? getCompany(d.otherCompanyId) : null,
  }));
  res.json({ duplicates: items });
}));

duplicatesRouter.post('/duplicates/:id/resolve', wrap(async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { resolution, actor } = z.object({
    resolution: z.enum(['confirmed-duplicate', 'not-duplicate']),
    actor: z.string().default('team'),
  }).parse(req.body);
  const resolved = resolvePossibleDuplicate(id, resolution, actor);
  recordReviewDecision({
    subjectType: 'possible-duplicate',
    subjectId: String(id),
    decision: resolution,
    actor,
    reason: resolved.detail,
  });
  audit({
    provider: 'system', mode: 'local', action: 'duplicate-resolve',
    subject: `${resolved.companyId} vs ${resolved.otherCompanyId}`, outcome: 'ok',
    detail: `${resolution} by ${actor}${resolution === 'confirmed-duplicate' ? ' — evidence merged, newer record marked merged' : ' — both records kept'}`,
  });
  res.json({ ok: true, duplicate: resolved });
}));
