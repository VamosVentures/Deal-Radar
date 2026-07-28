import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { store } from '../lib/store';
import { createApp } from '../app';
import { adminAgent } from './testAuth';

beforeEach(() => store.resetForTests());

describe('health endpoints', () => {
  let app: Express;
  let agent: Awaited<ReturnType<typeof adminAgent>>;

  beforeEach(async () => {
    app = createApp();
    agent = await adminAgent(app);
  });

  it('/health/live is unauthenticated and always reports live while the process runs', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'live' });
  });

  it('/health/ready reports database and migrations OK without requiring any third-party credential', async () => {
    const res = await agent.get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.checks.migrations.ok).toBe(true);
    // Missing HubSpot/Outlook/AI/GitHub/Product Hunt credentials must
    // never fail readiness — they're reported as informational state.
    expect(res.body.integrations.hubspot).toBe('not_configured');
    expect(res.body.integrations.outlook).toBe('not_configured');
    expect(res.body.integrations.ai).toBe('not_configured');
    expect(res.status).not.toBe(503);
  });

  it('/health/ready gives an unauthenticated caller the verdict only — no internal detail', async () => {
    const res = await request(app).get('/health/ready');
    // A load balancer still gets a routable status code and verdict…
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    // …but nothing that leaks schema version, raw DB errors, or which
    // third-party integrations are configured.
    expect(res.body).toEqual({ status: 'ready' });
    expect(res.body).not.toHaveProperty('checks');
    expect(res.body).not.toHaveProperty('integrations');
    expect(res.body).not.toHaveProperty('scheduler');
  });

  it('reports scheduler enabled/running state honestly', async () => {
    const res = await agent.get('/health/ready');
    expect(res.body.scheduler).toEqual({ enabled: false, running: false }); // RUN_SCHEDULER=false in tests
  });

  it('is not rate-limited or gated behind admin auth', async () => {
    // Fire many requests quickly — health checks must never be throttled like /api/*.
    const results = await Promise.all(Array.from({ length: 20 }, () => request(app).get('/health/live')));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
