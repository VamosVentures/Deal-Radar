import { getDb } from '../client';
import {
  ENRICHMENT_VERSION,
  type CorrectableField, type FieldCorrection, type FounderCandidate, type FounderResolution,
  type FounderResolutionStatus, type MatchSignal, type ResearchAttempt, type ResearchOutcome,
  type SourceFamily, type StageResolution, type VerticalClassification,
} from '../../../shared/enrichment';

/**
 * Enrichment repository: founder candidates, research attempts, per-company
 * founder/vertical/stage verdicts, the entity-relationship graph, run
 * records, and reviewer corrections.
 *
 * Every write here is idempotent by construction. Enrichment is expected
 * to be re-run — nightly, after a schema change, or by a reviewer hitting
 * "Research again" — and a second run must not duplicate a person, an
 * attempt, an edge, or a history entry. The uniqueness that guarantees
 * that lives in the schema (migration 11) rather than in caller
 * discipline, because caller discipline is what fails at 2am.
 */

const now = () => new Date().toISOString();

// ── Founder candidates ────────────────────────────────────────────

interface CandidateRow {
  id: number; company_id: string; person_key: string; full_name: string; title: string | null;
  source_url: string; source_family: string; source_type: string; published_at: string | null;
  retrieved_at: string; supporting_text: string; match_signals: string; match_score: number;
  confidence: number; status: string; first_seen_at: string; last_checked_at: string;
  review_decision: string | null; reviewed_by: string | null; reviewed_at: string | null; review_reason: string | null;
}

function rowToCandidate(r: CandidateRow): FounderCandidate {
  return {
    id: r.id,
    companyId: r.company_id,
    personKey: r.person_key,
    fullName: r.full_name,
    title: r.title,
    sourceUrl: r.source_url,
    sourceFamily: r.source_family as SourceFamily,
    sourceType: r.source_type,
    publishedAt: r.published_at,
    retrievedAt: r.retrieved_at,
    supportingText: r.supporting_text,
    matchSignals: JSON.parse(r.match_signals) as MatchSignal[],
    matchScore: r.match_score,
    confidence: r.confidence,
    status: r.status as FounderResolutionStatus,
    firstSeenAt: r.first_seen_at,
    lastCheckedAt: r.last_checked_at,
    reviewDecision: (r.review_decision as 'confirmed' | 'rejected' | null) ?? null,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewReason: r.review_reason,
  };
}

export interface UpsertCandidateInput {
  companyId: string;
  personKey: string;
  fullName: string;
  title: string | null;
  sourceUrl: string;
  sourceFamily: SourceFamily;
  sourceType: string;
  publishedAt: string | null;
  supportingText: string;
  matchSignals: MatchSignal[];
  matchScore: number;
  confidence: number;
  status: FounderResolutionStatus;
}

/**
 * Record (or refresh) one person-from-one-source.
 *
 * `first_seen_at` is preserved across re-runs while `last_checked_at`
 * moves, so "we have known about this person since March and re-checked
 * it yesterday" survives. A single timestamp column would have collapsed
 * those into one fact and lost the more useful half.
 *
 * A reviewer's decision is deliberately NOT touched here. Automated
 * re-research refreshes the evidence; it never un-confirms or
 * un-rejects a human's call.
 */
export function upsertFounderCandidate(input: UpsertCandidateInput): number {
  const ts = now();
  const db = getDb();
  db.prepare(`
    INSERT INTO founder_candidates (
      company_id, person_key, full_name, title, source_url, source_family, source_type,
      published_at, retrieved_at, supporting_text, match_signals, match_score, confidence,
      status, first_seen_at, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id, person_key, source_url) DO UPDATE SET
      full_name = excluded.full_name,
      title = excluded.title,
      source_family = excluded.source_family,
      source_type = excluded.source_type,
      published_at = excluded.published_at,
      retrieved_at = excluded.retrieved_at,
      supporting_text = excluded.supporting_text,
      match_signals = excluded.match_signals,
      match_score = excluded.match_score,
      confidence = excluded.confidence,
      status = excluded.status,
      last_checked_at = excluded.last_checked_at
  `).run(
    input.companyId, input.personKey, input.fullName, input.title, input.sourceUrl,
    input.sourceFamily, input.sourceType, input.publishedAt, ts, input.supportingText,
    JSON.stringify(input.matchSignals), input.matchScore, input.confidence,
    input.status, ts, ts,
  );
  const row = db.prepare('SELECT id FROM founder_candidates WHERE company_id = ? AND person_key = ? AND source_url = ?')
    .get(input.companyId, input.personKey, input.sourceUrl) as { id: number };
  return row.id;
}

