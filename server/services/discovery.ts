import { z } from 'zod';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import {
  discoveryCandidateSchema, discoveryQuerySchema, discoveryRunSchema,
  RESTRICTED_SOURCES,
  type DiscoveryCandidate, type DiscoveryQuery, type DiscoveryRun,
} from '../../shared/discovery';
import { importedCompanySchema, importedCompanies, type ImportedCompany } from './imports';
import { normalizeCompanyName, normalizeDomain } from '../../shared/integrations';
import { runSource, type RawCandidate } from './sources';
import { upsertRecord } from './records';
import { loadCompanies } from '../../src/data/loader';

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

// ── Duplicate detection ──────────────────────────────────────────

interface KnownRecord { id: string; name: string; domain: string | null; kind: 'bundled' | 'imported' | 'candidate' }

function knownRecords(): KnownRecord[] {
  const imported = importedCompanies().map((c) => ({
    id: c.id, name: c.name, domain: c.website ? normalizeDomain(c.website) : null, kind: 'imported' as const,
  }));
  const candidates = existingCandidates()
    .filter((c) => c.status !== 'dismissed')
    .map((c) => ({ id: c.id, name: c.companyName, domain: c.website !== 'Unknown' ? normalizeDomain(c.website) : null, kind: 'candidate' as const }));
  return [...BUNDLED_INDEX, ...imported, ...candidates];
}

/** Bundled sample names/domains — the server reuses the frontend data layer (pure TS + Zod). */
const BUNDLED_INDEX: KnownRecord[] = loadCompanies().map((c) => ({
  id: c.id,
  name: c.name,
  domain: c.website ? normalizeDomain(c.website) : null,
  kind: 'bundled' as const,
}));

export function detectDuplicate(c: DiscoveryCandidate): Pick<DiscoveryCandidate, 'duplicateStatus' | 'duplicateOfId' | 'duplicateOfName'> {
  const domain = c.website !== 'Unknown' ? normalizeDomain(c.website) : null;
  const name = normalizeCompanyName(c.companyName);
  for (const k of knownRecords()) {
    if (k.id === c.id) continue;
    if (domain && k.domain && domain === k.domain) {
      return { duplicateStatus: 'exact', duplicateOfId: k.id, duplicateOfName: k.name };
    }
  }
  for (const k of knownRecords()) {
    if (k.id === c.id) continue;
    if (normalizeCompanyName(k.name) === name) {
      return { duplicateStatus: 'likely', duplicateOfId: k.id, duplicateOfName: k.name };
    }
  }
  return { duplicateStatus: 'none', duplicateOfId: null, duplicateOfName: null };
}

// ── Run pipeline ─────────────────────────────────────────────────

export function existingCandidates(): DiscoveryCandidate[] {
  return z.array(discoveryCandidateSchema).catch([]).parse(store.raw.discoveryCandidates);
}

export async function runDiscovery(rawReq: unknown, initiatedBy: string, runType: DiscoveryRun['runType'] = 'manual'): Promise<DiscoveryRun> {
  assertNoRestrictedSources(rawReq);
  const q = discoveryQuerySchema.parse(rawReq);
  const started = Date.now();
  store.raw.discoveryCancelRequested = false;

  const runId = store.nextId('run');
  const sourceResults: DiscoveryRun['sourceResults'] = [];
  const errors: string[] = [];
  let apiCalls = 0;
  let discovered = 0;
  let duplicatesSkipped = 0;
  let rejectedByValidation = 0;
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
      cand = { ...cand, ...detectDuplicate(cand) };
      if (cand.duplicateStatus === 'exact' && q.mode === 'new-only') {
        duplicatesSkipped += 1;
        continue; // still counted; humans can rerun in 'all' mode to see them
      }
      accepted.push(cand);
      discovered += 1;
      found += 1;
    }
    sourceResults.push({ sourceId, mode: result.mode, found, detail: result.detail });
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
  const run: DiscoveryRun = discoveryRunSchema.parse({
    id: runId,
    at: new Date().toISOString(),
    runType,
    mode: liveCount > 0 && simCount > 0 ? 'mixed' : liveCount > 0 ? 'live' : simCount > 0 ? 'simulated' : 'local',
    query: q,
    sourceResults,
    discovered,
    updatedExisting: 0,
    duplicatesSkipped,
    rejectedByValidation,
    imported: 0,
    errors,
    apiCalls,
    modelCalls: 0,
    estimatedTokens: 0, // model calls are not used during discovery itself
    estimatedCostUsd: 0,
    durationMs: Date.now() - started,
    status: cancelled ? 'Cancelled'
      : failedCount > 0 && discovered === 0 && failedCount === sourceResults.length ? 'Failed'
      : failedCount > 0 || budgetWarnings.length > 0 ? 'Completed with warnings'
      : liveCount === 0 ? 'Simulated'
      : 'Completed',
    initiatedBy,
  });
  void cost;
  store.raw.discoveryRuns = [run, ...store.raw.discoveryRuns].slice(0, 100);
  store.save();
  audit({
    provider: 'system', mode: liveCount > 0 ? 'live' : 'mock', action: 'discovery-run',
    subject: `${q.sources.join(',')}`, outcome: run.status === 'Failed' ? 'error' : 'ok',
    detail: `${discovered} discovered, ${duplicatesSkipped} dup-skipped, ${rejectedByValidation} rejected, ${apiCalls} API calls, status ${run.status}${budgetWarnings.length > 0 ? ` (${budgetWarnings.join('; ')})` : ''}`,
  });
  return run;
}

