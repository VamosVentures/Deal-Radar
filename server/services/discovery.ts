import { z } from 'zod';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import {
  discoveryCandidateSchema, discoveryQuerySchema, discoveryRunSchema,
  RESTRICTED_SOURCES,
  type DiscoveryCandidate, type DiscoveryQuery, type DiscoveryRun,
} from '../../shared/discovery';
import { importedCompanySchema, type ImportedCompany } from './imports';
import { runSource, type RawCandidate } from './sources';
import { detectDuplicate, existingCandidates } from '../sourcing/dedupe';
import { mergeIntoRun } from '../sourcing/enrich';
import { appendEvidence, getCompany, saveCompany } from '../db/repos/companies';
import {
  getConfig, listRuns, recordReviewDecision, saveRun, saveScore, setConfig, updateRunCounts,
} from '../db/repos/operations';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

// Deduplication lives in server/sourcing/dedupe.ts; re-exported here
// so existing imports (routes, tests) keep working.
export { detectDuplicate, existingCandidates };

/**
 * Discovery pipeline: run sources under strict budgets → normalize →
 * Zod-validate → duplicate-detect → persist candidates for HUMAN
 * preview. Import is a separate, explicit user action; imported
 * candidates land in Needs Review. Nothing is auto-approved,
 * auto-rejected, auto-synced, or auto-contacted — ever.
 */

const COST_PER_1K_TOKENS_USD = 0.003; // rough blended estimate, labeled as such

export function estimateCost(q: DiscoveryQuery): { estimatedTokens: number; estimatedCostUsd: number; note: string } {
  const estimatedTokens = Math.min(q.maxEstimatedTokens, q.maxModelCalls * 1200);
  return {
    estimatedTokens,
    estimatedCostUsd: Number(((estimatedTokens / 1000) * COST_PER_1K_TOKENS_USD).toFixed(4)),
    note: 'Rough estimate: API calls are free-tier public endpoints; model cost assumes ~1.2K tokens/call at a blended rate. Actual cost depends on the configured provider.',
  };
}

/** Reject restricted services by name anywhere in the request. */
export function assertNoRestrictedSources(raw: unknown): void {
  const text = JSON.stringify(raw ?? '').toLowerCase();
  const hit = RESTRICTED_SOURCES.find((s) => text.includes(s));
  if (hit) {
    throw Object.assign(
      new Error(`"${hit}" is a restricted source. LinkedIn, PitchBook, and Crunchbase are never scraped — use authorized licensed exports via the upload connector instead.`),
      { status: 422 },
    );
  }
}

// ── Normalization ────────────────────────────────────────────────

const STATE_IN_GEO: Record<string, string[]> = {
  'Preferred states': ['NM', 'NY', 'NJ', 'OR', 'CA', 'TX', 'IL'],
};

function normalizeCandidate(raw: RawCandidate, runId: string, sourceId: string, simulated: boolean): unknown {
  const nextStep =
    raw.website ? `Verify the pitch and team on ${raw.website}, then classify vertical/stage.`
    : 'Requires manual review — locate an official website or filing before classifying.';
  return {
    id: store.nextId('cand'),
    runId,
    discoveredAt: new Date().toISOString(),
    sourceId,
    simulated,
    externalId: raw.externalId ?? null,
    companyName: raw.companyName?.trim(),
    website: raw.website ?? 'Unknown',
    pitch: raw.pitch ?? 'Unknown',
    vertical: raw.vertical ?? 'Unknown',
    subcategory: raw.subcategory ?? 'Unknown',
    stage: raw.stage ?? 'Unknown',
    hqCity: raw.hqCity ?? 'Unknown',
    hqState: raw.hqState ?? 'Unknown',
    foundingYear: raw.foundingYear ?? null,
    founderNames: raw.founderNames ?? [],
    founderCount: raw.founderNames ? raw.founderNames.length : null,
    accelerator: raw.accelerator ?? 'Unknown',
    publicFunding: raw.publicFunding ?? 'Unknown',
    mostRecentRound: raw.mostRecentRound ?? 'Unknown',
    fundingDate: raw.fundingDate ?? null,
    tractionSignals: raw.tractionSignals ?? [],
    evidence: raw.evidence,
    confidence: raw.confidence,
    verificationStatus: 'Not verified',
    duplicateStatus: 'none',
    duplicateOfId: null,
    duplicateOfName: null,
    policyExceptionFlags: [],
    suggestedNextStep: nextStep,
    status: 'pending',
  };
}