export function listFounderCandidates(companyId: string): FounderCandidate[] {
  const rows = getDb()
    .prepare('SELECT * FROM founder_candidates WHERE company_id = ? ORDER BY match_score DESC, confidence DESC, id')
    .all(companyId) as unknown as CandidateRow[];
  return rows.map(rowToCandidate);
}

export function getFounderCandidate(id: number): FounderCandidate | null {
  const row = getDb().prepare('SELECT * FROM founder_candidates WHERE id = ?').get(id) as unknown as CandidateRow | undefined;
  return row ? rowToCandidate(row) : null;
}

/** All candidates, grouped by company — the bulk read path for the companies payload. */
export function allFounderCandidates(): Record<string, FounderCandidate[]> {
  const rows = getDb()
    .prepare('SELECT * FROM founder_candidates ORDER BY company_id, match_score DESC, confidence DESC, id')
    .all() as unknown as CandidateRow[];
  const out: Record<string, FounderCandidate[]> = {};
  for (const r of rows) (out[r.company_id] ??= []).push(rowToCandidate(r));
  return out;
}

/**
 * Record a reviewer's confirm/reject on a candidate.
 *
 * The automated columns are untouched — match signals, score, supporting
 * text and source all stay exactly as the research left them. A reviewer
 * adds a verdict beside the evidence; they do not rewrite it.
 */
export function reviewFounderCandidate(
  id: number,
  decision: 'confirmed' | 'rejected',
  reviewer: { id: string; label: string },
  reason: string,
): FounderCandidate | null {
  getDb().prepare(`
    UPDATE founder_candidates
    SET review_decision = ?, reviewed_by = ?, reviewed_at = ?, review_reason = ?
    WHERE id = ?
  `).run(decision, reviewer.label, now(), reason, id);
  return getFounderCandidate(id);
}

// ── Research attempts ─────────────────────────────────────────────

/**
 * Record what happened when we asked one source family about one
 * company. Upserted per (company, family) so a re-run refreshes the
 * attempt rather than appending a duplicate — the question "when did we
 * last ask the SEC about this company" must have exactly one answer.
 */
export function recordResearchAttempt(a: {
  companyId: string;
  runId: string | null;
  sourceFamily: SourceFamily;
  url: string | null;
  outcome: ResearchOutcome;
  detail: string;
  candidatesFound: number;
}): void {
  getDb().prepare(`
    INSERT INTO founder_research_attempts (company_id, run_id, source_family, url, attempted_at, outcome, detail, candidates_found)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id, source_family) DO UPDATE SET
      run_id = excluded.run_id,
      url = excluded.url,
      attempted_at = excluded.attempted_at,
      outcome = excluded.outcome,
      detail = excluded.detail,
      candidates_found = excluded.candidates_found
  `).run(a.companyId, a.runId, a.sourceFamily, a.url, now(), a.outcome, a.detail, a.candidatesFound);
}

export function listResearchAttempts(companyId: string): ResearchAttempt[] {
  const rows = getDb()
    .prepare('SELECT * FROM founder_research_attempts WHERE company_id = ? ORDER BY source_family')
    .all(companyId) as unknown as {
      company_id: string; source_family: string; url: string | null;
      attempted_at: string; outcome: string; detail: string; candidates_found: number;
    }[];
  return rows.map((r) => ({
    companyId: r.company_id,
    sourceFamily: r.source_family as SourceFamily,
    url: r.url,
    attemptedAt: r.attempted_at,
    outcome: r.outcome as ResearchOutcome,
    detail: r.detail,
    candidatesFound: r.candidates_found,
  }));
}

