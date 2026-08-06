import { z } from 'zod';
import { getDb } from '../client';
import { discoveryRunSchema, type DiscoveryRun } from '../../../shared/discovery';
import { DEFAULT_STALE_SETTINGS, staleSettingsSchema, STALE_SETTINGS_KEY, type StaleSettings } from '../../../shared/integrations';

/**
 * Operational repositories: source runs, review decisions, scoring
 * results, HubSpot sync history, integration health, and sourcing
 * configuration.
 */

const now = () => new Date().toISOString();

// ── Source runs ──────────────────────────────────────────────────

export function saveRun(run: DiscoveryRun): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO source_runs (id, at, completed_at, run_type, mode, query, discovered, updated_existing,
      duplicates_skipped, duplicates_identified, filtered_by_policy, rejected_by_validation, imported, errors,
      api_calls, model_calls, estimated_tokens, estimated_cost_usd, duration_ms, status, initiated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id, run.at, run.completedAt, run.runType, run.mode, JSON.stringify(run.query), run.discovered, run.updatedExisting,
    run.duplicatesSkipped, run.duplicatesIdentified, run.filteredByPolicy, run.rejectedByValidation, run.imported,
    JSON.stringify(run.errors), run.apiCalls, run.modelCalls, run.estimatedTokens, run.estimatedCostUsd,
    run.durationMs, run.status, run.initiatedBy,
  );
  db.prepare('DELETE FROM source_run_results WHERE run_id = ?').run(run.id);
  const insert = db.prepare('INSERT INTO source_run_results (run_id, position, source_id, mode, found, detail, failure_kind, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  run.sourceResults.forEach((r, i) => insert.run(run.id, i, r.sourceId, r.mode, r.found, r.detail, r.failureKind ?? null, r.durationMs ?? null));
}

export function listRuns(limit = 100): DiscoveryRun[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM source_runs ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  const runs: DiscoveryRun[] = [];
  for (const r of rows) {
    const results = db.prepare('SELECT source_id, mode, found, detail, failure_kind, duration_ms FROM source_run_results WHERE run_id = ? ORDER BY position').all(r.id as string) as
      { source_id: string; mode: string; found: number; detail: string; failure_kind: string | null; duration_ms: number | null }[];
    // Rows written before migration v4 have no completed_at — derive it
    // from the duration so old history still renders a sensible end time.
    const completedAt = (r.completed_at as string | null) ?? new Date(new Date(r.at as string).getTime() + (r.duration_ms as number)).toISOString();
    const parsed = discoveryRunSchema.safeParse({
      id: r.id, at: r.at, completedAt, runType: r.run_type, mode: r.mode, query: JSON.parse(r.query as string),
      sourceResults: results.map((x) => ({
        sourceId: x.source_id, mode: x.mode, found: x.found, detail: x.detail,
        ...(x.failure_kind ? { failureKind: x.failure_kind } : {}),
        ...(x.duration_ms !== null ? { durationMs: x.duration_ms } : {}),
      })),
      discovered: r.discovered, updatedExisting: r.updated_existing, duplicatesSkipped: r.duplicates_skipped,
      duplicatesIdentified: r.duplicates_identified ?? 0, filteredByPolicy: r.filtered_by_policy ?? 0,
      rejectedByValidation: r.rejected_by_validation, imported: r.imported, errors: JSON.parse(r.errors as string),
      apiCalls: r.api_calls, modelCalls: r.model_calls, estimatedTokens: r.estimated_tokens,
      estimatedCostUsd: r.estimated_cost_usd, durationMs: r.duration_ms, status: r.status, initiatedBy: r.initiated_by,
    });
    if (parsed.success) runs.push(parsed.data);
  }
  return runs;
}

export function updateRunCounts(runId: string, counts: { imported: number; updatedExisting: number }): void {
  getDb().prepare('UPDATE source_runs SET imported = ?, updated_existing = ? WHERE id = ?')
    .run(counts.imported, counts.updatedExisting, runId);
}

// ── Review decisions ─────────────────────────────────────────────

/**
 * The single place a company-level review timestamp gets stamped
 * (companies.last_reviewed_at).
 *
 * Every call of this function is reached only via an interactive
 * analyst-route action (never the automated discovery or enrichment
 * pipelines, which only ever call this with subjectType 'candidate') —
 * but not every interactive action represents actual analyst JUDGMENT
 * about the company, so subjectType 'company' alone is not sufficient.
 * `countsAsCompanyReview` (default true) is the explicit opt-out for
 * the one exception: "Refresh live research" re-queries live sources
 * and merges whatever it finds — real work was done, but no analyst
 * judgment was exercised, so a call for that action passes `false`.
 * Everything else that reaches this function with subjectType='company'
 * — a status/disposition change, "Mark reviewed", a note, or a
 * founder-candidate confirm/reject recorded against its company — does
 * represent a human decision about THIS company and keeps the default.
 *
 * Because actor is an unauthenticated free string in this build (no
 * per-user accounts), this records that a company-level review ACTION
 * happened, attributed to whatever actor string the caller supplied —
 * not a cryptographically verified human identity.
 */
