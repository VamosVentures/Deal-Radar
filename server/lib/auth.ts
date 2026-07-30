import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { adminAuthConfigured, adminSessionKey, env, microsoftSsoConfigured } from '../env';

/** True when at least one identity provider could establish a session. */
export function authProviderConfigured(): boolean {
  return adminAuthConfigured() || microsoftSsoConfigured();
}

/**
 * Real server-side enforcement for "Administrator-only" actions
 * (scheduled sourcing, connector management, HubSpot/Outlook
 * connect-disconnect). Previously these were gated only by the
 * frontend hiding a button — anyone who could reach the API could
 * call them directly.
 *
 * Two identity providers can open a session, selected by AUTH_MODE
 * (see server/env.ts): the shared administrator password, and
 * Microsoft Entra SSO. The password is one shared credential rather
 * than a user account, which is why a session records WHICH provider
 * answered — a note written under the shared password must never be
 * mistakable for the work of a named employee.
 */

export const SESSION_COOKIE = 'vamos_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60_000; // 12 hours

/**
 * The identity carried inside a session cookie.
 *
 * The cookie is HMAC-signed and httpOnly, so this is tamper-evident
 * but not secret — which is fine, because it holds only who the person
 * is. No Microsoft access or refresh token is ever put in it, in any
 * mode. Those either are not retained at all (sign-in) or live
 * encrypted in the database (mailbox access).
 */
export interface SessionIdentity {
  /** 'local-admin', or the Entra object id under SSO. */
  sub: string;
  label: string;
  source: 'local-admin' | 'microsoft-sso';
  /** Verified work address; absent for the shared local password. */
  email?: string;
}

export const LOCAL_ADMIN_IDENTITY: SessionIdentity = {
  sub: 'local-admin',
  label: 'Local administrator',
  source: 'local-admin',
};

function sign(payload: string): string {
  return crypto.createHmac('sha256', adminSessionKey).update(payload).digest('base64url');
}

export function createSessionToken(identity: SessionIdentity = LOCAL_ADMIN_IDENTITY): string {
  const payload = JSON.stringify({
    exp: Date.now() + SESSION_TTL_MS,
    sub: identity.sub,
    label: identity.label,
    src: identity.source,
    ...(identity.email ? { email: identity.email } : {}),
  });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

/**
 * The identity a cookie proves, or null when it proves nothing.
 *
 * A signed, unexpired token that predates identity-carrying sessions
 * holds only `{ exp }`. Those are honored as the local administrator
 * rather than rejected: the alternative is signing every open session
 * out on deploy, and the claim it makes — "the shared password was
 * entered" — is exactly what such a token used to mean.
 */
export function readSession(token: string | undefined): SessionIdentity | null {
  if (!token) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expected = sign(encoded);
  // Lengths must match for timingSafeEqual; a malformed token just fails the check.
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      exp?: number; sub?: string; label?: string; src?: string; email?: string;
    };
    if (typeof claims.exp !== 'number' || Date.now() >= claims.exp) return null;
    if (claims.src === 'microsoft-sso') {
      // Every field is required for an attributed identity — a
      // half-populated SSO session must not silently degrade into an
      // anonymous or mislabeled author.
      if (!claims.sub || !claims.label || !claims.email) return null;
      return { sub: claims.sub, label: claims.label, source: 'microsoft-sso', email: claims.email };
    }
    if (claims.src === 'local-admin' || claims.src === undefined) {
      return LOCAL_ADMIN_IDENTITY;
    }
    return null; // unrecognized provider — fail closed
  } catch {
    return null;
  }
}

export function verifySessionToken(token: string | undefined): boolean {
  return readSession(token) !== null;
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
 * Gate for every admin-only route. Fails closed: if NO sign-in provider
 * was configured, admin actions are entirely unusable (401) rather than
 * silently open — unlike other integrations in this app, a missing
 * credential here must not mean "runs anyway."
 *
 * "A provider" is either the shared password or Microsoft SSO. Checking
 * only for ADMIN_PASSWORD would mean a Microsoft-only deployment —
 * which has no reason to set one — 401'd every request despite holding
 * a perfectly valid verified session.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!authProviderConfigured()) {
    res.status(401).json({
      error: 'auth_failed',
      message: 'Administrator actions are not enabled.',
      hint: 'Set ADMIN_PASSWORD in .env (or configure Microsoft SSO), then sign in.',
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
