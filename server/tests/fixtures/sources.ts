import { __setSourceRunnerForTests, type RawCandidate, type SourceRunResult } from '../../services/sources';
import type { CandidateEvidence, DiscoverySourceId } from '../../../shared/discovery';

/**
 * TEST FIXTURES ONLY. Deterministic, clearly-fictional discovery
 * candidates injected via __setSourceRunnerForTests so the pipeline
 * (normalize → validate → dedupe → import) can be tested without
 * network access. The running application has no simulated sources.
 */

const today = () => new Date().toISOString().slice(0, 10);

function ev(
  claim: string, source: string, url: string, confidence: number, notes = '',
  publishedAt: string | null = null,
): CandidateEvidence {
  return {
    claim, source, url, dateAccessed: today(), publishedAt,
    verificationStatus: 'Not verified', confidence, notes,
  };
}

export const FIXTURE_CANDIDATES: Record<string, RawCandidate[]> = {
  yc: [
    {
      companyName: 'Cosecha Labs (fictional)', website: 'https://cosecha-labs.example.com',
      pitch: 'Bilingual payroll advances for agricultural crews.', vertical: 'fintech',
      subcategory: 'Financial inclusion', stage: 'Seed', hqCity: 'Fresno', hqState: 'CA',
      foundingYear: 2025, founderNames: ['R. Delgado', 'P. Marín'], accelerator: 'YC (fixture cohort)',
      tractionSignals: ['Fixture directory listing'],
      evidence: [ev('Listed in fixture YC directory', 'Fixture: YC directory', 'https://example.com/fix/yc/cosecha', 0.55, 'Test fixture — no real YC call was made')],
      confidence: 0.55,
    },
    {
      companyName: 'Verdea Grid (fictional)', website: 'https://verdea-grid.example.com',
      pitch: 'Community-solar billing for small utilities.', vertical: 'sustainability',
      subcategory: 'Energy transition software', stage: 'Pre-seed', hqCity: 'Albuquerque', hqState: 'NM',
      foundingYear: 2026, founderNames: ['T. Vigil'],
      evidence: [ev('Listed in fixture YC directory', 'Fixture: YC directory', 'https://example.com/fix/yc/verdea', 0.5, 'Test fixture')],
      confidence: 0.5,
    },
  ],
  'funding-news': [
    {
      companyName: 'Anda Care (fictional)', website: 'https://anda-care.example.com',
      pitch: 'Home-care coordination for multigenerational households.', vertical: 'health',
      subcategory: 'Personalized care', stage: 'Seed', hqCity: 'San Antonio', hqState: 'TX',
      founderNames: ['L. Fuentes', 'M. Ochoa'], publicFunding: '$2.1M (fixture announcement)',
      mostRecentRound: 'Seed', fundingDate: '2026-06-12',
      evidence: [ev('Fixture funding announcement', 'Fixture: funding news', 'https://example.com/fix/news/anda', 0.6, 'Test fixture', '2026-06-12')],
      confidence: 0.6,
    },
  ],
  grants: [
    {
      companyName: 'Solar Cocina (fictional)', pitch: 'Induction retrofit kits for food trucks.',
      vertical: 'sustainability', subcategory: 'Energy transition software', stage: 'Pre-seed',
      hqCity: 'Portland', hqState: 'OR', founderNames: ['A. Reyes'],
      publicFunding: 'SBIR Phase I (fixture)',
      evidence: [ev('Fixture SBIR award', 'Fixture: grants', 'https://example.com/fix/grants/cocina', 0.6, 'Test fixture')],
      confidence: 0.6,
    },
  ],
  accelerators: [
    {
      companyName: 'Turno HQ (fictional)', website: 'https://turno-hq.example.com',
      pitch: 'Shift-swap and wage-access tools for hourly teams.', vertical: 'fow',
      subcategory: 'Hourly workforce tools', stage: 'Pre-seed', hqCity: 'Chicago', hqState: 'IL',
      founderNames: ['C. Baez', 'N. Salas'], accelerator: 'Techstars (fixture cohort)',
      evidence: [ev('Fixture accelerator cohort page', 'Fixture: accelerator directory', 'https://example.com/fix/acc/turno', 0.55, 'Test fixture')],
      confidence: 0.55,
    },
  ],
};

/** Route discovery source runs through the fixtures instead of the network. */
export function installFixtureSources(): void {
  __setSourceRunnerForTests(async (sourceId: DiscoverySourceId): Promise<SourceRunResult> => {
    if (sourceId === 'producthunt' || sourceId === 'licensed') {
      return { sourceId, mode: 'skipped', candidates: [], apiCalls: 0, detail: 'Skipped — requires authorized access. Never scraped.' };
    }
    if (sourceId === 'upload') {
      return { sourceId, mode: 'local', candidates: [], apiCalls: 0, detail: 'Uploaded rows enter through the Local CSV connector.' };
    }
    const fixtures = FIXTURE_CANDIDATES[sourceId] ?? [];
    return {
      sourceId,
      mode: 'simulated',
      candidates: fixtures,
      apiCalls: 0,
      detail: fixtures.length > 0
        ? `Test fixture: ${fixtures.length} fictional candidate(s). No external call was made.`
        : 'Test fixture: no fixture data for this source.',
    };
  });
}

export function uninstallFixtureSources(): void {
  __setSourceRunnerForTests(null);
}
