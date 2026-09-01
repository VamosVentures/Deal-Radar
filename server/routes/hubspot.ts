import { Router } from 'express';
import { z } from 'zod';
import { env } from '../env';
import { audit } from '../lib/guard';
import { requireAdmin } from '../lib/auth';
import { wrap } from './helpers';
import { companyMetaView, setCompanyMeta } from '../db/repos/companies';
import { failedHubspotSyncs, getConfig, lastFailedHubspotSync, recordHubspotSync, setConfig } from '../db/repos/operations';
import {
  beginHubSpotConnect, disconnectHubSpot, handleHubSpotCallback,
  hubspotConnected, hubspotService,
} from '../services/hubspot';
import {
  companySyncRequestSchema,
  hubspotPipelineMappingSchema,
  isSyncableContactName,
  RADAR_HUBSPOT_STAGES,
  type CompanySyncRequest,
} from '../../shared/integrations';

/**
 * Resolve a radar stage to HubSpot pipeline+stage ids. Submissions are
 * blocked with instructions until a mapping exists — the app never
 * guesses stage IDs.
 */
const MAPPING_KEY = 'hubspot-pipeline-mapping';

function storedMapping() {
  return getConfig(MAPPING_KEY, hubspotPipelineMappingSchema.nullable(), null);
}

function resolveStage(radarStage: string): { pipelineId: string; stageId: string } {
  const mapping = storedMapping();
  const target = mapping?.stages[radarStage];
  if (target) return target;
  throw Object.assign(
    new Error(`No HubSpot stage is mapped for "${radarStage}".`),
    {
      status: 409,
      hint: 'Open Data Sources & Refresh → HubSpot → Pipeline mapping, load your portal’s pipelines, and map each Deal Radar status to an existing HubSpot stage ID. Submissions are blocked until a mapping exists.',
    },
  );
}

function minimalDeal(companyName: string, dealRadarId: string, dealRadarUrl: string) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    companyName,
    fitScore: 1,
    recommendation: 'Track',
    vertical: '',
    stage: '',
    scoreBreakdown: [],
    rationale: '',
    risks: '',
    evidenceQualityScore: 0,
    policyException: null,
    sourcingStatus: 'Surfaced',
    dateSurfaced: today,
    nextAction: 'Review',
    relationshipOwner: null,
    dealRadarId,
    dealRadarUrl,
    scoreExplanation: '',
    approvedBy: null,
    approvalDate: null,
    sourceUrls: [],
  };
}

export const hubspotRouter = Router();

hubspotRouter.post('/hubspot/check-duplicate', wrap(async (req, res) => {
  const input = z
    .object({
      name: z.string().min(1),
      domain: z.string().nullable().default(null),
      founderEmails: z.array(z.string().email()).default([]),
    })
    .parse(req.body);
  const svc = hubspotService();
  const matches = await svc.checkDuplicate(input);
  res.json({ matches, demo: svc.mode !== 'live' });
}));

hubspotRouter.get('/hubspot/pipelines', requireAdmin, wrap(async (_req, res) => {
  const svc = hubspotService();
  res.json({ pipelines: await svc.getPipelines(), demo: svc.mode !== 'live' });
}));

hubspotRouter.get('/hubspot/pipeline-mapping', requireAdmin, wrap(async (_req, res) => {
  res.json({ mapping: storedMapping(), radarStages: RADAR_HUBSPOT_STAGES });
}));

hubspotRouter.put('/hubspot/pipeline-mapping', requireAdmin, wrap(async (req, res) => {
  const mapping = hubspotPipelineMappingSchema.parse(req.body);
  setConfig(MAPPING_KEY, mapping);
  audit({ provider: 'hubspot', mode: hubspotConnected() ? 'live' : 'local', action: 'save-pipeline-mapping', subject: 'hubspot-pipeline-mapping', outcome: 'ok', detail: `${Object.keys(mapping.stages).length} stages mapped` });
  res.json({ ok: true, mapping });
}));

hubspotRouter.post('/hubspot/connect', requireAdmin, wrap(async (_req, res) => {
  res.json(beginHubSpotConnect());
}));

// Not gated: this is the OAuth provider's redirect target, reached by a
// top-level browser navigation from HubSpot — not our own admin session.
// It's protected by its own state-token validation (see services/hubspot.ts).
hubspotRouter.get('/hubspot/callback', wrap(async (req, res) => {
  const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.query);
  await handleHubSpotCallback(code, state);
  res.redirect(`${env.FRONTEND_URL}/sources?hubspot=connected`);
}));

