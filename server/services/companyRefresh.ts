import { getCompany, applyFieldUpdate, appendEvidence, markRefreshed, type FieldOrigin } from '../db/repos/companies';
import { recordReviewDecision, saveScore } from '../db/repos/operations';
import { audit } from '../lib/guard';
import { runSource } from '../sourcing';
import { discoveryQuerySchema, type DiscoveryQuery } from '../../shared/discovery';
import { normalizeCompanyKey, isHighConfidenceFuzzy } from '../sourcing/identity';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';
import type { RawCandidate } from '../sourcing/normalize';

/**
 * True per-company live research refresh (Phase 10) — distinct from
 * the lightweight "Mark reviewed" action (POST /companies/:id/refresh,
 * which only stamps last_refreshed). This one actually re-queries live
 * sources for the one company, merges what it finds, and reports
 * exactly what changed. Never overwrites a verified/user-entered field
 * with a weaker (extracted) source — see applyFieldUpdate's provenance
 * guard, reused here unchanged.
 */

/** Sources with a real adapter that can plausibly answer "what's new about THIS company". */
const COMPANY_LEVEL_SOURCES: DiscoveryQuery['sources'] = ['github', 'sec', 'grants', 'yc', 'funding-news', 'research', 'producthunt'];

const REFRESHABLE_FIELDS: { field: keyof RawCandidate & string; column: string; label: string }[] = [
  { field: 'website', column: 'website', label: 'Website' },
  { field: 'pitch', column: 'oneLiner', label: 'Description' },
  { field: 'vertical', column: 'vertical', label: 'Vertical' },
  { field: 'subcategory', column: 'subcategory', label: 'Subcategory' },
  { field: 'stage', column: 'stage', label: 'Stage' },
  { field: 'hqCity', column: 'city', label: 'City' },
  { field: 'hqState', column: 'state', label: 'State' },
  { field: 'accelerator', column: 'accelerator', label: 'Accelerator' },
  { field: 'publicFunding', column: 'raising', label: 'Funding' },
  { field: 'fundingDate', column: 'lastFundingDate', label: 'Last funding date' },
];

export interface FieldChange { field: string; from: string; to: string; source: string }
export interface FieldConflict { field: string; existing: string; attempted: string; source: string; reason: string }
export interface SourceOutcome { sourceId: string; detail: string; found: number }

export interface RefreshResearchResult {
  companyId: string;
  refreshedAt: string;
  newEvidenceCount: number;
  newEvidence: { claim: string; source: string; url: string; date: string; type: string }[];
  updatedFields: FieldChange[];
  conflictingFields: FieldConflict[];
  unchangedFieldCount: number;
  newFounderNamesFound: string[];
  sourcesRan: SourceOutcome[];
  sourcesFailed: SourceOutcome[];
  sourcesSkipped: SourceOutcome[];
  fieldsRequiringHumanReview: string[];
  oldScore: { score: number; version: string } | null;
  newScore: { score: number; version: string };
}

function matchesCompany(candidateName: string, companyName: string): boolean {
  const a = normalizeCompanyKey(candidateName);
  const b = normalizeCompanyKey(companyName);
  return a === b || isHighConfidenceFuzzy(a, b);
}

