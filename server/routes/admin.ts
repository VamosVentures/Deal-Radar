import { Router } from 'express';
import { z } from 'zod';
import { aiConfigured, env, hubspotOAuthConfigured, outlookConfigured } from '../env';
import { getDb } from '../db/client';
import { failedHubspotSyncs, listRuns, setStaleSettings } from '../db/repos/operations';
import {
  AI_UNAVAILABLE_DETAIL, AI_UNAVAILABLE_STATUS,
  OUTLOOK_UNAVAILABLE_DETAIL, OUTLOOK_UNAVAILABLE_STATUS,
  staleSettingsSchema,
} from '../../shared/integrations';
import { hubspotServiceIfAvailable } from '../services/hubspot';
import { outlookService } from '../services/outlook';
import { verifyAiConnection } from '../services/analysis';
import { computeSourceAnalytics } from '../services/sourceAnalytics';
import { computeSourceHealth } from '../services/sourceHealth';
import { buildShortlists, DEFAULT_PER_SECTOR, diversityAnalytics } from '../services/shortlist';
import { CORE_VERTICAL_IDS } from '../../src/data/taxonomy';
import { backupSettingsSchema, createBackup, getBackupMetadata, getBackupPath, getBackupSettings, listBackups, setBackupSettings } from '../services/backup';
import { fetchWithTimeout } from '../lib/http';
import { activeModel, budgetStatus, budgetWarning, getAiSettings, setAiSettings, usageReport } from '../services/aiBudget';
import { aiSettingsBaseSchema, PRICING_CHECKED_ON, PRICING_SOURCE_URL } from '../../shared/ai';
import { requireAdmin } from '../lib/auth';
import { wrap } from './helpers';

/**
 * Settings — Admin Only system panel. Everything here is either a
 * real health check ("Connected" appears ONLY after one succeeds), a
 * credential-presence boolean (never a secret value), or an aggregate
 * over persisted run history. Secrets stay server-side.
 *
 * Every route in this router requires an authenticated admin session
 * (requireAdmin) — this panel exposes operational detail (error text,
 * rate-limit state, run history) beyond just credential-presence
 * booleans, so it's gated the same as the mutating admin actions.
 *
 * Mounted at '/api/admin' (not the shared '/api') so this router's
 * unconditional requireAdmin gate can never intercept requests bound
 * for other routers — see app.ts for the mount point.
 */
export const adminRouter = Router();
adminRouter.use(requireAdmin);

type UiStatus =
  | 'Connected'
  | 'Not connected'
  | 'Implemented — credentials required'
  | 'Error'
  | typeof OUTLOOK_UNAVAILABLE_STATUS
  | typeof AI_UNAVAILABLE_STATUS;

const healthCache = new Map<string, { at: number; status: UiStatus; detail: string }>();
export function resetAdminHealthCacheForTests(): void {
  healthCache.clear();
}
async function cachedHealth(key: string, run: () => Promise<{ status: UiStatus; detail: string }>) {
  const hit = healthCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
  const res = await run().catch((e: Error) => ({ status: 'Error' as UiStatus, detail: e.message }));
  const entry = { at: Date.now(), ...res };
  healthCache.set(key, entry);
  return entry;
}

