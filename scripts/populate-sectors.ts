/**
 * Populate the dashboard with real, live-sourced companies — five per
 * sector — using only credential-free public sources.
 *
 * This is an operator script, not application code. It drives the same
 * runDiscovery pipeline the UI uses (same validation, same dedupe, same
 * evidence rules), then applies deterministic sector classification and
 * imports the top N per sector.
 *
 * Honesty rules it enforces:
 *  - Nothing is fabricated. Every imported company came back from a real
 *    HTTP response, with a real source URL.
 *  - A candidate whose published text does not clearly indicate the
 *    sector is NOT imported into it. If a sector cannot fill its quota
 *    from real matches, it is left short and the shortfall is reported.
 *  - Sources that fail (SBIR's 429, for instance) are reported as failed,
 *    never silently replaced with something else.
 *
 * Usage:
 *   npx tsx scripts/populate-sectors.ts [--per-sector 5] [--dry-run]
 */

import { runDiscovery, existingCandidates, importCandidates } from '../server/services/discovery';
import { classifyCandidate, matchesSector } from '../server/sourcing/classify';
import { listCompanies } from '../server/db/repos/companies';
import { VERTICALS } from '../src/data/taxonomy';
import type { VerticalId } from '../src/types';
import { MAX_SOURCES_PER_RUN, type DiscoveryQuery } from '../shared/discovery';

const args = process.argv.slice(2);
const PER_SECTOR = Number(args[args.indexOf('--per-sector') + 1]) || 5;
const DRY_RUN = args.includes('--dry-run');

/**
 * Search terms per sector. These drive the public-API queries; the
 * classifier still has to independently confirm each result, so a broad
 * term cannot pull an unrelated company into a sector.
 */
const SECTOR_TERMS: Record<VerticalId, string[]> = {
  health: ['healthcare', 'digital health', 'clinical'],
  fintech: ['fintech', 'payments', 'lending'],
  fow: ['future of work', 'workflow automation', 'hiring'],
  sustainability: ['climate tech', 'renewable energy', 'decarbonization'],
  robotics: ['robotics', 'autonomous robots', 'warehouse automation'],
  spacetech: ['space technology', 'satellite', 'earth observation'],
  ai: ['ai infrastructure', 'large language model', 'machine learning platform'],
  aoi: [], // catch-all: never sourced into directly
};

/** Credential-free adapters only. Product Hunt needs a token and is skipped. */
const SOURCES: DiscoveryQuery['sources'] = ['yc', 'github', 'funding-news', 'grants', 'research', 'sec'];

/**
 * A discovery run may query at most MAX_SOURCES_PER_RUN sources, so this
 * script sweeps its full source list in batches rather than asking for
 * all six at once.
 *
 * Same coverage and the same total number of third-party requests — the
 * cap bounds how wide any ONE run is, not how many runs an operator may
 * make. Batching here rather than exempting scripts from the rule keeps
 * a single enforcement point: the shared schema, which the server
 * applies to every caller regardless of which client built the request.
 */
function sourceBatches(): DiscoveryQuery['sources'][] {
  const batches: DiscoveryQuery['sources'][] = [];
  for (let i = 0; i < SOURCES.length; i += MAX_SOURCES_PER_RUN) {
    batches.push(SOURCES.slice(i, i + MAX_SOURCES_PER_RUN));
  }
  return batches;
}

const DAYS_90 = 90;
const DAYS_365 = 365;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function baseQuery(terms: string[], windowDays: number, sources: DiscoveryQuery['sources']): DiscoveryQuery {
  return {
    vertical: null, // classification happens after retrieval, not as a source filter
    subcategory: null,
    areasOfInterest: [],
    terms,
    geography: 'United States',
    states: [],
    stages: ['Pre-seed', 'Seed', 'Series A'],
    sources,
    dateFrom: isoDaysAgo(windowDays),
    dateTo: new Date().toISOString().slice(0, 10),
    maxResults: 20,
    maxApiCalls: 14,
    maxModelCalls: 0,
    maxEstimatedTokens: 0,
    minConfidence: 0,
    mode: 'all',
    minEvidenceRecencyDays: null,
    staleAfterDays: 30,
  } as DiscoveryQuery;
}

/**
 * One logical sweep across every source, executed as several
 * within-cap runs and merged back into a single run-shaped result.
 *
 * The counters are summed and the candidate lists concatenated, so the
 * report a caller reads describes the sweep as a whole rather than
 * whichever batch happened to run last. `status` takes the worst of the
 * batches: a sweep in which one batch failed is not a clean sweep, and
 * reporting it as one would hide a source that returned nothing.
 */
async function runBatched(terms: string[], windowDays: number, initiatedBy: string) {
  const runs = [];
  for (const sources of sourceBatches()) {
    runs.push(await runDiscovery(baseQuery(terms, windowDays, sources), initiatedBy));
  }
  const worst = runs.find((r) => r.status === 'Failed')
    ?? runs.find((r) => r.status === 'Completed with warnings')
    ?? runs[0];
  return {
    ...worst,
    discovered: runs.reduce((n, r) => n + r.discovered, 0),
    imported: runs.reduce((n, r) => n + r.imported, 0),
    rejectedByValidation: runs.reduce((n, r) => n + r.rejectedByValidation, 0),
    duplicatesSkipped: runs.reduce((n, r) => n + r.duplicatesSkipped, 0),
    errors: runs.flatMap((r) => r.errors),
    sourceResults: runs.flatMap((r) => r.sourceResults),
  };
}

interface SectorOutcome {
  vertical: VerticalId;
  name: string;
  windowUsed: string;
  retrieved: number;
  matched: number;
  imported: string[];
  skipReasons: string[];
  shortfall: number;
  sourceResults: { sourceId: string; mode: string; found: number; detail: string }[];
}

