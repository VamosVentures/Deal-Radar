import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { wrap } from './helpers';
import {
  adminAuthConfigured,
  effectiveAuthMode,
  env,
  localLoginAvailable,
  microsoftLoginAvailable,
  microsoftSsoConfigured,
  microsoftSsoPending,
  microsoftSsoRequirements,
  awaitingSsoCutover,
} from '../env';
import { audit } from '../lib/guard';
import {
  authProviderConfigured,
  createSessionToken,
  LOCAL_ADMIN_IDENTITY,
  passwordMatches,
  readCookie,
  readSession,
  SESSION_COOKIE,
  type SessionIdentity,
} from '../lib/auth';
import { randomToken } from '../lib/crypto';
import { consumeOAuthState, issueOAuthState } from '../lib/oauthState';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCodeForIdToken,
  verifyIdToken,
} from '../lib/microsoftAuth';

export const authRouter = Router();

/**
 * Shown wherever Microsoft was asked for but the Entra variables are
 * not all present. One string, so the sign-in screen, the Settings
 * integration panel, and the API all say the same thing.
 */
export const AWAITING_MICROSOFT_CONFIG = 'Awaiting Microsoft administrator configuration';

/**
 * Shown on the default deployment before the Entra app registration
 * exists. Deliberately states the END STATE as well as today's, so
 * nobody reads the password form and concludes the shared password is
 * how this application is meant to be secured.
 */
export const AWAITING_SSO_CUTOVER =
  'Sign-in will move to Microsoft single sign-on, limited to @vamosventures.com accounts. '
  + 'The shared password works until the Entra app registration is complete, and stops working automatically once it is.';

const SESSION_MAX_AGE_MS = 12 * 60 * 60_000;

/** One place deciding how a session cookie is written, for both providers. */
function setSessionCookie(res: Response, identity: SessionIdentity): void {
  res.cookie(SESSION_COOKIE, createSessionToken(identity), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

// Anti-brute-force for a real client: 10 attempts per 15 minutes per IP.
// This limiter is created at MODULE scope, so it is shared by every
// createApp() in a process — which is correct in production (one app)
// but means a test suite signing in for each of its cases exhausts the
// budget and starts getting 429s that look like auth failures. The
// suite is not an attacker, so the ceiling is raised under
// NODE_ENV=test only, matching the same carve-out the global /api
// limiter already makes in server/app.ts. Production is unchanged.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: process.env.NODE_ENV === 'test' ? 10_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Try again in a few minutes.' },
});

/**
 * What the sign-in screen needs in order to render itself honestly.
 *
 * `configured` and `authenticated` keep their original meanings — the
 * E2E suite and the Settings page both branch on them. Everything else
 * is additive.
 */
authRouter.get('/auth/status', wrap(async (req, res) => {
  const session = readSession(readCookie(req, SESSION_COOKIE));
  const pending = microsoftSsoPending();
  const awaiting = awaitingSsoCutover();
  res.json({
    /**
     * Whether a sign-in is possible at all. Historically this meant
     * "ADMIN_PASSWORD is set"; it now means "some provider is
     * configured", so a Microsoft-only deployment — which has no reason
     * to set a password — does not report itself as unusable.
     */
    configured: authProviderConfigured(),
    authenticated: authProviderConfigured() && !!session,
    mode: effectiveAuthMode(),
    requestedMode: env.AUTH_MODE,
    localLoginAvailable: localLoginAvailable(),
    microsoftLoginAvailable: microsoftLoginAvailable(),
    /**
     * True when an administrator asked for Microsoft but the Entra
     * variables are incomplete. The UI then shows the awaiting-
     * configuration notice rather than a button that would dead-end at
     * Microsoft with an unknown client id.
     */
    microsoftPending: pending,
    microsoftPendingMessage: pending ? AWAITING_MICROSOFT_CONFIG : null,
    /**
     * WHICH preconditions are still unmet — the variable names an
     * operator types into a hosting dashboard, and nothing else.
     *
     * Without this, every incomplete deployment reports itself
     * identically: `microsoftLoginAvailable: false` and a pending
     * message that names no cause. Diagnosing it then means bisecting
     * five `&&`ed conditions against a dashboard that shows only
     * whether a variable is set, not whether its VALUE satisfies the
     * check — and `MICROSOFT_TENANT_ID` has to be a single-tenant GUID,
     * so "set" and "accepted" are genuinely different states.
     *
     * The same list is already logged at boot and already returned, in
     * full, by the 503 from /auth/microsoft/start below, so this adds
     * no reach that an unauthenticated caller did not have. It reports
     * presence and well-formedness only: no value is read here, so
     * nothing secret can pass through it.
     */
    microsoftMissingRequirements: microsoftSsoRequirements().unmet,
    /**
     * True on the DEFAULT deployment while Entra is not configured yet:
     * the shared password is the way in today, and will stop being one
     * the moment the app registration lands.
     *
     * Reported separately from `microsoftPending` so the sign-in screen
     * can be honest that the password is a temporary state rather than
     * the intended end state — without showing a warning about
     * something nobody explicitly asked for.
     */
    awaitingSsoCutover: awaiting,
    awaitingSsoCutoverMessage: awaiting ? AWAITING_SSO_CUTOVER : null,
    /** The domain that will be allowed to sign in once SSO is live. */
    allowedEmailDomain: env.MICROSOFT_ALLOWED_EMAIL_DOMAIN,
    /** Who is signed in, for attribution in the UI. Never a token. */
    identity: session
      ? { label: session.label, source: session.source, email: session.email ?? null }
      : null,
  });
}));

