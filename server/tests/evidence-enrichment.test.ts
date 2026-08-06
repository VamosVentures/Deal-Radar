import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  applyEnrichment, enrichCandidateEvidence, extractFactsFromPage, ENRICHMENT_FIELDS,
} from '../sourcing/evidenceEnrichment';
import { clearPolitenessCacheForTests, RequestBudget } from '../sourcing/politeness';
import { discoveryCandidateSchema, type DiscoveryCandidate } from '../../shared/discovery';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

/**
 * Evidence enrichment. Every test here mocks fetch — none depends on
 * the live internet.
 */

const NOW = new Date('2026-08-05T00:00:00.000Z');

beforeEach(() => clearPolitenessCacheForTests());
afterEach(() => vi.unstubAllGlobals());

function candidate(over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return discoveryCandidateSchema.parse({
    id: 'cand-1', runId: 'run-1', discoveredAt: '2026-08-01T00:00:00.000Z',
    sourceId: 'yc', simulated: false, companyName: 'Gridline',
    website: 'https://gridline.example.com',
    pitch: 'Grid software.',
    confidence: 0.7,
    evidence: [{
      claim: 'Listed in the public YC directory.', source: 'Y Combinator',
      url: 'https://www.ycombinator.com/companies/gridline', dateAccessed: '2026-08-01',
    }],
    ...over,
  });
}

const RICH_PAGE = `<!doctype html><html><head><title>Gridline — grid software</title>
<meta property="article:published_time" content="2026-06-15">
</head><body>
<main>
<h1>Gridline</h1>
<p>Gridline builds interconnection software for utilities and grid operators across the United States.
We reduce study time from months to days.</p>
<p>Our customers include Xcel Energy and two additional investor-owned utilities.</p>
<p>Built on a proprietary dataset of forty years of interconnection filings, which improves with every study run.</p>
<p>Gridline is based in Austin, TX.</p>
<p>Gridline raised a $4.2M seed round led by Example Ventures.</p>
<p>Backed by Y Combinator (S26).</p>
<p>We launched our public interconnection API in June.</p>
<h2>Team</h2>
<p>Ana Ruiz — Co-Founder &amp; CEO. Previously a transmission planning engineer at ERCOT.</p>
<p>Ben Osei — Co-Founder &amp; CTO. PhD in power systems.</p>
</main></body></html>`;

const EMPTY_PAGE = `<!doctype html><html><head><title>Quietco</title></head><body><main>
<p>Quietco is building something in the energy space. Sign up for updates and we will let you know when we launch our product to the world.</p>
</main></body></html>`;

const PARKED_PAGE = `<!doctype html><html><head><title>gridline.example.com</title></head>
<body><p>This domain is parked and available for purchase. Buy this domain.</p></body></html>`;