async function sourceSector(v: { id: VerticalId; name: string }): Promise<SectorOutcome> {
  const terms = SECTOR_TERMS[v.id];
  let windowUsed = 'last 90 days';
  let run = await runBatched(terms, DAYS_90, `populate:${v.id}`);

  // Rule: prefer the last 90 days; widen to 12 months only if a sector
  // cannot fill its quota. Widening is recorded, not hidden.
  let pending = existingCandidates().filter((c) => c.status === 'pending');
  let matches = pending.filter((c) => matchesSector({
    companyName: c.companyName, pitch: c.pitch ?? undefined,
    subcategory: c.subcategory ?? undefined,
    evidenceText: c.evidence.map((e) => e.claim).join(' '),
  }, v.id).ok);

  if (matches.length < PER_SECTOR) {
    windowUsed = 'widened to last 12 months (90 days was insufficient)';
    run = await runBatched(terms, DAYS_365, `populate:${v.id}:wide`);
    pending = existingCandidates().filter((c) => c.status === 'pending');
    matches = pending.filter((c) => matchesSector({
      companyName: c.companyName, pitch: c.pitch ?? undefined,
      subcategory: c.subcategory ?? undefined,
      evidenceText: c.evidence.map((e) => e.claim).join(' '),
    }, v.id).ok);
  }

  // Rank by the source's own confidence, then by how clearly the text
  // indicated the sector, then prefer candidates that have a website.
  const ranked = matches
    .map((c) => ({
      c,
      cls: classifyCandidate({
        companyName: c.companyName, pitch: c.pitch ?? undefined,
        subcategory: c.subcategory ?? undefined,
        evidenceText: c.evidence.map((e) => e.claim).join(' '),
      }),
    }))
    .sort((a, b) =>
      (b.c.confidence - a.c.confidence)
      || (b.cls.confidence - a.cls.confidence)
      || (Number(!!b.c.website) - Number(!!a.c.website)));

  // The same company legitimately arrives from several sources (YC and a
  // funding headline, say). The pipeline's dedupe works against ALREADY
  // IMPORTED companies; within one un-imported batch we still have to
  // collapse by normalized name, or a sector's five slots get spent on
  // two companies listed twice each.
  const seen = new Set<string>();
  const deduped = ranked.filter(({ c }) => {
    const key = c.companyName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, PER_SECTOR);

  const imported: string[] = [];
  const skipReasons: string[] = [];
  if (!DRY_RUN && deduped.length > 0) {
    const result = importCandidates({
      candidateIds: deduped.map((r) => r.c.id),
      actor: `populate:${v.id}`,
      duplicateAction: 'skip',
    });
    // Surface every refusal. Discarding these is what made a 100%
    // rejection rate look like a silent failure last time.
    for (const s of result.skipped) skipReasons.push(`${s.companyName ?? s.id}: [${s.code}] ${s.reason}`);
    for (const f of result.failed) skipReasons.push(`${f.companyName ?? f.id}: [failed] ${f.reason}`);
    imported.push(...deduped
      .filter((r) => result.imported.includes(r.c.id))
      .map((r) => r.c.companyName));
  }

  return {
    vertical: v.id,
    name: v.name,
    windowUsed,
    retrieved: pending.length,
    matched: matches.length,
    imported: DRY_RUN ? deduped.map((r) => r.c.companyName) : imported,
    skipReasons,
    shortfall: Math.max(0, PER_SECTOR - deduped.length),
    sourceResults: run.sourceResults.map((s) => ({
      sourceId: s.sourceId, mode: s.mode, found: s.found, detail: s.detail ?? '',
    })),
  };
}

const targets = VERTICALS.filter((v) => v.core); // the aoi catch-all is never sourced into

console.log(`Populating ${targets.length} sectors × ${PER_SECTOR} companies from live public sources`);
console.log(`Sources: ${SOURCES.join(', ')}${DRY_RUN ? '  [DRY RUN — nothing will be imported]' : ''}\n`);

const outcomes: SectorOutcome[] = [];
for (const v of targets) {
  process.stdout.write(`  ${v.name.padEnd(18)} … `);
  try {
    const o = await sourceSector(v);
    outcomes.push(o);
    console.log(`retrieved ${String(o.retrieved).padStart(3)}  matched ${String(o.matched).padStart(3)}  imported ${o.imported.length}${o.shortfall ? `  SHORT BY ${o.shortfall}` : ''}`);
  } catch (e) {
    console.log(`FAILED: ${(e as Error).message}`);
  }
}

console.log('\n── Per-sector detail ─────────────────────────────────────');
for (const o of outcomes) {
  console.log(`\n${o.name} (${o.vertical}) — ${o.windowUsed}`);
  for (const n of o.imported) console.log(`   ✓ ${n}`);
  for (const r of o.skipReasons) console.log(`   ✗ ${r}`);
  if (o.shortfall > 0) {
    console.log(`   ! Short by ${o.shortfall}. Only ${o.matched} candidate(s) in this run were confirmed to be ${o.vertical}. Not padded with unrelated companies.`);
  }
  const failed = o.sourceResults.filter((s) => s.mode === 'failed' || s.mode === 'skipped');
  for (const f of failed) console.log(`   · ${f.sourceId}: ${f.mode} — ${f.detail.slice(0, 100)}`);
}

const total = outcomes.reduce((n, o) => n + o.imported.length, 0);
console.log(`\n── Totals ────────────────────────────────────────────────`);
console.log(`Imported ${total} of a possible ${targets.length * PER_SECTOR}`);
console.log(`Companies now in the database: ${listCompanies().length}`);
if (DRY_RUN) console.log('(dry run — nothing was written)');
