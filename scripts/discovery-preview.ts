/**
 * Controlled, budget-capped sourcing validation.
 *
 * Runs the discovery pipeline TWICE per vertical against the same live
 * public sources — once with the pre-existing behaviour (baseline) and
 * once with this pass's improvements (improved) — and reports the
 * difference under the UNCHANGED Vamos Fit Score. Both runs are
 * `preview: true`, so neither writes a candidate, a run row, a company,
 * a score, a review decision or an id counter. Nothing is added to the
 * pipeline, no CRM stage moves, nothing syncs to HubSpot, and no
 * founder is contacted.
 *
 *   npm run discovery:preview                  # every vertical
 *   npm run discovery:preview -- health fintech
 *
 * Strongly recommended: point DATABASE_FILE at a COPY of the database
 * so even the run lock and audit ledger land somewhere disposable —
 *   DATABASE_FILE=/tmp/preview.db npm run discovery:preview
 *
 * The scores printed here are the real thing: each surviving candidate
 * is put through exactly the pipeline's own import path
 * (resolveVertical → candidateToImportedCompany) and then through
 * scoreCompany() with no modification whatsoever. A candidate that
 * cannot be scored honestly is reported as provisional, which is the
 * point — this script cannot make a number look better than the
 * evidence behind it.
 */
import {
  runDiscovery, resolveVertical, candidateToImportedCompany,
} from '../server/services/discovery';
import { scoreCompany } from '../src/lib/scoring';
import { assessQuality } from '../server/sourcing/qualitySignals';
import { applyEnrichment, enrichCandidateEvidence, type EnrichmentOutcome } from '../server/sourcing/evidenceEnrichment';
import { RequestBudget } from '../server/sourcing/politeness';
import { CORE_VERTICAL_IDS, verticalById } from '../src/data/taxonomy';
import { HOT_THRESHOLD } from '../shared/scoringThresholds';
import type { DiscoveryCandidate, DiscoverySourceId } from '../shared/discovery';
import type { Company, VerticalId } from '../src/types';

// ── Budget ───────────────────────────────────────────────────────
// Deliberately small and stated up front. Every source below is a
// key-free public endpoint, so the monetary cost is zero and the real
// budget is third-party request volume and politeness.
const SOURCES: DiscoverySourceId[] = ['yc', 'grants', 'funding-news'];
const MAX_API_CALLS_PER_RUN = 6;
const MAX_RESULTS_PER_RUN = 20;
/** Only YC batches from roughly the last 18 months are in scope. */
const BATCH_WINDOW_DAYS = 550;
/**
 * Evidence enrichment is the expensive stage, so it is spent on the
 * strongest eligible candidates only — that is what the triage priority
 * is FOR. Everything else keeps the evidence discovery gave it.
 */
const ENRICH_TOP_N = 12;
const ENRICH_PAGES_PER_CANDIDATE = 6;
const ENRICH_TOTAL_PAGE_BUDGET = 60;

const targets = (process.argv.slice(2).filter((a) => !a.startsWith('-')) as VerticalId[]);
const VERTICALS: VerticalId[] = targets.length > 0
  ? targets.filter((v) => (CORE_VERTICAL_IDS as string[]).includes(v))
  : [...CORE_VERTICAL_IDS];