async function githubHealth(): Promise<{ status: UiStatus; detail: string }> {
  try {
    const res = await fetchWithTimeout('https://api.github.com/rate_limit', {
      headers: {
        'User-Agent': 'vamos-deal-radar',
        ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
    }, 6000);
    if (!res.ok) return { status: 'Error', detail: `GitHub API returned ${res.status}.` };
    const data = (await res.json()) as { resources?: { core?: { remaining?: number; limit?: number; reset?: number } } };
    const core = data.resources?.core;
    const reset = core?.reset ? new Date(core.reset * 1000).toISOString().slice(11, 16) : '?';
    return {
      status: 'Connected',
      detail: `GitHub API verified. Rate limit ${core?.remaining ?? '?'}/${core?.limit ?? '?'} remaining (resets ${reset} UTC)${env.GITHUB_TOKEN ? ', authenticated' : ', unauthenticated'}.`,
    };
  } catch (e) {
    return { status: 'Error', detail: `GitHub API unreachable: ${(e as Error).message}` };
  }
}

adminRouter.get('/status', wrap(async (_req, res) => {
  // ── Database ────────────────────────────────────────────────────
  const db = getDb();
  const companies = (db.prepare("SELECT COUNT(*) AS n FROM companies WHERE status = 'active'").get() as { n: number }).n;
  const migrationVersion = (db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null }).v ?? 0;
  const location = env.DATABASE_FILE ?? env.DATA_FILE ?? 'server/.data/deal-radar.db';

  // ── Connector health (Connected ONLY after a real check) ────────
  const github = await cachedHealth('github', githubHealth);

  const hsService = hubspotServiceIfAvailable();
  const hubspot = hsService
    ? await cachedHealth('hubspot', async () => {
        const v = await hsService.verifyConnection();
        return { status: v.ok ? 'Connected' as UiStatus : 'Error' as UiStatus, detail: v.detail };
      })
    : { status: 'Implemented — credentials required' as UiStatus, detail: 'The full HubSpot client is implemented; add HUBSPOT_ACCESS_TOKEN or OAuth credentials to enable live actions. No simulated success is ever shown.' };

  const outlookSvc = outlookService();
  const outlookStatus = await outlookSvc.status();
  const outlook = outlookStatus.mode === 'disconnected'
    ? { status: OUTLOOK_UNAVAILABLE_STATUS as UiStatus, detail: OUTLOOK_UNAVAILABLE_DETAIL }
    : !outlookStatus.connected
      ? { status: 'Not connected' as UiStatus, detail: outlookStatus.detail }
      : await cachedHealth('outlook', async () => {
          const v = await outlookSvc.verifyConnection();
          return { status: v.ok ? 'Connected' as UiStatus : 'Error' as UiStatus, detail: v.detail };
        });

  const ai = aiConfigured()
    ? await cachedHealth('ai', async () => {
        const v = await verifyAiConnection();
        return { status: v.ok ? 'Connected' as UiStatus : 'Error' as UiStatus, detail: v.detail };
      })
    : { status: AI_UNAVAILABLE_STATUS as UiStatus, detail: AI_UNAVAILABLE_DETAIL };

  // ── Credential presence (booleans only — never values) ──────────
  const credentials = {
    hubspotPrivateAppToken: !!env.HUBSPOT_ACCESS_TOKEN,
    hubspotOAuthApp: hubspotOAuthConfigured(),
    hubspotPortalId: !!env.HUBSPOT_PORTAL_ID,
    microsoftEntraApp: outlookConfigured(),
    sessionSecret: !!env.SESSION_SECRET,
    aiProviderKey: aiConfigured(),
    githubToken: !!env.GITHUB_TOKEN,
    secContactEmail: !!env.SEC_CONTACT_EMAIL,
  };

  // ── Sourcing runs (persisted history) ───────────────────────────
  const runs = listRuns(200);
  const lastRun = runs[0] ?? null;
  const lastSuccessfulRun = runs.find((r) => r.status === 'Completed' || r.status === 'Completed with warnings') ?? null;
  const lastFailedRun = runs.find((r) => r.status === 'Failed') ?? null;
  const rateLimited = Array.from(new Set(
    runs.slice(0, 20).flatMap((r) => r.sourceResults.filter((x) => x.failureKind === 'rate-limited').map((x) => x.sourceId)),
  ));

  res.json({
    database: {
      ok: true, // this handler just read from it
      engine: 'SQLite (node:sqlite, WAL)',
      location,
      companies,
      migrationVersion,
    },
    connectors: {
      github: { status: github.status, detail: github.detail },
      hubspot: { status: hubspot.status, detail: hubspot.detail },
      outlook: { status: outlook.status, detail: outlook.detail },
      ai: { status: ai.status, detail: ai.detail },
    },
    credentials,
    sourcing: {
      lastRun: lastRun ? { at: lastRun.at, status: lastRun.status, initiatedBy: lastRun.initiatedBy } : null,
      lastSuccessfulRun: lastSuccessfulRun ? { at: lastSuccessfulRun.at, status: lastSuccessfulRun.status } : null,
      lastFailedRun: lastFailedRun ? { at: lastFailedRun.at, status: lastFailedRun.status } : null,
      recordsRetrieved: runs.reduce((s, r) => s + r.discovered, 0),
      recordsCreated: runs.reduce((s, r) => s + r.imported, 0),
      recordsUpdated: runs.reduce((s, r) => s + r.updatedExisting, 0),
      recentErrors: (lastRun?.errors ?? []).slice(0, 10),
      rateLimited,
    },
    hubspotFailedSyncs: failedHubspotSyncs(),
  });
}));

/**
 * Stale-record settings (Phase 10) — how long a non-terminal company
 * can go untouched before the UI flags it Stale, whether Monitor/
 * Research Needed count, and how Overview surfaces the list. Persisted
 * via the generic config store; changes apply immediately, no restart.
 * Reading these isn't sensitive (no credentials involved) and every
 * page that renders a Stale badge needs them, so the read is public —
 * only the write is admin-gated. See statusRouter for the public GET.
 */
adminRouter.put('/stale-settings', wrap(async (req, res) => {
  const patch = staleSettingsSchema.partial().parse(req.body);
  res.json(setStaleSettings(patch));
}));

/**
 * Source-quality analytics — computed live on each request from
 * persisted run history + company/scoring records (see
 * server/services/sourceAnalytics.ts). Nothing is cached or
 * pre-aggregated, so it's always current as of this call.
 */
adminRouter.get('/source-analytics', wrap(async (_req, res) => {
  res.json({ sources: computeSourceAnalytics() });
}));

/**
 * Combined source-health view: getSourceMeta()'s static config state +
 * computeSourceAnalytics()'s real run history, in one payload instead
 * of two calls the UI previously had to reconcile itself. Never
 * exposes a token/credential or a raw stack trace — see
 * server/services/sourceHealth.ts.
 */
