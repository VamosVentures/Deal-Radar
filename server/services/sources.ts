import { integrationModeForcedMock } from '../env';
import { fetchWithTimeout } from '../lib/http';
import type { CandidateEvidence, DiscoveryQuery, DiscoverySourceId } from '../../shared/discovery';

/**
 * Discovery source adapters. Each adapter returns RAW candidates that
 * the discovery pipeline normalizes and validates. Rules:
 * - Public, authorized sources only. LinkedIn / PitchBook / Crunchbase
 *   are never fetched; licensed data only runs with user credentials.
 * - Unknown facts stay unknown — adapters never invent fields.
 * - Live adapters run only outside forced-mock mode; every result is
 *   labeled with the mode that actually produced it.
 */

export interface RawCandidate {
  companyName: string;
  website?: string;
  pitch?: string;
  vertical?: 'health' | 'fintech' | 'fow' | 'sustainability' | 'aoi';
  subcategory?: string;
  stage?: 'Pre-seed' | 'Seed' | 'Series A' | 'Stealth';
  hqCity?: string;
  hqState?: string;
  foundingYear?: number;
  founderNames?: string[];
  accelerator?: string;
  publicFunding?: string;
  mostRecentRound?: string;
  fundingDate?: string;
  tractionSignals?: string[];
  evidence: CandidateEvidence[];
  confidence: number;
}

export interface SourceRunResult {
  sourceId: DiscoverySourceId;
  mode: 'live' | 'local' | 'simulated' | 'failed' | 'skipped';
  candidates: RawCandidate[];
  apiCalls: number;
  detail: string;
}

export interface SourceMeta {
  id: DiscoverySourceId;
  name: string;
  liveCapable: boolean;
  needs: string;
}

export const SOURCE_META: SourceMeta[] = [
  { id: 'yc', name: 'Y Combinator public directory', liveCapable: true, needs: 'Outbound network to the public YC API. No login.' },
  { id: 'accelerators', name: 'Accelerator & fellowship sites', liveCapable: false, needs: 'Per-program adapters — simulated until configured.' },
  { id: 'websites', name: 'Company websites', liveCapable: true, needs: 'Outbound network to candidate domains (used for verification, not discovery).' },
  { id: 'funding-news', name: 'Public funding announcements', liveCapable: false, needs: 'News feed adapters — simulated until configured.' },
  { id: 'sec', name: 'SEC EDGAR (Form D)', liveCapable: true, needs: 'Outbound network to efts.sec.gov with a User-Agent.' },
  { id: 'github', name: 'GitHub public API', liveCapable: true, needs: 'Nothing (unauthenticated; low rate limits).' },
  { id: 'grants', name: 'Government grants', liveCapable: false, needs: 'Grants.gov/SBIR adapters — simulated until configured.' },
  { id: 'patents', name: 'Patent databases', liveCapable: false, needs: 'USPTO adapter — simulated until configured.' },
  { id: 'research', name: 'Public research publications', liveCapable: false, needs: 'arXiv/PubMed adapters — simulated until configured.' },
  { id: 'hackathons', name: 'Hackathon & demo-day sites', liveCapable: false, needs: 'Per-event adapters — simulated until configured.' },
  { id: 'producthunt', name: 'Product Hunt (authorized only)', liveCapable: false, needs: 'PRODUCTHUNT_TOKEN — refuses to run without authorized access.' },
  { id: 'registries', name: 'State company registries', liveCapable: false, needs: 'Per-state adapters where legally appropriate — simulated until configured.' },
  { id: 'upload', name: 'User-uploaded CSV/JSON', liveCapable: true, needs: 'Nothing — use the Local CSV connector; discovery treats those rows as already imported.' },
  { id: 'licensed', name: 'Licensed data (authorized credentials)', liveCapable: false, needs: 'Vamos-supplied licensed credentials. Never scraped.' },
];

const today = () => new Date().toISOString().slice(0, 10);

function ev(claim: string, source: string, url: string, confidence: number, notes = ''): CandidateEvidence {
  return { claim, source, url, dateAccessed: today(), verificationStatus: 'Not verified', confidence, notes };
}

// ── Simulated fixtures (deterministic, clearly fictional) ────────