hubspotRouter.post('/hubspot/disconnect', requireAdmin, wrap(async (_req, res) => {
  disconnectHubSpot();
  res.json({ ok: true });
}));

hubspotRouter.post('/hubspot/verify', requireAdmin, wrap(async (_req, res) => {
  const v = await hubspotService().verifyConnection();
  res.json(v);
}));

hubspotRouter.post('/hubspot/search', wrap(async (req, res) => {
  const { query, type } = z
    .object({ query: z.string().min(1), type: z.enum(['companies', 'contacts', 'deals']).default('companies') })
    .parse(req.body);
  const svc = hubspotService();
  res.json({ hits: await svc.search(query, type), demo: svc.mode !== 'live' });
}));

const singleCompany = z.object({ record: z.unknown(), radarStage: z.enum(RADAR_HUBSPOT_STAGES).default('To Be Reviewed') });

hubspotRouter.post('/hubspot/company', wrap(async (req, res) => {
  const { record } = singleCompany.parse(req.body);
  const company = companySyncRequestSchema.shape.company.parse(record);
  const svc = hubspotService();
  const result = await svc.syncCompany({
    company, contacts: [],
    deal: minimalDeal(company.name, company.dealRadarId, company.dealRadarUrl),
    ...resolveStage('To Be Reviewed'),
    resolution: 'create-new', existingRecordId: null, existingDealId: null,
  });
  res.json(result);
}));

/**
 * The one sync path (used by both sync-company and retry). Success AND
 * failure are recorded in hubspot_sync_history — failures keep the
 * full payload so they can be retried. Idempotent: a radar record that
 * is already linked to a HubSpot company always updates that company,
 * regardless of what the caller asked for.
 */
async function performSync(parsed: CompanySyncRequest) {
  const svc = hubspotService();

  /**
   * Placeholder people are dropped here, on the server, not only in the
   * modal that usually builds this payload.
   *
   * The imported founders table still carries "Unknown founder" for most
   * companies, and a rule only the UI applies is a rule anyone with the
   * API can skip — including our own retry path, which replays a stored
   * payload that may predate this check. The company and deal still
   * sync; only the unusable contact is withheld.
   */
  const contacts = parsed.contacts.filter((ct) =>
    isSyncableContactName(`${ct.firstName} ${ct.lastName}`.trim()));
  if (contacts.length !== parsed.contacts.length) {
    audit({
      provider: 'hubspot', mode: 'live', action: 'contact-withheld',
      subject: parsed.company.dealRadarId, outcome: 'ok',
      detail: `${parsed.contacts.length - contacts.length} contact(s) withheld from the sync: `
        + 'a placeholder or single-token name cannot be matched in HubSpot and would create a junk record.',
    });
  }
  parsed = { ...parsed, contacts };
  const { pipelineId, stageId } = resolveStage(parsed.radarStage);

  // Idempotency tier 1: our own persisted link.
  const meta = companyMetaView()[parsed.company.dealRadarId];
  const linkedId = meta?.hubspotCompanyId ?? null;
  const linkedDealId = meta?.hubspotDealId ?? null;
  const resolution = linkedId ? 'update-existing' as const : parsed.duplicateResolution;
  const existingRecordId = linkedId ?? parsed.existingRecordId;

  try {
    const result = await svc.syncCompany({
      company: parsed.company,
      contacts: parsed.contacts,
      deal: parsed.deal,
      pipelineId,
      stageId,
      resolution,
      existingRecordId,
      existingDealId: linkedDealId,
    });
    recordHubspotSync({
      companyId: parsed.company.dealRadarId,
      action: result.action,
      hubspotCompanyId: result.companyId,
      hubspotDealId: result.dealId,
      contactCount: result.contactIds.length,
      outcome: 'ok',
      detail: result.message,
      payload: parsed,
    });
    // A real, confirmed sync is the one event allowed to move the
    // status forward automatically — it isn't a guess, it's a fact.
    setCompanyMeta(parsed.company.dealRadarId, { hubspotCompanyId: result.companyId, hubspotDealId: result.dealId, reviewStatus: 'Synced to HubSpot' });
    return result;
  } catch (e) {
    recordHubspotSync({
      companyId: parsed.company.dealRadarId,
      action: 'sync-failed',
      outcome: 'error',
      detail: (e as Error).message,
      payload: parsed, // kept so the sync can be retried
    });
    throw e;
  }
}