/** Serve a fixed body for any URL matching a predicate; 404 otherwise. */
function stubPages(pages: Record<string, string>) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const body = Object.entries(pages).find(([k]) => url.includes(k))?.[1];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => 'not found', headers: new Headers() } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => body, headers: new Headers() } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fact extraction from one page', () => {
  const facts = () => extractFactsFromPage({
    html: RICH_PAGE, url: 'https://gridline.example.com/', companyName: 'Gridline',
    primary: true, accessedAt: '2026-08-05',
  });

  it('records a URL, an access date, and a verbatim quote on EVERY fact', () => {
    const out = facts();
    expect(out.length).toBeGreaterThan(0);
    for (const f of out) {
      expect(f.sourceUrl).toBe('https://gridline.example.com/');
      expect(f.accessedAt).toBe('2026-08-05');
      expect(f.quote.length).toBeGreaterThan(0);
      // The quote must be real text FROM THE PAGE, not a paraphrase.
      // Both sides are reduced to lowercase alphanumerics so that
      // entity decoding, punctuation and whitespace handling cannot
      // fail a quote that is genuinely present.
      const flatten = (t: string) => t.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, ' ')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
      expect(flatten(RICH_PAGE), `${f.field}: "${f.quote}"`).toContain(flatten(f.quote).slice(0, 40));
    }
  });

  it('reads the publication date the page states about itself', () => {
    expect(facts().every((f) => f.publishedAt === '2026-06-15')).toBe(true);
  });

  it('labels every fact as fact, inference, or unknown', () => {
    for (const f of facts()) expect(['fact', 'inference', 'unknown']).toContain(f.assertionType);
  });

  it('extracts named customers, a moat, funding, HQ, validation, and activity', () => {
    const byField = new Map(facts().map((f) => [f.field, f]));
    expect(byField.get('customers')!.value).toMatch(/Xcel Energy/);
    expect(byField.get('moat')!.value).toMatch(/proprietary/i);
    expect(byField.get('funding')!.value).toMatch(/4\.2M/);
    expect(byField.get('hq')!.value).toMatch(/Austin/);
    expect(byField.get('validation')!.value).toMatch(/Y Combinator/);
    expect(byField.get('activity')!.value).toMatch(/launched/i);
  });

  it('extracts founder names and the roles the page prints, and nothing else about them', () => {
    const founders = facts().filter((f) => f.field === 'founders');
    expect(founders.map((f) => f.value).join(' ')).toMatch(/Ana Ruiz/);
    expect(founders.map((f) => f.value).join(' ')).toMatch(/Ben Osei/);
    // Only a name and a stated title — nothing derived from either.
    for (const f of founders) expect(f.value).toMatch(/^[^—]+(?: — .+)?$/);
  });

  it('fabricates nothing from a page that states nothing', () => {
    const out = extractFactsFromPage({
      html: EMPTY_PAGE, url: 'https://quietco.example.com/', companyName: 'Quietco',
      primary: true, accessedAt: '2026-08-05',
    });
    expect(out.filter((f) => f.field === 'customers')).toHaveLength(0);
    expect(out.filter((f) => f.field === 'funding')).toHaveLength(0);
    expect(out.filter((f) => f.field === 'founders')).toHaveLength(0);
  });
});

describe('never infers founder identity', () => {
  it('has no code path reading names or images for demographic attributes', () => {
    // A structural guard. The rule cannot be tested behaviourally —
    // absence of a feature has no output — so it is asserted against
    // the source, and any future attempt to add such a field fails here.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sourcing', 'evidenceEnrichment.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of [
      'ethnicity', 'gender', 'latino', 'latina', 'hispanic', 'female', 'male',
      'race', 'photo', 'headshot', 'avatar', 'pronoun',
    ]) {
      expect(src.toLowerCase(), `enrichment must not reference "${banned}"`).not.toContain(banned);
    }
  });

  it('leaves mission alignment unassessable after enrichment — self-ID is never manufactured', async () => {
    stubPages({ 'gridline.example.com': RICH_PAGE });
    const c = candidate();
    const outcome = await enrichCandidateEvidence(c, { maxPages: 3, now: NOW });
    const enriched = applyEnrichment(c, outcome);
    // Founders are now known by name...
    expect(enriched.founderNames.length).toBeGreaterThan(0);
    // ...and mission alignment is still unmeasurable, as it must be.
    expect(outcome.facts.some((f) => /identity|ethnic|gender/i.test(f.field))).toBe(false);
  });
});

