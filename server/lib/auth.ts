import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { adminAuthConfigured, adminSessionKey, env } from '../env';

/**
 * Real server-side enforcement for "Administrator-only" actions
 * (scheduled sourcing, connector management, HubSpot/Outlook
 * connect-disconnect). Previously these were gated only by the
 * frontend hiding a button — anyone who could reach the API could
 * call them directly. This is a single shared admin password, not a
 * multi-user system: sufficient to close the "anyone can trigger this"
 * gap for a small internal tool, not a substitute for real per-user
 * accounts if this is ever opened up to a larger team.
 */

export const SESSION_COOKIE = 'vamos_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60_000; // 12 hours

function sign(payload: string): string {
  return crypto.createHmac('sha256', adminSessionKey).update(payload).digest('base64url');
}

export function createSessionToken(): string {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return false;
  const expected = sign(encoded);
  // Lengths must match for timingSafeEqual; a malformed token just fails the check.
  if (expected.length !== sig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { exp: number };
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

/** Constant-time password check — never a plain `===` on a secret. */
export function passwordMatches(candidate: string): boolean {
  if (!env.ADMIN_PASSWORD) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(env.ADMIN_PASSWORD);
  if (a.length !== b.length) return false; // lengths differing is not itself sensitive here
  return crypto.timingSafeEqual(a, b);
}

/** Minimal cookie-header reader — avoids pulling in cookie-parser for one cookie. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Gate for every admin-only route. Fails closed: if ADMIN_PASSWORD was
 * never configured, admin actions are entirely unusable (401) rather
 * than silently open — unlike other integrations in this app, a
 * missing credential here must not mean "runs anyway."
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!adminAuthConfigured()) {
    res.status(401).json({
      error: 'auth_failed',
      message: 'Administrator actions are not enabled.',
      hint: 'Set ADMIN_PASSWORD in .env, then sign in from Settings.',
    });
    return;
  }
  if (!verifySessionToken(readCookie(req, SESSION_COOKIE))) {
    res.status(401).json({
      error: 'auth_failed',
      message: 'Administrator sign-in required.',
    });
    return;
  }
  next();
}
