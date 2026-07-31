import { z } from 'zod';
import crypto from 'node:crypto';

/**
 * Environment validation. The app boots with ZERO credentials — every
 * integration is then simply "not connected" and reports that honestly.
 * There is no demo/mock mode: an integration is live when (and only
 * when) its credentials are configured.
 */
const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  HUBSPOT_PORTAL_ID: z.string().optional(),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_REDIRECT_URI: z.string().optional(),

  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default('common'),
  /** Outlook mailbox consent callback — unchanged, kept separate from sign-in. */
  MICROSOFT_REDIRECT_URI: z.string().optional(),
  /**
   * Sign-in (OpenID Connect) callback. Deliberately a DIFFERENT URI from
   * MICROSOFT_REDIRECT_URI: the two flows request different scopes and
   * mean different things, and a shared callback would let a mailbox
   * consent response be replayed into the sign-in handler.
   */
  MICROSOFT_SSO_REDIRECT_URI: z.string().optional(),
  /**
   * Which account domain may sign in. A SECONDARY check only — the
   * tenant id above is the real restriction (see verifyIdToken in
   * server/lib/microsoftAuth.ts). Domain text in a token is an
   * attribute of an account, not proof of one.
   */
  MICROSOFT_ALLOWED_EMAIL_DOMAIN: z.string().default('vamosventures.com'),

  /**
   * Which identity providers may establish a session.
   *
   *   auto      — Entra SSO alone once it is fully configured; the shared
   *               password until then. THE DEFAULT.
   *   local     — the shared administrator password only
   *   microsoft — Microsoft Entra SSO only
   *   hybrid    — both, for migration/live-testing before cutting over
   *
   * `auto` exists because the intended end state is "only @vamosventures.com
   * accounts can sign in", and the only thing standing between here and
   * there is an Entra app registration. Requiring somebody to ALSO remember
   * to flip this variable afterwards would mean the shared password quietly
   * kept working for months after it was supposed to be gone — the failure
   * is silent, and the whole point of the change is to stop relying on a
   * password that everyone knows.
   *
   * Under `auto` the switch happens on its own: the moment a client id,
   * secret, SSO redirect URI, and concrete tenant GUID are all present,
   * the password form stops being offered and `passwordMatches` stops
   * being consulted.
   *
   * Every mode still degrades to `local` when Microsoft is requested but
   * not fully configured, so a half-finished credential handover can never
   * lock the team out of its own tool. See effectiveAuthMode() below.
   */
  AUTH_MODE: z.enum(['auto', 'local', 'microsoft', 'hybrid']).default('auto'),

  AI_PROVIDER: z.enum(['anthropic', 'openai']).optional(),
  AI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),

  /** Optional GitHub token — raises API rate limits; public data only. */
  GITHUB_TOKEN: z.string().optional(),
  /** SEC EDGAR asks automated clients to identify themselves with contact info in the User-Agent. */
  SEC_CONTACT_EMAIL: z.string().optional(),
  /** Comma-separated public RSS feed URLs for the funding-news source (overrides defaults). */
  FUNDING_NEWS_FEEDS: z.string().optional(),
  /**
   * Comma-separated investor newsroom feed URLs (overrides the registry).
   * Entries on a domain that is not in server/sourcing/investorRegistry.ts
   * are dropped: an unregistered domain cannot be attributed to a firm,
   * so nothing under it could count as investor-primary evidence.
   */
  INVESTOR_NEWS_FEEDS: z.string().optional(),
  /** Product Hunt developer token — required for the producthunt source; refuses to run without it. */
  PRODUCTHUNT_TOKEN: z.string().optional(),

  RUN_SCHEDULER: z.enum(['true', 'false']).default('false'),
  SESSION_SECRET: z.string().min(16).optional(),
  /** SQLite database location (':memory:' in tests). Defaults to server/.data/deal-radar.db */
  DATABASE_FILE: z.string().optional(),
  DATA_FILE: z.string().optional(), // legacy alias, honored for ':memory:' test setups

  /**
   * Shared administrator password gating Settings' admin-only actions
   * (scheduled sourcing config/run-now, connector enable/disable,
   * refresh runs, HubSpot/Outlook connect-disconnect). Unset means
   * those actions are entirely unusable (fail closed), not open —
   * see requireAdmin() in server/lib/auth.ts.
   */
  ADMIN_PASSWORD: z.string().optional(),
});

/**
 * A freshly-copied .env.example ships every key present but blank
 * (e.g. `AI_PROVIDER=`) — once .env is actually loaded (via
 * --env-file-if-exists, see package.json), that arrives as an empty
 * string, which fails `.optional()` validation (undefined ≠ "").
 * Treat blank as unset so "boots fine with zero credentials" holds
 * for a literal copy of the example file, not just a hand-trimmed one.
 */
const cleanedEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const parsed = envSchema.safeParse(cleanedEnv);
if (!parsed.success) {
  // Fail loudly on malformed values; never print the values themselves.
  const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid environment configuration for: ${fields}`);
}

export const env = parsed.data;

/** Resolve the AI key: AI_API_KEY wins, else the provider-specific var. */
export function aiKey(): string | undefined {
  if (env.AI_API_KEY) return env.AI_API_KEY;
  if (env.AI_PROVIDER === 'openai') return env.OPENAI_API_KEY;
  if (env.AI_PROVIDER === 'anthropic') return env.ANTHROPIC_API_KEY;
  return undefined;
}

/** True when HubSpot OAuth is configured (connection still needs the user flow). */
export function hubspotOAuthConfigured(): boolean {
  return !!(env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET && env.HUBSPOT_REDIRECT_URI);
}

export function schedulerEnabled(): boolean {
  return env.RUN_SCHEDULER === 'true';
}

/** Outlook is configured when the Entra app + token-encryption secret exist. */
export function outlookConfigured(): boolean {
  return !!(
    env.MICROSOFT_CLIENT_ID &&
    env.MICROSOFT_CLIENT_SECRET &&
    env.MICROSOFT_REDIRECT_URI &&
    env.SESSION_SECRET
  );
}

// ── Microsoft Entra sign-in (separate from Outlook mailbox access) ──

/**
 * A real, single-tenant directory id — never one of Microsoft's
 * multi-tenant aliases.
 *
 * `common`, `organizations`, and `consumers` all mean "any directory,
 * and let the token tell you which one." For an internal tool whose
 * entire authorization model is "employees of one company," accepting
 * those would mean any Microsoft account anywhere could complete the
 * flow and we would be relying on a domain string in the resulting
 * token to keep strangers out. So SSO refuses to consider itself
 * configured until a concrete tenant GUID is present, and that GUID is
 * then checked against the `tid` claim on every sign-in.
 */
const TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function microsoftTenantIsSingleTenant(): boolean {
  return TENANT_GUID.test(env.MICROSOFT_TENANT_ID);
}

/**
 * Microsoft SSO is configured when an Entra app, a single-tenant
 * directory id, a sign-in callback, and a durable SESSION_SECRET all
 * exist. Anything short of that and sign-in stays local — reported to
 * the UI as "Awaiting Microsoft administrator configuration" rather
 * than rendered as a button that cannot work.
 */
export function microsoftSsoConfigured(): boolean {
  return !!(
    env.MICROSOFT_CLIENT_ID &&
    env.MICROSOFT_CLIENT_SECRET &&
    env.MICROSOFT_SSO_REDIRECT_URI &&
    env.SESSION_SECRET &&
    microsoftTenantIsSingleTenant()
  );
}

/**
 * The mode actually in force. Requesting `microsoft` or `hybrid`
 * without complete Entra configuration degrades to `local` instead of
 * failing shut: a half-finished credential handover must never be able
 * to lock the team out of its own tool.
 */
export function effectiveAuthMode(): 'local' | 'microsoft' | 'hybrid' {
  if (env.AUTH_MODE === 'local') return 'local';
  // `auto` is the self-completing path: SSO-only as soon as SSO can
  // actually run, and the password until then. Nobody has to remember to
  // come back and turn the password off.
  if (env.AUTH_MODE === 'auto') return microsoftSsoConfigured() ? 'microsoft' : 'local';
  return microsoftSsoConfigured() ? env.AUTH_MODE : 'local';
}

/**
 * True when Microsoft was EXPLICITLY asked for but cannot run yet —
 * drives the awaiting-configuration notice.
 *
 * `auto` deliberately does not count. It is the default, so treating it
 * as a pending request would show every local-only deployment a standing
 * "SSO not configured" warning about something nobody asked for, and a
 * warning that is always on is one nobody reads.
 */
export function microsoftSsoPending(): boolean {
  return (env.AUTH_MODE === 'microsoft' || env.AUTH_MODE === 'hybrid') && !microsoftSsoConfigured();
}

/**
 * True when the shared password is still the way in, but only because
 * Entra is not configured yet.
 *
 * Distinct from `microsoftSsoPending`: this is the honest status of the
 * DEFAULT deployment, and it is what the sign-in screen and the settings
 * page use to say "the password works today and will stop working once
 * SSO is registered" instead of implying the password is the intended
 * end state.
 */
export function awaitingSsoCutover(): boolean {
  return env.AUTH_MODE === 'auto' && !microsoftSsoConfigured();
}

/** The password form is offered in every mode except Microsoft-only. */
export function localLoginAvailable(): boolean {
  return effectiveAuthMode() !== 'microsoft' && adminAuthConfigured();
}

/** The Microsoft button is offered only when the flow can actually complete. */
export function microsoftLoginAvailable(): boolean {
  return effectiveAuthMode() !== 'local' && microsoftSsoConfigured();
}

/** AI is live when a provider and key are configured; otherwise the local template answers. */
export function aiConfigured(): boolean {
  return !!(env.AI_PROVIDER && aiKey());
}

/**
 * A route hit an integration that is not connected. Rendered as a 503
 * with a clear, honest message — never simulated.
 */
export function notConnected(name: string, hint: string): Error {
  return Object.assign(new Error(`${name} is not connected.`), { status: 503, hint });
}

/**
 * Encryption key for tokens at rest. Live Outlook requires a real
 * SESSION_SECRET; without one, no tokens are ever stored, so an
 * ephemeral key is harmless.
 */
export const encryptionKey: Buffer = env.SESSION_SECRET
  ? crypto.scryptSync(env.SESSION_SECRET, 'vamos-deal-radar', 32)
  : crypto.randomBytes(32);

/**
 * Signs admin session cookies. Ephemeral (random per process start) when
 * SESSION_SECRET isn't set — a restart invalidates every session and
 * requires re-login, which is acceptable for a single-admin internal
 * tool and strictly safer than a fixed fallback key.
 */
export const adminSessionKey: Buffer = env.SESSION_SECRET
  ? crypto.scryptSync(env.SESSION_SECRET, 'vamos-deal-radar-admin-session', 32)
  : crypto.randomBytes(32);

export function adminAuthConfigured(): boolean {
  return !!env.ADMIN_PASSWORD;
}
