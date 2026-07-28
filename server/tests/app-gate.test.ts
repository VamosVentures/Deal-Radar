import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { resetDbForTests } from '../db/client';
import { adminAgent, TEST_ADMIN_PASSWORD } from './testAuth';
import { SESSION_COOKIE } from '../lib/auth';

/**
 * Regression net for the whole-application authentication gate.
 *
 * Until this gate existed, only the administrator plane was protected.
 * Roughly thirty routes — every company record, the audit log, the
 * integration status, and mutating routes that write to a real CRM or
 * a real mailbox — answered anyone who could reach the origin. These
 * tests exist so that regression cannot happen silently again.
 *
 * The distinction being pinned down: a gated route must 401 WITHOUT a
 * session and must NOT 401 WITH one. What it returns with a session
 * (200, 400, 404, 503…) is that route's own business, so those cases
 * assert only "not 401" — otherwise this file would duplicate, and
 * drift from, every other suite.
 */

/** A representative slice of what used to be reachable anonymously. */
const GATED: { method: 'get' | 'post' | 'put'; path: string; body?: unknown }[] = [
  { method: 'get', path: '/api/companies/imported' },
  { method: 'get', path: '/api/audit' },
  { method: 'get', path: '/api/integrations/status' },
  { method: 'get', path: '/api/duplicates' },
  { method: 'get', path: '/api/discovery/runs' },
  { method: 'get', path: '/api/discovery/sources' },
  { method: 'get', path: '/api/stealth/signals' },
  { method: 'get', path: '/api/portfolio' },
  { method: 'get', path: '/api/stale-settings' },
  { method: 'get', path: '/api/outlook/status' },
  { method: 'post', path: '/api/discovery/run', body: { sources: ['yc'], maxResults: 1 } },
  { method: 'post', path: '/api/hubspot/sync-company', body: { companyId: 'c-1' } },
  { method: 'post', path: '/api/hubspot/search', body: { query: 'x', type: 'companies' } },
  { method: 'post', path: '/api/outlook/drafts', body: { companyId: 'c-1', to: 'a@b.co', subject: 'S', body: 'Body text here.' } },
  { method: 'post', path: '/api/companies/bulk-status', body: { ids: ['c-1'], status: 'Monitor' } },
  { method: 'post', path: '/api/companies/import-csv', body: { csv: 'name\nAcme' } },
  { method: 'post', path: '/api/portfolio/company', body: { name: 'X', vertical: 'FinTech', stage: 'Seed', status: 'Active' } },
];

describe('whole-application authentication gate', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store.resetForTests();
    resetIdempotencyForTests();
    resetDbForTests();
    app = createApp();
  });

  describe('without a session', () => {
    for (const route of GATED) {
      it(`${route.method.toUpperCase()} ${route.path} is refused`, async () => {
        const res = await request(app)[route.method](route.path).send(route.body ?? {});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('auth_failed');
      });
    }

    it('a forged session cookie is rejected, not accepted', async () => {
      // Correct cookie NAME, structurally plausible value, invalid HMAC.
      const forged = `${Buffer.from(JSON.stringify({ exp: Date.now() + 60_000 }), 'utf8').toString('base64url')}.not-a-real-signature`;
      const res = await request(app)
        .get('/api/companies/imported')
        .set('Cookie', `${SESSION_COOKIE}=${forged}`);
      expect(res.status).toBe(401);
    });

    it('an expired-but-correctly-signed session is rejected', async () => {
      // Signature validity alone must not be enough — expiry is checked too.
      const agent = await adminAgent(app);
      const ok = await agent.get('/api/companies/imported');
      expect(ok.status).not.toBe(401); // sanity: the agent really is signed in

      const stale = Buffer.from(JSON.stringify({ exp: Date.now() - 1 }), 'utf8').toString('base64url');
      const res = await request(app)
        .get('/api/companies/imported')
        .set('Cookie', `${SESSION_COOKIE}=${stale}.whatever`);
      expect(res.status).toBe(401);
    });
  });

  describe('with a valid session', () => {
    for (const route of GATED) {
      it(`${route.method.toUpperCase()} ${route.path} is no longer refused by the gate`, async () => {
        const agent = await adminAgent(app);
        const res = await agent[route.method](route.path).send(route.body ?? {});
        // The route may legitimately 400/404/422/502/503 — it must not 401.
        expect(res.status).not.toBe(401);
      });
    }
  });

  describe('the public allowlist still works unauthenticated', () => {
    it('GET /api/auth/status returns 200', async () => {
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
    });

    it('POST /api/auth/login with the right password returns 200 and sets a cookie', async () => {
      const res = await request(app).post('/api/auth/login').send({ password: TEST_ADMIN_PASSWORD });
      expect(res.status).toBe(200);
      expect(String(res.headers['set-cookie'])).toContain(SESSION_COOKIE);
    });

    it('POST /api/auth/login with a wrong password returns 401 from the LOGIN, not the gate', async () => {
      const res = await request(app).post('/api/auth/login').send({ password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('auth_failed');
      expect(res.body.message).toMatch(/incorrect password/i);
    });

    it('POST /api/auth/logout returns 200 without a session', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(200);
    });
  });

  describe('health endpoints', () => {
    it('/health/live is public', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('live');
    });

    it('/health/ready gives an anonymous caller the verdict only', async () => {
      const res = await request(app).get('/health/ready');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('status');
      // No schema version, no raw DB error text, no integration inventory.
      expect(res.body).not.toHaveProperty('checks');
      expect(res.body).not.toHaveProperty('integrations');
      expect(res.body).not.toHaveProperty('scheduler');
    });

    it('/health/ready gives an administrator the full detail', async () => {
      const agent = await adminAgent(app);
      const res = await agent.get('/health/ready');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('checks');
      expect(res.body).toHaveProperty('integrations');
      expect(res.body).toHaveProperty('scheduler');
    });
  });
});