export function allResearchAttempts(): Record<string, ResearchAttempt[]> {
  const rows = getDb()
    .prepare('SELECT * FROM founder_research_attempts ORDER BY company_id, source_family')
    .all() as unknown as {
      company_id: string; source_family: string; url: string | null;
      attempted_at: string; outcome: string; detail: string; candidates_found: number;
    }[];
  const out: Record<string, ResearchAttempt[]> = {};
  for (const r of rows) {
    (out[r.company_id] ??= []).push({
      companyId: r.company_id,
      sourceFamily: r.source_family as SourceFamily,
      url: r.url,
      attemptedAt: r.attempted_at,
      outcome: r.outcome as ResearchOutcome,
      detail: r.detail,
      candidatesFound: r.candidates_found,
    });
  }
  return out;
}

// ── Founder resolution verdict ────────────────────────────────────

export function saveFounderResolution(r: FounderResolution): void {
  getDb().prepare(`
    INSERT INTO company_founder_resolution (
      company_id, status, resolved_person_key, resolved_name, resolved_title,
      summary, next_action, sources_attempted, researched_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id) DO UPDATE SET
      status = excluded.status,
      resolved_person_key = excluded.resolved_person_key,
      resolved_name = excluded.resolved_name,
      resolved_title = excluded.resolved_title,
      summary = excluded.summary,
      next_action = excluded.next_action,
      sources_attempted = excluded.sources_attempted,
      researched_at = excluded.researched_at,
      version = excluded.version
  `).run(
    r.companyId, r.status, r.resolvedPersonKey, r.resolvedName, r.resolvedTitle,
    r.summary, r.nextAction, JSON.stringify(r.sourcesAttempted), r.researchedAt, r.version,
  );
}

interface ResolutionRow {
  company_id: string; status: string; resolved_person_key: string | null; resolved_name: string | null;
  resolved_title: string | null; summary: string; next_action: string; sources_attempted: string;
  researched_at: string; version: string;
}

function rowToResolution(r: ResolutionRow): FounderResolution {
  return {
    companyId: r.company_id,
    status: r.status as FounderResolutionStatus,
    resolvedPersonKey: r.resolved_person_key,
    resolvedName: r.resolved_name,
    resolvedTitle: r.resolved_title,
    summary: r.summary,
    nextAction: r.next_action,
    sourcesAttempted: JSON.parse(r.sources_attempted) as SourceFamily[],
    researchedAt: r.researched_at,
    version: r.version,
  };
}

export function getFounderResolution(companyId: string): FounderResolution | null {
  const row = getDb().prepare('SELECT * FROM company_founder_resolution WHERE company_id = ?')
    .get(companyId) as unknown as ResolutionRow | undefined;
  return row ? rowToResolution(row) : null;
}

export function allFounderResolutions(): Record<string, FounderResolution> {
  const rows = getDb().prepare('SELECT * FROM company_founder_resolution').all() as unknown as ResolutionRow[];
  const out: Record<string, FounderResolution> = {};
  for (const r of rows) out[r.company_id] = rowToResolution(r);
  return out;
}

// ── Vertical classification ───────────────────────────────────────

export function saveVerticalClassification(v: VerticalClassification): void {
  getDb().prepare(`
    INSERT INTO company_vertical_classification (
      company_id, primary_sector, secondary_sector, subvertical, reason,
      source_url, confidence, basis, evidence_gap, classified_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id) DO UPDATE SET
      primary_sector = excluded.primary_sector,
      secondary_sector = excluded.secondary_sector,
      subvertical = excluded.subvertical,
      reason = excluded.reason,
      source_url = excluded.source_url,
      confidence = excluded.confidence,
      basis = excluded.basis,
      evidence_gap = excluded.evidence_gap,
      classified_at = excluded.classified_at,
      version = excluded.version
  `).run(
    v.companyId, v.primarySector, v.secondarySector, v.subvertical, v.reason,
    v.sourceUrl, v.confidence, v.basis, v.evidenceGap, v.classifiedAt, v.version,
  );
}