function matchesQuery(c: DiscoveryCandidate, q: DiscoveryQuery): boolean {
  if (q.vertical && c.vertical !== 'Unknown' && c.vertical !== q.vertical) return false;
  if (q.stages.length > 0 && c.stage !== 'Unknown' && c.stage !== 'Stealth' && !q.stages.includes(c.stage as 'Pre-seed' | 'Seed' | 'Series A')) return false;
  if (c.confidence < q.minConfidence) return false;
  const geoStates = q.states.length > 0 ? q.states : STATE_IN_GEO[q.geography];
  if (geoStates && c.hqState !== 'Unknown' && !geoStates.includes(c.hqState)) return false;
  return true; // Unknown fields never exclude a candidate — humans decide.
}

/**
 * Evidence-recency threshold: drop a candidate whose evidence is ALL
 * older than the configured window. A candidate with no parseable
 * evidence date is never excluded this way — recency can't be judged,
 * so it isn't guessed.
 */
function passesEvidenceRecency(c: DiscoveryCandidate, q: DiscoveryQuery): boolean {
  if (q.minEvidenceRecencyDays === null) return true;
  const dated = c.evidence
    .map((e) => new Date(e.dateAccessed).getTime())
    .filter((t) => !Number.isNaN(t));
  if (dated.length === 0) return true;
  const ageDays = (Date.now() - Math.max(...dated)) / 86_400_000;
  return ageDays <= q.minEvidenceRecencyDays;
}

/**
 * 'stale-only' mode targets refreshing EXISTING companies, not finding
 * new ones: a candidate is kept only when it matches a company that
 * has gone unrefreshed for at least `staleAfterDays` (or never).
 */
function passesStaleOnlyFilter(c: DiscoveryCandidate, q: DiscoveryQuery): boolean {
  if (q.mode !== 'stale-only') return true;
  if (c.duplicateStatus === 'none' || !c.duplicateOfId) return false;
  const existing = getCompany(c.duplicateOfId);
  const last = existing?.lastRefreshed;
  if (!last) return true;
  const ageDays = (Date.now() - new Date(last).getTime()) / 86_400_000;
  return ageDays >= q.staleAfterDays;
}

// ── Overlap prevention ───────────────────────────────────────────
// One sourcing run (manual, scheduled, or an admin's "Run sourcing
// now") at a time. The lock is persisted (not just in-process) so it
// holds even across the scheduler's hourly tick and ad hoc admin
// triggers; a crashed run can't wedge it forever because a lock older
// than RUN_LOCK_STALE_MS is treated as abandoned and reclaimed.

const RUN_LOCK_KEY = 'discovery-run-lock';
const RUN_LOCK_STALE_MS = 15 * 60_000;
const runLockSchema = z.object({ startedAt: z.string(), initiatedBy: z.string() }).nullable();

function acquireRunLock(initiatedBy: string): boolean {
  const existing = getConfig(RUN_LOCK_KEY, runLockSchema, null);
  if (existing && Date.now() - new Date(existing.startedAt).getTime() < RUN_LOCK_STALE_MS) return false;
  setConfig(RUN_LOCK_KEY, { startedAt: new Date().toISOString(), initiatedBy });
  return true;
}
function releaseRunLock(): void {
  setConfig(RUN_LOCK_KEY, null);
}

// ── Run pipeline ─────────────────────────────────────────────────

