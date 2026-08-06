import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { researchFoundersForRecord } from '../services/enrichment';
import { buildResearchPlan } from '../enrichment/researchPlan';
import { clearPolitenessCacheForTests, RequestBudget } from '../sourcing/politeness';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

/**
 * Founder research for newly enriched candidates must go through the
 * EXISTING pipeline, not a second one. These tests pin both halves: the
 * shared code path is genuinely shared, and the research it produces
 * feeds the founder/team component and evidence completeness.
 *
 * All network access is mocked. Nothing here depends on the internet.
 */

const NOW = '2026-08-06T00:00:00.000Z';

beforeEach(() => clearPolitenessCacheForTests());
afterEach(() => vi.unstubAllGlobals());

const TEAM_PAGE = `<!doctype html><html><head><title>Gridline — team</title></head><body><main>
<h1>Team</h1>
<p>Ana Ruiz — Co-Founder &amp; CEO. Previously a transmission planning engineer at ERCOT for eight years.</p>
<p>Ben Osei — Co-Founder &amp; CTO. PhD in power systems; published at IEEE PES.</p>
<p>Carla Dean — Head of Sales.</p>
<p>Gridline is based in Austin, TX and builds interconnection software for utilities.</p>
</main></body></html>`;

const NO_TEAM_PAGE = `<!doctype html><html><head><title>Quietco</title></head><body><main>
<p>Quietco is building energy software. We will share more soon. Sign up for updates and we will
let you know when the product is available to customers in your region.</p>
</main></body></html>`;

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'fr-1', name: 'Gridline', website: 'https://gridline.example.com',
    accelerator: 'Y Combinator (S26)', city: 'Austin', state: 'TX',
    evidence: [], dealEvidence: [],
    ...over,
  } as Parameters<typeof researchFoundersForRecord>[0];
}

