import { Router } from 'express';
import { aiConfigured, env } from '../env';
import { store } from '../lib/store';
import { wrap } from './helpers';
import { HUBSPOT_OAUTH_SCOPES, hubspotAuthType, hubspotServiceIfAvailable } from '../services/hubspot';
import { outlookService } from '../services/outlook';
import { verifyAiConnection } from '../services/analysis';
import { refreshLog } from '../services/refresh';
import { getStaleSettings, recordIntegrationHealth } from '../db/repos/operations';
import {
  AI_UNAVAILABLE_DETAIL, AI_UNAVAILABLE_STATUS,
  OUTLOOK_UNAVAILABLE_DETAIL, OUTLOOK_UNAVAILABLE_STATUS,
  type IntegrationsStatus,
} from '../../shared/integrations';

export type UiStatus =
  | 'Connected'
  | 'Not connected'
  | 'Disconnected'
  | 'Configuration required'
  | 'Expired'
  | 'Error'
  | typeof OUTLOOK_UNAVAILABLE_STATUS
  | typeof AI_UNAVAILABLE_STATUS;

// Verification results are cached briefly so the status endpoint stays
// cheap; "Connected" is only ever shown after a real verified call.
const verifyCache = new Map<string, { at: number; ok: boolean; detail: string }>();
export function resetVerifyCacheForTests(): void {
  verifyCache.clear();
}
async function cachedVerify(key: string, run: () => Promise<{ ok: boolean; detail: string }>) {
  const hit = verifyCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
  const res = await run().catch((e: Error) => ({ ok: false, detail: e.message }));
  const entry = { at: Date.now(), ...res };
  verifyCache.set(key, entry);
  return entry;
}

export const statusRouter = Router();

statusRouter.get('/integrations/status', wrap(async (_req, res) => {
  const hsService = hubspotServiceIfAvailable();
  const outlook = await outlookService().status();
  const aiLive = aiConfigured();

  // HubSpot: never claim connected without a verified real call.
  let hsStatus: UiStatus = 'Not connected';
  let hsDetail = 'Implemented — credentials required. Add HUBSPOT_ACCESS_TOKEN (or OAuth credentials) to .env to enable live HubSpot actions; nothing is simulated meanwhile.';
  if (hsService) {
    const v = await cachedVerify('hubspot', () => hsService.verifyConnection());
    hsStatus = v.ok ? 'Connected' : 'Error';
    hsDetail = v.detail;
  }

  let olStatus: UiStatus;
  let olDetail = outlook.detail;
  if (outlook.mode === 'disconnected') {
    // Names who has to act, rather than reporting the code's state.
    olStatus = OUTLOOK_UNAVAILABLE_STATUS;
    olDetail = OUTLOOK_UNAVAILABLE_DETAIL;
  } else if (!outlook.connected) {
    olStatus = 'Disconnected';
  } else {
    const v = await cachedVerify('outlook', () => outlookService().verifyConnection());
    olStatus = v.ok ? 'Connected' : /expired|reconnect/i.test(v.detail) ? 'Expired' : 'Error';
    olDetail = v.detail;
  }

  let aiStatus: UiStatus = AI_UNAVAILABLE_STATUS;
  let aiDetail = AI_UNAVAILABLE_DETAIL;
  if (aiLive) {
    const v = await cachedVerify('ai', verifyAiConnection);
    aiStatus = v.ok ? 'Connected' : 'Error';
    aiDetail = v.detail;
  }

  // Durable health history — one row per provider with the latest check.
  recordIntegrationHealth('hubspot', hsStatus === 'Connected', hsStatus, hsDetail);
  recordIntegrationHealth('outlook', olStatus === 'Connected', olStatus, olDetail);
  recordIntegrationHealth('ai', aiStatus === 'Connected', aiStatus, aiDetail);

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
    mode: hsService || outlook.mode === 'live' || aiLive ? 'live' : 'disconnected',
    hubspot: {
      provider: 'hubspot',
      mode: hsService ? 'live' : 'disconnected',
      connected: hsStatus === 'Connected',
      account: hsService ? (env.HUBSPOT_PORTAL_ID ?? hubspotAuthType()) : null,
      detail: hsDetail,
      // The scopes actually requested, read from the one list that
      // builds the authorize URL — not a hand-maintained summary that
      // can drift into understating what was granted.
      permissions: hsService ? [...HUBSPOT_OAUTH_SCOPES] : [],
      lastConnectedAt: null,
    },
    outlook: {
      provider: 'outlook',
      mode: outlook.mode === 'disconnected' ? 'disconnected' : 'live',
      connected: olStatus === 'Connected',
      account: outlook.account,
      detail: olDetail,
      permissions: outlook.permissions,
      lastConnectedAt: outlook.lastConnectedAt,
    },
    ai: {
      provider: 'ai',
      mode: aiLive ? 'live' : 'disconnected',
      connected: aiStatus === 'Connected',
      account: aiLive ? `${env.AI_PROVIDER} / ${env.AI_MODEL ?? 'default'}` : 'Local template generator (no AI model)',
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

statusRouter.get('/audit', wrap(async (_req, res) => {
  res.json(store.raw.audit.slice(0, 100));
}));

// Public read: not sensitive, and every page rendering a Stale badge
// needs it. Only PUT /api/admin/stale-settings requires admin sign-in.
statusRouter.get('/stale-settings', wrap(async (_req, res) => {
  res.json(getStaleSettings());
}));