export async function runDiscovery(rawReq: unknown, initiatedBy: string, runType: DiscoveryRun['runType'] = 'manual'): Promise<DiscoveryRun> {
  assertNoRestrictedSources(rawReq);
  const q = discoveryQuerySchema.parse(rawReq);

  if (!acquireRunLock(initiatedBy)) {
    throw Object.assign(
      new Error('A sourcing run is already in progress. Wait for it to finish, or check back in a few minutes.'),
      { status: 409 },
    );
  }

  try {
    const startedAt = new Date();
    store.raw.discoveryCancelRequested = false;

    const runId = store.nextId('run');
    const sourceResults: DiscoveryRun['sourceResults'] = [];
    const errors: string[] = [];
    let apiCalls = 0;
    let discovered = 0;
    let duplicatesSkipped = 0;
    let duplicatesIdentified = 0;
    let filteredByPolicy = 0;
    let rejectedByValidation = 0;
    let enrichedInRun = 0;
    let cancelled = false;
    const accepted: DiscoveryCandidate[] = [];

    for (const sourceId of q.sources) {
      if (store.raw.discoveryCancelRequested) { cancelled = true; break; }
      if (discovered >= q.maxResults) {
        sourceResults.push({ sourceId, mode: 'skipped', found: 0, detail: 'Result budget reached before this source ran.' });
        continue;
      }
      let result;
      try {
        result = await runSource(sourceId, q, q.maxApiCalls - apiCalls);
      } catch (e) {
        errors.push(`${sourceId}: ${(e as Error).message}`);
        sourceResults.push({ sourceId, mode: 'failed', found: 0, detail: (e as Error).message });
        continue; // partial failure never loses other sources' work
      }
      apiCalls += result.apiCalls;
      let found = 0;
      for (const raw of result.candidates) {
        if (discovered >= q.maxResults) break;
        const parsed = discoveryCandidateSchema.safeParse(normalizeCandidate(raw, runId, sourceId, result.mode !== 'live'));
        if (!parsed.success) {
          rejectedByValidation += 1;
          continue;
        }
        let cand = parsed.data;
        if (!matchesQuery(cand, q)) continue;
        if (!passesEvidenceRecency(cand, q)) { filteredByPolicy += 1; continue; }
        cand = { ...cand, ...detectDuplicate(cand) };
        if (cand.duplicateStatus !== 'none') duplicatesIdentified += 1;
        if (!passesStaleOnlyFilter(cand, q)) { filteredByPolicy += 1; continue; }
        if (cand.duplicateStatus === 'exact' && q.mode === 'new-only') {
          duplicatesSkipped += 1;
          continue; // still counted; humans can rerun in 'all' mode to see them
        }
        // Enrichment: the same company surfaced by another source in THIS
        // run gains evidence + missing fields instead of a duplicate row.
        if (mergeIntoRun(accepted, cand)) {
          enrichedInRun += 1;
          continue;
        }
        accepted.push(cand);
        discovered += 1;
        found += 1;
      }
      sourceResults.push({ sourceId, mode: result.mode, found, detail: result.detail, ...(result.failureKind ? { failureKind: result.failureKind } : {}) });
      if (result.mode === 'failed') errors.push(`${sourceId}: ${result.detail}`);
    }

    store.raw.discoveryCandidates = [...store.raw.discoveryCandidates, ...accepted];

    const liveCount = sourceResults.filter((r) => r.mode === 'live').length;
    const simCount = sourceResults.filter((r) => r.mode === 'simulated').length;
    const failedCount = sourceResults.filter((r) => r.mode === 'failed').length;
    const budgetWarnings: string[] = [];
    if (apiCalls >= q.maxApiCalls) budgetWarnings.push('API-call budget reached');
    if (discovered >= q.maxResults) budgetWarnings.push('Result budget reached');

    const cost = estimateCost(q);
    const completedAt = new Date();
    const run: DiscoveryRun = discoveryRunSchema.parse({
      id: runId,
      at: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      runType,
      mode: liveCount > 0 && simCount > 0 ? 'mixed' : liveCount > 0 ? 'live' : simCount > 0 ? 'simulated' : 'local',
      query: q,
      sourceResults,
      discovered,
      updatedExisting: 0,
      duplicatesSkipped,
      duplicatesIdentified,
      filteredByPolicy,
      rejectedByValidation,
      imported: 0,
      errors,
      apiCalls,
      modelCalls: 0,
      estimatedTokens: 0, // model calls are not used during discovery itself
      estimatedCostUsd: 0,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      status: cancelled ? 'Cancelled'
        : failedCount > 0 && discovered === 0 && failedCount === sourceResults.length ? 'Failed'
        : failedCount > 0 || budgetWarnings.length > 0 ? 'Completed with warnings'
        : liveCount === 0 ? 'Simulated'
        : 'Completed',
      initiatedBy,
    });
    void cost;
    saveRun(run);
    store.save();
    audit({
      provider: 'system', mode: liveCount > 0 ? 'live' : 'local', action: 'discovery-run',
      subject: `${q.sources.join(',')}`, outcome: run.status === 'Failed' ? 'error' : 'ok',
      detail: `${discovered} discovered, ${enrichedInRun} enriched cross-source, ${duplicatesIdentified} duplicates identified (${duplicatesSkipped} skipped), ${filteredByPolicy} filtered by recency/refresh-age policy, ${rejectedByValidation} rejected, ${apiCalls} API calls, status ${run.status}${budgetWarnings.length > 0 ? ` (${budgetWarnings.join('; ')})` : ''}`,
    });
    return run;
  } finally {
    releaseRunLock();
  }
}

