import { afterEach, describe, expect, it, vi } from 'vitest';
import { ycAdapter, batchToApproxDate } from '../sourcing/adapters/ycombinator';
import { queryTermsFor, resolveQueryTerm, strategyCoverage } from '../sourcing/verticalQueries';
import { discoveryQuerySchema, type DiscoveryQuery } from '../../shared/discovery';
import { CORE_VERTICAL_IDS } from '../../src/data/taxonomy';

afterEach(() => vi.unstubAllGlobals());

function q(over: Partial<DiscoveryQuery> = {}): DiscoveryQuery {
  return discoveryQuerySchema.parse({ sources: ['yc'], ...over });
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const DIRECTORY = {
  companies: [
    { name: 'Brexlike', batch: 'W17', oneLiner: 'Corporate cards.', slug: 'brexlike', status: 'Active' },
    { name: 'Oldtimer', batch: 'S09', oneLiner: 'An old alumnus.', slug: 'oldtimer', status: 'Active' },
    { name: 'Freshco', batch: 'S26', oneLiner: 'A new company.', slug: 'freshco', status: 'Active' },
    { name: 'Recentco', batch: 'W25', oneLiner: 'Also recent.', slug: 'recentco', status: 'Active' },
    { name: 'Undated', batch: null, oneLiner: 'No batch published.', slug: 'undated', status: 'Active' },
    { name: 'Deadco', batch: 'S25', oneLiner: 'Shut down.', slug: 'deadco', status: 'Inactive' },
  ],
};

describe('per-vertical query strategy', () => {
  it('covers all five approved verticals', () => {
    const covered = strategyCoverage().map((s) => s.vertical).sort();
    expect(covered).toEqual([...CORE_VERTICAL_IDS].sort());
  });

  it('gives every vertical source-specific terms for the live discovery sources', () => {
    for (const vertical of CORE_VERTICAL_IDS) {
      for (const source of ['yc', 'grants', 'research', 'funding-news', 'investor-news', 'github'] as const) {
        expect(queryTermsFor(vertical, source).length, `${vertical}/${source}`).toBeGreaterThan(0);
      }
    }
  });

  it('asks for evidence of demand rather than for lists of "AI startups"', () => {
    const allTerms = strategyCoverage().flatMap((s) => s.sources.flatMap((src) => queryTermsFor(s.vertical, src)));
    expect(allTerms.length).toBeGreaterThan(50);
    // The specific anti-pattern this table replaced.
    for (const t of allTerms) {
      expect(t.toLowerCase(), t).not.toMatch(/^ai (?:startup|compan)/);
      expect(t.toLowerCase(), t).not.toBe('ai');
    }
    // And a meaningful share point at commercial or institutional proof.
    const evidenceWords = /customer|pilot|contract|deployment|deploy|trial|grant|spin-?out|clearance|partnership|demonstration|award/i;
    const withEvidence = allTerms.filter((t) => evidenceWords.test(t)).length;
    expect(withEvidence / allTerms.length).toBeGreaterThan(0.3);
  });

  it('lets an explicit user term win over the strategy table', () => {
    expect(resolveQueryTerm(['my own search'], 'health', 'yc', 'fallback')).toBe('my own search');
    expect(resolveQueryTerm([], 'health', 'yc', 'fallback')).toBe(queryTermsFor('health', 'yc')[0]);
    expect(resolveQueryTerm([], null, 'yc', 'fallback')).toBe('fallback');
  });
});

describe('YC adapter batch-recency gate', () => {
  it('maps batch codes onto approximate dates', () => {
    expect(batchToApproxDate('W17')).toBe('2017-01-01');
    expect(batchToApproxDate('S26')).toBe('2026-06-01');
    expect(batchToApproxDate(null)).toBeNull();
    expect(batchToApproxDate('nonsense')).toBeNull();
  });

  it('drops alumni from batches older than dateFrom', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DIRECTORY)));
    const out = await ycAdapter.run(q({ dateFrom: '2025-01-01' }), { maxApiCalls: 5, maxResults: 50 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const names = out.leads.map((l) => l.companyName);
    expect(names).toContain('Freshco');
    expect(names).toContain('Recentco');
    // The whole point: decade-old alumni stop entering the funnel.
    expect(names).not.toContain('Brexlike');
    expect(names).not.toContain('Oldtimer');
    expect(out.detail).toMatch(/dropped as alumni/);
  });

  it('KEEPS a company whose batch is unreadable — an unparseable code is a gap, not evidence of age', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DIRECTORY)));
    const out = await ycAdapter.run(q({ dateFrom: '2025-01-01' }), { maxApiCalls: 5, maxResults: 50 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.leads.map((l) => l.companyName)).toContain('Undated');
  });

  it('still drops inactive companies, and does so independently of the batch gate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DIRECTORY)));
    const out = await ycAdapter.run(q(), { maxApiCalls: 5, maxResults: 50 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.leads.map((l) => l.companyName)).not.toContain('Deadco');
  });

  it('applies no batch gate at all when the run sets no dateFrom', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DIRECTORY)));
    const out = await ycAdapter.run(q(), { maxApiCalls: 5, maxResults: 50 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Every active company, unchanged from the previous behaviour.
    expect(out.leads).toHaveLength(5);
  });

  it('uses the vertical strategy term when the caller supplied none', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ companies: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await ycAdapter.run(q({ vertical: 'sustainability' }), { maxApiCalls: 5, maxResults: 10 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(encodeURIComponent(queryTermsFor('sustainability', 'yc')[0]));
  });
});