export function recordReviewDecision(args: {
  subjectType: 'candidate' | 'company' | 'possible-duplicate';
  subjectId: string;
  decision: string;
  actor: string;
  reason?: string;
  countsAsCompanyReview?: boolean;
}): void {
  const at = now();
  const db = getDb();
  db.prepare('INSERT INTO review_decisions (subject_type, subject_id, decision, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(args.subjectType, args.subjectId, args.decision, args.actor, args.reason ?? '', at);
  if (args.subjectType === 'company' && args.countsAsCompanyReview !== false) {
    db.prepare("UPDATE companies SET last_reviewed_at = ? WHERE id = ? AND status = 'active'").run(at, args.subjectId);
  }
}

export function listReviewDecisions(subjectId?: string): { subjectType: string; subjectId: string; decision: string; actor: string; reason: string; at: string }[] {
  const db = getDb();
  const rows = (subjectId
    ? db.prepare('SELECT * FROM review_decisions WHERE subject_id = ? ORDER BY id DESC').all(subjectId)
    : db.prepare('SELECT * FROM review_decisions ORDER BY id DESC LIMIT 200').all()) as Record<string, unknown>[];
  return rows.map((r) => ({
    subjectType: r.subject_type as string, subjectId: r.subject_id as string,
    decision: r.decision as string, actor: r.actor as string, reason: r.reason as string, at: r.at as string,
  }));
}

// ── Scoring results ──────────────────────────────────────────────

const scoreComponentsSchema = z.array(z.object({ key: z.string(), label: z.string(), points: z.number(), max: z.number(), rationale: z.string() }));

export function saveScore(
  companyId: string,
  fit: {
    score: number;
    totalPoints: number;
    components: { key: string; label: string; points: number; max: number; rationale: string }[];
    exceptions: { flag: string; message: string }[];
    version: string;
    evidenceConfidence: number;
    explanation: string;
    provisional?: boolean;
    completeness?: number;
    assessablePoints?: number;
  },
  supportingEvidenceUrls: string[] = [],
): void {
  getDb().prepare(`
    INSERT INTO scoring_results (company_id, score, total_points, components, exceptions, version, evidence_confidence, explanation, supporting_evidence, computed_at, provisional, completeness, assessable_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId, fit.score, fit.totalPoints, JSON.stringify(fit.components), JSON.stringify(fit.exceptions),
    fit.version, fit.evidenceConfidence, fit.explanation, JSON.stringify(supportingEvidenceUrls), now(),
    fit.provisional ? 1 : 0, fit.completeness ?? null, fit.assessablePoints ?? null,
  );
}

export function latestScore(companyId: string): {
  score: number;
  totalPoints: number;
  components: z.infer<typeof scoreComponentsSchema>;
  version: string;
  evidenceConfidence: number | null;
  explanation: string;
  supportingEvidence: string[];
  computedAt: string;
  provisional: boolean;
  completeness: number | null;
  assessablePoints: number | null;
} | null {
  const row = getDb().prepare('SELECT score, total_points, components, version, evidence_confidence, explanation, supporting_evidence, computed_at, provisional, completeness, assessable_points FROM scoring_results WHERE company_id = ? ORDER BY id DESC LIMIT 1')
    .get(companyId) as { score: number; total_points: number; components: string; version: string; evidence_confidence: number | null; explanation: string; supporting_evidence: string; computed_at: string; provisional: number; completeness: number | null; assessable_points: number | null } | undefined;
  if (!row) return null;
  return {
    score: row.score,
    totalPoints: row.total_points,
    components: scoreComponentsSchema.catch([]).parse(JSON.parse(row.components)),
    version: row.version,
    evidenceConfidence: row.evidence_confidence,
    explanation: row.explanation,
    supportingEvidence: z.array(z.string()).catch([]).parse(JSON.parse(row.supporting_evidence)),
    computedAt: row.computed_at,
    provisional: row.provisional === 1,
    completeness: row.completeness,
    assessablePoints: row.assessable_points,
  };
}

/** Latest score for every company, in one query — avoids N+1 per-company lookups for aggregate KPIs. */
export function latestScoresForAllCompanies(): Map<string, { score: number; provisional: boolean }> {
  const rows = getDb().prepare(`
    SELECT sr.company_id, sr.score, sr.provisional
    FROM scoring_results sr
    WHERE sr.id = (SELECT MAX(id) FROM scoring_results WHERE company_id = sr.company_id)
  `).all() as { company_id: string; score: number; provisional: number }[];
  return new Map(rows.map((r) => [r.company_id, { score: r.score, provisional: r.provisional === 1 }]));
}

// ── HubSpot sync history ─────────────────────────────────────────

export function recordHubspotSync(args: {
  companyId: string;
  action: string;
  hubspotCompanyId?: string | null;
  hubspotDealId?: string | null;
  contactCount?: number;
  outcome: 'ok' | 'error';
  detail: string;
  /** Full request payload (JSON) — kept so failed syncs can be retried. */
  payload?: unknown;
}): void {
  getDb().prepare(`
    INSERT INTO hubspot_sync_history (company_id, action, hubspot_company_id, hubspot_deal_id, contact_count, outcome, detail, at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(args.companyId, args.action, args.hubspotCompanyId ?? null, args.hubspotDealId ?? null, args.contactCount ?? 0, args.outcome, args.detail, now(), args.payload === undefined ? null : JSON.stringify(args.payload));
}

/** The most recent FAILED sync for a company, with its stored payload (for retry). */
export function lastFailedHubspotSync(companyId: string): { id: number; detail: string; at: string; payload: unknown } | null {
  const row = getDb().prepare(`
    SELECT id, detail, at, payload FROM hubspot_sync_history
    WHERE company_id = ? AND outcome = 'error' AND payload IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(companyId) as { id: number; detail: string; at: string; payload: string } | undefined;
  if (!row) return null;
  try {
    return { id: row.id, detail: row.detail, at: row.at, payload: JSON.parse(row.payload) };
  } catch {
    return null;
  }
}

/** Companies whose most recent sync attempt failed (retry candidates). */
export function failedHubspotSyncs(): { companyId: string; detail: string; at: string }[] {
  const rows = getDb().prepare(`
    SELECT h.company_id, h.detail, h.at FROM hubspot_sync_history h
    JOIN (SELECT company_id, MAX(id) AS max_id FROM hubspot_sync_history GROUP BY company_id) latest
      ON latest.company_id = h.company_id AND latest.max_id = h.id
    WHERE h.outcome = 'error'
    ORDER BY h.id DESC LIMIT 50
  `).all() as { company_id: string; detail: string; at: string }[];
  return rows.map((r) => ({ companyId: r.company_id, detail: r.detail, at: r.at }));
}

export function listHubspotSyncHistory(companyId?: string): { companyId: string; action: string; hubspotCompanyId: string | null; hubspotDealId: string | null; contactCount: number; outcome: string; detail: string; at: string }[] {
  const db = getDb();
  const rows = (companyId
    ? db.prepare('SELECT * FROM hubspot_sync_history WHERE company_id = ? ORDER BY id DESC').all(companyId)
    : db.prepare('SELECT * FROM hubspot_sync_history ORDER BY id DESC LIMIT 200').all()) as Record<string, unknown>[];
  return rows.map((r) => ({
    companyId: r.company_id as string, action: r.action as string,
    hubspotCompanyId: (r.hubspot_company_id as string | null) ?? null,
    hubspotDealId: (r.hubspot_deal_id as string | null) ?? null,
    contactCount: r.contact_count as number, outcome: r.outcome as string,
    detail: r.detail as string, at: r.at as string,
  }));
}

// ── Integration health ───────────────────────────────────────────

export function recordIntegrationHealth(provider: string, ok: boolean, status: string, detail: string): void {
  getDb().prepare(`
    INSERT INTO integration_health (provider, ok, status, detail, checked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (provider) DO UPDATE SET ok = excluded.ok, status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at
  `).run(provider, ok ? 1 : 0, status, detail, now());
}

export function integrationHealth(): { provider: string; ok: boolean; status: string; detail: string; checkedAt: string }[] {
  const rows = getDb().prepare('SELECT * FROM integration_health ORDER BY provider').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    provider: r.provider as string, ok: Boolean(r.ok), status: r.status as string,
    detail: r.detail as string, checkedAt: r.checked_at as string,
  }));
}

// ── Sourcing configuration ───────────────────────────────────────

export function getConfig<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM sourcing_config WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  const parsed = schema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : fallback;
}

export function setConfig(key: string, value: unknown): void {
  getDb().prepare(`
    INSERT INTO sourcing_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now());
}

// ── Stale-record settings (Phase 10) ──────────────────────────────
// Persisted via the same generic config store above — no new table,
// no server restart or code change needed to change how staleness is
// computed. See shared/integrations.ts#staleSettingsSchema for what
// each field means and how it differs from schedule refresh-age /
// evidence-recency filters.

export function getStaleSettings(): StaleSettings {
  return getConfig(STALE_SETTINGS_KEY, staleSettingsSchema, DEFAULT_STALE_SETTINGS);
}

export function setStaleSettings(patch: Partial<StaleSettings>): StaleSettings {
  const merged = staleSettingsSchema.parse({ ...getStaleSettings(), ...patch });
  setConfig(STALE_SETTINGS_KEY, merged);
  return merged;
}
