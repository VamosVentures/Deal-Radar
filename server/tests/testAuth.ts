import request from 'supertest';
import type { Express } from 'express';

/** Test admin password — matches ADMIN_PASSWORD in vitest.config.ts. */
export const TEST_ADMIN_PASSWORD = 'test-admin-password';

/**
 * Returns a supertest agent already signed in as admin (cookies persist
 * across requests made with the same agent). Every gated route
 * (schedule, refresh, admin/status, HubSpot/Outlook connect-disconnect)
 * needs this instead of a bare `request(app)` now that they require a
 * real session — see server/lib/auth.ts.
 */
export async function adminAgent(app: Express) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ password: TEST_ADMIN_PASSWORD });
  if (res.status !== 200) throw new Error(`Test admin login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