// ── Local administrator password ─────────────────────────────────

authRouter.post('/auth/login', loginLimiter, wrap(async (req, res) => {
  const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
  if (!adminAuthConfigured()) {
    res.status(401).json({ error: 'auth_failed', message: 'Administrator actions are not enabled.', hint: 'Set ADMIN_PASSWORD in .env.' });
    return;
  }
  // In microsoft-only mode the password is refused but NOT removed —
  // setting AUTH_MODE back to `hybrid` restores it without a code
  // change, which is what makes the cutover reversible if live SSO
  // testing goes wrong.
  if (effectiveAuthMode() === 'microsoft') {
    audit({ provider: 'system', mode: 'local', action: 'admin-login', subject: 'admin', outcome: 'blocked', detail: 'Password sign-in refused — AUTH_MODE=microsoft' });
    res.status(401).json({
      error: 'auth_failed',
      message: 'Password sign-in is disabled. Use “Sign in with your Vamos Microsoft account.”',
      hint: 'Set AUTH_MODE=hybrid in .env to re-enable the local administrator password.',
    });
    return;
  }
  if (!passwordMatches(password)) {
    audit({ provider: 'system', mode: 'local', action: 'admin-login', subject: 'admin', outcome: 'blocked', detail: 'Incorrect password' });
    res.status(401).json({ error: 'auth_failed', message: 'Incorrect password.' });
    return;
  }
  setSessionCookie(res, LOCAL_ADMIN_IDENTITY);
  audit({ provider: 'system', mode: 'local', action: 'admin-login', subject: 'admin', outcome: 'ok', detail: 'Signed in' });
  res.json({ ok: true });
}));

authRouter.post('/auth/logout', wrap(async (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
}));

// ── Microsoft Entra SSO ──────────────────────────────────────────

/**
 * Begin sign-in: mint state + nonce + PKCE, hand back the Microsoft URL.
 *
 * A POST rather than a GET on purpose. The route is necessarily
 * reachable without a session, and a GET could be triggered by any
 * third-party page embedding it as an image or an iframe, quietly
 * minting pending-state records. A POST cannot be provoked that way,
 * and it shares the login rate limiter.
 */
