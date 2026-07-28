import { Router } from 'express';
import { getDb } from '../db/client';
import { latestMigrationVersion } from '../db/migrations';
import { schedulerEnabled, aiConfigured, outlookConfigured, env } from '../env';
import { hubspotConnected } from '../services/hubspot';
import { schedulerRunning } from '../services/schedule';
import { readCookie, SESSION_COOKIE, verifySessionToken } from '../lib/auth';

/**
 * Deployment health endpoints — deliberately NOT under /api (the
 * conventional bare path most hosting platforms/orchestrators probe).
 * /health/ready never fails on a missing THIRD-PARTY credential —
 * HubSpot/Outlook/AI/GitHub/Product Hunt are optional integrations by
 * design, reported as informational state, never a readiness blocker.
 */
export const healthRouter = Router();

healthRouter.get('/health/live', (_req, res) => {
  res.json({ status: 'live' });
});

healthRouter.get('/health/ready', (req, res) => {
  // Readiness has two audiences with different needs. An orchestrator
  // needs a status code and nothing else; an administrator debugging a
  // bad deploy needs the detail. Anonymous callers therefore get the
  // verdict only — the full body leaks the schema version, raw SQLite
  // error text, and which third-party integrations are configured,
  // none of which should be readable from the open internet.
  const detailed = verifySessionToken(readCookie(req, SESSION_COOKIE));
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    getDb().prepare('SELECT 1').get();
    checks.database = { ok: true, detail: 'Connected.' };
  } catch (e) {
    checks.database = { ok: false, detail: (e as Error).message };
  }

  try {
    const db = getDb();
    const applied = (db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null }).v ?? 0;
    const latest = latestMigrationVersion();
    checks.migrations = applied >= latest
      ? { ok: true, detail: `Schema v${applied} (current).` }
      : { ok: false, detail: `Schema v${applied}, expected v${latest} — migrations did not complete.` };
  } catch (e) {
    checks.migrations = { ok: false, detail: (e as Error).message };
  }

  // env.ts already throws at process boot if required config is malformed,
  // so reaching this handler at all proves the schema parsed successfully —
  // this check exists to make that fact explicit in the response.
  checks.config = { ok: true, detail: 'Environment configuration parsed successfully at boot.' };

  const allOk = Object.values(checks).every((c) => c.ok);
  const status = allOk ? 'ready' : 'not_ready';

  if (!detailed) {
    // Enough for a load balancer to route on, nothing more.
    res.status(allOk ? 200 : 503).json({ status });
    return;
  }

  res.status(allOk ? 200 : 503).json({
    status,
    checks,
    // Optional integrations — never block readiness, reported honestly.
    integrations: {
      hubspot: hubspotConnected() ? 'configured' : 'not_configured',
      outlook: outlookConfigured() ? 'configured' : 'not_configured',
      ai: aiConfigured() ? 'configured' : 'not_configured',
      github: env.GITHUB_TOKEN ? 'configured' : 'not_configured (works unauthenticated)',
      producthunt: env.PRODUCTHUNT_TOKEN ? 'configured' : 'not_configured',
    },
    scheduler: {
      enabled: schedulerEnabled(),
      running: schedulerRunning(),
    },
  });
});