const SIM: Record<string, RawCandidate[]> = {
  yc: [
    {
      companyName: 'Cosecha Labs (fictional)', website: 'https://cosecha-labs.example.com',
      pitch: 'Bilingual payroll advances for agricultural crews.', vertical: 'fintech',
      subcategory: 'Financial inclusion', stage: 'Seed', hqCity: 'Fresno', hqState: 'CA',
      foundingYear: 2025, founderNames: ['R. Delgado', 'P. Marín'], accelerator: 'YC (simulated cohort)',
      tractionSignals: ['Simulated directory listing'],
      evidence: [ev('Listed in simulated YC directory fixture', 'Simulated: YC directory', 'https://example.com/sim/yc/cosecha', 0.55, 'Local Mode fixture — no real YC call was made')],
      confidence: 0.55,
    },
    {
      companyName: 'Verdea Grid (fictional)', website: 'https://verdea-grid.example.com',
      pitch: 'Community-solar billing for small utilities.', vertical: 'sustainability',
      subcategory: 'Energy transition software', stage: 'Pre-seed', hqCity: 'Albuquerque', hqState: 'NM',
      foundingYear: 2026, founderNames: ['T. Vigil'],
      evidence: [ev('Listed in simulated YC directory fixture', 'Simulated: YC directory', 'https://example.com/sim/yc/verdea', 0.5, 'Local Mode fixture')],
      confidence: 0.5,
    },
  ],
  'funding-news': [
    {
      companyName: 'Anda Care (fictional)', website: 'https://anda-care.example.com',
      pitch: 'Home-care coordination for multigenerational households.', vertical: 'health',
      subcategory: 'Personalized care', stage: 'Seed', hqCity: 'San Antonio', hqState: 'TX',
      founderNames: ['L. Fuentes', 'M. Ochoa'], publicFunding: '$2.1M (simulated announcement)',
      mostRecentRound: 'Seed', fundingDate: '2026-06-12',
      evidence: [ev('Simulated funding announcement fixture', 'Simulated: funding news', 'https://example.com/sim/news/anda', 0.6, 'Local Mode fixture')],
      confidence: 0.6,
    },
  ],
  grants: [
    {
      companyName: 'Solar Cocina (fictional)', pitch: 'Induction retrofit kits for food trucks.',
      vertical: 'sustainability', subcategory: 'Energy transition software', stage: 'Pre-seed',
      hqCity: 'Portland', hqState: 'OR', founderNames: ['A. Reyes'],
      publicFunding: 'SBIR Phase I (simulated)',
      evidence: [ev('Simulated SBIR award fixture', 'Simulated: grants', 'https://example.com/sim/grants/cocina', 0.6, 'Local Mode fixture')],
      confidence: 0.6,
    },
  ],
  accelerators: [
    {
      companyName: 'Turno HQ (fictional)', website: 'https://turno-hq.example.com',
      pitch: 'Shift-swap and wage-access tools for hourly teams.', vertical: 'fow',
      subcategory: 'Hourly workforce tools', stage: 'Pre-seed', hqCity: 'Chicago', hqState: 'IL',
      founderNames: ['C. Baez', 'N. Salas'], accelerator: 'Techstars (simulated cohort)',
      evidence: [ev('Simulated accelerator cohort page fixture', 'Simulated: accelerator directory', 'https://example.com/sim/acc/turno', 0.55, 'Local Mode fixture')],
      confidence: 0.55,
    },
  ],
};
// Sources with no fixture return zero simulated results (honest empty).

// ── Live adapters ────────────────────────────────────────────────

async function liveYc(q: DiscoveryQuery, budgetCalls: number): Promise<SourceRunResult> {
  try {
    const term = q.terms[0] ?? q.subcategory ?? q.vertical ?? 'startup';
    const res = await fetchWithTimeout(
      `https://api.ycombinator.com/v0.1/companies?q=${encodeURIComponent(term)}`,
      { headers: { 'User-Agent': 'vamos-deal-radar' } }, 8000,
    );
    if (!res.ok) return { sourceId: 'yc', mode: 'failed', candidates: [], apiCalls: 1, detail: `YC directory returned ${res.status}.` };
    const data = (await res.json()) as { companies?: { name: string; website?: string; one_liner?: string; batch?: string; team_size?: number }[] };
    const rows = (data.companies ?? []).slice(0, Math.min(q.maxResults, budgetCalls * 10));
    return {
      sourceId: 'yc', mode: 'live', apiCalls: 1,
      detail: `${rows.length} public YC directory entr${rows.length === 1 ? 'y' : 'ies'} for "${term}".`,
      candidates: rows.map((r) => ({
        companyName: r.name,
        website: r.website,
        pitch: r.one_liner,
        accelerator: `Y Combinator${r.batch ? ` (${r.batch})` : ''}`,
        evidence: [ev(`Listed in the public YC directory${r.batch ? `, batch ${r.batch}` : ''}`, 'Y Combinator public directory', `https://www.ycombinator.com/companies?q=${encodeURIComponent(r.name)}`, 0.7)],
        confidence: 0.7,
      })),
    };
  } catch (e) {
    return { sourceId: 'yc', mode: 'failed', candidates: [], apiCalls: 1, detail: `YC directory unreachable: ${(e as Error).message}` };
  }
}