interface VerticalRow {
  company_id: string; primary_sector: string; secondary_sector: string | null; subvertical: string | null;
  reason: string; source_url: string | null; confidence: number; basis: string;
  evidence_gap: string | null; classified_at: string; version: string;
}

function rowToVertical(r: VerticalRow): VerticalClassification {
  return {
    companyId: r.company_id,
    primarySector: r.primary_sector as VerticalClassification['primarySector'],
    secondarySector: r.secondary_sector as VerticalClassification['secondarySector'],
    subvertical: r.subvertical,
    reason: r.reason,
    sourceUrl: r.source_url,
    confidence: r.confidence,
    basis: r.basis as 'explicit' | 'inferred',
    evidenceGap: r.evidence_gap,
    classifiedAt: r.classified_at,
    version: r.version,
  };
}

export function getVerticalClassification(companyId: string): VerticalClassification | null {
  const row = getDb().prepare('SELECT * FROM company_vertical_classification WHERE company_id = ?')
    .get(companyId) as unknown as VerticalRow | undefined;
  return row ? rowToVertical(row) : null;
}

export function allVerticalClassifications(): Record<string, VerticalClassification> {
  const rows = getDb().prepare('SELECT * FROM company_vertical_classification').all() as unknown as VerticalRow[];
  const out: Record<string, VerticalClassification> = {};
  for (const r of rows) out[r.company_id] = rowToVertical(r);
  return out;
}

// ── Stage resolution ──────────────────────────────────────────────

export function saveStageResolution(s: StageResolution): void {
  getDb().prepare(`
    INSERT INTO company_stage_resolution (
      company_id, stage, basis, confidence, evidence_url, evidence_date,
      explanation, conflicts, last_checked_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id) DO UPDATE SET
      stage = excluded.stage,
      basis = excluded.basis,
      confidence = excluded.confidence,
      evidence_url = excluded.evidence_url,
      evidence_date = excluded.evidence_date,
      explanation = excluded.explanation,
      conflicts = excluded.conflicts,
      last_checked_at = excluded.last_checked_at,
      version = excluded.version
  `).run(
    s.companyId, s.stage, s.basis, s.confidence, s.evidenceUrl, s.evidenceDate,
    s.explanation, JSON.stringify(s.conflicts), s.lastCheckedAt, s.version,
  );
}

interface StageRow {
  company_id: string; stage: string; basis: string; confidence: number;
  evidence_url: string | null; evidence_date: string | null; explanation: string;
  conflicts: string; last_checked_at: string; version: string;
}

function rowToStage(r: StageRow): StageResolution {
  return {
    companyId: r.company_id,
    stage: r.stage as StageResolution['stage'],
    basis: r.basis as 'explicit' | 'inferred',
    confidence: r.confidence,
    evidenceUrl: r.evidence_url,
    evidenceDate: r.evidence_date,
    explanation: r.explanation,
    conflicts: JSON.parse(r.conflicts) as StageResolution['conflicts'],
    lastCheckedAt: r.last_checked_at,
    version: r.version,
  };
}

export function getStageResolution(companyId: string): StageResolution | null {
  const row = getDb().prepare('SELECT * FROM company_stage_resolution WHERE company_id = ?')
    .get(companyId) as unknown as StageRow | undefined;
  return row ? rowToStage(row) : null;
}

export function allStageResolutions(): Record<string, StageResolution> {
  const rows = getDb().prepare('SELECT * FROM company_stage_resolution').all() as unknown as StageRow[];
  const out: Record<string, StageResolution> = {};
  for (const r of rows) out[r.company_id] = rowToStage(r);
  return out;
}

// ── Entity relationship graph ─────────────────────────────────────

export interface EntityEdge {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  sourceFamily: SourceFamily;
  evidenceUrl: string;
  detail: string;
  confidence: number;
}