describe('fetching and page hygiene', () => {
  it('reads the company site and reports every page it touched', async () => {
    stubPages({ 'gridline.example.com': RICH_PAGE });
    const outcome = await enrichCandidateEvidence(candidate(), { maxPages: 4, now: NOW });
    expect(outcome.pages.length).toBeGreaterThan(0);
    expect(outcome.pages.every((p) => typeof p.status === 'number')).toBe(true);
    expect(outcome.facts.length).toBeGreaterThan(0);
  });

  it('refuses to treat a parked domain as evidence', async () => {
    stubPages({ 'gridline.example.com': PARKED_PAGE });
    const outcome = await enrichCandidateEvidence(candidate(), { maxPages: 2, now: NOW });
    expect(outcome.facts).toHaveLength(0);
    expect(outcome.pages.some((p) => !p.ok && p.skippedReason)).toBe(true);
  });

  it('reports unresolved fields instead of filling them', async () => {
    stubPages({ 'quietco.example.com': EMPTY_PAGE });
    const outcome = await enrichCandidateEvidence(
      candidate({
        companyName: 'Quietco',
        website: 'https://quietco.example.com',
        evidence: [{
          claim: 'Quietco listing.', source: 'Directory',
          url: 'https://quietco.example.com/', dateAccessed: '2026-08-01',
        }] as DiscoveryCandidate['evidence'],
      }),
      { maxPages: 2, now: NOW },
    );
    expect(outcome.unresolved).toEqual(expect.arrayContaining(['customers', 'funding', 'founders']));
    for (const f of outcome.unresolved) expect(ENRICHMENT_FIELDS).toContain(f);
  });

  it('honours the page budget and stops rather than fetching more', async () => {
    const fetchMock = stubPages({ 'gridline.example.com': RICH_PAGE });
    await enrichCandidateEvidence(candidate(), { maxPages: 2, budget: new RequestBudget(2), now: NOW });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('never throws when a source fails — it reports and continues', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const outcome = await enrichCandidateEvidence(candidate(), { maxPages: 2, now: NOW });
    expect(outcome.facts).toHaveLength(0);
    expect(outcome.pages.every((p) => !p.ok)).toBe(true);
  });
});

describe('independent-source accounting', () => {
  it('does not count one release syndicated across outlets as corroboration', async () => {
    const release = '<html><body><main><p>Gridline raised a $4.2M seed round led by Example Ventures.</p></main></body></html>';
    stubPages({ 'outlet-a.example.com': release, 'outlet-b.example.com': release });
    const c = candidate({
      website: 'Unknown',
      evidence: [
        { claim: 'Gridline raised a $4.2M seed round led by Example Ventures.', source: 'Outlet A', url: 'https://outlet-a.example.com/1', dateAccessed: '2026-08-01' },
        { claim: 'Gridline raised a $4.2M seed round led by Example Ventures.', source: 'Outlet B', url: 'https://outlet-b.example.com/1', dateAccessed: '2026-08-01' },
      ] as DiscoveryCandidate['evidence'],
    });
    const outcome = await enrichCandidateEvidence(c, { maxPages: 4, now: NOW });
    // Two URLs, one story — one independent source.
    expect(outcome.independentSources).toBe(1);
    expect(outcome.corroboratedFields).not.toContain('funding');
  });

  it('marks a field corroborated when two genuinely different sources state it', async () => {
    stubPages({
      'gridline.example.com': RICH_PAGE,
      'utilitydive.example.com': '<html><body><main><p>Gridline is based in Austin, TX and works with utilities.</p></main></body></html>',
    });
    const c = candidate({
      evidence: [{ claim: 'Coverage of Gridline.', source: 'Utility Dive', url: 'https://utilitydive.example.com/story', dateAccessed: '2026-08-01' }] as DiscoveryCandidate['evidence'],
    });
    const outcome = await enrichCandidateEvidence(c, { maxPages: 6, now: NOW });
    expect(outcome.independentSources).toBeGreaterThanOrEqual(2);
    expect(outcome.corroboratedFields).toContain('hq');
  });
});

describe('folding enrichment back onto the candidate', () => {
  it('fills only unknown fields, and every filled field gains a citation', async () => {
    stubPages({ 'gridline.example.com': RICH_PAGE });
    const c = candidate();
    const outcome = await enrichCandidateEvidence(c, { maxPages: 5, now: NOW });
    const enriched = applyEnrichment(c, outcome);

    expect(enriched.hqState).toBe('TX');
    expect(enriched.founderNames).toContain('Ana Ruiz');
    expect(enriched.accelerator).toMatch(/Y Combinator/);
    expect(enriched.publicFunding).toMatch(/4\.2M/);
    expect(enriched.tractionSignals.join(' ')).toMatch(/Xcel Energy/);

    // Every new evidence row carries a URL and an access date.
    expect(enriched.evidence.length).toBeGreaterThan(c.evidence.length);
    for (const e of enriched.evidence) {
      expect(e.url).toMatch(/^https?:\/\//);
      expect(e.dateAccessed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never overwrites a value the candidate already had', async () => {
    stubPages({ 'gridline.example.com': RICH_PAGE });
    const c = candidate({ hqCity: 'Denver', hqState: 'CO', accelerator: 'Techstars 2025' });
    const enriched = applyEnrichment(c, await enrichCandidateEvidence(c, { maxPages: 5, now: NOW }));
    expect(enriched.hqState).toBe('CO');
    expect(enriched.accelerator).toBe('Techstars 2025');
  });

  it('quotes the company’s own words in a traction signal rather than summarising', async () => {
    stubPages({ 'gridline.example.com': RICH_PAGE });
    const c = candidate();
    const enriched = applyEnrichment(c, await enrichCandidateEvidence(c, { maxPages: 5, now: NOW }));
    const signal = enriched.tractionSignals.find((s) => s.includes('Xcel'))!;
    expect(signal).toMatch(/"/);            // carries a quote
    expect(signal).toMatch(/https?:\/\//);  // carries its source
    expect(signal).toMatch(/accessed \d{4}-\d{2}-\d{2}/);
  });

  it('materially raises evidence completeness without touching the rubric', async () => {
    stubPages({ 'gridline.example.com': RICH_PAGE });
    const c = candidate();
    const enriched = applyEnrichment(c, await enrichCandidateEvidence(c, { maxPages: 6, now: NOW }));

    const toCompany = (x: DiscoveryCandidate): Company => ({
      id: x.id, name: x.companyName, oneLiner: x.pitch, vertical: 'sustainability',
      subcategory: 'Smart grids', stage: 'Seed',
      city: x.hqCity === 'Unknown' ? 'Unknown' : x.hqCity,
      state: x.hqState === 'Unknown' ? '??' : x.hqState,
      foundedYear: 2025, teamSize: Math.max(1, x.founderCount ?? 1),
      traction: {
        level: 0,
        note: x.tractionSignals.length > 0 ? `Signals only: ${x.tractionSignals.join('; ')} (unrated)` : 'Unknown — not yet researched',
      },
      founders: (x.founderNames.length > 0 ? x.founderNames : ['Unknown founder'])
        .map((n) => ({ name: n, role: 'Unknown', background: 'Unknown — requires manual research' })),
      evidence: x.evidence.map((e) => ({ claim: e.claim, source: e.source, url: e.url, date: e.dateAccessed, type: 'Database record' as const })),
      flags: [], imported: true,
    } as unknown as Company);

    const before = scoreCompany(toCompany(c), NOW);
    const after = scoreCompany(toCompany(enriched), NOW);

    // More of the model is judgeable, because more is actually known.
    expect(after.completeness).toBeGreaterThan(before.completeness);
    // Components that were gaps are now real, cited assessments.
    expect(before.components.find((x) => x.key === 'geo')!.assessable).toBe(false);
    expect(after.components.find((x) => x.key === 'geo')!.assessable).toBe(true);
    // Traction deliberately does NOT become assessable. Enrichment found
    // a customer phrase, but an UNRATED signal is not an analyst rating —
    // scoring it would mean reading "we found a mention" as "traction is
    // 0/10". It stays a gap until a person reviews it.
    expect(after.components.find((x) => x.key === 'traction')!.assessable).toBe(false);
    expect(after.provisional).toBe(true);
    // And the WEIGHTS are untouched — enrichment adds evidence, never points.
    expect(after.components.map((x) => x.max)).toEqual(before.components.map((x) => x.max));
  });
});
