import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { runSource } from '../sourcing';
import { discoveryQuerySchema, type DiscoveryQuery } from '../../shared/discovery';

/**
 * Tests for the two adapters added to close previously-honest gaps:
 * arXiv (public research publications) and Product Hunt (authorized
 * launches). Network is always stubbed — see server/tests/sourcing.test.ts
 * for the established pattern this file follows.
 */

const q = (over: Partial<DiscoveryQuery> = {}): DiscoveryQuery =>
  discoveryQuerySchema.parse({ sources: ['research'], ...over });

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/atom+xml' } });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => store.resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PRODUCTHUNT_TOKEN;
  vi.resetModules();
});

describe('arXiv (research) adapter', () => {
  it('creates a lead ONLY from a paper with a non-empty author affiliation, used verbatim', async () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
      <feed xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2601.00001v1</id>
          <title>Novel battery chemistry for grid storage</title>
          <summary>We present a new approach.</summary>
          <published>2026-01-05T00:00:00Z</published>
          <author><name>Jamie Rivera</name><arxiv:affiliation>Voltaic Grid Systems Inc</arxiv:affiliation></author>
          <author><name>Alex Kim</name></author>
        </entry>
        <entry>
          <id>http://arxiv.org/abs/2601.00002v1</id>
          <title>A survey of unrelated academic work</title>
          <summary>Survey only.</summary>
          <author><name>Some Professor</name></author>
        </entry>
      </feed>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(xmlResponse(xml)));
    const res = await runSource('research', q({ terms: ['battery'] }), 10);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(1);
    const c = res.candidates[0];
    expect(c.companyName).toBe('Voltaic Grid Systems Inc');
    expect(c.founderNames).toEqual(['Jamie Rivera']);
    expect(c.evidence[0].url).toBe('http://arxiv.org/abs/2601.00001v1');
    expect(c.confidence).toBeLessThan(0.5); // weak, unverified signal
  });

  it('an honest zero when no paper lists an affiliation — never guessed from an author name', async () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2601.00003v1</id>
          <title>Pure theory paper</title>
          <summary>No affiliations listed.</summary>
          <author><name>No Affiliation Here</name></author>
        </entry>
      </feed>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(xmlResponse(xml)));
    const res = await runSource('research', q(), 10);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(0);
    expect(res.detail).toMatch(/expected/i);
  });

  it('a non-feed body is an invalid-response failure, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not xml at all', { status: 200 })));
    const res = await runSource('research', q(), 10);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('invalid-response');
  });
});

describe('Product Hunt adapter', () => {
  it('is skipped (zero cost) without PRODUCTHUNT_TOKEN — never guesses at public data', async () => {
    const res = await runSource('producthunt', q({ sources: ['producthunt'] }), 10);
    expect(res.mode).toBe('skipped');
    expect(res.failureKind).toBe('missing-credentials');
    expect(res.apiCalls).toBe(0);
    expect(res.candidates).toHaveLength(0);
  });

  it('with a token configured, a real launch becomes a candidate', async () => {
    process.env.PRODUCTHUNT_TOKEN = 'test-ph-token';
    vi.resetModules();
    const { runSource: freshRunSource } = await import('../sourcing');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: {
        posts: {
          edges: [{
            node: {
              id: 'post-1',
              name: 'Acme Launcher',
              tagline: 'Ship things faster',
              url: 'https://www.producthunt.com/posts/acme-launcher',
              website: 'https://acmelauncher.example.com',
              votesCount: 42,
              createdAt: '2026-07-10T00:00:00Z',
              makers: [{ name: 'Dana Lee' }],
            },
          }],
        },
      },
    })));
    const res = await freshRunSource('producthunt', q({ sources: ['producthunt'] }), 10);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(1);
    const c = res.candidates[0];
    expect(c.companyName).toBe('Acme Launcher');
    expect(c.founderNames).toEqual(['Dana Lee']);
    expect(c.evidence[0].url).toBe('https://www.producthunt.com/posts/acme-launcher');
  });

  it('a real 401 (bad/expired token) is reported as a genuine failure, not silently skipped', async () => {
    process.env.PRODUCTHUNT_TOKEN = 'expired-token';
    vi.resetModules();
    const { runSource: freshRunSource } = await import('../sourcing');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'invalid token' }] }, 401)));
    const res = await freshRunSource('producthunt', q({ sources: ['producthunt'] }), 10);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('missing-credentials');
    expect(res.apiCalls).toBe(1);
  });
});