/** Idempotent: the same edge from the same source moves `last_seen_at` rather than duplicating. */
export function upsertRelationship(e: EntityEdge): void {
  const ts = now();
  getDb().prepare(`
    INSERT INTO entity_relationships (
      from_type, from_id, to_type, to_id, relation, source_family,
      evidence_url, detail, confidence, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (from_type, from_id, to_type, to_id, relation, evidence_url) DO UPDATE SET
      detail = excluded.detail,
      confidence = excluded.confidence,
      source_family = excluded.source_family,
      last_seen_at = excluded.last_seen_at
  `).run(
    e.fromType, e.fromId, e.toType, e.toId, e.relation, e.sourceFamily,
    e.evidenceUrl, e.detail, e.confidence, ts, ts,
  );
}

export interface StoredEdge extends EntityEdge { id: number; createdAt: string; lastSeenAt: string }

function rowToEdge(r: Record<string, unknown>): StoredEdge {
  return {
    id: r.id as number,
    fromType: r.from_type as string,
    fromId: r.from_id as string,
    toType: r.to_type as string,
    toId: r.to_id as string,
    relation: r.relation as string,
    sourceFamily: r.source_family as SourceFamily,
    evidenceUrl: r.evidence_url as string,
    detail: r.detail as string,
    confidence: r.confidence as number,
    createdAt: r.created_at as string,
    lastSeenAt: r.last_seen_at as string,
  };
}

/** Every edge touching a node, in either direction. */
export function relationshipsFor(type: string, id: string): StoredEdge[] {
  const rows = getDb().prepare(`
    SELECT * FROM entity_relationships
    WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
    ORDER BY confidence DESC, id
  `).all(type, id, type, id) as Record<string, unknown>[];
  return rows.map(rowToEdge);
}

export function countRelationships(): number {
  return (getDb().prepare('SELECT COUNT(*) n FROM entity_relationships').get() as { n: number }).n;
}

// ── Enrichment runs ───────────────────────────────────────────────

export interface EnrichmentRunTotals {
  companiesAttempted: number;
  foundersVerified: number;
  foundersCandidate: number;
  foundersConflicting: number;
  foundersExhausted: number;
  foundersManualReview: number;
  verticalsClassified: number;
  verticalsUnclassifiable: number;
  stagesNamed: number;
  stagesBounded: number;
  stagesConflicting: number;
}

export const EMPTY_TOTALS: EnrichmentRunTotals = {
  companiesAttempted: 0,
  foundersVerified: 0,
  foundersCandidate: 0,
  foundersConflicting: 0,
  foundersExhausted: 0,
  foundersManualReview: 0,
  verticalsClassified: 0,
  verticalsUnclassifiable: 0,
  stagesNamed: 0,
  stagesBounded: 0,
  stagesConflicting: 0,
};

