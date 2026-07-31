import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { runSource } from '../sourcing';
import { leadEvidenceSchema } from '../sourcing/types';
import { extractFundingEvent, parseFeed } from '../sourcing/fundingEvent';
import { parseDisplayName } from '../sourcing/adapters/sec';
import { filingIndexUrl } from '../sourcing/formd';
import { clearPolitenessCacheForTests } from '../sourcing/politeness';
import { runDiscovery, existingCandidates } from '../services/discovery';
import { discoveryQuerySchema, type DiscoveryQuery } from '../../shared/discovery';

/**
 * Live-sourcing foundation tests. All network access is stubbed —
 * these tests verify validation, honest failure states, and that a
 * failing source NEVER falls back to fake records.
 */

const q = (over: Partial<DiscoveryQuery> = {}): DiscoveryQuery =>
  discoveryQuerySchema.parse({ sources: ['github'], ...over });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  store.resetForTests();
  // The politeness layer caches successful responses per URL for up to
  // 30 minutes. That is correct in production — it stops us re-hitting
  // someone else's free API — but across tests it would serve an earlier
  // test's success to a later test that stubbed a failure, so each test
  // starts with an empty cache and a clean per-host request queue.
  clearPolitenessCacheForTests();
});
afterEach(() => vi.unstubAllGlobals());

// ── Successful source validation ─────────────────────────────────

describe('successful source runs (validated external responses)', () => {
  it('GitHub: org repos become validated leads with real source URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      items: [
        { name: 'ledger-core', html_url: 'https://github.com/acme-labs/ledger-core', description: 'Ledger infra', pushed_at: '2026-07-01T00:00:00Z', owner: { login: 'acme-labs', type: 'Organization', html_url: 'https://github.com/acme-labs' } },
        { name: 'dotfiles', html_url: 'https://github.com/someuser/dotfiles', description: 'x', owner: { login: 'someuser', type: 'User', html_url: 'https://github.com/someuser' } },
      ],
    })));
    const res = await runSource('github', q(), 10);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(1); // user-owned repos are not company signals
    expect(res.candidates[0].companyName).toBe('acme-labs');
    expect(res.candidates[0].evidence[0].url).toBe('https://github.com/acme-labs/ledger-core');
    expect(res.candidates[0].confidence).toBeLessThan(0.5); // engineering signal only
  });

  it('SBIR: public award records become leads with amounts and locations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([
      { firm: 'Acme Diagnostics LLC', award_title: 'Point-of-care assay', agency: 'HHS', program: 'SBIR', phase: 'I', award_amount: '256,000', award_year: 2026, city: 'Albuquerque', state: 'NM', company_url: 'acmediagnostics.com', award_link: 'https://www.sbir.gov/awards/12345' },
    ])));
    const res = await runSource('grants', q({ sources: ['grants'] }), 10);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(1);
    const c = res.candidates[0];
    expect(c.companyName).toBe('Acme Diagnostics LLC');
    expect(c.hqState).toBe('NM');
    expect(c.publicFunding).toContain('256,000');
    expect(c.website).toBe('https://acmediagnostics.com');
    expect(c.evidence[0].url).toBe('https://www.sbir.gov/awards/12345');
  });

  it('SEC: Form D hits become leads pointing at real filing-index URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      hits: { hits: [
        { _id: '0001234567-26-000001:formd.xml', _source: { display_names: ['Acme Robotics Inc (CIK 0009876543)'], file_date: '2026-06-30', adsh: '0001234567-26-000001', ciks: ['0009876543'] } },
      ] },
    })));
    const res = await runSource('sec', q({ sources: ['sec'], terms: ['robotics'] }), 10);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].companyName).toBe('Acme Robotics Inc');
    expect(res.candidates[0].evidence[0].url).toBe('https://www.sec.gov/Archives/edgar/data/9876543/000123456726000001/0001234567-26-000001-index.htm');
  });

  it('RSS: only headlines that state a funding event become leads — no guessing', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title><![CDATA[Acme Robotics Raises $5M Seed Round to Expand]]></title><link>https://news.example.com/acme-5m</link><pubDate>Wed, 15 Jul 2026 12:00:00 GMT</pubDate></item>
      <item><title>Opinion: the future of robotics</title><link>https://news.example.com/opinion</link></item>
    </channel></rss>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 200 })));
    const res = await runSource('funding-news', q({ sources: ['funding-news'], maxApiCalls: 1 }), 1);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].companyName).toBe('Acme Robotics');
    expect(res.candidates[0].publicFunding).toContain('$5M');
    expect(res.candidates[0].evidence[0].url).toBe('https://news.example.com/acme-5m');
  });

  it('adapter output conforms to the LeadEvidence schema (and bad leads are rejected)', () => {
    const good = {
      sourceId: 'github', sourceName: 'GitHub public API', sourceType: 'api',
      sourceUrl: 'https://github.com/acme/repo', companyName: 'acme',
      evidenceText: 'Public repo activity.', discoveredAt: new Date().toISOString(), confidence: 0.4,
    };
    expect(leadEvidenceSchema.safeParse(good).success).toBe(true);
    expect(leadEvidenceSchema.safeParse({ ...good, sourceUrl: 'not-a-url' }).success).toBe(false); // no verifiable URL → rejected
    expect(leadEvidenceSchema.safeParse({ ...good, confidence: 2 }).success).toBe(false);
    expect(leadEvidenceSchema.safeParse({ ...good, evidenceText: '' }).success).toBe(false);
  });
});

