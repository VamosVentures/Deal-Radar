import { createApp } from './app';
import { startScheduler, stopScheduler } from './services/schedule';
import { aiConfigured, env, outlookConfigured } from './env';
import { hubspotConnected } from './services/hubspot';
import { store } from './lib/store';
import { closeDb } from './db/client';

const app = createApp();

if (process.env.NODE_ENV === 'production') {
  // Nothing here is fatal by design (every integration is optional —
  // see KNOWN_LIMITATIONS.md) but an operator starting a real
  // deployment should see these called out clearly, not discover them
  // later as a silent "not connected" state.
  if (!env.ADMIN_PASSWORD) console.warn('[startup] ADMIN_PASSWORD is not set — every administrator-plane action (scheduling, connectors, HubSpot/Outlook connect) is unusable until it is.');
  if (!env.SESSION_SECRET) console.warn('[startup] SESSION_SECRET is not set — admin sessions use an ephemeral per-process key (fine for one instance, but every restart signs everyone out), and live Outlook cannot store tokens at rest.');
}

const server = app.listen(env.PORT, () => {
  const y = (b: boolean) => (b ? 'connected/configured' : 'not connected');
  console.log(`Vamos Deal Radar API listening on :${env.PORT}`);
  console.log(
    `Integrations → HubSpot: ${y(hubspotConnected())} · Outlook: ${y(outlookConfigured())} · AI: ${aiConfigured() ? 'configured' : 'local templates'}`,
  );
  if (!hubspotConnected() && !outlookConfigured()) {
    console.log('No integrations are connected. External actions will fail honestly until credentials are added — see .env.example.');
  }
});

startScheduler(); // no-op unless RUN_SCHEDULER=true

// ── Graceful shutdown ──────────────────────────────────────────────
// Stop the scheduler first (no new tick starts mid-shutdown), stop
// accepting new HTTP connections, give in-flight requests a short
// grace period to finish, then close the database and exit. A hard
// timeout forces exit if something hangs, so shutdown is never stuck.

let shuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] Received ${signal} — stopping scheduler, closing server...`);

  stopScheduler();

  const forceExit = setTimeout(() => {
    console.error('[shutdown] Grace period elapsed with requests still in flight — forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref?.();

  server.close((err) => {
    clearTimeout(forceExit);
    if (err) console.error('[shutdown] Error while closing the HTTP server:', err.message);
    try {
      closeDb();
      store.flush();
      console.log('[shutdown] Database closed, operational state flushed. Exiting cleanly.');
      process.exit(err ? 1 : 0);
    } catch (e) {
      console.error('[shutdown] Error while closing the database:', (e as Error).message);
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