export function cancelDiscovery(): void {
  store.raw.discoveryCancelRequested = true;
  store.save();
}

export function discoveryRuns(): DiscoveryRun[] {
  return listRuns();
}

// ── Selective import (explicit human action) ─────────────────────

const importRequestSchema = z.object({
  candidateIds: z.array(z.string()).min(1),
  actor: z.string().default('team'),
  /** For likely/exact duplicates: 'merge-evidence' appends the candidate's evidence to the existing record. */
  duplicateAction: z.enum(['skip', 'merge-evidence', 'import-anyway']).default('skip'),
});

export interface ImportOutcome {
  imported: string[];
  merged: string[];
  skipped: { id: string; reason: string }[];
}

export function importCandidates(rawReq: unknown): ImportOutcome {
  const req = importRequestSchema.parse(rawReq);
  const all = existingCandidates();
  const outcome: ImportOutcome = { imported: [], merged: [], skipped: [] };

  for (const id of req.candidateIds) {
    const cand = all.find((c) => c.id === id);
    if (!cand) { outcome.skipped.push({ id, reason: 'Candidate not found.' }); continue; }
    if (cand.status !== 'pending') { outcome.skipped.push({ id, reason: `Already ${cand.status}.` }); continue; }

    if (cand.duplicateStatus !== 'none') {
      if (req.duplicateAction === 'skip') {
        outcome.skipped.push({ id, reason: `Duplicate of ${cand.duplicateOfName} — left pending (choose merge or import-anyway).` });
        continue;
      }
      if (req.duplicateAction === 'merge-evidence' && cand.duplicateOfId) {
        mergeEvidenceIntoExisting(cand);
        cand.status = 'merged';
        outcome.merged.push(id);
        recordReviewDecision({ subjectType: 'candidate', subjectId: cand.id, decision: 'merged-evidence', actor: req.actor, reason: `into ${cand.duplicateOfName}` });
        continue;
      }
    }

    const company = candidateToImportedCompany(cand);
    if (!company.success) {
      outcome.skipped.push({ id, reason: company.reason });
      continue;
    }
    saveCompany(company.value, {
      origin: 'extracted', // public-source extraction; verified fields are never downgraded
      source: `discovery:${cand.sourceId}`,
      externalId: cand.externalId ? { sourceId: cand.sourceId, externalId: cand.externalId } : undefined,
      reviewStatus: 'Awaiting Review',
      discoverySource: cand.sourceId,
      discoveredAt: cand.discoveredAt.slice(0, 10),
    });
    saveScore(company.value.id, scoreCompany(company.value as unknown as Company), company.value.evidence.map((e) => e.url));
    recordReviewDecision({ subjectType: 'candidate', subjectId: cand.id, decision: 'imported', actor: req.actor });
    cand.status = 'imported';
    outcome.imported.push(id);
  }

  store.raw.discoveryCandidates = all;
  // Reflect import counts on the originating runs.
  const runIds = new Set(all.map((c) => c.runId));
  for (const runId of runIds) {
    updateRunCounts(runId, {
      imported: all.filter((c) => c.runId === runId && c.status === 'imported').length,
      updatedExisting: all.filter((c) => c.runId === runId && c.status === 'merged').length,
    });
  }
  store.save();
  audit({
    provider: 'system', mode: 'local', action: 'discovery-import', subject: req.candidateIds.join(','),
    outcome: 'ok',
    detail: `${outcome.imported.length} imported to Awaiting Review, ${outcome.merged.length} merged, ${outcome.skipped.length} skipped — by ${req.actor}. No outreach, approval, or sync happened automatically.`,
  });
  return outcome;
}