// ── Empty responses ──────────────────────────────────────────────

describe('empty source responses', () => {
  it('GitHub with zero matches reports live with 0 candidates — honestly, no filler', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [] })));
    const res = await runSource('github', q(), 10);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(0);
    expect(res.detail).toContain('0 recently active');
  });

  it('RSS feed with no funding headlines yields 0 leads', async () => {
    const xml = `<rss><channel><item><title>A thoughtful essay</title><link>https://news.example.com/essay</link></item></channel></rss>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 200 })));
    const res = await runSource('funding-news', q({ sources: ['funding-news'], maxApiCalls: 1 }), 1);
    expect(res.mode).toBe('live');
    expect(res.candidates).toHaveLength(0);
  });
});

// ── Invalid responses ────────────────────────────────────────────

describe('invalid responses', () => {
  it('schema-mismatched JSON fails with invalid-response and zero candidates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: 'not-an-array' })));
    const res = await runSource('github', q(), 10);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('invalid-response');
    expect(res.candidates).toHaveLength(0);
  });

  it('non-JSON body fails with invalid-response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>maintenance</html>', { status: 200 })));
    const res = await runSource('grants', q({ sources: ['grants'] }), 10);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('invalid-response');
    expect(res.candidates).toHaveLength(0);
  });

  it('a body that is not an RSS feed fails with invalid-response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('plain text, no feed', { status: 200 })));
    const res = await runSource('funding-news', q({ sources: ['funding-news'], maxApiCalls: 1 }), 1);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('invalid-response');
  });
});

// ── Timeouts ─────────────────────────────────────────────────────

describe('timeouts', () => {
  it('an aborted request is reported as a timeout failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    const res = await runSource('sec', q({ sources: ['sec'] }), 10);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('timeout');
    expect(res.detail).toMatch(/timed out/i);
    expect(res.candidates).toHaveLength(0);
  });
});

// ── Rate limits ──────────────────────────────────────────────────

describe('rate limits', () => {
  it('GitHub 403 with exhausted rate-limit headers is reported as rate-limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })));
    const res = await runSource('github', q(), 10);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('rate-limited');
    expect(res.candidates).toHaveLength(0);
  });

  it('HTTP 429 is reported as rate-limited', async () => {
    // mockImplementation, not mockResolvedValue: the politeness layer
    // retries a plain 429, and a Response body can only be read once, so
    // a single shared Response instance would fail the second attempt
    // with "body already read" and be misreported as a network error.
    // A real server sends a fresh response per attempt.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ error: 'slow down' }, 429))));
    const res = await runSource('grants', q({ sources: ['grants'] }), 10);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('rate-limited');
  });
});

// ── Missing credentials ──────────────────────────────────────────

describe('missing credentials', () => {
  it('credential-gated sources are skipped, never scraped', async () => {
    const ph = await runSource('producthunt', q({ sources: ['producthunt'] }), 10);
    expect(ph.mode).toBe('skipped');
    expect(ph.failureKind).toBe('missing-credentials');
    expect(ph.candidates).toHaveLength(0);
    const lic = await runSource('licensed', q({ sources: ['licensed'] }), 10);
    expect(lic.mode).toBe('skipped');
    expect(lic.failureKind).toBe('missing-credentials');
  });

  it('a 401 from an API is classified as missing credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Bad credentials' }, 401)));
    const res = await runSource('github', q(), 10);
    expect(res.mode).toBe('failed');
    expect(res.failureKind).toBe('missing-credentials');
  });

  it('sources with no adapter are skipped with not-configured — zero results, zero simulation', async () => {
    const res = await runSource('patents', q({ sources: ['patents'] }), 10);
    expect(res.mode).toBe('skipped');
    expect(res.failureKind).toBe('not-configured');
    expect(res.candidates).toHaveLength(0);
    expect(res.detail).toMatch(/nothing was simulated/i);
  });
});

// ── No fallback to fake data ─────────────────────────────────────

describe('no fallback to fake data — ever', () => {
  it('a fully failed run discovers nothing and stores no candidates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const run = await runDiscovery({ sources: ['github', 'sec', 'grants'], maxResults: 20, maxApiCalls: 10 }, 'tester');
    expect(run.status).toBe('Failed');
    expect(run.discovered).toBe(0);
    expect(run.errors.length).toBeGreaterThan(0);
    expect(existingCandidates()).toHaveLength(0);
    // Nothing fictional or sample-shaped appears anywhere in the run record.
    const text = JSON.stringify(run).toLowerCase();
    for (const banned of ['fictional', 'sample', 'cosecha', 'verdea', 'anda care', 'solar cocina', 'turno']) {
      expect(text).not.toContain(banned);
    }
    expect(run.sourceResults.every((r) => r.mode === 'failed')).toBe(true);
    expect(run.sourceResults.every((r) => r.found === 0)).toBe(true);
  });

  it('every stored candidate carries at least one real source URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      items: [{ name: 'core', html_url: 'https://github.com/real-org/core', description: 'x', owner: { login: 'real-org', type: 'Organization', html_url: 'https://github.com/real-org' } }],
    })));
    await runDiscovery({ sources: ['github'], maxResults: 5, maxApiCalls: 5 }, 'tester');
    const cands = existingCandidates();
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.evidence.length).toBeGreaterThanOrEqual(1);
      for (const e of c.evidence) expect(e.url).toMatch(/^https?:\/\//);
    }
  });
});

// ── Pure helpers ─────────────────────────────────────────────────

describe('parsing helpers', () => {
  it('parses SEC display names and builds filing URLs', () => {
    expect(parseDisplayName('Acme Robotics Inc (CIK 0001234567)')).toEqual({ name: 'Acme Robotics Inc', cik: '0001234567' });
    expect(parseDisplayName('No CIK Here LLC')).toEqual({ name: 'No CIK Here LLC', cik: null });
    expect(filingIndexUrl('0001234567', '0009999999-26-000123')).toBe('https://www.sec.gov/Archives/edgar/data/1234567/000999999926000123/0009999999-26-000123-index.htm');
    expect(filingIndexUrl(null, '0009999999-26-000123')).toBeNull();
  });

  it('extracts funding facts only from headlines that state them', () => {
    const item = (title: string) => ({
      title, link: 'https://news.example.com/a', publishedAt: '2026-07-20T00:00:00.000Z',
      description: '', author: null, guid: null, categories: [] as string[], outboundLinks: [] as string[],
    });
    const acme = extractFundingEvent(item('Acme Robotics Raises $5M Seed Round'), '2026-07-25');
    expect(acme.ok).toBe(true);
    if (acme.ok) {
      expect(acme.event.companyName).toBe('Acme Robotics');
      expect(acme.event.amountUsd).toBe(5_000_000);
      expect(acme.event.roundType).toBe('Seed');
    }
    const verde = extractFundingEvent(item('Verde Lands $2.5 Million to fix the grid'), '2026-07-25');
    expect(verde.ok && verde.event.amountUsd).toBe(2_500_000);

    expect(extractFundingEvent(item('The state of venture in 2026'), '2026-07-25').ok).toBe(false);
    expect(extractFundingEvent(item('How Acme raised its team spirit'), '2026-07-25').ok).toBe(false);
  });

  it('parses RSS items and skips ones without a valid link', () => {
    const parsed = parseFeed('<rss><channel><item><title>T1</title><link>https://a.example.com/x</link></item><item><title>T2</title><link>not-a-url</link></item></channel></rss>');
    expect(parsed.format).toBe('rss');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].title).toBe('T1');
    expect(parsed.rejected.map((r) => r.code)).toContain('item-link-malformed');
  });
});
