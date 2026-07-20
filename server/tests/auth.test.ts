import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createSessionToken, passwordMatches, verifySessionToken } from '../lib/auth';
import { TEST_ADMIN_PASSWORD, adminAgent } from './testAuth';

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
});

describe('session token', () => {
  it('round-trips a freshly created token', () => {
    expect(verifySessionToken(createSessionToken())).toBe(true);
  });

  it('rejects a missing or malformed token', () => {
    expect(verifySessionToken(undefined)).toBe(false);
    expect(verifySessionToken('not-a-real-token')).toBe(false);
    expect(verifySessionToken('')).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = createSessionToken();
    const [encoded] = token.split('.');
    expect(verifySessionToken(`${encoded}.forged-signature-forged-signature`)).toBe(false);
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    try {
      const token = createSessionToken();
      vi.advanceTimersByTime(13 * 60 * 60_000); // past the 12h TTL
      expect(verifySessionToken(token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('passwordMatches', () => {
  it('accepts the configured password and rejects anything else', () => {
    expect(passwordMatches(TEST_ADMIN_PASSWORD)).toBe(true);
    expect(passwordMatches('wrong')).toBe(false);
    expect(passwordMatches('')).toBe(false);
  });
});

describe('auth routes (ADMIN_PASSWORD configured — see vitest.config.ts)', () => {
  it('GET /auth/status reports configured, not yet authenticated', async () => {
    const { createApp } = await import('../app');
    const res = await request(createApp()).get('/api/auth/status');
    expect(res.body).toEqual({ configured: true, authenticated: false });
  });

  it('rejects an incorrect password', async () => {
    const { createApp } = await import('../app');
    const res = await request(createApp()).post('/api/auth/login').send({ password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth_failed');
  });

  it('accepts the correct password, sets a session cookie, and the session then shows authenticated', async () => {
    const { createApp } = await import('../app');
    const app = createApp();
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']?.[0]).toMatch(/vamos_admin_session=/);
    expect(login.headers['set-cookie']?.[0]).toMatch(/HttpOnly/i);

    const status = await agent.get('/api/auth/status');
    expect(status.body).toEqual({ configured: true, authenticated: true });
  });

  it('logout clears the session', async () => {
    const { createApp } = await import('../app');
    const app = createApp();
    const agent = await adminAgent(app);
    expect((await agent.get('/api/auth/status')).body.authenticated).toBe(true);
    await agent.post('/api/auth/logout').send({});
    expect((await agent.get('/api/auth/status')).body.authenticated).toBe(false);
  });

  it('gates an admin-only route: 401 without a session, 200 with one', async () => {
    const { createApp } = await import('../app');
    const app = createApp();
    const denied = await request(app).get('/api/admin/status');
    expect(denied.status).toBe(401);
    expect(denied.body.message).toMatch(/sign-in required/i);

    const agent = await adminAgent(app);
    const allowed = await agent.get('/api/admin/status');
    expect(allowed.status).toBe(200);
  });

  it('does not gate the general team review actions (company status) or the discovery/outlook-draft paths', async () => {
    // These stay usable without an admin session — only the
    // administrator-plane actions (schedule, refresh, connector
    // connect/disconnect) require sign-in.
    const { createApp } = await import('../app');
    const res = await request(createApp()).get('/api/integrations/status');
    expect(res.status).toBe(200);
  });
});

describe('auth routes (ADMIN_PASSWORD not configured)', () => {
  // Restore the test-suite-wide ADMIN_PASSWORD (vitest.config.ts) after
  // each test here — vitest can share a worker process across test
  // files, so leaving this deleted would break every other file's
  // gated-route tests that assume it's set.
  afterEach(() => {
    process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
    vi.resetModules();
  });

  it('reports not configured and refuses login, fail-closed', async () => {
    delete process.env.ADMIN_PASSWORD;
    vi.resetModules();
    const { createApp } = await import('../app');
    const app = createApp();

    const status = await request(app).get('/api/auth/status');
    expect(status.body).toEqual({ configured: false, authenticated: false });

    const login = await request(app).post('/api/auth/login').send({ password: 'anything' });
    expect(login.status).toBe(401);
    expect(login.body.hint).toMatch(/ADMIN_PASSWORD/);

    // Admin-only routes stay unusable, not open, when no password is set.
    const gated = await request(app).get('/api/admin/status');
    expect(gated.status).toBe(401);
    expect(gated.body.message).toMatch(/not enabled/i);
  });
});
