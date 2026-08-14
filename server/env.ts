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
  /**
   * THE public origin this application is reached at — scheme, host,
   * and port, no path and no trailing slash. This is the ONE place a
   * deployment states where it lives:
   *
   *   local development   (unset)  -> http://localhost:<PORT>
   *   Render production            -> https://deal-radar-sbo8.onrender.com
   *   a future custom domain       -> https://dealradar.vamosventures.com
   *
   * Every OAuth callback this app hands to Microsoft and HubSpot, and
   * the origin CORS allows, are derived from it (see callbackUrl()
   * below). Moving to a custom domain is therefore a one-variable
   * change here plus re-registering the same three paths with the two
   * identity providers — never a code change and never a sweep through
   * the repository for a hard-coded hostname.
   *
   * Left unset on purpose in development, where the Vite dev server
   * (:5173) and this API (:8787) are genuinely two different origins.
   */
  APP_BASE_URL: z.string().url().optional(),
  /**
   * Where the browser-facing app is served from, when that is NOT the
   * same origin as this API — i.e. local development, where Vite runs
   * on :5173. In production the server serves the built bundle itself,
   * so this is left unset and defaults to APP_BASE_URL. Setting it in
   * production would defeat the point of having one base URL.
   */
  FRONTEND_URL: z.string().optional(),

  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  HUBSPOT_PORTAL_ID: z.string().optional(),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  /** Optional override; defaults to APP_BASE_URL + /api/hubspot/callback. */
  HUBSPOT_REDIRECT_URI: z.string().optional(),

  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default('common'),
  /**
   * Outlook mailbox consent callback — kept separate from sign-in.
   * Optional override; defaults to APP_BASE_URL + /api/outlook/callback.
   */
  MICROSOFT_REDIRECT_URI: z.string().optional(),
  /**
   * Sign-in (OpenID Connect) callback. Deliberately a DIFFERENT URI from
   * MICROSOFT_REDIRECT_URI: the two flows request different scopes and
   * mean different things, and a shared callback would let a mailbox
   * consent response be replayed into the sign-in handler.
   *
   * Optional override; defaults to APP_BASE_URL + /api/auth/microsoft/callback.
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
 * Values that are COMPARED or used as key material, where trimming
 * would silently change behaviour instead of fixing a typo:
 *
 *   SESSION_SECRET  derives the session-cookie signing key and the
 *                   token-encryption key (scryptSync, bottom of this
 *                   file). Trimming a deployed value that happens to
 *                   carry stray whitespace would rotate both on the
 *                   next deploy — every session invalidated and every
 *                   stored Outlook token permanently undecryptable.
 *   ADMIN_PASSWORD  compared against what somebody types. Trimming it
 *                   changes which strings are accepted.
 *
 * Everything else is an identifier, a URL, or a credential handed
 * verbatim to another service, where surrounding whitespace is only
 * ever a paste artefact.
 */
const UNTRIMMED_KEYS = new Set(['SESSION_SECRET', 'ADMIN_PASSWORD']);

/**
 * A freshly-copied .env.example ships every key present but blank
 * (e.g. `AI_PROVIDER=`) — once .env is actually loaded (via
 * --env-file-if-exists, see package.json), that arrives as an empty
 * string, which fails `.optional()` validation (undefined ≠ "").
 * Treat blank as unset so "boots fine with zero credentials" holds
 * for a literal copy of the example file, not just a hand-trimmed one.
 *
 * Values are trimmed first, which makes whitespace-only count as blank
 * too, and — the reason this exists — stops a pasted value from being
 * present-but-rejected. A hosting dashboard will happily store
 * `MICROSOFT_TENANT_ID` with the trailing newline that came along with
 * the copy, and TENANT_GUID below is anchored, so the tenant reads as
 * set everywhere an operator can look while SSO reports itself
 * unconfigured and never says why. Same class of failure for a client
 * id, a client secret, or an API key with an invisible character on
 * the end, which fails later and further away, at the provider.
 */
