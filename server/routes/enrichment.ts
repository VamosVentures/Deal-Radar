import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { requireAdmin } from '../lib/auth';
import { resolveReviewer } from '../lib/reviewer';
import { audit } from '../lib/guard';
import { getCompany } from '../db/repos/companies';
import { recordReviewDecision } from '../db/repos/operations';
import { companyEnrichment } from '../services/enrichmentView';
import { runEnrichment } from '../services/enrichment';
import { buildRadar, duplicateHints, radarCounts, reviewCandidate, RADAR_FILTERS } from '../services/stealthRadar';
import { listFieldCorrections, recordFieldCorrection } from '../db/repos/enrichment';
import { CORRECTABLE_FIELDS, PRIMARY_SECTORS, NON_SECTOR_STATUS, STAGE_RESULTS } from '../../shared/enrichment';

/**
 * Founder / vertical / stage enrichment endpoints.
 *
 * `requireAdmin` is applied PER ROUTE rather than router-wide, matching
 * routes/notes.ts: this router is mounted at the shared '/api' prefix
 * where an unconditional gate would 401 requests merely passing through
 * on their way to a later router, including login.
 *
 * Every response distinguishes the six resolution states (confirmed,
 * bounded inference, candidate, conflict, exhausted, manual review). No
 * endpoint here returns a bare null or the string "unknown" for an
 * enriched field — see services/enrichmentView.ts.
 */

export const enrichmentRouter = Router();

const NOT_FOUND = { error: 'not_found', message: 'Company not found.' } as const;

function unauthorized(res: Parameters<Parameters<typeof wrap>[0]>[1]) {
  res.status(401).json({ error: 'auth_failed', message: 'Administrator sign-in required.' });
}

// ── Read ──────────────────────────────────────────────────────────

enrichmentRouter.get('/companies/:id/enrichment', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  if (!getCompany(companyId)) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  res.json({ enrichment: companyEnrichment(companyId) });
}));

// ── Stealth Founder Radar ─────────────────────────────────────────

enrichmentRouter.get('/stealth/radar', requireAdmin, wrap(async (req, res) => {
  const { filter, limit } = z.object({
    filter: z.enum(RADAR_FILTERS).default('all'),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }).parse({ filter: req.query.filter ?? 'all', limit: req.query.limit });
  res.json({ entries: buildRadar({ filter, limit }), counts: radarCounts() });
}));

/**
 * Duplicate hints are REPORTED here, never acted on. Merging stays in the
 * existing reviewed possible-duplicate workflow.
 */
enrichmentRouter.get('/stealth/radar/duplicates', requireAdmin, wrap(async (_req, res) => {
  res.json({ hints: duplicateHints() });
}));

enrichmentRouter.post('/stealth/radar/candidates/:candidateId/review', requireAdmin, wrap(async (req, res) => {
  const reviewer = resolveReviewer(req);
  if (!reviewer) { unauthorized(res); return; }

  const candidateId = z.coerce.number().int().parse(req.params.candidateId);
  const { decision, reason } = z.object({
    decision: z.enum(['confirmed', 'rejected']),
    // A decision without a stated reason is unreviewable six months
    // later, which defeats the point of keeping the evidence at all.
    reason: z.string().trim().min(3, 'State why you are confirming or rejecting this candidate.').max(2000),
  }).parse(req.body ?? {});

  const { candidate, companyId } = reviewCandidate({
    candidateId, decision, reason,
    reviewer: { id: reviewer.id, label: reviewer.label, source: reviewer.source },
  });
  recordReviewDecision({
    subjectType: 'company', subjectId: companyId, decision: `founder-${decision}`,
    actor: reviewer.id, reason: `Founder candidate ${candidateId}`,
  });
  res.json({ candidate, enrichment: companyEnrichment(companyId) });
}));

// ── Manual corrections ────────────────────────────────────────────

/**
 * Correct an enriched field.
 *
 * The correction is layered over the automated verdict rather than
 * replacing it: the research rows are untouched, the previous value is
 * stored, and the read path shows both. Reviewer identity comes from the
 * authenticated session, never from the body.
 */
const correctionSchema = z.object({
  field: z.enum(CORRECTABLE_FIELDS),
  value: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(3, 'State the basis for this correction.').max(2000),
  sourceUrl: z.string().url().nullable().default(null),
});

enrichmentRouter.post('/companies/:id/enrichment/correct', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  if (!getCompany(companyId)) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  const reviewer = resolveReviewer(req);
  if (!reviewer) { unauthorized(res); return; }

  const input = correctionSchema.parse(req.body ?? {});

  // A corrected sector or stage must be one of the permitted values.
  // Free text here would reintroduce exactly the ungoverned vocabulary
  // ("Unknown", "TBD", "n/a") that this work exists to remove.
  if (input.field === 'vertical') {
    const allowed = [...PRIMARY_SECTORS, NON_SECTOR_STATUS] as readonly string[];
    if (!allowed.includes(input.value)) {
      res.status(400).json({
        error: 'validation_failed',
        message: `Sector must be one of: ${allowed.join(', ')}.`,
      });
      return;
    }
  }
  if (input.field === 'stage' && !(STAGE_RESULTS as readonly string[]).includes(input.value)) {
    res.status(400).json({
      error: 'validation_failed',
      message: `Stage must be one of: ${STAGE_RESULTS.join(', ')}.`,
    });
    return;
  }

  const before = companyEnrichment(companyId);
  const previousValue = input.field === 'founder'
    ? (before.founder.value?.name ?? before.founder.status)
    : input.field === 'vertical'
      ? (before.vertical.value?.primarySector ?? null)
      : (before.stage.value?.stage ?? null);

  const id = recordFieldCorrection({
    companyId,
    field: input.field,
    previousValue,
    newValue: input.value,
    reason: input.reason,
    sourceUrl: input.sourceUrl,
    reviewer: { id: reviewer.id, label: reviewer.label, source: reviewer.source },
  });
  recordReviewDecision({
    subjectType: 'company', subjectId: companyId, decision: `enrichment-corrected-${input.field}`,
    actor: reviewer.id, reason: `Correction ${id}`,
  });
  audit({
    provider: 'system', mode: 'local', action: 'enrichment-correction', subject: companyId, outcome: 'ok',
    detail: `${reviewer.label} corrected ${input.field} from "${previousValue ?? 'none'}" to "${input.value}". `
      + 'Automated research evidence preserved.',
  });

  res.status(201).json({ correctionId: id, enrichment: companyEnrichment(companyId) });
}));

enrichmentRouter.get('/companies/:id/enrichment/corrections', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  if (!getCompany(companyId)) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  res.json({ corrections: listFieldCorrections(companyId) });
}));

// ── Re-research a single company ──────────────────────────────────

/**
 * "Research again" from the company detail panel.
 *
 * Bounded to one company and a small request budget so a click cannot
 * turn into a crawl of somebody else's infrastructure. Writes are
 * idempotent upserts, so pressing it twice refreshes rather than
 * duplicates.
 */
enrichmentRouter.post('/companies/:id/enrichment/research', requireAdmin, wrap(async (req, res) => {
  const companyId = req.params.id as string;
  if (!getCompany(companyId)) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  const reviewer = resolveReviewer(req);
  if (!reviewer) { unauthorized(res); return; }

  const result = await runEnrichment({
    apply: true,
    companyIds: [companyId],
    maxRequests: 30,
    initiatedBy: reviewer.id,
  });
  res.json({
    runId: result.runId,
    requestsSpent: result.requestsSpent,
    sourceErrors: result.sourceErrors,
    enrichment: companyEnrichment(companyId),
  });
}));
