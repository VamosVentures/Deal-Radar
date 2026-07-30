import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { TEST_ADMIN_PASSWORD } from './testAuth';

/**
 * Microsoft Entra sign-in — security tests.
 *
 * FIXTURES ONLY. Nothing here reaches login.microsoftonline.com. A
 * throwaway RSA keypair is generated in-process, its public half is
 * served as the tenant's JWKS through the test seam in
 * server/lib/microsoftAuth.ts, and the private half signs the id_tokens
 * under test. That is what makes it possible to assert the NEGATIVE
 * cases — a token from the wrong tenant, for the wrong app, with a
 * replayed nonce — which are the cases that actually matter and which
 * no amount of live testing against a real tenant would let us produce.
 *
 * The tenant id, client id, and secret below are invented test values.
 */

const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER_TENANT = '99999999-8888-7777-6666-555555555555';
const CLIENT_ID = 'test-client-id-not-real';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const SSO_CALLBACK = 'http://localhost:8787/api/auth/microsoft/callback';

// One keypair for the whole file — generating 2048-bit RSA per test is
// slow and buys nothing.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
const KID = 'test-signing-key-1';
const JWKS_KEYS = [{ kid: KID, kty: 'RSA', alg: 'RS256', use: 'sig', n: publicJwk.n, e: publicJwk.e }];

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
  token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
  jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