authRouter.post('/auth/microsoft/start', loginLimiter, wrap(async (_req, res) => {
  if (!microsoftSsoConfigured()) {
    res.status(503).json({
      error: 'not_connected',
      message: AWAITING_MICROSOFT_CONFIG,
      hint: 'A Microsoft administrator must supply MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, a single-tenant MICROSOFT_TENANT_ID, MICROSOFT_SSO_REDIRECT_URI, and SESSION_SECRET.',
    });
    return;
  }
  if (effectiveAuthMode() === 'local') {
    res.status(503).json({
      error: 'not_connected',
      message: 'Microsoft sign-in is not enabled.',
      hint: 'Set AUTH_MODE=hybrid (password and Microsoft) or AUTH_MODE=microsoft (Microsoft only) in .env.',
    });
    return;
  }
  const { verifier, challenge } = createPkcePair();
  // Stored server-side and never sent to the browser: the point of a
  // nonce is that only this server and Microsoft know what the
  // returned id_token has to contain.
  const nonce = randomToken(32);
  const { state } = issueOAuthState('sso', { nonce, codeVerifier: verifier });
  res.json({
    authUrl: await buildAuthorizeUrl({ state, nonce, codeChallenge: challenge }),
    message: 'Redirecting to Microsoft sign-in.',
  });
}));

/**
 * The sign-in callback:
 *   http://localhost:8787/api/auth/microsoft/callback
 *
 * Deliberately NOT the Outlook callback (/api/outlook/callback). The
 * two flows request different scopes and mean different things, and a
 * shared callback would let a mailbox-consent response be replayed
 * into the sign-in handler.
 *
 * Public by necessity — Microsoft redirects the BROWSER here, so no
 * cookie is guaranteed — and therefore trusting nothing in the query
 * string beyond a `state` this server issued and has not yet redeemed.
 * Every failure path lands the person back on the sign-in screen with
 * a reason; none establishes a session, and none echoes the
 * authorization code or any token.
 */
authRouter.get('/auth/microsoft/callback', wrap(async (req, res) => {
  const signInUrl = (params: Record<string, string>) =>
    `${env.FRONTEND_URL}/?${new URLSearchParams(params)}`;

  // Microsoft reports consent problems (declined, admin approval
  // required) as a redirect carrying `error`, not as an HTTP error.
  const query = z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
  }).parse(req.query);

  if (query.error) {
    audit({
      provider: 'system', mode: 'live', action: 'sso-login', subject: 'microsoft',
      outcome: 'blocked', detail: `Microsoft returned an error: ${query.error}`,
    });
    res.redirect(signInUrl({ signin: 'failed', reason: 'Microsoft did not complete the sign-in.' }));
    return;
  }
  if (!microsoftSsoConfigured() || effectiveAuthMode() === 'local') {
    res.redirect(signInUrl({ signin: 'failed', reason: 'Microsoft sign-in is not enabled.' }));
    return;
  }
  if (!query.code || !query.state) {
    res.redirect(signInUrl({ signin: 'failed', reason: 'The sign-in response was incomplete.' }));
    return;
  }

  try {
    // Consumes the state (single use) and returns the nonce and PKCE
    // verifier that were bound to it.
    const record = consumeOAuthState(query.state, 'sso');
    if (!record.nonce || !record.codeVerifier) {
      throw Object.assign(
        new Error('This sign-in could not be matched to a request from this app. Start again.'),
        { status: 400 },
      );
    }
    const idToken = await exchangeCodeForIdToken({
      code: query.code,
      codeVerifier: record.codeVerifier,
    });
    const identity = await verifyIdToken(idToken, { nonce: record.nonce });

    setSessionCookie(res, {
      sub: identity.oid,
      label: identity.name,
      source: 'microsoft-sso',
      email: identity.email,
    });
    audit({
      provider: 'system', mode: 'live', action: 'sso-login',
      subject: identity.email, outcome: 'ok',
      detail: `Microsoft sign-in verified for tenant ${identity.tid}`,
    });
    res.redirect(signInUrl({ signin: 'ok' }));
  } catch (e) {
    // Messages thrown by the verifier are authored for a person (see
    // server/lib/microsoftAuth.ts) and contain no token and no
    // authorization code, so showing them is safe and tells someone
    // whose account was refused WHY. Anything without a `.status` is
    // an unexpected bug and stays generic.
    const err = e as { status?: number; message?: string };
    const reason = err.status ? (err.message ?? 'Sign-in failed.') : 'Sign-in failed.';
    audit({
      provider: 'system', mode: 'live', action: 'sso-login', subject: 'microsoft',
      outcome: 'blocked', detail: `Rejected: ${reason}`,
    });
    res.redirect(signInUrl({ signin: 'failed', reason }));
  }
}));
