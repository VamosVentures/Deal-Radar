import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * Production callback URL generation.
 *
 * The failure this file exists to prevent is specific and expensive:
 * the app hands an identity provider a redirect_uri that the provider
 * has never been told about, and every sign-in dead-ends at a consent
 * screen error that says nothing useful. It happened once already, when
 * the deployment moved and a hostname was hard-coded in several places
 * — so what is asserted here is not "some URL is produced" but "these
 * exact three URLs are produced, from one variable."
 *
 * The paths are literals in the assertions ON PURPOSE. Importing
 * CALLBACK_PATHS and asserting a path equals itself would pass no
 * matter what the constant said; these are the strings a human types
 * into the Entra and HubSpot consoles, so a change to them has to break
 * a test loudly enough to make somebody go re-register them.
 *
 * No network. The Microsoft flow uses the OIDC test seam in
 * server/lib/microsoftAuth.ts; HubSpot and Outlook build their
 * authorize URLs locally.
 */

/** The single canonical production deployment. */
const PROD_BASE = 'https://deal-radar-sbo8.onrender.com';

/** The exact paths registered with Microsoft Entra and HubSpot. */
const SSO_PATH = '/api/auth/microsoft/callback';
const OUTLOOK_PATH = '/api/outlook/callback';
const HUBSPOT_PATH = '/api/hubspot/callback';

const TENANT = '11111111-2222-3333-4444-555555555555';
const DISCOVERY = {
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
  token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
  jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
};

const OWNED_ENV_KEYS = [
  'APP_BASE_URL', 'FRONTEND_URL',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID',
  'MICROSOFT_SSO_REDIRECT_URI', 'MICROSOFT_REDIRECT_URI',
  'HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_REDIRECT_URI',
  'SESSION_SECRET', 'AUTH_MODE',
];

/**
 * Set env, then re-read it. server/env.ts resolves the base URL once at
 * module load, so every case has to come from a fresh registry.
 */