const dateFrom = new Date(Date.now() - BATCH_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
const NOW = new Date();

interface Assessed {
  candidate: DiscoveryCandidate;
  vertical: VerticalId | null;
  reason: string;
  score: number | null;
  provisional: boolean | null;
  completeness: number | null;
  evidenceConfidence: number | null;
  components: { label: string; points: number; max: number; assessable: boolean; rationale: string }[];
  unscorable: string | null;
}

/**
 * Put a candidate through the pipeline's own import path and score it
 * with the official model. No shortcuts, no substitutions.
 */
function assess(c: DiscoveryCandidate): Assessed {
  const resolved = resolveVertical(c);
  const base: Assessed = {
    candidate: c, vertical: resolved.vertical, reason: resolved.reason,
    score: null, provisional: null, completeness: null, evidenceConfidence: null,
    components: [], unscorable: null,
  };
  if (!resolved.vertical) return { ...base, unscorable: resolved.reason };
  const company = candidateToImportedCompany(c, resolved.vertical);
  if (!company.success) return { ...base, unscorable: company.reason };
  const fit = scoreCompany(company.value as unknown as Company, NOW);
  return {
    ...base,
    score: fit.score,
    provisional: fit.provisional,
    completeness: fit.completeness,
    evidenceConfidence: fit.evidenceConfidence,
    components: fit.components.map((x) => ({
      label: x.label, points: x.points, max: x.max, assessable: x.assessable, rationale: x.rationale,
    })),
  };
}

interface RunMetrics {
  label: string;
  fetched: number;
  /** Candidates that actually reached the review queue (fetched minus anything dropped). */
  surviving: number;
  eligible: number;
  duplicates: number;
  filteredByThesis: number;
  filteredByQuality: number;
  rejectedByValidation: number;
  scorable: number;
  provisional: number;
  medianScore: number | null;
  topQuartileScore: number | null;
  maxScore: number | null;
  atOrAboveThreshold: number;
  medianEvidenceItems: number;
  medianIndependentSources: number;
  apiCalls: number;
  durationMs: number;
  warnings: string[];
}

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

function metrics(label: string, runs: Awaited<ReturnType<typeof runDiscovery>>[], assessed: Assessed[]): RunMetrics {
  const scores = assessed.map((a) => a.score).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const evidenceCounts = assessed.map((a) => a.candidate.evidence.length);
  const indep = assessed.map((a) => a.candidate.independentSources);
  return {
    label,
    fetched: runs.reduce((s, r) => s + r.discovered + r.filteredByThesis + r.filteredByQuality, 0),
    surviving: assessed.length,
    eligible: assessed.filter((a) => a.candidate.thesisEligible !== false).length,
    duplicates: runs.reduce((s, r) => s + r.duplicatesIdentified, 0),
    filteredByThesis: runs.reduce((s, r) => s + r.filteredByThesis, 0),
    filteredByQuality: runs.reduce((s, r) => s + r.filteredByQuality, 0),
    rejectedByValidation: runs.reduce((s, r) => s + r.rejectedByValidation, 0),
    scorable: scores.length,
    provisional: assessed.filter((a) => a.provisional === true).length,
    medianScore: quantile(scores, 0.5),
    topQuartileScore: quantile(scores, 0.75),
    maxScore: scores.length > 0 ? scores[scores.length - 1] : null,
    atOrAboveThreshold: scores.filter((s) => s >= HOT_THRESHOLD).length,
    medianEvidenceItems: median(evidenceCounts) ?? 0,
    medianIndependentSources: median(indep) ?? 0,
    apiCalls: runs.reduce((s, r) => s + r.apiCalls, 0),
    durationMs: runs.reduce((s, r) => s + r.durationMs, 0),
    warnings: runs.flatMap((r) => r.errors),
  };
}

async function sweep(
  label: string,
  build: (v: VerticalId) => Record<string, unknown>,
): Promise<{ runs: Awaited<ReturnType<typeof runDiscovery>>[]; assessed: Assessed[] }> {
  const runs: Awaited<ReturnType<typeof runDiscovery>>[] = [];
  const assessed: Assessed[] = [];
  for (const v of VERTICALS) {
    process.stdout.write(`  ${label} · ${verticalById(v).name} … `);
    try {
      const run = await runDiscovery(build(v), `preview:${label}`, 'manual');
      runs.push(run);
      const found = run.previewCandidates ?? [];
      for (const c of found) {
        // Re-derive triage signals for baseline candidates too, so the
        // two arms are described with the same vocabulary even though
        // only the improved arm FILTERS on them.
        const q = assessQuality(c, NOW);
        assessed.push(assess({ ...c, independentSources: c.independentSources || q.independentSources }));
      }
      process.stdout.write(`${found.length} candidate(s), ${run.apiCalls} API call(s)\n`);
    } catch (e) {
      process.stdout.write(`FAILED: ${(e as Error).message}\n`);
    }
  }
  return { runs, assessed };
}

/**
 * STAGE 3 for the strongest eligible candidates only.
 *
 * The first controlled run established that discovery-time snippets
 * cannot support a well-evidenced score — every candidate came back at
 * 20–45% completeness with no traction, no founder and often no
 * location. Filtering harder does not fix that; going and reading the
 * company's own pages does.
 *
 * Candidates are chosen by TRIAGE PRIORITY, which is what that value
 * exists for. It decides who gets researched; it never touches the
 * score that comes out the other end.
 */
async function enrichStrongest(
  assessed: Assessed[],
): Promise<{ assessed: Assessed[]; outcomes: Map<string, EnrichmentOutcome>; pagesFetched: number }> {
  const ranked = [...assessed].sort(
    (a, b) => (b.candidate.qualityPriority ?? 0) - (a.candidate.qualityPriority ?? 0),
  );
  const chosen = ranked.slice(0, ENRICH_TOP_N);
  const budget = new RequestBudget(ENRICH_TOTAL_PAGE_BUDGET);
  const outcomes = new Map<string, EnrichmentOutcome>();
  let pagesFetched = 0;

  console.log(`\n── Evidence enrichment: top ${chosen.length} by triage priority ──`);
  const out: Assessed[] = [];
  for (const a of assessed) {
    if (!chosen.includes(a)) { out.push(a); continue; }
    process.stdout.write(`  ${a.candidate.companyName.slice(0, 28).padEnd(30)}`);
    try {
      const outcome = await enrichCandidateEvidence(a.candidate, {
        maxPages: ENRICH_PAGES_PER_CANDIDATE, budget, now: NOW,
      });
      outcomes.set(a.candidate.id, outcome);
      pagesFetched += outcome.pages.filter((pg) => pg.ok).length;
      const enrichedCandidate = applyEnrichment(a.candidate, outcome);
      const rescored = assess(enrichedCandidate);
      out.push(rescored);
      console.log(
        `${outcome.facts.length} fact(s) from ${outcome.pages.filter((pg) => pg.ok).length} page(s)`
        + `, ${outcome.independentSources} independent source(s)`
        + `  ${a.score?.toFixed(1) ?? 'n/a'} → ${rescored.score?.toFixed(1) ?? 'n/a'}`
        + `  (${Math.round((a.completeness ?? 0) * 100)}% → ${Math.round((rescored.completeness ?? 0) * 100)}% complete)`,
      );
    } catch (e) {
      out.push(a);
      console.log(`enrichment failed: ${(e as Error).message}`);
    }
  }
  return { assessed: out, outcomes, pagesFetched };
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`;
}

function printComparison(a: RunMetrics, b: RunMetrics): void {
  const rows: [string, string, string][] = [
    ['candidates fetched', String(a.fetched), String(b.fetched)],
    ['reached the review queue', String(a.surviving), String(b.surviving)],
    ['eligible-candidate rate', pct(a.eligible, a.fetched), pct(b.eligible, b.fetched)],
    ['duplicates identified', String(a.duplicates), String(b.duplicates)],
    ['dropped by thesis filter', String(a.filteredByThesis), String(b.filteredByThesis)],
    ['dropped below triage floor', String(a.filteredByQuality), String(b.filteredByQuality)],
    ['rejected by validation', String(a.rejectedByValidation), String(b.rejectedByValidation)],
    ['scorable, of those queued', `${a.scorable} (${pct(a.scorable, a.surviving)})`, `${b.scorable} (${pct(b.scorable, b.surviving)})`],
    ['provisional-score rate', pct(a.provisional, a.scorable), pct(b.provisional, b.scorable)],
    ['median Vamos score', a.medianScore?.toFixed(1) ?? 'n/a', b.medianScore?.toFixed(1) ?? 'n/a'],
    ['top-quartile Vamos score', a.topQuartileScore?.toFixed(1) ?? 'n/a', b.topQuartileScore?.toFixed(1) ?? 'n/a'],
    ['max Vamos score', a.maxScore?.toFixed(1) ?? 'n/a', b.maxScore?.toFixed(1) ?? 'n/a'],
    [`scoring >= ${HOT_THRESHOLD}`, String(a.atOrAboveThreshold), String(b.atOrAboveThreshold)],
    ['median evidence items', String(a.medianEvidenceItems), String(b.medianEvidenceItems)],
    ['median independent sources', String(a.medianIndependentSources), String(b.medianIndependentSources)],
    ['API requests', String(a.apiCalls), String(b.apiCalls)],
    ['runtime (s)', (a.durationMs / 1000).toFixed(1), (b.durationMs / 1000).toFixed(1)],
    ['warnings', String(a.warnings.length), String(b.warnings.length)],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  console.log(`\n${'metric'.padEnd(w)}  ${'baseline'.padStart(12)}  ${'improved'.padStart(12)}`);
  console.log('-'.repeat(w + 28));
  for (const [k, x, y] of rows) console.log(`${k.padEnd(w)}  ${x.padStart(12)}  ${y.padStart(12)}`);
}

function printShortlist(assessed: Assessed[], limit: number, outcomes: Map<string, EnrichmentOutcome> = new Map()): void {
  const ranked = [...assessed]
    .filter((a) => a.score !== null)
    .sort((x, y) => {
      // Non-provisional first (a provisional score is a statement about
      // our sourcing, not about the company), then by official score,
      // then by triage priority as a tiebreak only.
      if (x.provisional !== y.provisional) return x.provisional ? 1 : -1;
      if (y.score! !== x.score!) return y.score! - x.score!;
      return (y.candidate.qualityPriority ?? 0) - (x.candidate.qualityPriority ?? 0);
    })
    .slice(0, limit);

  if (ranked.length === 0) {
    console.log('\nNo candidate in this run could be scored. Nothing to shortlist — reported as-is.');
    return;
  }

  console.log(`\n${'═'.repeat(78)}\nSHORTLIST — strongest newly discovered candidates\n${'═'.repeat(78)}`);
  ranked.forEach((a, i) => {
    const c = a.candidate;
    const pos = c.qualitySignals.filter((s) => s.direction === 'positive');
    const neg = c.qualitySignals.filter((s) => s.direction === 'negative');
    console.log(`
${i + 1}. ${c.companyName}
   Website ............. ${c.website}
   Approved vertical ... ${a.vertical ? verticalById(a.vertical).name : 'unclassifiable'} (${a.reason})
   Geography / stage ... ${c.hqCity}, ${c.hqState} · ${c.stage}
   Founders ............ ${c.founderNames.length > 0 ? c.founderNames.join(', ') : 'none named by the source'}
   Source / discovered . ${c.sourceId} · ${c.discoveredAt.slice(0, 10)}
   Product & buyer ..... ${c.pitch.replace(/\s+/g, ' ').slice(0, 220)}
   Traction evidence ... ${c.tractionSignals.length > 0 ? c.tractionSignals.join('; ') : 'none stated by any cited source'}
   Defensibility ....... ${pos.filter((s) => ['technical-moat', 'data-moat'].includes(s.key)).map((s) => `${s.label}: "${s.evidence}"`).join(' | ') || 'none stated'}
   VAMOS SCORE ......... ${a.score!.toFixed(1)}/10  ${a.provisional ? '[PROVISIONAL — not a statement about the company]' : '[assessed]'}
   Completeness ........ ${Math.round((a.completeness ?? 0) * 100)}% of the model was assessable
   Evidence confidence . ${Math.round((a.evidenceConfidence ?? 0) * 100)}% · ${c.independentSources} independent source(s), ${c.evidence.length} item(s)
   Components:`);
    for (const comp of a.components) {
      console.log(`     ${comp.assessable ? ' ' : '~'} ${comp.label.padEnd(38)} ${String(comp.points).padStart(2)}/${comp.max}${comp.assessable ? '' : '  (not assessable — excluded, not zeroed)'}`);
    }
    console.log(`   Triage priority ..... ${c.qualityPriority}/100 (${c.qualityBand}) — internal ordering only, NOT the Vamos score`);
    console.log(`   Positive signals .... ${pos.map((s) => `${s.key} "${s.evidence}"`).join('; ') || 'none'}`);
    console.log(`   Primary risk ........ ${neg[0] ? `${neg[0].label} — "${neg[0].evidence}"` : 'no negative signal fired; the risk is simply how little is on record'}`);
    console.log(`   Duplicate check ..... ${c.duplicateStatus === 'none' ? 'no match against any existing record' : `${c.duplicateStatus} match: ${c.duplicateOfName}`}`);
    const enrichment = outcomes.get(c.id);
    if (enrichment) {
      console.log(`   Enrichment .......... ${enrichment.facts.length} cited fact(s) from ${enrichment.pages.filter((p) => p.ok).length} page(s); `
        + `${enrichment.independentSources} independent source(s); corroborated: ${enrichment.corroboratedFields.join(', ') || 'none'}`);
      for (const f of enrichment.facts.slice(0, 6)) {
        console.log(`       [${f.assertionType}/${f.sourceKind}] ${f.field}: "${f.quote.slice(0, 90)}" — ${f.sourceUrl} (accessed ${f.accessedAt})`);
      }
      if (enrichment.unresolved.length > 0) {
        console.log(`       unresolved (reported, NOT filled): ${enrichment.unresolved.join(', ')}`);
      }
    } else {
      console.log('   Enrichment .......... not enriched (below the triage cut for this run)');
    }
    console.log(`   Missing diligence ... ${missingDiligence(a).join('; ')}`);
  });
}

/** The specific unknowns blocking a confident judgment, derived from what is genuinely absent. */
function missingDiligence(a: Assessed): string[] {
  const gaps: string[] = [];
  const c = a.candidate;
  for (const comp of a.components) if (!comp.assessable) gaps.push(`no ${comp.label.toLowerCase()} on record`);
  if (c.founderNames.length === 0) gaps.push('no founder named by any source');
  if (c.independentSources < 2) gaps.push('single-source — needs independent corroboration');
  if (!c.qualitySignals.some((s) => s.key === 'named-customers')) gaps.push('no named customer or pilot');
  return gaps.length > 0 ? gaps : ['none identified from the recorded evidence'];
}

async function main(): Promise<void> {
  console.log('Controlled sourcing validation — PREVIEW ONLY.');
  console.log(`Sources: ${SOURCES.join(', ')} · verticals: ${VERTICALS.join(', ')}`);
  console.log(`Budget: <= ${MAX_API_CALLS_PER_RUN} API calls and <= ${MAX_RESULTS_PER_RUN} results per run, ${VERTICALS.length} vertical(s) x 2 arms.`);
  console.log('Nothing is imported, scored into the database, staged, synced, or emailed.\n');

  // BASELINE: the pipeline exactly as it behaved before this pass — a
  // bare sector term, no batch-recency window, no thesis enforcement,
  // no triage floor.
  const baseline = await sweep('baseline', (v) => ({
    vertical: v, terms: [v], sources: SOURCES,
    maxResults: MAX_RESULTS_PER_RUN, maxApiCalls: MAX_API_CALLS_PER_RUN,
    geography: 'United States', mode: 'all', preview: true,
    // Explicit, because the thesis filter now DEFAULTS to on. Without
    // this the "baseline" would silently inherit the improvement it is
    // supposed to be measured against, and the comparison would
    // understate the change.
    enforceThesisFilter: false,
    dateFrom: null,
  }));

  // IMPROVED: vertical/source query strategy (terms left empty so the
  // strategy table supplies them), the YC batch-recency window, and
  // stage-1 thesis enforcement.
  //
  // `minQualityPriority` is deliberately left OFF. The triage priority
  // is for ORDERING which candidates get enrichment effort first, and
  // the first calibration run showed what happens when it is used as a
  // gate instead: it removed twelve candidates from human review on the
  // strength of short directory one-liners, which is not evidence that
  // those companies are bad — only that their listing is terse. Hard
  // exclusion is stage 1's job and stage 1 requires proof.
  const improved = await sweep('improved', (v) => ({
    vertical: v, terms: [], sources: SOURCES,
    maxResults: MAX_RESULTS_PER_RUN, maxApiCalls: MAX_API_CALLS_PER_RUN,
    geography: 'United States', mode: 'all', preview: true,
    dateFrom,
    enforceThesisFilter: true,
  }));

  // Enrich the strongest eligible candidates from the improved arm, then
  // re-score them under the SAME unchanged rubric. The baseline arm is
  // deliberately left un-enriched: it is the "before" picture.
  const enrichedArm = await enrichStrongest(improved.assessed);

  const a = metrics('baseline', baseline.runs, baseline.assessed);
  const b = metrics('improved', improved.runs, enrichedArm.assessed);
  printComparison(a, b);

  console.log(`
NOTE ON INTERPRETATION. A higher median here counts as an improvement
only because the rubric, its weights and the ${HOT_THRESHOLD}.0 threshold are
byte-identical between the two arms — the only things that changed are
which candidates were fetched and which were allowed through. If the
improved arm shows no candidate at or above ${HOT_THRESHOLD}.0, that is the honest
answer and is reported as such.`);

  printShortlist(enrichedArm.assessed, 10, enrichedArm.outcomes);

  const warnings = [...new Set([...a.warnings, ...b.warnings])];
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`Total API requests: ${a.apiCalls + b.apiCalls} across ${VERTICALS.length * 2} runs.`);
  console.log('Estimated monetary cost: $0.00 — every source used is a key-free public endpoint, and no model calls were made.');
  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log('\nNothing was persisted. Every candidate above requires explicit human approval before it enters the pipeline.');
}

main().catch((e) => { console.error(e); process.exit(1); });
