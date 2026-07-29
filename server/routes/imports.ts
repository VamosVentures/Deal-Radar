import { Router } from 'express';
import { z } from 'zod';
import { wrap } from './helpers';
import { getOpportunity, listDealEvidence } from '../db/repos/opportunities';
import { getQualification, listQuarantined } from '../services/issuerQualification';
import { audit } from '../lib/guard';
import { companyMetaView, getCompany, markRefreshed, setCompanyMeta } from '../db/repos/companies';
import { recordReviewDecision } from '../db/repos/operations';
import { COMPANY_STATUSES } from '../../shared/integrations';
import {
  clearImportedCompanies, importCompaniesCsv, importedCompanies,
} from '../services/imports';
import { refreshCompanyResearch } from '../services/companyRefresh';

export const importsRouter = Router();

importsRouter.post('/companies/import-csv', wrap(async (req, res) => {
  const { csv } = z.object({ csv: z.string().min(10) }).parse(req.body);
  res.json(importCompaniesCsv(csv));
}));

importsRouter.get('/companies/imported', wrap(async (_req, res) => {
  // Opportunity classification and issuer qualification ride along with
  // the company list. They are per-company lookups the review queue needs
  // for EVERY row, so returning them here avoids the UI firing 176
  // follow-up requests to render one table.
  const companies = importedCompanies();
  const opportunities: Record<string, unknown> = {};
  const qualifications: Record<string, unknown> = {};
  const dealEvidence: Record<string, unknown[]> = {};
  const quarantine: Record<string, { reason: string; at: string }> = {};

  for (const q of listQuarantined()) quarantine[q.id] = { reason: q.reason, at: q.at };
  for (const c of companies as { id: string }[]) {
    const o = getOpportunity(c.id);
    if (o) opportunities[c.id] = o;
    const qual = getQualification(c.id);
    if (qual) qualifications[c.id] = qual;
    // Every reporting article, not just the primary one. A round covered
    // by three outlets is ONE event with three sources, and a reviewer
    // has to be able to see all three to judge it.
    const rows = listDealEvidence(c.id);
    if (rows.length > 0) dealEvidence[c.id] = rows;
  }

  res.json({
    companies,
    companyMeta: companyMetaView(),
    opportunities,
    qualifications,
    dealEvidence,
    quarantine,
  });
}));

importsRouter.post('/companies/imported/clear', wrap(async (_req, res) => {
  clearImportedCompanies();
  res.json({ ok: true });
}));

/**
 * Simple status lifecycle (New, Awaiting Review, Research Needed,
 * Approved for HubSpot, Synced to HubSpot, Monitor, Passed) — no full
 * CRM workflow, just the handful of decisions a reviewer actually
 * makes. Every transition is a recorded review decision.
 */
/**
 * Bulk status change for the review queue (Phase 10) — still not a
 * CRM workflow: only the four non-CRM-facing statuses are allowed
 * here. 'Approved for HubSpot' and 'Synced to HubSpot' are deliberately
 * excluded — HubSpot sync stays an individual, per-company action with
 * its own review screen (see /companies/:id/status for that one).
 * Every affected company gets its own review-decision + audit entry,
 * exactly like an individual status change would. Partial failures
 * (unknown id, already synced to HubSpot) are reported honestly, never
 * silently dropped or silently forced through.
 */
const BULK_STATUSES = ['Awaiting Review', 'Research Needed', 'Monitor', 'Passed'] as const;
importsRouter.post('/companies/bulk-status', wrap(async (req, res) => {
  const { ids, status, actor } = z.object({
    ids: z.array(z.string().min(1)).min(1).max(200),
    status: z.enum(BULK_STATUSES),
    actor: z.string().default('team'),
  }).parse(req.body);

  const updated: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const company = getCompany(id);
    if (!company) {
      skipped.push({ id, reason: 'Company not found.' });
      continue;
    }
    const currentStatus = companyMetaView()[id]?.reviewStatus ?? 'New';
    if (currentStatus === 'Synced to HubSpot') {
      skipped.push({ id, reason: 'Already synced to HubSpot — bulk actions never change a completed CRM sync. Use the individual review screen if this is intentional.' });
      continue;
    }
    setCompanyMeta(id, { reviewStatus: status });
    recordReviewDecision({ subjectType: 'company', subjectId: id, decision: status, actor, reason: 'Bulk status change' });
    updated.push(id);
  }
  audit({
    provider: 'system', mode: 'local', action: 'company-bulk-status', subject: `${updated.length} compan${updated.length === 1 ? 'y' : 'ies'}`, outcome: skipped.length > 0 ? 'blocked' : 'ok',
    detail: `Bulk status → "${status}" by ${actor}: ${updated.length} updated, ${skipped.length} skipped.`,
  });
  res.json({ ok: true, status, updated, skipped });
}));

importsRouter.post('/companies/:id/status', wrap(async (req, res) => {
  const id = req.params.id as string;
  const { status, actor } = z
    .object({ status: z.enum(COMPANY_STATUSES), actor: z.string().default('team') })
    .parse(req.body);
  if (!getCompany(id)) {
    res.status(404).json({ error: 'not_found', message: 'Company not found.' });
    return;
  }
  setCompanyMeta(id, { reviewStatus: status });
  recordReviewDecision({ subjectType: 'company', subjectId: id, decision: status, actor });
  audit({ provider: 'system', mode: 'local', action: 'company-status', subject: id, outcome: 'ok', detail: `Status set to "${status}" by ${actor}` });
  res.json({ ok: true, status });
}));

/**
 * "Mark reviewed" for a stale company: stamps last_refreshed as of
 * today WITHOUT re-running any external lookup — it honestly records
 * that a human looked at it again, exactly like the bulk refresh
 * connector's semantics. For an actual live-research refresh, see
 * POST /companies/:id/refresh-research below — the two are
 * deliberately distinct actions.
 */
importsRouter.post('/companies/:id/refresh', wrap(async (req, res) => {
  const id = req.params.id as string;
  const { actor } = z.object({ actor: z.string().default('team') }).parse(req.body ?? {});
  if (!getCompany(id)) {
    res.status(404).json({ error: 'not_found', message: 'Company not found.' });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  markRefreshed([id], today);
  recordReviewDecision({ subjectType: 'company', subjectId: id, decision: 'refreshed', actor });
  audit({ provider: 'system', mode: 'local', action: 'company-refresh', subject: id, outcome: 'ok', detail: `Marked reviewed/refreshed by ${actor} on ${today}` });
  res.json({ ok: true, lastRefreshed: today });
}));

/**
 * "Refresh live research" — actually re-queries live, company-level-
 * capable sources for this one company, merges new evidence (never
 * duplicated, never deleting history), recomputes the Vamos Fit
 * Score, and reports exactly what changed. See
 * server/services/companyRefresh.ts for the full algorithm. Rate-
 * limited in app.ts since this makes real outbound requests.
 */
importsRouter.post('/companies/:id/refresh-research', wrap(async (req, res) => {
  const id = req.params.id as string;
  const { actor } = z.object({ actor: z.string().default('team') }).parse(req.body ?? {});
  const result = await refreshCompanyResearch(id, actor);
  res.json(result);
}));