async function liveGithub(q: DiscoveryQuery, _budgetCalls: number): Promise<SourceRunResult> {
  try {
    const term = [q.terms[0], q.subcategory].filter(Boolean).join(' ') || q.vertical || 'startup';
    const res = await fetchWithTimeout(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(term)}+created:%3E2025-01-01&sort=updated&per_page=${Math.min(q.maxResults, 10)}`,
      { headers: { 'User-Agent': 'vamos-deal-radar', Accept: 'application/vnd.github+json' } }, 8000,
    );
    if (!res.ok) return { sourceId: 'github', mode: 'failed', candidates: [], apiCalls: 1, detail: `GitHub search returned ${res.status}.` };
    const data = (await res.json()) as { items?: { name: string; html_url: string; description?: string; owner?: { login: string; type: string } }[] };
    const rows = (data.items ?? []).filter((r) => r.owner?.type === 'Organization');
    return {
      sourceId: 'github', mode: 'live', apiCalls: 1,
      detail: `${rows.length} recently active public GitHub org repositor${rows.length === 1 ? 'y' : 'ies'} matching "${term}". Engineering signal only — company facts stay Unknown.`,
      candidates: rows.map((r) => ({
        companyName: r.owner!.login,
        pitch: r.description ?? undefined,
        tractionSignals: [`Active public repository: ${r.name}`],
        evidence: [ev(`Public GitHub organization "${r.owner!.login}" has recent activity on ${r.name}`, 'GitHub public API', r.html_url, 0.4, 'Engineering signal; not proof a company exists')],
        confidence: 0.4,
      })),
    };
  } catch (e) {
    return { sourceId: 'github', mode: 'failed', candidates: [], apiCalls: 1, detail: `GitHub unreachable: ${(e as Error).message}` };
  }
}

async function liveSec(q: DiscoveryQuery, _budgetCalls: number): Promise<SourceRunResult> {
  try {
    const term = q.terms[0] ?? 'technology';
    const res = await fetchWithTimeout(
      `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(term)}&forms=D`,
      { headers: { 'User-Agent': 'vamos-deal-radar research contact@example.com' } }, 8000,
    );
    if (!res.ok) return { sourceId: 'sec', mode: 'failed', candidates: [], apiCalls: 1, detail: `SEC EDGAR returned ${res.status}.` };
    // Full parsing of EDGAR responses is a follow-up; reachability + honest zero-result is correct here.
    return { sourceId: 'sec', mode: 'live', candidates: [], apiCalls: 1, detail: 'SEC EDGAR reachable; Form D result parsing not yet mapped to candidates (0 imported, honestly).' };
  } catch (e) {
    return { sourceId: 'sec', mode: 'failed', candidates: [], apiCalls: 1, detail: `SEC EDGAR unreachable: ${(e as Error).message}` };
  }
}

// ── Adapter runner ───────────────────────────────────────────────

export async function runSource(sourceId: DiscoverySourceId, q: DiscoveryQuery, remainingApiCalls: number): Promise<SourceRunResult> {
  if (sourceId === 'producthunt') {
    return { sourceId, mode: 'skipped', candidates: [], apiCalls: 0, detail: 'Product Hunt runs only with authorized access (PRODUCTHUNT_TOKEN). Skipped — never scraped.' };
  }
  if (sourceId === 'licensed') {
    return { sourceId, mode: 'skipped', candidates: [], apiCalls: 0, detail: 'Licensed data requires Vamos-supplied credentials or a user-uploaded export. Skipped — never scraped.' };
  }
  if (sourceId === 'upload') {
    return { sourceId, mode: 'local', candidates: [], apiCalls: 0, detail: 'Uploaded CSV/JSON rows enter through the Local CSV connector and are already in the dataset.' };
  }
  if (remainingApiCalls <= 0) {
    return { sourceId, mode: 'skipped', candidates: [], apiCalls: 0, detail: 'API-call budget exhausted before this source ran.' };
  }

  const forcedMock = integrationModeForcedMock();
  if (!forcedMock) {
    if (sourceId === 'yc') return liveYc(q, remainingApiCalls);
    if (sourceId === 'github') return liveGithub(q, remainingApiCalls);
    if (sourceId === 'sec') return liveSec(q, remainingApiCalls);
  }

  const fixtures = SIM[sourceId] ?? [];
  return {
    sourceId,
    mode: 'simulated',
    candidates: fixtures,
    apiCalls: 0,
    detail: fixtures.length > 0
      ? `Local Mode: ${fixtures.length} clearly-fictional fixture candidate(s). No external call was made.`
      : 'Local Mode: no fixture data for this source; a real adapter is required for live results.',
  };
}