function withEnv(vars: Record<string, string>) {
  for (const key of OWNED_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  vi.resetModules();
  return import('../env');
}

/** The production Render deployment's variables — APP_BASE_URL and nothing else. */
const PRODUCTION_ENV = { APP_BASE_URL: PROD_BASE };

afterEach(() => {
  // Vitest shares a worker across files: a leaked APP_BASE_URL would
  // change how every other suite resolves CORS and callbacks.
  for (const key of OWNED_ENV_KEYS) delete process.env[key];
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('callback URLs derived from APP_BASE_URL', () => {
  it('generates the exact three production callbacks from the Render base URL', async () => {
    const env = await withEnv(PRODUCTION_ENV);
    expect(env.microsoftSsoRedirectUri()).toBe(`${PROD_BASE}${SSO_PATH}`);
    expect(env.outlookRedirectUri()).toBe(`${PROD_BASE}${OUTLOOK_PATH}`);
    expect(env.hubspotRedirectUri()).toBe(`${PROD_BASE}${HUBSPOT_PATH}`);
  });

  it('keeps sign-in and mailbox consent on DIFFERENT callbacks', async () => {
    // Not cosmetic: a shared callback would let a mailbox-consent
    // response be replayed into the sign-in handler, which requests a
    // different scope set and means a different thing.
    const env = await withEnv(PRODUCTION_ENV);
    expect(env.microsoftSsoRedirectUri()).not.toBe(env.outlookRedirectUri());
    expect(env.CALLBACK_PATHS.microsoftSso).not.toBe(env.CALLBACK_PATHS.outlook);
  });

  it('uses localhost for local development when APP_BASE_URL is unset', async () => {
    const env = await withEnv({});
    expect(env.microsoftSsoRedirectUri()).toBe(`http://localhost:8787${SSO_PATH}`);
    expect(env.outlookRedirectUri()).toBe(`http://localhost:8787${OUTLOOK_PATH}`);
    expect(env.hubspotRedirectUri()).toBe(`http://localhost:8787${HUBSPOT_PATH}`);
    // The Vite dev server is a genuinely different origin in development.
    expect(env.env.FRONTEND_URL).toBe('http://localhost:5173');
    expect(env.appBaseUrlConfigured()).toBe(false);
  });

  it('honours PORT when deriving the local development origin', async () => {
    const previous = process.env.PORT;
    process.env.PORT = '9999';
    try {
      const env = await withEnv({});
      expect(env.microsoftSsoRedirectUri()).toBe(`http://localhost:9999${SSO_PATH}`);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
      vi.resetModules();
    }
  });

  it('moves every callback to a custom domain from ONE variable', async () => {
    // The whole point of the variable: a future vamosventures.com
    // domain is a one-line change plus re-registration, not a sweep
    // through the repository for a hostname.
    const custom = 'https://dealradar.vamosventures.com';
    const env = await withEnv({ APP_BASE_URL: custom });
    expect(env.microsoftSsoRedirectUri()).toBe(`${custom}${SSO_PATH}`);
    expect(env.outlookRedirectUri()).toBe(`${custom}${OUTLOOK_PATH}`);
    expect(env.hubspotRedirectUri()).toBe(`${custom}${HUBSPOT_PATH}`);
    expect(env.env.FRONTEND_URL).toBe(custom);
  });

  it('normalizes a trailing slash instead of producing a double slash', async () => {
    // `https://host//api/...` is a different string to Entra than
    // `https://host/api/...`, and a redirect_uri comparison is exact.
    const env = await withEnv({ APP_BASE_URL: `${PROD_BASE}/` });
    expect(env.microsoftSsoRedirectUri()).toBe(`${PROD_BASE}${SSO_PATH}`);
    expect(env.env.APP_BASE_URL).toBe(PROD_BASE);
  });

  it('lets an explicit redirect URI override the derived one', async () => {
    const override = 'https://proxy.example.com/deal-radar/api/auth/microsoft/callback';
    const env = await withEnv({ APP_BASE_URL: PROD_BASE, MICROSOFT_SSO_REDIRECT_URI: override });
    expect(env.microsoftSsoRedirectUri()).toBe(override);
    // …and overriding one does not disturb the others.
    expect(env.outlookRedirectUri()).toBe(`${PROD_BASE}${OUTLOOK_PATH}`);
  });

  it('serves the frontend from the same origin as the API in production', async () => {
    const env = await withEnv(PRODUCTION_ENV);
    expect(env.env.FRONTEND_URL).toBe(PROD_BASE);
    expect(env.env.APP_BASE_URL).toBe(PROD_BASE);
  });

  it('never generates a callback on the retired Vercel host', async () => {
    const env = await withEnv(PRODUCTION_ENV);
    for (const url of [
      env.microsoftSsoRedirectUri(), env.outlookRedirectUri(), env.hubspotRedirectUri(),
      env.env.FRONTEND_URL, env.env.APP_BASE_URL,
    ]) {
      expect(url).not.toMatch(/vercel\.app/);
    }
  });
});

describe('OAuth is reported as unconfigured when nobody has said where the app lives', () => {
  /**
   * Fail-closed. Without an origin the app would hand a provider a
   * localhost callback and send people to a consent screen that cannot
   * come back — better to report "not configured" and show the
   * awaiting-configuration notice.
   */
  it('refuses to consider Microsoft SSO configured with neither APP_BASE_URL nor an explicit URI', async () => {
    const env = await withEnv({
      MICROSOFT_CLIENT_ID: 'test-client-id-not-real',
      MICROSOFT_CLIENT_SECRET: 'test-client-secret-not-real',
      MICROSOFT_TENANT_ID: TENANT,
      SESSION_SECRET: 'test-session-secret-at-least-16-chars',
      AUTH_MODE: 'hybrid',
    });
    expect(env.microsoftSsoConfigured()).toBe(false);
    // …and the team is never locked out by that.
    expect(env.effectiveAuthMode()).toBe('local');
    expect(env.localLoginAvailable()).toBe(true);
  });

  it('considers Microsoft SSO configured once APP_BASE_URL alone is set', async () => {
    const env = await withEnv({
      APP_BASE_URL: PROD_BASE,
      MICROSOFT_CLIENT_ID: 'test-client-id-not-real',
      MICROSOFT_CLIENT_SECRET: 'test-client-secret-not-real',
      MICROSOFT_TENANT_ID: TENANT,
      SESSION_SECRET: 'test-session-secret-at-least-16-chars',
      AUTH_MODE: 'hybrid',
    });
    expect(env.microsoftSsoConfigured()).toBe(true);
    expect(env.microsoftSsoRedirectUri()).toBe(`${PROD_BASE}${SSO_PATH}`);
  });

  it('applies the same rule to Outlook and HubSpot', async () => {
    const without = await withEnv({
      MICROSOFT_CLIENT_ID: 'c', MICROSOFT_CLIENT_SECRET: 's',
      HUBSPOT_CLIENT_ID: 'c', HUBSPOT_CLIENT_SECRET: 's',
      SESSION_SECRET: 'test-session-secret-at-least-16-chars',
    });
    expect(without.outlookConfigured()).toBe(false);
    expect(without.hubspotOAuthConfigured()).toBe(false);

    const withBase = await withEnv({
      APP_BASE_URL: PROD_BASE,
      MICROSOFT_CLIENT_ID: 'c', MICROSOFT_CLIENT_SECRET: 's',
      HUBSPOT_CLIENT_ID: 'c', HUBSPOT_CLIENT_SECRET: 's',
      SESSION_SECRET: 'test-session-secret-at-least-16-chars',
    });
    expect(withBase.outlookConfigured()).toBe(true);
    expect(withBase.hubspotOAuthConfigured()).toBe(true);
  });
});

describe('the URLs actually sent to the providers', () => {
  it('sends the production sign-in callback on the Microsoft authorize request', async () => {
    await withEnv({
      ...PRODUCTION_ENV,
      MICROSOFT_CLIENT_ID: 'test-client-id-not-real',
      MICROSOFT_CLIENT_SECRET: 'test-client-secret-not-real',
      MICROSOFT_TENANT_ID: TENANT,
      SESSION_SECRET: 'test-session-secret-at-least-16-chars',
      AUTH_MODE: 'hybrid',
    });
    const microsoftAuth = await import('../lib/microsoftAuth');
    microsoftAuth.__setMicrosoftOidcForTests({ discovery: DISCOVERY, keys: [] });
    const { createApp } = await import('../app');

    const res = await request(createApp()).post('/api/auth/microsoft/start').send({});
    expect(res.status).toBe(200);
    const url = new URL(res.body.authUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(`${PROD_BASE}${SSO_PATH}`);
    // Sign-in stays identity-only: no mailbox scope is ever bundled in,
    // and there is no send permission anywhere in this codebase.
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes.sort()).toEqual(['User.Read', 'email', 'openid', 'profile'].sort());
    expect(scopes).not.toContain('Mail.Send');

    microsoftAuth.__setMicrosoftOidcForTests(null);
  });

  it('sends the production mailbox callback on the Outlook consent request', async () => {
    await withEnv({
      ...PRODUCTION_ENV,
      MICROSOFT_CLIENT_ID: 'test-client-id-not-real',
      MICROSOFT_CLIENT_SECRET: 'test-client-secret-not-real',
      MICROSOFT_TENANT_ID: TENANT,
      SESSION_SECRET: 'test-session-secret-at-least-16-chars',
    });
    const { store } = await import('../lib/store');
    store.resetForTests();
    const { outlookService } = await import('../services/outlook');

    const { authUrl } = await outlookService().beginConnect();
    const url = new URL(authUrl!);
    expect(url.searchParams.get('redirect_uri')).toBe(`${PROD_BASE}${OUTLOOK_PATH}`);
    // Mailbox consent asks for read/write drafting and nothing that can
    // send or delete mail.
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).not.toContain('Mail.Send');
    expect(scopes.some((s) => s.startsWith('Mail.Send'))).toBe(false);
  });

  it('sends the production callback on the HubSpot authorize request', async () => {
    await withEnv({
      ...PRODUCTION_ENV,
      HUBSPOT_CLIENT_ID: 'test-client-id-not-real',
      HUBSPOT_CLIENT_SECRET: 'test-client-secret-not-real',
    });
    const { store } = await import('../lib/store');
    store.resetForTests();
    const { beginHubSpotConnect } = await import('../services/hubspot');

    const { authUrl } = beginHubSpotConnect();
    const url = new URL(authUrl!);
    expect(url.searchParams.get('redirect_uri')).toBe(`${PROD_BASE}${HUBSPOT_PATH}`);
  });
});

describe('the app serves the paths it tells providers to call back on', () => {
  /**
   * A correct redirect_uri that 404s or 401s is the same outage as a
   * wrong one. Both callbacks must be reachable by a browser carrying
   * no session — the provider redirects the BROWSER, and each route
   * validates its own single-use state token instead.
   */
  it('reaches the sign-in callback without a session', async () => {
    await withEnv(PRODUCTION_ENV);
    const { createApp } = await import('../app');
    const res = await request(createApp()).get(SSO_PATH).query({ error: 'access_denied' });
    // Redirected back to the sign-in screen with a reason — never a 401
    // from the application gate, and never a 404.
    expect(res.status).toBe(302);
    expect(res.headers.location.startsWith(PROD_BASE)).toBe(true);
    expect(res.headers.location).toContain('signin=failed');
  });

  it('reaches the mailbox callback without a session', async () => {
    await withEnv(PRODUCTION_ENV);
    const { createApp } = await import('../app');
    // No code/state: the route validates and rejects on its own terms
    // (a 4xx), rather than being turned away by the application gate.
    const res = await request(createApp()).get(OUTLOOK_PATH);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('still gates ordinary API routes', async () => {
    // The public allowlist is exactly the callbacks and the sign-in
    // endpoints — proving the two tests above are not passing because
    // the gate is off.
    await withEnv(PRODUCTION_ENV);
    const { createApp } = await import('../app');
    expect((await request(createApp()).get('/api/companies')).status).toBe(401);
  });
});

// ── Why the Microsoft button is or isn't there ───────────────────

/**
 * The production incident these cover: the deployed app showed only the
 * password form, and every status field it reported was consistent with
 * a deployment that had never been meant to have Microsoft sign-in at
 * all. The cause was that the Entra variables were not declared on the
 * service, so there was nothing to fill in — but nothing anywhere said
 * so, and the five conditions behind the button had to be re-derived by
 * hand from source.
 */
describe('microsoftSsoRequirements names exactly what is missing', () => {
  /** Everything Microsoft sign-in needs, as production will have it. */
  const FULL_SSO_ENV = {
    APP_BASE_URL: PROD_BASE,
    MICROSOFT_CLIENT_ID: 'test-client-id-not-real',
    MICROSOFT_CLIENT_SECRET: 'test-client-secret-not-real',
    MICROSOFT_TENANT_ID: TENANT,
    SESSION_SECRET: 'test-session-secret-at-least-16-chars',
    AUTH_MODE: 'hybrid',
  };

  it('reports nothing unmet when every requirement is present', async () => {
    const env = await withEnv(FULL_SSO_ENV);
    expect(env.microsoftSsoRequirements().unmet).toEqual([]);
    expect(env.microsoftSsoRequirements().met).toHaveLength(5);
    expect(env.microsoftSsoConfigured()).toBe(true);
  });

  it('names the one variable that is missing, for each of them in turn', async () => {
    const cases: Array<[keyof typeof FULL_SSO_ENV, RegExp]> = [
      ['MICROSOFT_CLIENT_ID', /^MICROSOFT_CLIENT_ID$/],
      ['MICROSOFT_CLIENT_SECRET', /^MICROSOFT_CLIENT_SECRET$/],
      ['MICROSOFT_TENANT_ID', /^MICROSOFT_TENANT_ID /],
      ['APP_BASE_URL', /^APP_BASE_URL /],
      ['SESSION_SECRET', /^SESSION_SECRET$/],
    ];
    for (const [missing, pattern] of cases) {
      const { [missing]: _dropped, ...rest } = FULL_SSO_ENV;
      const env = await withEnv(rest);
      const { unmet } = env.microsoftSsoRequirements();
      // Exactly one thing is wrong, and it is named — not "SSO is not
      // configured", which is the message that cost the afternoon.
      expect(unmet).toHaveLength(1);
      expect(unmet[0]).toMatch(pattern);
      expect(env.microsoftSsoConfigured()).toBe(false);
    }
  });

  it('treats the default tenant `common` as unmet, and says why', async () => {
    // The trap: MICROSOFT_TENANT_ID has a schema default, so it is
    // always *set*. An operator looking at a dashboard sees a value and
    // moves on. `common` means "any Microsoft directory", which would
    // leave a domain string in a token as the only thing between the
    // app and every Microsoft account in the world.
    const env = await withEnv({ ...FULL_SSO_ENV, MICROSOFT_TENANT_ID: 'common' });
    const { unmet } = env.microsoftSsoRequirements();
    expect(unmet).toHaveLength(1);
    expect(unmet[0]).toContain('MICROSOFT_TENANT_ID');
    expect(unmet[0]).toContain('common');
    expect(env.microsoftSsoConfigured()).toBe(false);
  });

  it('reports the production symptom exactly, when nothing is configured', async () => {
    // This is what https://deal-radar-sbo8.onrender.com returned: a
    // deployment that knows its own address and nothing else.
    const env = await withEnv(PRODUCTION_ENV);
    expect(env.microsoftLoginAvailable()).toBe(false);
    expect(env.effectiveAuthMode()).toBe('local');
    expect(env.microsoftSsoRequirements().unmet).toEqual([
      'MICROSOFT_CLIENT_ID',
      'MICROSOFT_CLIENT_SECRET',
      expect.stringContaining('MICROSOFT_TENANT_ID'),
      'SESSION_SECRET',
    ]);
  });

  it('never leaks a configured value into the requirement names', async () => {
    // These strings are written to logs. They must name variables, not
    // report their contents.
    const env = await withEnv(FULL_SSO_ENV);
    const names = env.microsoftSsoRequirements().met.join(' ');
    for (const secret of [
      FULL_SSO_ENV.MICROSOFT_CLIENT_ID,
      FULL_SSO_ENV.MICROSOFT_CLIENT_SECRET,
      FULL_SSO_ENV.MICROSOFT_TENANT_ID,
      FULL_SSO_ENV.SESSION_SECRET,
    ]) {
      expect(names).not.toContain(secret);
    }
  });

  it('keeps the gate and the diagnostic from ever disagreeing', async () => {
    // microsoftSsoConfigured() is DERIVED from the requirement list, so
    // a sixth requirement cannot be added to the diagnostic without
    // also being enforced — nor enforced without being explained.
    for (const vars of [{}, PRODUCTION_ENV, FULL_SSO_ENV, { ...FULL_SSO_ENV, MICROSOFT_TENANT_ID: 'common' }]) {
      const env = await withEnv(vars);
      expect(env.microsoftSsoConfigured()).toBe(env.microsoftSsoRequirements().unmet.length === 0);
    }
  });

  /**
   * Requirement 6 of the production handover, and the reason
   * render.yaml pins AUTH_MODE rather than letting the `auto` default
   * run: the shared password has to survive the moment SSO switches on,
   * so a wrong Entra registration is a failed sign-in and not a lockout.
   */
  // ADMIN_PASSWORD is set globally in vitest.config.ts, so
  // localLoginAvailable() below reflects a provisioned password without
  // this file setting one — and must not set one, since overwriting it
  // would break every other suite's adminAgent() in the same worker.
  it('offers BOTH providers under the hybrid mode production is pinned to', async () => {
    const env = await withEnv(FULL_SSO_ENV);
    expect(env.effectiveAuthMode()).toBe('hybrid');
    expect(env.microsoftLoginAvailable()).toBe(true);
    // The emergency way back in, still there.
    expect(env.localLoginAvailable()).toBe(true);
  });

  it('would drop the password the moment AUTH_MODE is removed — the last cutover step', async () => {
    const { AUTH_MODE: _auto, ...withoutMode } = FULL_SSO_ENV;
    const env = await withEnv(withoutMode);
    expect(env.effectiveAuthMode()).toBe('microsoft');
    expect(env.microsoftLoginAvailable()).toBe(true);
    expect(env.localLoginAvailable()).toBe(false);
  });
});

/**
 * The boot log is the only place the reason surfaces without a shell on
 * the host: an operator who has just set variables in a dashboard reads
 * the deploy log next. It must name what is still missing, must confirm
 * the redirect URI when it succeeds, and must never print a value.
 */
describe('the production boot log explains itself', () => {
  /** Re-import server/env.ts as if booting in production. */
  async function bootProduction(vars: Record<string, string>) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      for (const key of OWNED_ENV_KEYS) delete process.env[key];
      Object.assign(process.env, vars);
      vi.resetModules();
      await import('../env');
      return {
        warnings: warn.mock.calls.map((c) => String(c[0])).join('\n'),
        infos: info.mock.calls.map((c) => String(c[0])).join('\n'),
      };
    } finally {
      process.env.NODE_ENV = previous;
      warn.mockRestore();
      info.mockRestore();
      for (const key of OWNED_ENV_KEYS) delete process.env[key];
      vi.resetModules();
    }
  }

  it('names every missing Entra variable when SSO was asked for', async () => {
    const { warnings } = await bootProduction({ APP_BASE_URL: PROD_BASE, AUTH_MODE: 'hybrid' });
    expect(warnings).toContain('Microsoft sign-in is NOT available');
    expect(warnings).toContain('MICROSOFT_CLIENT_ID');
    expect(warnings).toContain('MICROSOFT_CLIENT_SECRET');
    expect(warnings).toContain('MICROSOFT_TENANT_ID');
    expect(warnings).toContain('SESSION_SECRET');
  });

  it('warns on a HALF-finished handover even with no explicit AUTH_MODE', async () => {
    // Somebody set the client id and stopped. This is the case that
    // most needs a message and would otherwise be silent.
    const { warnings } = await bootProduction({
      APP_BASE_URL: PROD_BASE,
      MICROSOFT_CLIENT_ID: 'test-client-id-not-real',
    });
    expect(warnings).toContain('MICROSOFT_CLIENT_SECRET');
    expect(warnings).not.toContain('test-client-id-not-real');
  });

  it('confirms the exact redirect URI to register once SSO is live', async () => {
    const { infos, warnings } = await bootProduction({
      APP_BASE_URL: PROD_BASE,
      MICROSOFT_CLIENT_ID: 'test-client-id-not-real',
      MICROSOFT_CLIENT_SECRET: 'test-client-secret-not-real',
      MICROSOFT_TENANT_ID: TENANT,
      SESSION_SECRET: 'test-session-secret-at-least-16-chars',
      AUTH_MODE: 'hybrid',
    });
    expect(infos).toContain(`${PROD_BASE}${SSO_PATH}`);
    expect(warnings).not.toContain('NOT available');
    // Never the secret, and never the tenant id on its own line of the
    // log where it could be mistaken for something to copy.
    expect(infos).not.toContain('test-client-secret-not-real');
  });

  it('stays quiet on a default deployment that never asked for Microsoft', async () => {
    // A warning that fires on every boot of every local-only deployment
    // is one nobody reads by the time it matters.
    const { warnings } = await bootProduction({ APP_BASE_URL: PROD_BASE });
    expect(warnings).not.toContain('Microsoft sign-in is NOT available');
  });
});

// ── The Render blueprint itself ──────────────────────────────────

/**
 * render.yaml is the reason this outage was invisible. A variable that
 * is not declared there does not appear on the service as an empty
 * field to fill in — it simply does not exist, and the app reports
 * itself as a deployment that was never meant to have SSO. Asserting on
 * the blueprint catches that at test time instead of after a deploy.
 */
describe('the Render blueprint declares what production needs', () => {
  const blueprint = fs.readFileSync(path.resolve(import.meta.dirname, '../../render.yaml'), 'utf8');
  /** Every `- key: NAME` under envVars. */
  const declared = [...blueprint.matchAll(/^\s*-\s*key:\s*(\S+)/gm)].map((m) => m[1]);

  it('declares the three Entra variables a Microsoft administrator fills in', () => {
    for (const key of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']) {
      expect(declared).toContain(key);
    }
  });

  it('never commits a value for any of them', () => {
    // sync: false = "this service has this variable; its value is
    // entered in the dashboard". A `value:` here would put a client
    // secret in git history.
    for (const key of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID', 'SESSION_SECRET', 'ADMIN_PASSWORD']) {
      const entry = new RegExp(`-\\s*key:\\s*${key}\\s*\\n\\s*(\\S+):`, 'm').exec(blueprint);
      expect(entry, `${key} is not declared in render.yaml`).not.toBeNull();
      expect(entry![1], `${key} must be sync: false, never a committed value`).toBe('sync');
    }
  });

  it('points APP_BASE_URL at the Render production host', () => {
    expect(blueprint).toMatch(
      new RegExp(`-\\s*key:\\s*APP_BASE_URL\\s*\\n\\s*value:\\s*${PROD_BASE.replace(/[.]/g, '\\.')}\\s*$`, 'm'),
    );
    expect(blueprint).not.toMatch(/vercel\.app/);
    // The redirect URIs are derived, so hard-coding either one back into
    // the blueprint would reintroduce the second source of truth.
    expect(declared).not.toContain('MICROSOFT_SSO_REDIRECT_URI');
    expect(declared).not.toContain('MICROSOFT_REDIRECT_URI');
    // Same reason: one process serves the API and the frontend.
    expect(declared).not.toContain('FRONTEND_URL');
  });

  it('pins AUTH_MODE to hybrid so switching SSO on cannot lock the team out', () => {
    expect(blueprint).toMatch(/-\s*key:\s*AUTH_MODE\s*\n\s*value:\s*hybrid\s*$/m);
    // …and the password it falls back to is still provisioned.
    expect(declared).toContain('ADMIN_PASSWORD');
  });
});
