import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { wrap } from './helpers';
import { adminAuthConfigured } from '../env';
import { audit } from '../lib/guard';
import { createSessionToken, passwordMatches, readCookie, SESSION_COOKIE, verifySessionToken } from '../lib/auth';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Try again in a few minutes.' },
});

authRouter.get('/auth/status', wrap(async (req, res) => {
  res.json({
    configured: adminAuthConfigured(),
    authenticated: adminAuthConfigured() && verifySessionToken(readCookie(req, SESSION_COOKIE)),
  });
}));

authRouter.post('/auth/login', loginLimiter, wrap(async (req, res) => {
  const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
  if (!adminAuthConfigured()) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator actions are not enabled.', hint: 'Set ADMIN_PASSWORD in .env.' });
    return;
  }
  if (!passwordMatches(password)) {
    audit({ provider: 'system', mode: 'local', action: 'admin-login', subject: 'admin', outcome: 'blocked', detail: 'Incorrect password' });
    res.status(401).json({ error: 'auth_failed', message: 'Incorrect password.' });
    return;
  }
  res.cookie(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60_000,
    path: '/',
  });
  audit({ provider: 'system', mode: 'local', action: 'admin-login', subject: 'admin', outcome: 'ok', detail: 'Signed in' });
  res.json({ ok: true });
}));

authRouter.post('/auth/logout', wrap(async (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
}));