export function cancelDiscovery(): void {
  store.raw.discoveryCancelRequested = true;
  store.save();
}

export function discoveryRuns(): DiscoveryRun[] {
  return z.array(discoveryRunSchema).catch([]).parse(store.raw.discoveryRuns);
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
        continue;
      }
    }

    const company = candidateToImportedCompany(cand);
    if (!company.success) {
      outcome.skipped.push({ id, reason: company.reason });
      continue;
    }
    store.raw.importedCompanies = [
      ...store.raw.importedCompanies.filter((c) => (c as { id?: string }).id !== company.value.id),
      company.value,
    ];
    store.raw.companyMeta[company.value.id] = {
      ...store.raw.companyMeta[company.value.id],
      reviewStatus: 'Needs Review',
      discoverySource: cand.sourceId,
      discoveredAt: cand.discoveredAt.slice(0, 10),
    };
    // Outreach tracker entry in the earliest human-review state.
    upsertRecord({
      companyId: company.value.id,
      companyName: company.value.name,
      founderName: cand.founderNames[0] ?? 'Unknown',
      founderEmail: null,
      owner: req.actor,
      vertical: company.value.vertical,
      companyStage: company.value.stage,
      fitScore: 0, // computed in the UI from real fields; never invented here
      policyException: null,
      sourceQuality: Math.round(cand.confidence * 10),
    });
    cand.status = 'imported';
    outcome.imported.push(id);
  }

  store.raw.discoveryCandidates = all;
  // Reflect import counts on the originating runs.
  const runs = discoveryRuns();
  for (const run of runs) {
    run.imported = all.filter((c) => c.runId === run.id && c.status === 'imported').length;
    run.updatedExisting = all.filter((c) => c.runId === run.id && c.status === 'merged').length;
  }
  store.raw.discoveryRuns = runs;
  store.save();
  audit({
    provider: 'system', mode: 'mock', action: 'discovery-import', subject: req.candidateIds.join(','),
    outcome: 'ok',
    detail: `${outcome.imported.length} imported to Needs Review, ${outcome.merged.length} merged, ${outcome.skipped.length} skipped — by ${req.actor}. No outreach, approval, or sync happened automatically.`,
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
  const imported = store.raw.importedCompanies as { id?: string; evidence?: unknown[] }[];
  const target = imported.find((c) => c.id === targetId);
  const newEvidence = cand.evidence.map((e) => ({
    claim: e.claim, source: e.source, url: e.url, date: e.dateAccessed, type: 'Database record' as const,
  }));
  if (target) {
    const existing = (target.evidence ?? []) as { url?: string }[];
    const fresh = newEvidence.filter((n) => !existing.some((x) => x.url === n.url));
    target.evidence = [...existing, ...fresh]; // append-only: conflicting claims are preserved side by side
  } else {
    // Bundled records are read-only — evidence additions live in companyMeta and surface in the UI.
    const meta = store.raw.companyMeta[targetId] ?? {};
    const existing = (meta.addedEvidence ?? []) as { url?: string }[];
    const fresh = newEvidence.filter((n) => !existing.some((x) => x.url === n.url));
    store.raw.companyMeta[targetId] = { ...meta, addedEvidence: [...existing, ...fresh] };
  }
}