adminRouter.get('/source-health', wrap(async (_req, res) => {
  res.json({ sources: computeSourceHealth() });
}));

/**
 * Backup/restore (Phase 10) — see server/services/backup.ts. No
 * unrestricted browser "restore" button exists anywhere: restoring is
 * a deliberately server-side/CLI-only action (npm run db:restore),
 * documented in TECHNICAL_HANDOFF.md. These routes only list, create,
 * and locate backups.
 */
adminRouter.get('/backups', wrap(async (_req, res) => {
  res.json({ backups: listBackups(), settings: getBackupSettings() });
}));

adminRouter.post('/backups', wrap(async (req, res) => {
  const { actor } = z.object({ actor: z.string().default('admin') }).parse(req.body ?? {});
  const result = await createBackup(actor);
  if (!result.ok) {
    res.status(500).json({ error: 'error', message: result.error });
    return;
  }
  res.json(result.backup);
}));

adminRouter.get('/backups/:file/metadata', wrap(async (req, res) => {
  const meta = getBackupMetadata(req.params.file as string);
  if (!meta) {
    res.status(404).json({ error: 'not_found', message: 'No backup with that filename is on record.' });
    return;
  }
  res.json(meta);
}));

/** Returns the backup's absolute path on the server's filesystem — never streams the file itself over HTTP. */
adminRouter.get('/backups/:file/location', wrap(async (req, res) => {
  const path = getBackupPath(req.params.file as string);
  res.json({ path });
}));

adminRouter.put('/backup-settings', wrap(async (req, res) => {
  const patch = backupSettingsSchema.partial().parse(req.body);
  res.json(setBackupSettings(patch));
}));

// ── AI budget, kill switch, and usage ledger ──────────────────────
// This whole router already requires an administrator session (see the
// requireAdmin at the top of the file plus the whole-application gate
// in server/app.ts), which satisfies "protect AI configuration and
// usage endpoints with administrator authorization".

adminRouter.get('/ai/settings', wrap(async (_req, res) => {
  res.json({
    settings: getAiSettings(),
    status: budgetStatus(),
    warning: budgetWarning(),
    pricing: {
      sourceUrl: PRICING_SOURCE_URL,
      checkedOn: PRICING_CHECKED_ON,
      activeModel: activeModel(),
    },
  });
}));

adminRouter.put('/ai/settings', wrap(async (req, res) => {
  // .partial() on the base object: the cross-field refinements still run
  // on the MERGED result inside setAiSettings, so a patch cannot land the
  // thresholds in an inconsistent order.
  const patch = aiSettingsBaseSchema.partial().parse(req.body);
  res.json({ settings: setAiSettings(patch), status: budgetStatus() });
}));

/** The kill switch as its own endpoint — unambiguous, and cheap to hit in an incident. */
adminRouter.post('/ai/kill-switch', wrap(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  res.json({ settings: setAiSettings({ enabled }), status: budgetStatus() });
}));

adminRouter.get('/ai/usage', wrap(async (req, res) => {
  const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
  res.json(usageReport(month));
}));

/** Source-diversity analytics — derived only from persisted evidence and verdicts. */
adminRouter.get('/diversity-analytics', wrap(async (_req, res) => {
  res.json(diversityAnalytics(CORE_VERTICAL_IDS));
}));

/**
 * The per-sector shortlists themselves — the selected opportunities AND
 * every live deal that was held back, each with its specific reason.
 *
 * This endpoint exists because the selection was previously invisible.
 * `buildShortlists` was only ever called inside `diversityAnalytics`,
 * which returns counts, so a reader could see that a sector held 5 of 5
 * slots but never which companies filled them, and a company that lost a
 * slot left no trace anywhere in the UI. Counts without names are not
 * reviewable.
 */
adminRouter.get('/shortlists', wrap(async (_req, res) => {
  const shortlists = buildShortlists(CORE_VERTICAL_IDS).map((s) => ({
    vertical: s.vertical,
    eligible: s.eligible,
    leads: s.leads,
    shortfall: s.shortfall,
    shortageExplanation: s.shortageExplanation,
    selected: s.selected.map((c) => ({
      companyId: c.companyId,
      name: c.name,
      classification: c.opportunity.classification,
      primarySourceId: c.opportunity.primarySourceId,
      primaryTier: c.opportunity.primaryTier,
      evidenceUrl: c.opportunity.evidenceUrl,
      evidencePublishedAt: c.opportunity.evidencePublishedAt,
      amountText: c.opportunity.amountText,
      roundType: c.opportunity.roundType,
      fitScore: c.fitScore,
    })),
    heldBack: s.heldBack,
  }));
  res.json({
    shortlists,
    perSector: DEFAULT_PER_SECTOR,
    totalSelected: shortlists.reduce((n, s) => n + s.selected.length, 0),
    totalHeldBack: shortlists.reduce((n, s) => n + s.heldBack.length, 0),
  });
}));