hubspotRouter.post('/hubspot/sync-company', wrap(async (req, res) => {
  const parsed = companySyncRequestSchema.parse(req.body);
  res.json(await performSync(parsed));
}));

/** Retry the most recent FAILED synchronization for a company, using its stored payload. */
hubspotRouter.post('/hubspot/retry-sync', requireAdmin, wrap(async (req, res) => {
  const { companyId } = z.object({ companyId: z.string().min(1) }).parse(req.body);
  const failed = lastFailedHubspotSync(companyId);
  if (!failed) {
    res.status(404).json({ error: 'error', message: `No retryable failed synchronization is on record for ${companyId}.` });
    return;
  }
  const parsed = companySyncRequestSchema.parse(failed.payload);
  res.json(await performSync(parsed));
}));

/** Companies whose latest sync attempt failed — the retry queue. */
hubspotRouter.get('/hubspot/failed-syncs', requireAdmin, wrap(async (_req, res) => {
  res.json({ failed: failedHubspotSyncs() });
}));

hubspotRouter.post('/hubspot/contact', wrap(async (req, res) => {
  // Standalone contact creation reuses syncCompany's contact path.
  // Validation (identity guardrails) happens in the schema parse below.
  const contact = companySyncRequestSchema.shape.contacts.element.parse(req.body);
  const svc = hubspotService();
  const result = await svc.syncCompany({
    company: {
      name: contact.companyName, domain: null, website: null, city: '', state: '',
      country: 'United States', description: '', industry: '',
      roundCurrentlyRaising: null, totalRaisingForRound: null, acceleratorParticipation: null,
      diverseGroup: null, diverseGroupOther: null, founders: [],
      dealRadarId: `contact-only-${Date.now()}`, dealRadarUrl: env.FRONTEND_URL,
    },
    contacts: [contact],
    deal: minimalDeal(contact.companyName, `contact-only-${Date.now()}`, env.FRONTEND_URL),
    ...resolveStage('To Be Reviewed'),
    resolution: 'create-new', existingRecordId: null, existingDealId: null,
  });
  res.json({ contactIds: result.contactIds, demo: result.demo });
}));

hubspotRouter.post('/hubspot/deal', wrap(async (req, res) => {
  const body = z.object({ deal: z.unknown(), radarStage: z.enum(RADAR_HUBSPOT_STAGES).default('To Be Reviewed') }).parse(req.body);
  const deal = companySyncRequestSchema.shape.deal.parse(body.deal);
  const svc = hubspotService();
  const { pipelineId, stageId } = resolveStage(body.radarStage);
  const result = await svc.syncCompany({
    company: {
      name: deal.companyName, domain: null, website: null, city: '', state: '',
      country: 'United States', description: '', industry: deal.vertical,
      roundCurrentlyRaising: null, totalRaisingForRound: null, acceleratorParticipation: null,
      diverseGroup: null, diverseGroupOther: null, founders: [],
      dealRadarId: deal.dealRadarId, dealRadarUrl: deal.dealRadarUrl,
    },
    contacts: [], deal, pipelineId, stageId,
    resolution: 'create-new', existingRecordId: null, existingDealId: null,
  });
  res.json({ dealId: result.dealId, dealUrl: result.dealUrl, demo: result.demo });
}));

hubspotRouter.post('/hubspot/log-activity', wrap(async (req, res) => {
  const { companyId, note, actor } = z
    .object({ companyId: z.string(), note: z.string().min(2), actor: z.string().default('team') })
    .parse(req.body);
  const hubspotCompanyId = companyMetaView()[companyId]?.hubspotCompanyId ?? null;
  if (!hubspotCompanyId) {
    res.status(404).json({ error: 'error', message: 'This company is not linked to a HubSpot record yet — sync it first.' });
    return;
  }
  const svc = hubspotService();
  const result = await svc.logActivity({ companyRecordId: hubspotCompanyId, note });
  audit({ provider: 'hubspot', mode: hubspotConnected() ? 'live' : 'local', action: 'log-activity', subject: companyId, outcome: 'ok', detail: `Note by ${actor} (${note.length} chars)` });
  res.json({ ok: true, hubspotNoteId: result.noteId, demo: result.demo });
}));