export function startEnrichmentRun(args: {
  id: string; mode: 'dry-run' | 'apply'; scope: string; initiatedBy: string;
}): void {
  getDb().prepare(`
    INSERT INTO enrichment_runs (id, at, mode, scope, status, initiated_by)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(args.id, now(), args.mode, args.scope, args.initiatedBy);
}

export function completeEnrichmentRun(
  id: string,
  totals: EnrichmentRunTotals,
  sourceErrors: { sourceFamily: string; detail: string; count: number }[],
  status: 'Completed' | 'Completed with warnings' | 'Failed',
): void {
  getDb().prepare(`
    UPDATE enrichment_runs SET
      completed_at = ?, companies_attempted = ?, founders_verified = ?, founders_candidate = ?,
      founders_conflicting = ?, founders_exhausted = ?, founders_manual_review = ?,
      verticals_classified = ?, verticals_unclassifiable = ?,
      stages_named = ?, stages_bounded = ?, stages_conflicting = ?,
      source_errors = ?, status = ?
    WHERE id = ?
  `).run(
    now(), totals.companiesAttempted, totals.foundersVerified, totals.foundersCandidate,
    totals.foundersConflicting, totals.foundersExhausted, totals.foundersManualReview,
    totals.verticalsClassified, totals.verticalsUnclassifiable,
    totals.stagesNamed, totals.stagesBounded, totals.stagesConflicting,
    JSON.stringify(sourceErrors), status, id,
  );
}

/**
 * The most recent run, for `--resume`.
 *
 * Resume works off the per-company attempt records rather than off a
 * cursor stored here, because a cursor goes stale the moment a company
 * is added or removed. "Which companies have no attempt newer than the
 * last run" is a question the data can always answer correctly.
 */
export function lastCompletedEnrichmentRun(): { id: string; at: string; completedAt: string | null } | null {
  const row = getDb().prepare(`
    SELECT id, at, completed_at FROM enrichment_runs
    WHERE status IN ('Completed', 'Completed with warnings')
    ORDER BY at DESC LIMIT 1
  `).get() as { id: string; at: string; completed_at: string | null } | undefined;
  return row ? { id: row.id, at: row.at, completedAt: row.completed_at } : null;
}

/** Companies with no founder-research attempt at all — the `--resume` work list. */
export function companyIdsWithoutResearch(): string[] {
  const rows = getDb().prepare(`
    SELECT c.id FROM companies c
    WHERE c.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM founder_research_attempts a WHERE a.company_id = c.id)
    ORDER BY c.created_at, c.id
  `).all() as { id: string }[];
  return rows.map((r) => r.id);
}

// ── Reviewer corrections ──────────────────────────────────────────

export function recordFieldCorrection(c: {
  companyId: string;
  field: CorrectableField;
  previousValue: string | null;
  newValue: string;
  reason: string;
  sourceUrl: string | null;
  reviewer: { id: string; label: string; source: string };
}): number {
  const res = getDb().prepare(`
    INSERT INTO field_corrections (
      company_id, field, previous_value, new_value, reason, source_url,
      reviewer_id, reviewer_label, reviewer_source, at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.companyId, c.field, c.previousValue, c.newValue, c.reason, c.sourceUrl,
    c.reviewer.id, c.reviewer.label, c.reviewer.source, now(),
  );
  return Number(res.lastInsertRowid);
}

function rowToCorrection(r: Record<string, unknown>): FieldCorrection {
  return {
    id: r.id as number,
    companyId: r.company_id as string,
    field: r.field as CorrectableField,
    previousValue: (r.previous_value as string | null) ?? null,
    newValue: r.new_value as string,
    reason: r.reason as string,
    sourceUrl: (r.source_url as string | null) ?? null,
    reviewerId: r.reviewer_id as string,
    reviewerLabel: r.reviewer_label as string,
    reviewerSource: r.reviewer_source as string,
    at: r.at as string,
  };
}

export function listFieldCorrections(companyId: string): FieldCorrection[] {
  const rows = getDb().prepare('SELECT * FROM field_corrections WHERE company_id = ? ORDER BY at DESC, id DESC')
    .all(companyId) as Record<string, unknown>[];
  return rows.map(rowToCorrection);
}

export function allFieldCorrections(): Record<string, FieldCorrection[]> {
  const rows = getDb().prepare('SELECT * FROM field_corrections ORDER BY company_id, at DESC, id DESC')
    .all() as Record<string, unknown>[];
  const out: Record<string, FieldCorrection[]> = {};
  for (const r of rows) (out[r.company_id as string] ??= []).push(rowToCorrection(r));
  return out;
}

/**
 * The latest reviewer correction per field, which is what the read path
 * layers over the automated verdict. Earlier corrections stay in the
 * table — this picks the current one without deleting the history.
 */
export function latestCorrections(companyId: string): Partial<Record<CorrectableField, FieldCorrection>> {
  const out: Partial<Record<CorrectableField, FieldCorrection>> = {};
  for (const c of listFieldCorrections(companyId)) {
    if (!out[c.field]) out[c.field] = c;
  }
  return out;
}

export { ENRICHMENT_VERSION };