/** Sign an id_token with the fixture key. `header` overrides allow forging attempts. */
function makeIdToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
  const p = b64(claims);
  const sig = crypto
    .sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf8'), privateKey)
    .toString('base64url');
  return `${h}.${p}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);

/** A token that passes every check — each test breaks exactly one thing. */
function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    tid: TENANT,
    oid: 'entra-object-id-abc',
    sub: 'subject-abc',
    iat: now(),
    nbf: now(),
    exp: now() + 3600,
    nonce: 'fixture-nonce-value',
    name: 'Ada Lovelace',
    preferred_username: 'ada@vamosventures.com',
    ...overrides,
  };
}

/**
 * Point the environment at the fixture tenant and reset the module
 * registry so server/env.ts re-reads process.env. Every test that needs
 * Microsoft configured calls this.
 */
function configureMicrosoft(extra: Record<string, string> = {}): void {
  process.env.MICROSOFT_CLIENT_ID = CLIENT_ID;
  process.env.MICROSOFT_CLIENT_SECRET = 'test-client-secret-not-real';
  process.env.MICROSOFT_TENANT_ID = TENANT;
  process.env.MICROSOFT_SSO_REDIRECT_URI = SSO_CALLBACK;
  process.env.MICROSOFT_REDIRECT_URI = 'http://localhost:8787/api/outlook/callback';
  process.env.SESSION_SECRET = 'test-session-secret-at-least-16-chars';
  process.env.AUTH_MODE = 'hybrid';
  Object.assign(process.env, extra);
  vi.resetModules();
}

const MICROSOFT_ENV_KEYS = [
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID',
  'MICROSOFT_SSO_REDIRECT_URI', 'MICROSOFT_REDIRECT_URI', 'SESSION_SECRET', 'AUTH_MODE',
];

/** Nothing Microsoft in the environment — the repo's state today. */
function clearMicrosoftEnv(): void {
  for (const key of MICROSOFT_ENV_KEYS) delete process.env[key];
  vi.resetModules();
}

afterEach(() => {
  // Vitest can share a worker across files: leaving Microsoft configured
  // (or ADMIN_PASSWORD deleted) would change how every other suite's
  // gated routes behave.
  for (const key of MICROSOFT_ENV_KEYS) delete process.env[key];
  process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Load the server graph from the CURRENT module registry, with the OIDC
 * fixtures installed.
 *
 * Every module has to come from the same post-`vi.resetModules()`
 * registry as the app under test. Reaching for a top-level `import` of
 * `store` instead would hand back the pre-reset copy — a different
 * object than the one the app writes its pending sign-in state into,
 * which looks exactly like "the state was never stored".
 */
async function loadServer() {
  const microsoftAuth = await import('../lib/microsoftAuth');
  microsoftAuth.__setMicrosoftOidcForTests({ discovery: DISCOVERY, keys: JWKS_KEYS });
  const { store } = await import('../lib/store');
  store.resetForTests();
  const { createApp } = await import('../app');
  return { createApp, store, verifyIdToken: microsoftAuth.verifyIdToken };
}

/** Just enough of the store's shape for these helpers. */
type StoreLike = { raw: { oauthStates: { state: string; nonce?: string; codeVerifier?: string }[] } };

/**
 * The human-readable reason off a failed-sign-in redirect.
 *
 * Parsed with URLSearchParams rather than decodeURIComponent: the
 * redirect is built with URLSearchParams, which encodes spaces as `+`,
 * and decodeURIComponent leaves `+` alone — so a naive decode would
 * compare against "not+in+the+Vamos..." and never match.
 */
function reasonFrom(location: string): string {
  return new URL(location).searchParams.get('reason') ?? '';
}

/** The pending sign-in's nonce, read from the same store the app wrote it to. */
function pendingFor(store: StoreLike, state: string) {
  const record = store.raw.oauthStates.find((s) => s.state === state);
  if (!record) throw new Error(`No pending sign-in found for state ${state}`);
  return record;
}

// ── id_token verification ────────────────────────────────────────

describe('verifyIdToken', () => {
  const NONCE = { nonce: 'fixture-nonce-value' };

  it('accepts a correctly-signed token from the Vamos tenant', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const identity = await verifyIdToken(makeIdToken(validClaims()), NONCE);
    expect(identity).toEqual({
      oid: 'entra-object-id-abc',
      tid: TENANT,
      email: 'ada@vamosventures.com',
      name: 'Ada Lovelace',
    });
  });

  it('rejects a token signed by a key that is not in the tenant JWKS', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    // Same `kid`, different private key — the forgery a stolen kid buys.
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
    const p = b64(validClaims());
    const sig = crypto
      .sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf8'), other.privateKey)
      .toString('base64url');
    await expect(verifyIdToken(`${h}.${p}.${sig}`, NONCE)).rejects.toThrow(/signature did not verify/i);
  });

  it('rejects an unsigned token (alg: none)', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const h = b64({ alg: 'none', kid: KID, typ: 'JWT' });
    const p = b64(validClaims());
    await expect(verifyIdToken(`${h}.${p}.`, NONCE)).rejects.toThrow(/unsupported signing algorithm/i);
  });

  it('rejects an HS256 token signed with the public key as an HMAC secret', async () => {
    // The classic algorithm-confusion attack: if `alg` were honored
    // rather than pinned, this token would "verify".
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const h = b64({ alg: 'HS256', kid: KID, typ: 'JWT' });
    const p = b64(validClaims());
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const sig = crypto.createHmac('sha256', pubPem).update(`${h}.${p}`).digest('base64url');
    await expect(verifyIdToken(`${h}.${p}.${sig}`, NONCE)).rejects.toThrow(/unsupported signing algorithm/i);
  });

  it('rejects a token from a DIFFERENT Microsoft tenant', async () => {
    // The single most important check: a real, correctly-signed
    // Microsoft token from somebody else's directory.
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const token = makeIdToken(validClaims({ tid: OTHER_TENANT }));
    await expect(verifyIdToken(token, NONCE)).rejects.toThrow(/not in the Vamos Ventures Microsoft directory/i);
  });

  it('rejects a token whose issuer is not the tenant issuer', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const token = makeIdToken(validClaims({ iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }));
    await expect(verifyIdToken(token, NONCE)).rejects.toThrow(/unexpected issuer/i);
  });

  it('rejects a token minted for a different application (audience)', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const token = makeIdToken(validClaims({ aud: 'some-other-app-registration' }));
    await expect(verifyIdToken(token, NONCE)).rejects.toThrow(/different application/i);
  });

  it('rejects an expired token', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const token = makeIdToken(validClaims({ exp: now() - 3600, iat: now() - 7200, nbf: now() - 7200 }));
    await expect(verifyIdToken(token, NONCE)).rejects.toThrow(/expired/i);
  });

  it('rejects a token that is not valid yet (nbf in the future)', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const token = makeIdToken(validClaims({ nbf: now() + 3600 }));
    await expect(verifyIdToken(token, NONCE)).rejects.toThrow(/not valid yet/i);
  });

  it('rejects a mismatched nonce, and a missing one', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    await expect(
      verifyIdToken(makeIdToken(validClaims({ nonce: 'a-different-nonce' })), NONCE),
    ).rejects.toThrow(/could not be matched/i);
    const { nonce: _drop, ...noNonce } = validClaims();
    await expect(verifyIdToken(makeIdToken(noNonce), NONCE)).rejects.toThrow(/could not be matched/i);
  });

  it('rejects a non-@vamosventures.com account even inside the tenant', async () => {
    // Tenants legitimately contain non-employee identities; the domain
    // check excludes them AFTER the tenant check has done the real work.
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const token = makeIdToken(validClaims({ preferred_username: 'contractor@example.com' }));
    await expect(verifyIdToken(token, NONCE)).rejects.toThrow(/limited to @vamosventures\.com/i);
  });

  it('is not fooled by a lookalike domain suffix', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    for (const address of [
      'ada@notvamosventures.com',      // suffix match without the @
      'ada@vamosventures.com.evil.io', // domain as a prefix
      'ada@vamosventures.co',
    ]) {
      await expect(
        verifyIdToken(makeIdToken(validClaims({ preferred_username: address })), NONCE),
      ).rejects.toThrow(/limited to @vamosventures\.com/i);
    }
  });

  it('rejects an externally-federated guest account', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const token = makeIdToken(validClaims({ idp: 'https://sts.windows.net/some-other-tenant/' }));
    await expect(verifyIdToken(token, NONCE)).rejects.toThrow(/guest and externally-federated/i);
  });

  it('rejects an account whose email domain the directory has not verified', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const token = makeIdToken(validClaims({ xms_edov: false }));
    await expect(verifyIdToken(token, NONCE)).rejects.toThrow(/not verified by the directory/i);
  });

  it('rejects a token with no user object id', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const { oid: _drop, ...noOid } = validClaims();
    await expect(verifyIdToken(makeIdToken(noOid), NONCE)).rejects.toThrow(/user object id/i);
  });

  it('rejects structurally malformed tokens', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    for (const bad of ['', 'not-a-jwt', 'only.two']) {
      await expect(verifyIdToken(bad, NONCE)).rejects.toThrow(/malformed/i);
    }
  });

  it('falls back to the verified address when the token carries no display name', async () => {
    configureMicrosoft();
    const { verifyIdToken } = await loadServer();
    const { name: _drop, ...noName } = validClaims();
    const identity = await verifyIdToken(makeIdToken(noName), NONCE);
    expect(identity.name).toBe('ada@vamosventures.com');
  });
});

// ── Configuration gating ─────────────────────────────────────────

describe('Microsoft configuration gating', () => {
  it('treats multi-tenant aliases as NOT configured', async () => {
    // `common` would let any Microsoft account anywhere complete the
    // flow, leaving a domain string as the only defense.
    for (const tenant of ['common', 'organizations', 'consumers']) {
      configureMicrosoft({ MICROSOFT_TENANT_ID: tenant });
      const { microsoftSsoConfigured, effectiveAuthMode, microsoftSsoPending } = await import('../env');
      expect(microsoftSsoConfigured()).toBe(false);
      expect(effectiveAuthMode()).toBe('local');
      expect(microsoftSsoPending()).toBe(true);
    }
  });

  it('is configured with a real single-tenant GUID', async () => {
    configureMicrosoft();
    const { microsoftSsoConfigured, effectiveAuthMode, microsoftSsoPending } = await import('../env');
    expect(microsoftSsoConfigured()).toBe(true);
    expect(effectiveAuthMode()).toBe('hybrid');
    expect(microsoftSsoPending()).toBe(false);
  });

  it('falls back to local mode — never a lockout — when Entra config is incomplete', async () => {
    for (const missing of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_SSO_REDIRECT_URI', 'SESSION_SECRET']) {
      configureMicrosoft({ AUTH_MODE: 'microsoft' });
      delete process.env[missing];
      vi.resetModules();
      const { effectiveAuthMode, localLoginAvailable, microsoftLoginAvailable, microsoftSsoPending } = await import('../env');
      expect(effectiveAuthMode()).toBe('local');
      // The password still works — a half-finished credential handover
      // must not be able to lock the team out of its own tool.
      expect(localLoginAvailable()).toBe(true);
      expect(microsoftLoginAvailable()).toBe(false);
      expect(microsoftSsoPending()).toBe(true);
    }
  });

  it('defaults to local mode when AUTH_MODE is unset', async () => {
    configureMicrosoft();
    delete process.env.AUTH_MODE;
    vi.resetModules();
    const { effectiveAuthMode, microsoftLoginAvailable, microsoftSsoPending } = await import('../env');
    expect(effectiveAuthMode()).toBe('local');
    expect(microsoftLoginAvailable()).toBe(false);
    // Nothing was requested, so nothing is "pending".
    expect(microsoftSsoPending()).toBe(false);
  });
});

// ── Routes ───────────────────────────────────────────────────────

describe('/api/auth/status', () => {
  it('reports awaiting-configuration when Microsoft is requested but incomplete', async () => {
    configureMicrosoft({ AUTH_MODE: 'hybrid' });
    delete process.env.MICROSOFT_CLIENT_ID;
    vi.resetModules();
    const { createApp } = await loadServer();
    const res = await request(createApp()).get('/api/auth/status');
    expect(res.body).toMatchObject({
      mode: 'local',
      requestedMode: 'hybrid',
      localLoginAvailable: true,
      microsoftLoginAvailable: false,
      microsoftPending: true,
      microsoftPendingMessage: 'Awaiting Microsoft administrator configuration',
    });
  });

  it('offers both providers in hybrid mode', async () => {
    configureMicrosoft({ AUTH_MODE: 'hybrid' });
    const { createApp } = await loadServer();
    const res = await request(createApp()).get('/api/auth/status');
    expect(res.body).toMatchObject({
      mode: 'hybrid',
      localLoginAvailable: true,
      microsoftLoginAvailable: true,
      microsoftPending: false,
    });
  });

  it('offers only Microsoft in microsoft mode', async () => {
    configureMicrosoft({ AUTH_MODE: 'microsoft' });
    const { createApp } = await loadServer();
    const res = await request(createApp()).get('/api/auth/status');
    expect(res.body).toMatchObject({
      mode: 'microsoft',
      localLoginAvailable: false,
      microsoftLoginAvailable: true,
    });
  });
});

describe('/api/auth/microsoft/start', () => {
  it('returns 503 with the awaiting-configuration message when Entra is not configured', async () => {
    // Default state of this repo today: no Microsoft credentials.
    clearMicrosoftEnv();
    const { createApp } = await loadServer();
    const res = await request(createApp()).post('/api/auth/microsoft/start').send({});
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('Awaiting Microsoft administrator configuration');
    // The hint names variables, never values.
    expect(res.body.hint).toMatch(/MICROSOFT_CLIENT_ID/);
  });

  it('returns 503 when configured but AUTH_MODE has not enabled it', async () => {
    configureMicrosoft({ AUTH_MODE: 'local' });
    const { createApp } = await loadServer();
    const res = await request(createApp()).post('/api/auth/microsoft/start').send({});
    expect(res.status).toBe(503);
    expect(res.body.hint).toMatch(/AUTH_MODE/);
  });

  it('builds an authorize URL with minimum sign-in scopes, state, nonce, and PKCE', async () => {
    configureMicrosoft();
    const { createApp } = await loadServer();
    const res = await request(createApp()).post('/api/auth/microsoft/start').send({});
    expect(res.status).toBe(200);

    const url = new URL(res.body.authUrl);
    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(SSO_CALLBACK);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();

    // Sign-in asks for identity ONLY — no mailbox scope, ever.
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes.sort()).toEqual(['User.Read', 'email', 'openid', 'profile'].sort());
    expect(scopes).not.toContain('Mail.ReadWrite');
    expect(scopes).not.toContain('Mail.Send');
    expect(scopes).not.toContain('offline_access');
  });

  it('stores the nonce and PKCE verifier server-side and sends neither to the browser', async () => {
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    const res = await request(createApp()).post('/api/auth/microsoft/start').send({});

    const record = store.raw.oauthStates.find((s) => s.purpose === 'sso');
    expect(record?.nonce).toBeTruthy();
    expect(record?.codeVerifier).toBeTruthy();
    // The verifier is the secret half of PKCE — it must never be in the
    // response, or PKCE protects nothing.
    expect(JSON.stringify(res.body)).not.toContain(record!.codeVerifier!);
  });
});

describe('/api/auth/microsoft/callback', () => {
  /** Stub only the Microsoft token endpoint; everything else is the fixture seam. */
  function stubTokenEndpoint(idToken: string | null) {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url) === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify(idToken ? { id_token: idToken } : {}), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected outbound request in test: ${url}`);
    }));
  }

  /** Run start → callback, returning the callback response. */
  async function completeFlow(
    app: import('express').Express,
    store: StoreLike,
    claimsFor: (nonce: string) => Record<string, unknown>,
  ) {
    const start = await request(app).post('/api/auth/microsoft/start').send({});
    const url = new URL(start.body.authUrl);
    const state = url.searchParams.get('state')!;
    const nonce = pendingFor(store, state).nonce!;
    stubTokenEndpoint(makeIdToken(claimsFor(nonce)));
    return request(app).get('/api/auth/microsoft/callback').query({ code: 'test-auth-code', state });
  }

  it('signs in a valid Vamos account and sets an httpOnly session cookie', async () => {
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    const app = createApp();

    const res = await completeFlow(app, store, (nonce) => validClaims({ nonce }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('signin=ok');
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/vamos_admin_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it('records the signed-in Microsoft user as the reviewer identity', async () => {
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    const app = createApp();
    const agent = request.agent(app);

    const start = await agent.post('/api/auth/microsoft/start').send({});
    const state = new URL(start.body.authUrl).searchParams.get('state')!;
    const nonce = pendingFor(store, state).nonce!;
    stubTokenEndpoint(makeIdToken(validClaims({ nonce })));
    await agent.get('/api/auth/microsoft/callback').query({ code: 'test-auth-code', state });

    const status = await agent.get('/api/auth/status');
    expect(status.body.authenticated).toBe(true);
    expect(status.body.identity).toEqual({
      label: 'Ada Lovelace',
      source: 'microsoft-sso',
      email: 'ada@vamosventures.com',
    });

    // And the session opens the gated plane, without any ADMIN_PASSWORD
    // involvement.
    expect((await agent.get('/api/admin/status')).status).toBe(200);
  });

  it('rejects an unknown state (nothing this server issued)', async () => {
    configureMicrosoft();
    const { createApp } = await loadServer();
    const res = await request(createApp())
      .get('/api/auth/microsoft/callback')
      .query({ code: 'test-auth-code', state: 'state-we-never-issued' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('signin=failed');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('consumes state exactly once — a replayed callback fails', async () => {
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    const app = createApp();

    const start = await request(app).post('/api/auth/microsoft/start').send({});
    const state = new URL(start.body.authUrl).searchParams.get('state')!;
    const nonce = pendingFor(store, state).nonce!;
    stubTokenEndpoint(makeIdToken(validClaims({ nonce })));

    const first = await request(app).get('/api/auth/microsoft/callback').query({ code: 'c', state });
    expect(first.headers.location).toContain('signin=ok');

    const replay = await request(app).get('/api/auth/microsoft/callback').query({ code: 'c', state });
    expect(replay.headers.location).toContain('signin=failed');
    expect(replay.headers['set-cookie']).toBeUndefined();
  });

  it('will not redeem an Outlook mailbox state on the sign-in callback', async () => {
    // Separate callbacks, separate state purposes — a mailbox consent
    // response must not be convertible into a login.
    configureMicrosoft();
    const { createApp } = await loadServer();
    // Imported AFTER loadServer so it writes into the same store the app
    // reads — and after the reset loadServer performs.
    const { issueOAuthState } = await import('../lib/oauthState');
    const { state } = issueOAuthState('outlook');

    const res = await request(createApp())
      .get('/api/auth/microsoft/callback')
      .query({ code: 'test-auth-code', state });
    expect(res.headers.location).toContain('signin=failed');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a wrong-tenant account and establishes no session', async () => {
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    const res = await completeFlow(createApp(), store, (nonce) =>
      validClaims({ nonce, tid: OTHER_TENANT }));
    expect(res.headers.location).toContain('signin=failed');
    expect(reasonFrom(res.headers.location)).toMatch(/not in the Vamos Ventures Microsoft directory/i);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a non-Vamos account and establishes no session', async () => {
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    const res = await completeFlow(createApp(), store, (nonce) =>
      validClaims({ nonce, preferred_username: 'someone@gmail.com' }));
    expect(res.headers.location).toContain('signin=failed');
    expect(reasonFrom(res.headers.location)).toMatch(/limited to @vamosventures\.com/i);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a token bearing someone else\'s nonce', async () => {
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    const res = await completeFlow(createApp(), store, () =>
      validClaims({ nonce: 'a-nonce-from-a-different-sign-in' }));
    expect(res.headers.location).toContain('signin=failed');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('surfaces a Microsoft-side error without establishing a session', async () => {
    configureMicrosoft();
    const { createApp } = await loadServer();
    const res = await request(createApp())
      .get('/api/auth/microsoft/callback')
      .query({ error: 'access_denied', error_description: 'The user declined consent.' });
    expect(res.headers.location).toContain('signin=failed');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never leaks the authorization code or a token into the audit log', async () => {
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    const app = createApp();

    const start = await request(app).post('/api/auth/microsoft/start').send({});
    const state = new URL(start.body.authUrl).searchParams.get('state')!;
    const record = pendingFor(store, state);
    const idToken = makeIdToken(validClaims({ nonce: record.nonce! }));
    stubTokenEndpoint(idToken);
    await request(app).get('/api/auth/microsoft/callback')
      .query({ code: 'super-secret-authorization-code', state });

    const serialized = JSON.stringify(store.raw.audit);
    expect(serialized).not.toContain('super-secret-authorization-code');
    expect(serialized).not.toContain(idToken);
    expect(serialized).not.toContain(record.codeVerifier!);
    expect(serialized).not.toContain('test-client-secret-not-real');
    // What it SHOULD contain: that a verified sign-in happened, and for whom.
    expect(serialized).toContain('ada@vamosventures.com');
  });

  it('stores no Microsoft token at all for a sign-in', async () => {
    // Sign-in has no use for the access token, so it keeps none. The
    // only persisted Microsoft tokens come from mailbox consent.
    configureMicrosoft();
    const { createApp, store } = await loadServer();
    await completeFlow(createApp(), store, (nonce) => validClaims({ nonce }));
    expect(store.raw.tokens).toHaveLength(0);
  });
});

// ── Mode behavior ────────────────────────────────────────────────

describe('authentication modes', () => {
  it('local mode: password works and the Microsoft callback is inert', async () => {
    configureMicrosoft({ AUTH_MODE: 'local' });
    const { createApp } = await loadServer();
    const app = createApp();

    const login = await request(app).post('/api/auth/login').send({ password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);

    const cb = await request(app).get('/api/auth/microsoft/callback').query({ code: 'c', state: 's' });
    expect(cb.headers.location).toContain('signin=failed');
    expect(cb.headers['set-cookie']).toBeUndefined();
  });

  it('hybrid mode: the password still works alongside Microsoft', async () => {
    configureMicrosoft({ AUTH_MODE: 'hybrid' });
    const { createApp } = await loadServer();
    const res = await request(createApp()).post('/api/auth/login').send({ password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
  });

  it('microsoft mode: the password is refused, with a reversible hint', async () => {
    configureMicrosoft({ AUTH_MODE: 'microsoft' });
    const { createApp } = await loadServer();
    const res = await request(createApp()).post('/api/auth/login').send({ password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Microsoft account/i);
    expect(res.body.hint).toMatch(/AUTH_MODE=hybrid/);
  });

  it('microsoft mode without ADMIN_PASSWORD still admits a verified SSO session', async () => {
    // Regression guard: the gate used to require ADMIN_PASSWORD
    // specifically, which would have 401'd every request in a
    // Microsoft-only deployment despite a valid session.
    configureMicrosoft({ AUTH_MODE: 'microsoft' });
    delete process.env.ADMIN_PASSWORD;
    vi.resetModules();
    const { createApp, store } = await loadServer();
    const app = createApp();
    const agent = request.agent(app);

    expect((await agent.get('/api/auth/status')).body.configured).toBe(true);
    expect((await agent.get('/api/admin/status')).status).toBe(401);

    const start = await agent.post('/api/auth/microsoft/start').send({});
    const state = new URL(start.body.authUrl).searchParams.get('state')!;
    const nonce = pendingFor(store, state).nonce!;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url) === DISCOVERY.token_endpoint) {
        return new Response(JSON.stringify({ id_token: makeIdToken(validClaims({ nonce })) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected outbound request in test: ${url}`);
    }));
    await agent.get('/api/auth/microsoft/callback').query({ code: 'c', state });

    expect((await agent.get('/api/admin/status')).status).toBe(200);
  });
});

// ── Scope boundaries ─────────────────────────────────────────────

describe('scope boundaries', () => {
  it('sign-in requests only openid, profile, email, and User.Read', async () => {
    const { SIGN_IN_SCOPES } = await import('../lib/microsoftAuth');
    expect([...SIGN_IN_SCOPES].sort()).toEqual(['User.Read', 'email', 'openid', 'profile'].sort());
  });

  it('mailbox consent adds Mail.ReadWrite and offline_access, and nothing forbidden', async () => {
    const { OUTLOOK_SCOPES } = await import('../services/outlook');
    expect([...OUTLOOK_SCOPES].sort()).toEqual(
      ['Mail.ReadWrite', 'User.Read', 'offline_access'].sort(),
    );
  });

  it('no scope list anywhere requests Mail.Send, shared, or application mailbox access', async () => {
    const { SIGN_IN_SCOPES } = await import('../lib/microsoftAuth');
    const { OUTLOOK_SCOPES } = await import('../services/outlook');
    const all = [...SIGN_IN_SCOPES, ...OUTLOOK_SCOPES];
    for (const forbidden of [
      'Mail.Send', 'Mail.Send.Shared', 'Mail.ReadWrite.Shared', 'Mail.Read.Shared',
      'Mail.ReadWrite.All', 'Mail.Read.All', 'MailboxSettings.ReadWrite',
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });
});
