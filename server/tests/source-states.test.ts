import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { getSourceMeta } from '../sourcing';

function stateOf(id: string) {
  return getSourceMeta().find((s) => s.id === id)?.state;
}

describe('honest source-selection states', () => {
  afterEach(() => {
    delete process.env.PRODUCTHUNT_TOKEN;
  });

  it('sources with a real, credential-free adapter are live', () => {
    for (const id of ['github', 'sec', 'grants', 'funding-news', 'yc', 'research', 'upload']) {
      expect(stateOf(id)).toBe('live');
    }
  });

  it('sources with no adapter but a plausible future one are planned', () => {
    for (const id of ['accelerators', 'hackathons', 'registries', 'licensed']) {
      expect(stateOf(id)).toBe('planned');
    }
  });

  it('sources with no viable path are unavailable', () => {
    expect(stateOf('websites')).toBe('unavailable'); // structurally a refresh check, not a discovery adapter
    expect(stateOf('patents')).toBe('unavailable'); // previously-known key-free API confirmed retired
  });

  it('Product Hunt is credentials-required without a token, live with one', async () => {
    expect(stateOf('producthunt')).toBe('credentials-required');

    process.env.PRODUCTHUNT_TOKEN = 'test-token';
    vi.resetModules();
    const { getSourceMeta: freshGetSourceMeta } = await import('../sourcing');
    expect(freshGetSourceMeta().find((s) => s.id === 'producthunt')?.state).toBe('live');

    delete process.env.PRODUCTHUNT_TOKEN;
    vi.resetModules();
  });

  it('every state is one of the four honest values, never a fabricated fifth', () => {
    for (const s of getSourceMeta()) {
      expect(['live', 'credentials-required', 'planned', 'unavailable']).toContain(s.state);
    }
  });

  it('GET /api/discovery/sources exposes the same states over HTTP', async () => {
    const { createApp } = await import('../app');
    const res = await request(createApp()).get('/api/discovery/sources');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.sources.map((s: { id: string; state: string }) => [s.id, s.state]));
    expect(byId.github).toBe('live');
    expect(byId.patents).toBe('unavailable');
    expect(byId.accelerators).toBe('planned');
  });
});
