import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, modes } from './env';
import { store } from './lib/store';
import { audit, idempotencyGuard, requestLogger } from './lib/guard';
import {
  beginHubSpotConnect, disconnectHubSpot, handleHubSpotCallback,
  hubspotAuthType, hubspotMode, hubspotService,
} from './services/hubspot';
import { outlookService } from './services/outlook';
import { emailGenerator } from './services/ai';
import { comparePortfolio, explainFit, verifyAiConnection } from './services/analysis';
import {
  cancelRefresh, listConnectors, refreshLog, refreshRequestSchema,
  runRefresh, setConnectorEnabled,
} from './services/refresh';
import {
  clearImportedCompanies, importCompaniesCsv, importedCompanies, savePortfolio,
} from './services/imports';
import {
  cancelDiscovery, discoveryRuns, estimateCost, existingCandidates,
  importCandidates, runDiscovery,
} from './services/discovery';
import { discoveryQuerySchema } from '../shared/discovery';
import { SOURCE_META } from './services/sources';
import { addSignal, generateHypothesis, listSignals, patchSignal } from './services/stealth';
import { deleteJob, listJobs, saveJob, schedulerStatus } from './services/schedule';
import { portfolioCompanySchema } from '../shared/integrations';
import { parseCsv } from './services/imports';
import {
  addActivity, followUpSummary, getRecords, patchRecord, setFollowUp, upsertRecord,
} from './services/records';
import {
  companySyncRequestSchema,
  emailGenContextSchema,
  hubspotPipelineMappingSchema,
  outreachDraftSchema,
  RADAR_HUBSPOT_STAGES,
  type IntegrationsStatus,
} from '../shared/integrations';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    cors({
      origin: [env.FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: false,
    }),
  );
  app.use(requestLogger);
  app.use(
    '/api',
    rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }),
  );
  app.use(
    '/api/outreach/generate',
    rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }),
  );
  app.use('/api', idempotencyGuard);

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  // ── Status ─────────────────────────────────────────────────────

  // Verification results are cached briefly so the status endpoint
  // stays cheap; "connected" is only ever shown after a real check.
  const verifyCache = new Map<string, { at: number; ok: boolean; detail: string }>();
  async function cachedVerify(key: string, run: () => Promise<{ ok: boolean; detail: string }>) {
    const hit = verifyCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
    const res = await run().catch((e: Error) => ({ ok: false, detail: e.message }));
    const entry = { at: Date.now(), ...res };
    verifyCache.set(key, entry);
    return entry;
  }

  type UiStatus = 'Connected' | 'Disconnected' | 'Configuration required' | 'Expired' | 'Error' | 'Local Mode';

  app.get('/api/integrations/status', wrap(async (_req, res) => {
    const outlook = await outlookService().status();
    const hsMode = hubspotMode();
    const aiMode = modes.ai();

    // HubSpot: never claim connected without a verified real call.
    let hsStatus: UiStatus = 'Local Mode';
    let hsDetail = 'Local Mode: HubSpot actions are simulated locally. Add HUBSPOT_ACCESS_TOKEN (or OAuth credentials) and set INTEGRATION_MODE=auto to go live.';
    if (hsMode === 'live') {
      const v = await cachedVerify('hubspot', () => hubspotService().verifyConnection());
      hsStatus = v.ok ? 'Connected' : 'Error';
      hsDetail = v.detail;
    }

    let olStatus: UiStatus = 'Local Mode';
    let olDetail = outlook.detail;
    if (outlook.mode === 'live') {
      if (!outlook.connected) {
        olStatus = 'Disconnected';
      } else {
        const v = await cachedVerify('outlook', () => outlookService().verifyConnection());
        olStatus = v.ok ? 'Connected' : /expired|reconnect/i.test(v.detail) ? 'Expired' : 'Error';
        olDetail = v.detail;
      }
    }

    let aiStatus: UiStatus = 'Local Mode';
    let aiDetail = 'Local Mode: deterministic templates built only from verified facts. Configure AI_PROVIDER + an API key to use a model.';
    if (aiMode === 'live') {
      const v = await cachedVerify('ai', verifyAiConnection);
      aiStatus = v.ok ? 'Connected' : 'Error';
      aiDetail = v.detail;
    }

    const lastRefresh = refreshLog()[0] ?? null;
    const refreshStatus: UiStatus =
      !lastRefresh ? 'Disconnected'
      : lastRefresh.status === 'ok' ? 'Connected'
      : lastRefresh.status === 'partial' ? 'Error'
      : lastRefresh.status === 'failed' ? 'Error'
      : 'Disconnected';

    const body: IntegrationsStatus & {
      statuses: Record<string, { status: UiStatus; detail: string }>;
    } = {
      mode: hsMode === 'live' || outlook.mode === 'live' || aiMode === 'live' ? 'live' : 'mock',
      hubspot: {
        provider: 'hubspot',
        mode: hsMode,
        connected: hsStatus === 'Connected',
        account: hsMode === 'live' ? (env.HUBSPOT_PORTAL_ID ?? hubspotAuthType()) : null,
        detail: hsDetail,
        permissions: hsMode === 'live' ? ['crm.objects.companies', 'crm.objects.contacts', 'crm.objects.deals', 'crm.objects.notes'] : [],
        lastConnectedAt: null,
      },
      outlook: {
        provider: 'outlook',
        mode: outlook.mode,
        connected: olStatus === 'Connected' || (outlook.mode === 'mock' && outlook.connected),
        account: outlook.account,
        detail: olDetail,
        permissions: outlook.permissions,
        lastConnectedAt: outlook.lastConnectedAt,
      },
      ai: {
        provider: 'ai',
        mode: aiMode,
        connected: true, // the template generator is always available
        account: aiMode === 'live' ? `${env.AI_PROVIDER} / ${env.AI_MODEL ?? 'default'}` : 'Deterministic template generator',
        detail: aiDetail,
        permissions: [],
        lastConnectedAt: null,
      },
      statuses: {
        hubspot: { status: hsStatus, detail: hsDetail },
        outlook: { status: olStatus, detail: olDetail },
        ai: { status: aiStatus, detail: aiDetail },
        refresh: {
          status: refreshStatus,
          detail: lastRefresh
            ? `Last refresh ${lastRefresh.at.slice(0, 16).replace('T', ' ')} — ${lastRefresh.status}`
            : 'No refresh has been run yet.',
        },
      },
    };
    res.json(body);
  }));

  app.get('/api/audit', wrap(async (_req, res) => {
    res.json(store.raw.audit.slice(0, 100));
  }));

  // ── HubSpot ────────────────────────────────────────────────────

  app.post('/api/hubspot/check-duplicate', wrap(async (req, res) => {
    const { name, domain } = z
      .object({ name: z.string().min(1), domain: z.string().nullable().default(null) })
      .parse(req.body);
    const matches = await hubspotService().checkDuplicate(name, domain);
    res.json({ matches, demo: hubspotMode() === 'mock' });
  }));

  app.get('/api/hubspot/pipelines', wrap(async (_req, res) => {
    res.json({ pipelines: await hubspotService().getPipelines(), demo: hubspotMode() === 'mock' });
  }));

  app.get('/api/hubspot/pipeline-mapping', wrap(async (_req, res) => {
    res.json({ mapping: store.raw.pipelineMapping, radarStages: RADAR_HUBSPOT_STAGES });
  }));

  app.put('/api/hubspot/pipeline-mapping', wrap(async (req, res) => {
    const mapping = hubspotPipelineMappingSchema.parse(req.body);
    store.raw.pipelineMapping = mapping;
    store.save();
    audit({ provider: 'hubspot', mode: hubspotMode(), action: 'save-pipeline-mapping', subject: mapping.pipelineId, outcome: 'ok', detail: `${Object.keys(mapping.stages).length} stages mapped` });
    res.json({ ok: true, mapping });
  }));

  app.post('/api/hubspot/connect', wrap(async (_req, res) => {
    res.json(beginHubSpotConnect());
  }));

  app.get('/api/hubspot/callback', wrap(async (req, res) => {
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.query);
    await handleHubSpotCallback(code, state);
    res.redirect(`${env.FRONTEND_URL}/sources?hubspot=connected`);
  }));

  app.post('/api/hubspot/disconnect', wrap(async (_req, res) => {
    disconnectHubSpot();
    res.json({ ok: true });
  }));

  app.post('/api/hubspot/verify', wrap(async (_req, res) => {
    const v = await hubspotService().verifyConnection();
    res.json({ ...v, mode: hubspotMode() });
  }));

  app.post('/api/hubspot/search', wrap(async (req, res) => {
    const { query, type } = z
      .object({ query: z.string().min(1), type: z.enum(['companies', 'contacts']).default('companies') })
      .parse(req.body);
    res.json({ hits: await hubspotService().search(query, type), demo: hubspotMode() === 'mock' });
  }));

  /** Resolve a radar stage to HubSpot pipeline+stage ids, honoring the mapping rules. */
  function resolveStage(radarStage: string): { pipelineId: string; stageId: string } {
    const mapping = store.raw.pipelineMapping;
    if (mapping?.stages[radarStage]) {
      return { pipelineId: mapping.pipelineId, stageId: mapping.stages[radarStage] };
    }
    if (hubspotMode() === 'live') {
      // Never guess real HubSpot stage IDs.
      throw Object.assign(
        new Error(`No HubSpot stage is mapped for "${radarStage}".`),
        {
          status: 409,
          hint: 'Open Data Sources & Refresh → HubSpot → Pipeline mapping, load your portal\u2019s pipelines, and map each Deal Radar status to an existing HubSpot stage ID. Live submissions are blocked until a mapping exists.',
        },
      );
    }
    return { pipelineId: 'demo-pipeline', stageId: `demo-${radarStage.toLowerCase().replace(/\s+/g, '-')}` };
  }

  const singleCompany = z.object({ record: z.unknown(), radarStage: z.enum(RADAR_HUBSPOT_STAGES).default('Surfaced') });

  app.post('/api/hubspot/company', wrap(async (req, res) => {
    const { record } = singleCompany.parse(req.body);
    const company = companySyncRequestSchema.shape.company.parse(record);
    const result = await hubspotService().syncCompany({
      company, contacts: [],
      deal: minimalDeal(company.name, company.dealRadarId, company.dealRadarUrl),
      ...resolveStage('Surfaced'),
      resolution: 'create-new', existingRecordId: null,
    });
    res.json(result);
  }));

  app.post('/api/hubspot/sync-company', wrap(async (req, res) => {
    const parsed = companySyncRequestSchema.parse(req.body);
    const { pipelineId, stageId } = resolveStage(parsed.radarStage);
    const result = await hubspotService().syncCompany({
      company: parsed.company,
      contacts: parsed.contacts,
      deal: parsed.deal,
      pipelineId,
      stageId,
      resolution: parsed.duplicateResolution,
      existingRecordId: parsed.existingRecordId,
    });

    // Track in the outreach tracker.
    const firstFounder = parsed.contacts[0];
    upsertRecord(
      {
        companyId: parsed.company.dealRadarId,
        companyName: parsed.company.name,
        founderName: firstFounder ? `${firstFounder.firstName} ${firstFounder.lastName}`.trim() : '—',
        founderEmail: firstFounder?.email ?? null,
        owner: parsed.deal.relationshipOwner ?? '—',
        vertical: parsed.company.vertical,
        companyStage: parsed.company.stage,
        fitScore: parsed.deal.fitScore,
        policyException: parsed.company.policyException,
        sourceQuality: parsed.deal.evidenceQualityScore,
      },
      {
        hubspotStatus: result.action === 'updated' ? 'Updated' : 'Added',
        hubspotCompanyId: result.companyId,
        hubspotUrl: result.companyUrl,
        outreachStatus: 'Added to HubSpot',
        nextAction: parsed.deal.nextAction,
      },
    );
    addActivity(
      parsed.company.dealRadarId,
      'company-added',
      `${result.demo ? 'Demo Mode — simulated: ' : ''}company ${result.action} in HubSpot with ${result.contactIds.length} contact(s) and 1 deal`,
      parsed.deal.relationshipOwner ?? 'team',
    );
    res.json(result);
  }));

  app.post('/api/hubspot/contact', wrap(async (req, res) => {
    // Standalone contact creation reuses syncCompany's contact path via a
    // dedicated mock/live call. Validation (identity guardrails) happens
    // in the schema parse below.
    const contact = companySyncRequestSchema.shape.contacts.element.parse(req.body);
    const svc = hubspotService();
    const result = await svc.syncCompany({
      company: {
        name: contact.companyName, domain: null, website: null, city: '', state: '',
        country: 'United States', description: '', vertical: '', subcategory: '',
        stage: '', accelerator: null, fundingRaised: null,
        dateFirstSurfaced: new Date().toISOString().slice(0, 10),
        lastRefreshed: new Date().toISOString().slice(0, 10),
        primarySource: 'Deal Radar', policyException: null,
        dealRadarId: `contact-only-${Date.now()}`, dealRadarUrl: env.FRONTEND_URL,
      },
      contacts: [contact],
      deal: minimalDeal(contact.companyName, `contact-only-${Date.now()}`, env.FRONTEND_URL),
      ...resolveStage('Surfaced'),
      resolution: 'create-new', existingRecordId: null,
    });
    res.json({ contactIds: result.contactIds, demo: result.demo });
  }));

  app.post('/api/hubspot/deal', wrap(async (req, res) => {
    const body = z.object({ deal: z.unknown(), radarStage: z.enum(RADAR_HUBSPOT_STAGES).default('Surfaced') }).parse(req.body);
    const deal = companySyncRequestSchema.shape.deal.parse(body.deal);
    const { pipelineId, stageId } = resolveStage(body.radarStage);
    const result = await hubspotService().syncCompany({
      company: {
        name: deal.companyName, domain: null, website: null, city: '', state: '',
        country: 'United States', description: '', vertical: deal.vertical, subcategory: '',
        stage: deal.stage, accelerator: null, fundingRaised: null,
        dateFirstSurfaced: deal.dateSurfaced, lastRefreshed: deal.dateSurfaced,
        primarySource: 'Deal Radar', policyException: deal.policyException,
        dealRadarId: deal.dealRadarId, dealRadarUrl: deal.dealRadarUrl,
      },
      contacts: [], deal, pipelineId, stageId,
      resolution: 'create-new', existingRecordId: null,
    });
    res.json({ dealId: result.dealId, dealUrl: result.dealUrl, demo: result.demo });
  }));

  app.post('/api/hubspot/log-activity', wrap(async (req, res) => {
    const { companyId, note, actor } = z
      .object({ companyId: z.string(), note: z.string().min(2), actor: z.string().default('team') })
      .parse(req.body);
    const record = store.raw.outreach[companyId];
    let hubspotNoteId: string | null = null;
    let demo = hubspotMode() === 'mock';
    if (record?.hubspotCompanyId) {
      const result = await hubspotService().logActivity({
        companyRecordId: record.hubspotCompanyId,
        note,
      });
      hubspotNoteId = result.noteId;
      demo = result.demo;
    }
    if (record) addActivity(companyId, 'note', note, actor, hubspotNoteId);
    res.json({ ok: true, hubspotNoteId, demo });
  }));

  // ── Outlook ────────────────────────────────────────────────────

  app.get('/api/outlook/status', wrap(async (_req, res) => {
    res.json(await outlookService().status());
  }));

  app.post('/api/outlook/connect', wrap(async (_req, res) => {
    res.json(await outlookService().beginConnect());
  }));

  app.get('/api/outlook/callback', wrap(async (req, res) => {
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.query);
    const { account } = await outlookService().handleCallback(code, state);
    res.redirect(`${env.FRONTEND_URL}/sources?outlook=connected&account=${encodeURIComponent(account)}`);
  }));

  app.post('/api/outlook/disconnect', wrap(async (_req, res) => {
    await outlookService().disconnect();
    res.json({ ok: true });
  }));

  app.post('/api/outlook/drafts', wrap(async (req, res) => {
    const input = z.object({
      companyId: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string().min(10),
      senderName: z.string().min(1),
      tone: z.string().default('—'),
    }).parse(req.body);

    const draftResult = await outlookService().createDraft({
      to: input.to, subject: input.subject, body: input.body,
    });

    const draft = outreachDraftSchema.parse({
      id: store.nextId('draft'),
      companyId: input.companyId,
      to: input.to,
      subject: input.subject,
      body: input.body,
      senderName: input.senderName,
      tone: input.tone,
      outlookDraftId: draftResult.draftId,
      outlookWebLink: draftResult.webLink,
      demo: draftResult.demo,
      createdAt: new Date().toISOString(),
    });
    store.raw.drafts.push(draft);
    store.save();

    // Update tracker + optionally HubSpot.
    const record = store.raw.outreach[input.companyId];
    let hubspotNoteId: string | null = null;
    if (record) {
      patchRecord(input.companyId, {
        outreachStatus: 'Saved to Outlook',
        draftCreatedAt: draft.createdAt,
        draftSubject: draft.subject,
        outlookDraftId: draftResult.draftId,
        outlookWebLink: draftResult.webLink,
        nextAction: 'Review the draft in Outlook and send it yourself',
      });
      if (record.hubspotCompanyId) {
        const note = await hubspotService().logActivity({
          companyRecordId: record.hubspotCompanyId,
          note: `Outreach draft created by ${input.senderName} — subject: "${input.subject}". Draft is awaiting human review and manual send from Outlook.`,
        });
        hubspotNoteId = note.noteId;
      }
      addActivity(input.companyId, 'draft-created', `Draft "${input.subject}" saved ${draftResult.demo ? '(Demo Mode — simulated Outlook draft)' : 'to Outlook'} by ${input.senderName}`, input.senderName, hubspotNoteId);
    }

    res.json({
      ok: true,
      demo: draftResult.demo,
      draftId: draft.id,
      outlookDraftId: draftResult.draftId,
      webLink: draftResult.webLink,
      message: draftResult.demo
        ? 'Demo Mode: simulated saving an Outlook draft. No real draft was created.'
        : 'Draft saved to Outlook. Open Outlook to review and send it yourself.',
    });
  }));

  /**
   * Explicit user action: read the status of a draft this app created.
   * If Outlook reports it was sent, the tracker is updated — sent
   * status is only ever confirmed this way or by manual marking.
   */
  app.post('/api/outlook/sync-status', wrap(async (req, res) => {
    const { companyId, actor } = z
      .object({ companyId: z.string(), actor: z.string().default('team') })
      .parse(req.body);
    const record = store.raw.outreach[companyId];
    if (!record?.outlookDraftId) {
      res.status(404).json({ error: 'error', message: 'No Outlook draft is on record for this company.' });
      return;
    }
    const status = await outlookService().getMessageStatus(record.outlookDraftId);
    let updated = record;
    if (status.sentAt && !record.emailSentAt) {
      updated = patchRecord(companyId, {
        outreachStatus: 'Manually Marked Sent',
        emailSentAt: status.sentAt,
        nextAction: 'Set a follow-up date',
      });
      addActivity(companyId, 'marked-sent', `Sent status confirmed from Outlook (${status.sentAt}) by ${actor}`, actor);
    }
    res.json({ status, record: updated });
  }));

  // ── AI analysis ────────────────────────────────────────────────

  app.post('/api/ai/explain-fit', wrap(async (req, res) => {
    res.json(await explainFit(req.body));
  }));

  app.post('/api/ai/compare-portfolio', wrap(async (req, res) => {
    const { company, portfolio } = z
      .object({ company: z.unknown(), portfolio: z.unknown().optional() })
      .parse(req.body);
    res.json(await comparePortfolio(company, portfolio ?? null));
  }));

  // ── Refresh system & connectors ────────────────────────────────

  app.get('/api/refresh/connectors', wrap(async (_req, res) => {
    res.json({ connectors: listConnectors() });
  }));

  app.post('/api/refresh/connectors/:id/enabled', wrap(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(setConnectorEnabled(req.params.id as string, enabled));
  }));

  app.post('/api/refresh/run', wrap(async (req, res) => {
    res.json(await runRefresh(refreshRequestSchema.parse(req.body ?? {})));
  }));

  app.post('/api/refresh/cancel', wrap(async (_req, res) => {
    cancelRefresh();
    res.json({ ok: true, message: 'Cancellation requested — the run stops before the next connector.' });
  }));

  app.get('/api/refresh/log', wrap(async (_req, res) => {
    res.json({ log: refreshLog() });
  }));

  // ── Deal discovery (Phase 4) ───────────────────────────────────

  app.get('/api/discovery/sources', wrap(async (_req, res) => {
    res.json({ sources: SOURCE_META });
  }));

  app.post('/api/discovery/estimate', wrap(async (req, res) => {
    const q = discoveryQuerySchema.parse(req.body);
    res.json(estimateCost(q));
  }));

  app.post('/api/discovery/run', wrap(async (req, res) => {
    const actor = z.object({ actor: z.string().default('team') }).parse({ actor: req.body?.actor }).actor;
    const run = await runDiscovery(req.body?.query ?? req.body, actor);
    res.json(run);
  }));

  app.post('/api/discovery/cancel', wrap(async (_req, res) => {
    cancelDiscovery();
    res.json({ ok: true, message: 'Cancellation requested — the run stops before the next source.' });
  }));

  app.get('/api/discovery/candidates', wrap(async (req, res) => {
    const { runId, status } = z.object({ runId: z.string().optional(), status: z.string().optional() }).parse(req.query);
    let candidates = existingCandidates();
    if (runId) candidates = candidates.filter((c) => c.runId === runId);
    if (status) candidates = candidates.filter((c) => c.status === status);
    res.json({ candidates });
  }));

  app.post('/api/discovery/import', wrap(async (req, res) => {
    res.json(importCandidates(req.body));
  }));

  app.get('/api/discovery/runs', wrap(async (_req, res) => {
    res.json({ runs: discoveryRuns() });
  }));

  // ── Stealth Founder Radar (Phase 4) ────────────────────────────

  app.get('/api/stealth/signals', wrap(async (_req, res) => {
    res.json({ signals: listSignals() });
  }));

  app.post('/api/stealth/signals', wrap(async (req, res) => {
    res.json(addSignal(req.body));
  }));

  app.post('/api/stealth/signals/:id', wrap(async (req, res) => {
    res.json(patchSignal(req.params.id as string, req.body));
  }));

  app.post('/api/stealth/signals/:id/hypothesis', wrap(async (req, res) => {
    res.json(generateHypothesis(req.params.id as string));
  }));

  // ── Scheduled sourcing (configuration; gated execution) ───────

  app.get('/api/schedule', wrap(async (_req, res) => {
    res.json({ ...schedulerStatus(), jobs: listJobs() });
  }));

  app.post('/api/schedule', wrap(async (req, res) => {
    res.json(saveJob(req.body));
  }));

  app.delete('/api/schedule/:id', wrap(async (req, res) => {
    deleteJob(req.params.id as string);
    res.json({ ok: true });
  }));

  // ── Portfolio (Phase 4: manual create + CSV) ───────────────────

  app.get('/api/portfolio', wrap(async (_req, res) => {
    res.json({ portfolio: store.raw.portfolio });
  }));

  app.post('/api/portfolio/company', wrap(async (req, res) => {
    const company = portfolioCompanySchema.parse(req.body);
    const rest = store.raw.portfolio.filter((p) => (p as { name?: string }).name?.toLowerCase() !== company.name.toLowerCase());
    store.raw.portfolio = [...rest, company];
    store.save();
    res.json({ ok: true, count: store.raw.portfolio.length });
  }));

  app.post('/api/portfolio/import-csv', wrap(async (req, res) => {
    const { csv } = z.object({ csv: z.string().min(10) }).parse(req.body);
    const rows = parseCsv(csv);
    let imported = 0;
    const skipped: { row: number; issues: string[] }[] = [];
    rows.forEach((row, i) => {
      const parsed = portfolioCompanySchema.safeParse({
        ...row,
        themes: row.themes ? row.themes.split('|').map((s) => s.trim()).filter(Boolean) : [],
        evidenceUrls: row.evidenceUrls ? row.evidenceUrls.split('|').map((s) => s.trim()).filter(Boolean) : [],
        partnershipThemes: row.partnershipThemes ? row.partnershipThemes.split('|').map((s) => s.trim()).filter(Boolean) : [],
        competitiveOverlapThemes: row.competitiveOverlapThemes ? row.competitiveOverlapThemes.split('|').map((s) => s.trim()).filter(Boolean) : [],
      });
      if (!parsed.success) {
        skipped.push({ row: i + 2, issues: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
        return;
      }
      store.raw.portfolio = [
        ...store.raw.portfolio.filter((p) => (p as { name?: string }).name?.toLowerCase() !== parsed.data.name.toLowerCase()),
        parsed.data,
      ];
      imported += 1;
    });
    store.save();
    res.json({ imported, skipped, total: rows.length });
  }));

  // ── Local imports ──────────────────────────────────────────────

  app.post('/api/companies/import-csv', wrap(async (req, res) => {
    const { csv } = z.object({ csv: z.string().min(10) }).parse(req.body);
    res.json(importCompaniesCsv(csv));
  }));

  app.get('/api/companies/imported', wrap(async (_req, res) => {
    res.json({ companies: importedCompanies(), companyMeta: store.raw.companyMeta });
  }));

  app.post('/api/companies/imported/clear', wrap(async (_req, res) => {
    clearImportedCompanies();
    res.json({ ok: true });
  }));

  app.get('/api/portfolio', wrap(async (_req, res) => {
    res.json({ portfolio: store.raw.portfolio });
  }));

  app.put('/api/portfolio', wrap(async (req, res) => {
    res.json(savePortfolio(req.body));
  }));

  // ── Outreach generation & tracking ─────────────────────────────

  app.post('/api/outreach/generate', wrap(async (req, res) => {
    const context = emailGenContextSchema.parse(req.body);
    const gen = emailGenerator();
    const email = await gen.generateOutreachEmail(context);

    // Ensure a tracker record exists and reflects generation.
    upsertRecord(
      {
        companyId: context.companyId,
        companyName: context.companyName,
        founderName: context.founderFullName,
        founderEmail: context.founderEmail,
        owner: context.senderName,
        vertical: context.vertical,
        companyStage: '—',
        fitScore: 1,
        policyException: null,
        sourceQuality: 0,
      },
      {},
    );
    const rec = store.raw.outreach[context.companyId];
    patchRecord(context.companyId, {
      outreachStatus:
        rec.outreachStatus === 'Not Reviewed' || rec.outreachStatus === 'Approved for Tracking' || rec.outreachStatus === 'Added to HubSpot' || rec.outreachStatus === 'Outreach Approved'
          ? 'Draft Generated'
          : rec.outreachStatus,
    });
    addActivity(context.companyId, 'outreach-approved', `Outreach generation run by ${context.senderName} (tone: ${context.tone})`, context.senderName);
    res.json(email);
  }));

  app.post('/api/outreach/regenerate', wrap(async (req, res) => {
    const { context, instructions } = z
      .object({ context: emailGenContextSchema, instructions: z.string().default('') })
      .parse(req.body);
    res.json(await emailGenerator().regenerateOutreachEmail(context, instructions));
  }));

  app.get('/api/outreach/records', wrap(async (_req, res) => {
    res.json({ records: getRecords(), followUps: followUpSummary() });
  }));

  app.post('/api/outreach/upsert', wrap(async (req, res) => {
    const body = z.object({
      seed: z.object({
        companyId: z.string(), companyName: z.string(), founderName: z.string(),
        founderEmail: z.string().nullable(), owner: z.string(), vertical: z.string(),
        companyStage: z.string(), fitScore: z.number(), policyException: z.string().nullable(),
        sourceQuality: z.number(),
      }),
      patch: z.record(z.string(), z.unknown()).default({}),
    }).parse(req.body);
    res.json(upsertRecord(body.seed, body.patch as never));
  }));

  app.post('/api/outreach/status', wrap(async (req, res) => {
    const { companyId, status, actor } = z
      .object({ companyId: z.string(), status: z.string(), actor: z.string().default('team') })
      .parse(req.body);
    const { isValidStatus } = await import('./services/records');
    if (!isValidStatus(status)) {
      res.status(400).json({ error: 'invalid_status', message: `"${status}" is not a valid outreach status.` });
      return;
    }
    const record = patchRecord(companyId, { outreachStatus: status });
    addActivity(companyId, 'note', `Status changed to ${status}`, actor);
    res.json(record);
  }));

  app.post('/api/outreach/mark-sent', wrap(async (req, res) => {
    const { companyId, actor } = z
      .object({ companyId: z.string(), actor: z.string().default('team') })
      .parse(req.body);
    const record = patchRecord(companyId, {
      outreachStatus: 'Manually Marked Sent',
      emailSentAt: new Date().toISOString(),
      nextAction: 'Set a follow-up date',
    });
    let hubspotNoteId: string | null = null;
    if (record.hubspotCompanyId) {
      const note = await hubspotService().logActivity({
        companyRecordId: record.hubspotCompanyId,
        note: `Outreach email manually marked as sent by ${actor}.`,
      });
      hubspotNoteId = note.noteId;
    }
    addActivity(companyId, 'marked-sent', `Email manually marked as sent by ${actor}`, actor, hubspotNoteId);
    res.json(record);
  }));

  app.post('/api/outreach/follow-up', wrap(async (req, res) => {
    const { companyId, dueDate, note, actor } = z
      .object({
        companyId: z.string(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().default(''),
        actor: z.string().default('team'),
      })
      .parse(req.body);
    const task = setFollowUp(companyId, dueDate, note);
    patchRecord(companyId, {
      outreachStatus: 'Follow-Up Needed',
      nextAction: `Follow up on ${dueDate}${note ? ` — ${note}` : ''}`,
    });
    addActivity(companyId, 'follow-up-set', `Follow-up set for ${dueDate}${note ? ` — ${note}` : ''}`, actor);
    res.json(task);
  }));

  app.post('/api/outreach/meeting', wrap(async (req, res) => {
    const { companyId, status, actor } = z
      .object({
        companyId: z.string(),
        status: z.enum(['None', 'Requested', 'Scheduled', 'Held']),
        actor: z.string().default('team'),
      })
      .parse(req.body);
    const record = patchRecord(companyId, {
      meetingStatus: status,
      outreachStatus: status === 'Scheduled' ? 'Meeting Scheduled' : store.raw.outreach[companyId].outreachStatus,
    });
    if (status === 'Scheduled') addActivity(companyId, 'meeting-scheduled', `Meeting scheduled by ${actor}`, actor);
    res.json(record);
  }));

  // ── Error handling: sanitized, user-friendly ───────────────────

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'validation_failed',
        message: 'The request did not pass validation.',
        issues: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      });
      return;
    }
    const e = err as { message?: string; status?: number; hint?: string; issues?: string[] };
    const status = e.status ?? 500;
    if (status >= 500 && process.env.NODE_ENV !== 'test') {
      console.error('Unhandled error:', e.message); // message only — never payloads/tokens
    }
    res.status(status).json({
      error: status === 401 ? 'auth_failed' : status === 409 ? 'blocked' : status === 422 ? 'rejected' : 'error',
      message: e.message ?? 'Something went wrong.',
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.issues ? { issues: e.issues } : {}),
    });
  });

  return app;
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
  };
}