export async function refreshCompanyResearch(companyId: string, actor: string): Promise<RefreshResearchResult> {
  const company = getCompany(companyId);
  if (!company) throw Object.assign(new Error('Company not found.'), { status: 404 });

  const oldFit = scoreCompany(company as unknown as Company);

  const term = company.name.trim();
  const query = discoveryQuerySchema.parse({
    sources: COMPANY_LEVEL_SOURCES,
    terms: [term],
    maxResults: 10,
    maxApiCalls: COMPANY_LEVEL_SOURCES.length * 2, // small, per-company budget — not a broad sourcing run
  } satisfies Partial<DiscoveryQuery>);

  const sourcesRan: SourceOutcome[] = [];
  const sourcesFailed: SourceOutcome[] = [];
  const sourcesSkipped: SourceOutcome[] = [];
  const matchedCandidates: RawCandidate[] = [];

  let remainingApiCalls = query.maxApiCalls;
  for (const sourceId of query.sources) {
    if (remainingApiCalls <= 0) {
      sourcesSkipped.push({ sourceId, detail: 'Per-company API-call budget exhausted before this source ran.', found: 0 });
      continue;
    }
    const result = await runSource(sourceId, query, remainingApiCalls);
    remainingApiCalls -= result.apiCalls;
    if (result.mode === 'live') {
      const matched = result.candidates.filter((c) => matchesCompany(c.companyName, company.name));
      matchedCandidates.push(...matched);
      sourcesRan.push({ sourceId, detail: result.detail, found: matched.length });
    } else if (result.mode === 'failed') {
      sourcesFailed.push({ sourceId, detail: result.detail, found: 0 });
    } else {
      sourcesSkipped.push({ sourceId, detail: result.detail, found: 0 });
    }
  }

  // ── Evidence: append-only, never duplicated (appendEvidence already
  // skips any URL already on record), so history is preserved intact.
  // CandidateEvidence has no `type` field (unlike the DB's evidence
  // row) — labeled 'Database record' here, matching the same
  // synthesis already used when discovery candidates are imported
  // (see mergeEvidenceIntoExisting in services/discovery.ts).
  const allEvidence = matchedCandidates.flatMap((c) => c.evidence);
  appendEvidence(
    companyId,
    allEvidence.map((e) => ({ claim: e.claim, source: e.source, url: e.url, date: e.dateAccessed, type: 'Database record' })),
    'discovery',
  );
  // Report exactly which evidence rows were newly added — recomputed
  // against the pre-call state using the same URL-dedup rule
  // appendEvidence itself applies, so the two never disagree.
  const preexistingUrls = new Set(company.evidence.map((e) => e.url));
  const newEvidence = allEvidence
    .filter((e) => !preexistingUrls.has(e.url))
    .map((e) => ({ claim: e.claim, source: e.source, url: e.url, date: e.dateAccessed, type: 'Database record' }));

  // ── Field comparison: provenance-guarded, never guesses, never
  // overwrites a stronger source. `origin: 'extracted'` — a live
  // public-source lookup, not a verified/user-entered fact.
  const updatedFields: FieldChange[] = [];
  const conflictingFields: FieldConflict[] = [];
  let unchangedFieldCount = 0;
  const currentByColumn: Record<string, unknown> = {
    website: company.website, oneLiner: company.oneLiner, vertical: company.vertical, subcategory: company.subcategory,
    stage: company.stage, city: company.city, state: company.state, accelerator: company.accelerator,
    raising: company.raising, lastFundingDate: company.lastFundingDate,
  };

  for (const { field, column, label } of REFRESHABLE_FIELDS) {
    for (const cand of matchedCandidates) {
      const incoming = cand[field];
      if (incoming === undefined || incoming === null || incoming === '' || incoming === 'Unknown') continue;
      const existingValue = currentByColumn[column];
      const existingStr = existingValue === undefined || existingValue === null ? '' : String(existingValue);
      if (existingStr === String(incoming)) continue; // no change — don't even attempt the write
      const sourceLabel = cand.evidence[0]?.source ?? 'discovery refresh';
      const outcome = applyFieldUpdate(companyId, column as never, incoming as string, 'extracted' as FieldOrigin, `refresh-research:${sourceLabel}`);
      if (outcome.applied) {
        updatedFields.push({ field: label, from: existingStr || 'Missing', to: String(incoming), source: sourceLabel });
        currentByColumn[column] = incoming; // don't re-report the same change if a later candidate repeats it
      } else {
        conflictingFields.push({ field: label, existing: existingStr || 'Missing', attempted: String(incoming), source: sourceLabel, reason: outcome.reason ?? 'Kept the existing value.' });
      }
    }
  }
  unchangedFieldCount = REFRESHABLE_FIELDS.length - updatedFields.length - conflictingFields.length;

  // Founder names are never auto-merged (identity-sensitive, and
  // replacing the founders table would destroy manually-recorded
  // detail) — surfaced as informational, requiring a human decision.
  const existingFounderNames = new Set(company.founders.map((f) => normalizeCompanyKey(f.name)));
  const newFounderNamesFound = Array.from(new Set(
    matchedCandidates.flatMap((c) => c.founderNames ?? [])
      .filter((n) => !existingFounderNames.has(normalizeCompanyKey(n))),
  ));

  const today = new Date().toISOString().slice(0, 10);
  markRefreshed([companyId], today);

  const refreshedCompany = getCompany(companyId)!;
  const newFit = scoreCompany(refreshedCompany as unknown as Company);
  saveScore(companyId, newFit, refreshedCompany.evidence.map((e) => e.url));

  const fieldsRequiringHumanReview = [
    ...conflictingFields.map((c) => `${c.field} (source says "${c.attempted}", kept "${c.existing}")`),
    ...(newFounderNamesFound.length > 0 ? [`Possible additional founder(s) found: ${newFounderNamesFound.join(', ')} — not added automatically`] : []),
  ];

  recordReviewDecision({
    subjectType: 'company', subjectId: companyId, decision: 'refresh-research', actor,
    reason: `${newEvidence.length} new evidence item(s), ${updatedFields.length} field(s) updated, ${conflictingFields.length} conflict(s), score ${oldFit.score.toFixed(1)} → ${newFit.score.toFixed(1)}`,
  });
  audit({
    provider: 'system', mode: 'local', action: 'company-refresh-research', subject: companyId, outcome: 'ok',
    detail: `Live research refresh by ${actor}: ${sourcesRan.length} source(s) ran, ${sourcesFailed.length} failed, ${sourcesSkipped.length} skipped, ${newEvidence.length} new evidence item(s).`,
  });

  return {
    companyId,
    refreshedAt: today,
    newEvidenceCount: newEvidence.length,
    newEvidence,
    updatedFields,
    conflictingFields,
    unchangedFieldCount,
    newFounderNamesFound,
    sourcesRan,
    sourcesFailed,
    sourcesSkipped,
    fieldsRequiringHumanReview,
    oldScore: { score: oldFit.score, version: oldFit.version },
    newScore: { score: newFit.score, version: newFit.version },
  };
}
