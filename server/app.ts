import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './env';
import { idempotencyGuard, requestLogger } from './lib/guard';
import { sanitizeErrorForClient } from './lib/errors';
import { healthRouter } from './routes/health';
import { statusRouter } from './routes/status';
import { hubspotRouter } from './routes/hubspot';
import { outlookRouter } from './routes/outlook';
import { aiRouter } from './routes/ai';
import { outreachRouter } from './routes/outreach';
import { refreshRouter } from './routes/refresh';
import { discoveryRouter } from './routes/discovery';
import { stealthRouter } from './routes/stealth';
import { scheduleRouter } from './routes/schedule';
import { portfolioRouter } from './routes/portfolio';
import { duplicatesRouter } from './routes/duplicates';
import { adminRouter } from './routes/admin';
import { importsRouter } from './routes/imports';
import { authRouter } from './routes/auth';

/**
 * App factory: middleware, per-domain routers (server/routes/), and
 * the sanitized error handler. All business logic lives in
 * server/services/; routers only validate, delegate, and shape
 * responses.
 */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // credentials: false is safe as long as the frontend reaches the API
  // same-origin (the Vite dev proxy, or a single origin in production).
  // Splitting frontend/backend across real origins later would need
  // credentials: true here, matching fetch credentials on the client,
  // and the admin session cookie's SameSite changed from 'lax' to
  // 'none' + secure (see server/routes/auth.ts).
  app.use(
    cors({
      origin: [env.FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: false,
    }),
  );
  app.use(requestLogger);

  // Health endpoints: bare paths (not under /api), never rate-limited
  // or gated — orchestrators/hosting platforms probe these frequently
  // and expect a fast, unauthenticated response.
  app.use(healthRouter);

  // The Settings page alone fires a couple dozen requests per load, and
  // the E2E suite reloads it many times inside one 60s window from a
  // single IP — a real client would never do this. Raise the ceiling
  // only under the test harness (NODE_ENV=test, set explicitly by
  // e2e/env.ts and vitest); production keeps the real limit.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: process.env.NODE_ENV === 'test' ? 5_000 : 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api/outreach/generate',
    rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }),
  );
  // Live research refresh makes several real outbound requests per
  // call — cheaper than outreach generation, but still not something
  // to allow unbounded.
  app.use(
    '/api/companies/:id/refresh-research',
    rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }),
  );
  app.use('/api', idempotencyGuard);

  app.use('/api', authRouter);
  app.use('/api', statusRouter);
  app.use('/api', hubspotRouter);
  app.use('/api', outlookRouter);
  app.use('/api', aiRouter);
  app.use('/api', outreachRouter);
  app.use('/api', discoveryRouter);
  app.use('/api', stealthRouter);
  app.use('/api', portfolioRouter);
  app.use('/api', duplicatesRouter);
  app.use('/api', importsRouter);
  // These three are entirely administrator-only end to end (every
  // route requires a session — see requireAdmin in each file), so
  // they're mounted at their OWN path prefix rather than the shared
  // '/api'. Mounting an unconditionally-gating router at the shared
  // prefix would 401 every request that reaches it before Express
  // ever tries the routers registered after it — see git history on
  // this line for the incident that taught us this the hard way.
  app.use('/api/schedule', scheduleRouter);
  app.use('/api/refresh', refreshRouter);
  app.use('/api/admin', adminRouter);

  // ── Serve the built frontend in production ─────────────────────
  // In dev, Vite serves the frontend on :5173 and proxies /api to
  // this server — nothing to do here. In production there is no
  // separate Vite server, so this process also serves the built
  // `dist/` bundle (and falls back to index.html for client-side
  // routes) when it exists. A missing `dist/` (e.g. dev mode running
  // with NODE_ENV=production by mistake) degrades to a clear message
  // instead of a silent 404.
  const distDir = path.resolve(import.meta.dirname, '..', 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api|\/health).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else if (process.env.NODE_ENV === 'production') {
    app.get(/^(?!\/api|\/health).*/, (_req, res) => {
      res.status(503).send('Frontend build not found — run `npm run build` before starting in production.');
    });
  }

  // ── Error handling: sanitized, user-friendly ───────────────────
  // sanitizeErrorForClient decides what's safe to show; see server/lib/errors.ts.

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const safe = sanitizeErrorForClient(err);
    if (safe.status >= 500 && safe.status !== 503 && process.env.NODE_ENV !== 'test') {
      console.error('Unhandled error:', (err as { message?: string })?.message); // message only — never payloads/tokens
    }
    res.status(safe.status).json({
      error: safe.error,
      message: safe.message,
      ...(safe.hint ? { hint: safe.hint } : {}),
      ...(safe.issues ? { issues: safe.issues } : {}),
    });
  });

  return app;
}