/** Candidates become imported companies only with honest defaults — Unknowns stay visible. */
function candidateToImportedCompany(c: DiscoveryCandidate): { success: true; value: ImportedCompany } | { success: false; reason: string } {
  if (c.vertical === 'Unknown') {
    return { success: false, reason: 'Vertical is Unknown — classify it in review before import (no guessing).' };
  }
  const parsed = importedCompanySchema.safeParse({
    id: `disc-${c.id}`,
    name: c.companyName,
    oneLiner: c.pitch !== 'Unknown' ? c.pitch : 'Unknown — pitch not yet verified',
    vertical: c.vertical,
    subcategory: c.subcategory !== 'Unknown' ? c.subcategory : 'Unclassified — requires manual review',
    stage: c.stage === 'Unknown' ? 'Stealth' : c.stage,
    city: c.hqCity !== 'Unknown' ? c.hqCity : 'Unknown',
    state: c.hqState !== 'Unknown' ? c.hqState : '??',
    foundedYear: c.foundingYear ?? new Date().getFullYear(),
    teamSize: Math.max(1, c.founderCount ?? 1),
    website: c.website !== 'Unknown' ? c.website : undefined,
    raising: c.publicFunding !== 'Unknown' ? c.publicFunding : undefined,
    accelerator: c.accelerator !== 'Unknown' ? c.accelerator : undefined,
    lastFundingDate: c.fundingDate && /^\d{4}-\d{2}-\d{2}$/.test(c.fundingDate) ? c.fundingDate : undefined,
    traction: {
      level: 0,
      note: c.tractionSignals.length > 0 ? `Signals only: ${c.tractionSignals.join('; ')} (unrated — needs analyst review)` : 'Unknown — not yet researched',
    },
    founders: (c.founderNames.length > 0 ? c.founderNames : ['Unknown founder']).map((n) => ({
      name: n === 'Unknown founder' ? n : n,
      role: 'Unknown',
      background: 'Unknown — requires manual research',
    })),
    evidence: c.evidence.map((e) => ({
      claim: e.claim, source: e.source, url: e.url, date: e.dateAccessed,
      type: 'Database record' as const,
    })),
    flags: c.policyExceptionFlags,
    imported: true as const,
  });
  if (!parsed.success) {
    return { success: false, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { success: true, value: parsed.data };
}

/** Merge candidate evidence into the matched record — appends, never overwrites; conflicts stay visible. */
function mergeEvidenceIntoExisting(cand: DiscoveryCandidate): void {
  const targetId = cand.duplicateOfId!;
  const newEvidence = cand.evidence.map((e) => ({
    claim: e.claim, source: e.source, url: e.url, date: e.dateAccessed, type: 'Database record' as const,
  }));
  if (getCompany(targetId)) {
    // Append-only into the database: conflicting claims are preserved side by side.
    appendEvidence(targetId, newEvidence, 'merge');
    return;
  }
  // Target is another pending candidate — append onto its evidence list.
  const all = existingCandidates();
  const target = all.find((c) => c.id === targetId);
  if (target) {
    const cited = new Set(target.evidence.map((e) => e.url));
    target.evidence = [
      ...target.evidence,
      ...cand.evidence.filter((e) => !cited.has(e.url)),
    ];
    store.raw.discoveryCandidates = all;
    store.save();
  }
}