function stub(pages: Record<string, string>) {
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

describe('the founder pipeline is reused, not duplicated', () => {
  const src = (p: string[]) => readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', ...p),
    'utf8',
  );

  it('the candidate entry point lives in the same module as runEnrichment', () => {
    const enrichment = src(['services', 'enrichment.ts']);
    expect(enrichment).toContain('export async function researchFoundersForRecord');
    expect(enrichment).toContain('export async function runEnrichment');
    // Both call the SAME plan builder, family executor and verdict rule.
    expect((enrichment.match(/buildResearchPlan\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((enrichment.match(/researchFamily\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((enrichment.match(/deriveFounderStatus\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('no second founder extractor was introduced anywhere in sourcing', () => {
    // evidenceEnrichment.ts may READ a team page for company facts, but
    // founder STATUS (verified / candidate / conflicting / exhausted) is
    // decided in exactly one place.
    const evidence = src(['sourcing', 'evidenceEnrichment.ts']);
    expect(evidence).not.toContain('deriveFounderStatus');
    expect(evidence).not.toContain('buildResearchPlan');
  });

  it('uses the same ordered source families as the stored-company path', () => {
    const plans = buildResearchPlan(record() as never);
    expect(plans.map((p) => p.family)).toEqual([
      'company-site', 'sec-form-d', 'accelerator', 'investor-portfolio',
      'founder-announcement', 'funding-press', 'public-profile',
      'professional-profile', 'corporate-registry',
    ]);
  });
});

describe('researching founders for a candidate', () => {
  it('finds founders with a stated role and records the supporting text', async () => {
    stub({ 'gridline.example.com': TEAM_PAGE });
    const res = await researchFoundersForRecord(record(), { budget: new RequestBudget(6), at: NOW });

    const names = res.candidates.map((c) => c.fullName);
    expect(names).toContain('Ana Ruiz');
    expect(names).toContain('Ben Osei');
    for (const c of res.candidates) {
      expect(c.sourceUrl).toMatch(/^https?:\/\//);
      expect(c.supportingText.length).toBeGreaterThan(0);
      expect(c.sourceFamily).toBeTruthy();
      expect(c.confidence).toBeGreaterThan(0);
    }
  });

  it('does not return a non-founder listed on the same page', async () => {
    stub({ 'gridline.example.com': TEAM_PAGE });
    const res = await researchFoundersForRecord(record(), { budget: new RequestBudget(6), at: NOW });
    expect(res.candidates.map((c) => c.fullName)).not.toContain('Carla Dean');
  });

  it('records facts the same fetch established in passing', async () => {
    stub({ 'gridline.example.com': TEAM_PAGE });
    const res = await researchFoundersForRecord(record(), { budget: new RequestBudget(6), at: NOW });
    expect(res.siteText).toMatch(/interconnection software/);
  });

  it('returns an honest verdict — never a founder — when no page names one', async () => {
    stub({ 'quietco.example.com': NO_TEAM_PAGE });
    const res = await researchFoundersForRecord(
      record({ id: 'fr-2', name: 'Quietco', website: 'https://quietco.example.com', accelerator: null }),
      { budget: new RequestBudget(6), at: NOW },
    );
    expect(res.candidates).toHaveLength(0);
    expect(res.verdict.status).not.toBe('verified');
  });

  it('reports every family it attempted, including the ones with no URL on record', async () => {
    stub({ 'gridline.example.com': TEAM_PAGE });
    const res = await researchFoundersForRecord(record(), { budget: new RequestBudget(6), at: NOW });
    expect(res.attempts.length).toBe(9);
    const noUrl = res.attempts.filter((a) => a.outcome === 'no-source-url-known');
    expect(noUrl.length).toBeGreaterThan(0);
    for (const a of noUrl) expect(a.detail).toMatch(/no .* URL is on record|does not apply/i);
  });

  it('honours the shared request budget', async () => {
    const fetchMock = stub({ 'gridline.example.com': TEAM_PAGE });
    await researchFoundersForRecord(record(), { budget: new RequestBudget(2), at: NOW });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('never throws when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = await researchFoundersForRecord(record(), { budget: new RequestBudget(4), at: NOW });
    expect(res.candidates).toHaveLength(0);
    expect(res.verdict).toBeTruthy();
  });

  it('writes nothing to the database', async () => {
    stub({ 'gridline.example.com': TEAM_PAGE });
    const enrichment = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'services', 'enrichment.ts'),
      'utf8',
    );
    // The candidate entry point ends at the verdict; persistence belongs
    // to runEnrichment's apply path, which this deliberately skips.
    const fn = enrichment.slice(
      enrichment.indexOf('export async function researchFoundersForRecord'),
      enrichment.indexOf('export type { FoundCandidate }'),
    );
    expect(fn).not.toContain('upsertFounderCandidate');
    expect(fn).not.toContain('saveScore');
    expect(fn).not.toContain('startEnrichmentRun');
  });
});

describe('founder research feeds the official founder component', () => {
  /** Fold researched founders onto a company the way an import would. */
  const withFounders = (founders: { name: string; background: string }[]): Company => ({
    id: 'fr-score', name: 'Gridline', oneLiner: 'Grid software.',
    vertical: 'sustainability', subcategory: 'Smart grids', stage: 'Seed',
    city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 3,
    traction: { level: 6, note: 'Pilot confirmed. Source: https://x/y' },
    founders: founders.map((f) => ({ name: f.name, role: 'Unknown', background: f.background })),
    evidence: [{ claim: 'c', source: 's', url: 'https://example.com/1', date: '2026-07-20', type: 'News' }],
    flags: [], imported: true,
  } as unknown as Company);

  it('a placeholder founder leaves the component UNASSESSABLE', () => {
    const fit = scoreCompany(withFounders([{ name: 'Unknown founder', background: 'Unknown' }]), new Date(NOW));
    expect(fit.components.find((x) => x.key === 'founder')!.assessable).toBe(false);
    expect(fit.provisional).toBe(true);
  });

  it('researched founders with recorded background make it assessable and raise completeness', () => {
    const before = scoreCompany(withFounders([{ name: 'Unknown founder', background: 'Unknown' }]), new Date(NOW));
    const after = scoreCompany(withFounders([
      { name: 'Ana Ruiz', background: 'Previously a transmission planning engineer at ERCOT; founded a prior company.' },
      { name: 'Ben Osei', background: 'PhD in power systems; research scientist.' },
    ]), new Date(NOW));

    expect(after.components.find((x) => x.key === 'founder')!.assessable).toBe(true);
    expect(after.completeness).toBeGreaterThan(before.completeness);
    expect(after.components.find((x) => x.key === 'founder')!.points).toBeGreaterThan(0);
  });

  it('founder NAMES with no background stay unscored on experience — nothing is inferred', () => {
    const fit = scoreCompany(withFounders([
      { name: 'Ana Ruiz', background: 'Unknown — requires manual research' },
      { name: 'Ben Osei', background: 'Unknown — requires manual research' },
    ]), new Date(NOW));
    const founder = fit.components.find((x) => x.key === 'founder')!;
    // Named people are a real finding, so the component is assessable...
    expect(founder.assessable).toBe(true);
    // ...but only the count scores. No prior-founder or relevant-background
    // points are awarded from a name.
    expect(founder.points).toBe(4);
    expect(founder.rationale).toMatch(/2 founders/);
  });

  it('never derives a demographic attribute from founder research', () => {
    const enrichment = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'services', 'enrichment.ts'),
      'utf8',
    );
    const fn = enrichment.slice(
      enrichment.indexOf('export async function researchFoundersForRecord'),
      enrichment.indexOf('export type { FoundCandidate }'),
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['ethnicity', 'gender', 'latino', 'latina', 'hispanic', 'race', 'photo', 'headshot']) {
      expect(fn.toLowerCase()).not.toContain(banned);
    }
    // And mission alignment still requires explicit self-identification.
    const withResearchedFounders = scoreCompany(withFounders([
      { name: 'Ana Ruiz', background: 'Previously at ERCOT.' },
    ]), new Date(NOW));
    expect(withResearchedFounders.components.find((x) => x.key === 'mission')!.assessable).toBe(false);
  });
});