const cleanedEnv = Object.fromEntries(
  Object.entries(process.env)
    .map(([k, v]) => [k, typeof v === 'string' && !UNTRIMMED_KEYS.has(k) ? v.trim() : v])
    .filter(([, v]) => v !== ''),
);
const parsed = envSchema.safeParse(cleanedEnv);
if (!parsed.success) {
  // Fail loudly on malformed values; never print the values themselves.
  const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid environment configuration for: ${fields}`);
}

// ── Public origin + OAuth callbacks ──────────────────────────────

/** `https://host/` and `https://host` must resolve to the same callbacks. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The origin an administrator ACTUALLY configured, or null.
 *
 * Kept separate from the resolved value below because the difference
 * matters: "you told us where this app lives" is a precondition for
 * offering an OAuth flow at all, while "we fell back to localhost" is
 * not. The `*Configured()` predicates below therefore test THIS, so a
 * deployment that never states its origin cannot silently hand
 * Microsoft or HubSpot a localhost callback and dead-end its users.
 */
const configuredBaseUrl = parsed.data.APP_BASE_URL ? stripTrailingSlash(parsed.data.APP_BASE_URL) : null;

/** Development fallbacks: this API, and the Vite dev server in front of it. */
const LOCAL_API_ORIGIN = `http://localhost:${parsed.data.PORT}`;
const LOCAL_WEB_ORIGIN = 'http://localhost:5173';

export const env = {
  ...parsed.data,
  APP_BASE_URL: configuredBaseUrl ?? LOCAL_API_ORIGIN,
  /**
   * Same origin as the API in production (one process serves both), the
   * Vite dev server locally. An explicit FRONTEND_URL still wins, which
   * is what keeps a split-origin deployment possible without a code
   * change.
   */
  FRONTEND_URL: parsed.data.FRONTEND_URL
    ? stripTrailingSlash(parsed.data.FRONTEND_URL)
    : (configuredBaseUrl ?? LOCAL_WEB_ORIGIN),
};

/** True when APP_BASE_URL was set, rather than defaulted to localhost. */
export function appBaseUrlConfigured(): boolean {
  return configuredBaseUrl !== null;
}

/**
 * The exact callback paths registered with the identity providers.
 *
 * These are literals, not configuration, on purpose: they are the paths
 * the routers actually serve (server/routes/auth.ts,
 * server/routes/outlook.ts, server/routes/hubspot.ts) and the paths
 * allow-listed as public in server/app.ts. A deployment changes its
 * HOST via APP_BASE_URL; the paths are part of the application.
 */
export const CALLBACK_PATHS = {
  microsoftSso: '/api/auth/microsoft/callback',
  outlook: '/api/outlook/callback',
  hubspot: '/api/hubspot/callback',
} as const;

export type CallbackKind = keyof typeof CALLBACK_PATHS;

/** The absolute callback URL for `kind` on this deployment's origin. */
export function callbackUrl(kind: CallbackKind): string {
  return `${env.APP_BASE_URL}${CALLBACK_PATHS[kind]}`;
}

/**
 * The three redirect URIs actually sent to the providers.
 *
 * An explicit *_REDIRECT_URI still wins — it is the escape hatch for a
 * deployment sitting behind a proxy that rewrites paths — but nothing
 * needs to set one, and production should not.
 */
export function microsoftSsoRedirectUri(): string {
  return env.MICROSOFT_SSO_REDIRECT_URI ?? callbackUrl('microsoftSso');
}
export function outlookRedirectUri(): string {
  return env.MICROSOFT_REDIRECT_URI ?? callbackUrl('outlook');
}
export function hubspotRedirectUri(): string {
  return env.HUBSPOT_REDIRECT_URI ?? callbackUrl('hubspot');
}

/**
 * Loud, non-fatal warning when a production process does not know its
 * own address. Non-fatal deliberately: refusing to boot would take a
 * running deployment down over configuration that only affects OAuth
 * flows which are, in that state, already reported as not configured.
 */
if (process.env.NODE_ENV === 'production' && !configuredBaseUrl) {
  console.warn(
    '[config] APP_BASE_URL is not set. OAuth callbacks would be generated against '
    + `${LOCAL_API_ORIGIN}, so Microsoft sign-in, Outlook consent, and HubSpot OAuth are `
    + 'reported as not configured. Set APP_BASE_URL to this deployment’s public origin.',
  );
}

/** Resolve the AI key: AI_API_KEY wins, else the provider-specific var. */
export function aiKey(): string | undefined {
  if (env.AI_API_KEY) return env.AI_API_KEY;
  if (env.AI_PROVIDER === 'openai') return env.OPENAI_API_KEY;
  if (env.AI_PROVIDER === 'anthropic') return env.ANTHROPIC_API_KEY;
  return undefined;
}

/**
 * True when HubSpot OAuth is configured (connection still needs the
 * user flow). The redirect URI counts as configured when EITHER it was
 * set explicitly or APP_BASE_URL was — see appBaseUrlConfigured().
 */
export function hubspotOAuthConfigured(): boolean {
  return !!(
    env.HUBSPOT_CLIENT_ID &&
    env.HUBSPOT_CLIENT_SECRET &&
    (env.HUBSPOT_REDIRECT_URI || appBaseUrlConfigured())
  );
}

export function schedulerEnabled(): boolean {
  return env.RUN_SCHEDULER === 'true';
}

/** Outlook is configured when the Entra app + token-encryption secret exist. */
export function outlookConfigured(): boolean {
  return !!(
    env.MICROSOFT_CLIENT_ID &&
    env.MICROSOFT_CLIENT_SECRET &&
    (env.MICROSOFT_REDIRECT_URI || appBaseUrlConfigured()) &&
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
 * Every precondition for Microsoft sign-in, split into the ones this
 * process has and the ones it does not.
 *
 * This exists because of how the failure actually presents itself: the
 * sign-in screen simply does not render a Microsoft button, and every
 * status field reads like a deployment that was never meant to have
 * one. Somebody then has to re-derive, from five `&&`ed conditions,
 * which single variable is missing. Naming them instead turns a
 * bisection into reading one line of the boot log.
 *
 * The strings are the EXACT variable names an operator types into a
 * hosting dashboard, because that is the next thing they will do.
 * Nothing here reads a value — only whether one is present and, for the
 * tenant, well-formed — so this is safe to log and safe to show.
 */
export function microsoftSsoRequirements(): { met: string[]; unmet: string[] } {
  const checks: Array<readonly [string, boolean]> = [
    ['MICROSOFT_CLIENT_ID', !!env.MICROSOFT_CLIENT_ID],
    ['MICROSOFT_CLIENT_SECRET', !!env.MICROSOFT_CLIENT_SECRET],
    // Named with its constraint: `common` is *set*, and is still wrong.
    // "MICROSOFT_TENANT_ID is missing" would send somebody to check a
    // variable that is right there in the dashboard.
    ['MICROSOFT_TENANT_ID (a single-tenant directory GUID, not "common")', microsoftTenantIsSingleTenant()],
    // Either the callback was stated outright or the deployment stated
    // its public origin, which is enough to derive it. Neither means
    // nobody has said where this app lives, and a sign-in button would
    // send people to a redirect_uri Entra has never seen.
    [
      'APP_BASE_URL (or an explicit MICROSOFT_SSO_REDIRECT_URI)',
      !!(env.MICROSOFT_SSO_REDIRECT_URI || appBaseUrlConfigured()),
    ],
    ['SESSION_SECRET', !!env.SESSION_SECRET],
  ];
  return {
    met: checks.filter(([, ok]) => ok).map(([name]) => name),
    unmet: checks.filter(([, ok]) => !ok).map(([name]) => name),
  };
}

/**
 * Microsoft SSO is configured when an Entra app, a single-tenant
 * directory id, a sign-in callback, and a durable SESSION_SECRET all
 * exist. Anything short of that and sign-in stays local — reported to
 * the UI as "Awaiting Microsoft administrator configuration" rather
 * than rendered as a button that cannot work.
 *
 * Derived from microsoftSsoRequirements() rather than repeating the
 * conditions: the list and the gate cannot disagree if there is only
 * one of them, so a requirement can never be added to the diagnostic
 * without also being enforced.
 */
export function microsoftSsoConfigured(): boolean {
  return microsoftSsoRequirements().unmet.length === 0;
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

/**
 * Say at boot, in the hosting platform's log, whether Microsoft sign-in
 * will be offered — and if not, exactly what is missing.
 *
 * Placed here rather than beside the APP_BASE_URL warning above because
 * it calls microsoftTenantIsSingleTenant(), whose TENANT_GUID regex is a
 * `const` declared further up this file: running it any earlier would
 * hit the temporal dead zone.
 *
 * When SSO *is* live it logs the redirect URI it will send. That is the
 * one string that has to byte-match a value registered in Entra, it is
 * not a secret, and comparing two strings by eye beats debugging a
 * consent screen that only ever says the request is invalid.
 *
 * Silent in the one case that is not actionable: a deployment with no
 * Microsoft configuration at all and no explicit request for it is the
 * documented default, and a warning that is always on is one nobody
 * reads. A PARTIAL configuration is never silent — that is somebody
 * halfway through a handover, which is exactly who needs the list.
 */
if (process.env.NODE_ENV === 'production') {
  const { unmet } = microsoftSsoRequirements();
  const requested = env.AUTH_MODE === 'microsoft' || env.AUTH_MODE === 'hybrid';
  // "Somebody has started this" must be judged on MICROSOFT-specific
  // variables only. Two of the five requirements — APP_BASE_URL and
  // SESSION_SECRET — are set by every production deployment for
  // unrelated reasons, so counting met requirements generally would
  // make this warning fire on every local-only deployment forever.
  const handoverStarted = !!(
    env.MICROSOFT_CLIENT_ID
    || env.MICROSOFT_CLIENT_SECRET
    || env.MICROSOFT_SSO_REDIRECT_URI
    || microsoftTenantIsSingleTenant()
  );
  if (unmet.length === 0) {
    console.info(
      `[config] Microsoft sign-in is configured (AUTH_MODE=${env.AUTH_MODE}, effective mode `
      + `${effectiveAuthMode()}). Entra must have this EXACT redirect URI registered: `
      + microsoftSsoRedirectUri(),
    );
  } else if (requested || handoverStarted) {
    console.warn(
      '[config] Microsoft sign-in is NOT available — the sign-in screen will not show the '
      + `Microsoft button. Missing: ${unmet.join(', ')}. `
      + 'Set these on this service and redeploy. Values are never read or logged here.',
    );
  }
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
