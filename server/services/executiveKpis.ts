import { getDb } from '../db/client';
import { latestScoresForAllCompanies } from '../db/repos/operations';
import { TERMINAL_COMPANY_STATUSES } from '../../shared/integrations';
import { CORE_VERTICAL_IDS } from '../../src/data/taxonomy';
import { HOT_THRESHOLD } from '../../shared/scoringThresholds';
import type { VerticalId } from '../../src/types';
import type {
  CumulativePeriod, CumulativePeriodResult, EntityKpis, ExecutiveKpis, VerticalBreakdown,
} from '../../shared/executiveKpis';

/**
 * Executive Overview KPIs — Companies and Stealth Founders, five cards
 * each. Every number here reads persisted rows; nothing is invented, and
 * every breakdown reconciles exactly to its own total (enforced by
 * construction here, and by tests).
 *
 * Vertical breakdowns are keyed by the 5 APPROVED core verticals only
 * (CORE_VERTICAL_IDS, src/data/taxonomy.ts). The legacy 'aoi' ("Other
 * Industries") bucket and anything else unrecognized fold into
 * `unassigned` — this changes only the PRESENTATION of the breakdown;
 * the underlying company.vertical / founder's company vertical value on
 * each row is untouched, so no historical data is altered or lost.
 *
 * "Stale" uses a FIXED 7-day threshold, deliberately separate from the
 * admin-configurable staleAfterDays setting used elsewhere in the app
 * (Settings → Stale-record settings, CompanyTable, the existing Overview
 * stale banner) — this is a distinct, executive-facing metric the task
 * specifies as exactly seven days, not a redefinition of the general one.
 *
 * The 7-day comparison is `now - lastTouchMs >= 7 * 86_400_000` — a raw
 * millisecond difference, exactly 168 hours, with no calendar/timezone
 * rounding. Every timestamp involved is UTC: last_reviewed_at/created_at
 * are full ISO datetimes with an explicit 'Z' offset; discovered_at is
 * DATE-ONLY (YYYY-MM-DD, no time-of-day) and JS parses a bare date
 * string as UTC midnight for that date — so a company actually
 * discovered at 23:00 UTC still has its 7-day clock start at 00:00 UTC
 * the same day, up to ~23 hours earlier than the true discovery moment.
 * This is an inherent precision limit of discovered_at's schema (date
 * only), not something this KPI logic introduces or can correct.
 *
 * "Discovered This Week" and Cumulative's time filters use the same UTC
 * convention: this codebase has no other timezone convention anywhere
 * (every stored timestamp is UTC), so calendar-week/month/year
 * boundaries are computed in UTC throughout, not the server's local time.
 */

const KNOWN_VERTICAL_IDS: VerticalId[] = [...CORE_VERTICAL_IDS]; // the 5 APPROVED verticals only — see header comment
const SEVEN_DAYS_MS = 7 * 86_400_000;

function emptyBreakdown(): VerticalBreakdown {
  const byVertical: Record<string, number> = {};
  for (const id of KNOWN_VERTICAL_IDS) byVertical[id] = 0;
  return { total: 0, byVertical, unassigned: 0 };
}

/** Builds a reconciling breakdown: total always equals sum(byVertical) + unassigned. */
function buildBreakdown(verticals: (string | null)[]): VerticalBreakdown {
  const b = emptyBreakdown();
  for (const v of verticals) {
    if (v && (KNOWN_VERTICAL_IDS as string[]).includes(v)) b.byVertical[v] += 1;
    else b.unassigned += 1;
  }
  b.total = verticals.length;
  return b;
}

/** ISO-8601 week: Monday 00:00:00.000 UTC through the following Monday (exclusive), for the UTC calendar date of `now`. */
function isoWeekBounds(now: number): { weekStart: string; weekEnd: string } {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7; // days since the most recent Monday
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMonday);
  const nextMonday = monday + 7 * 86_400_000;
  return { weekStart: new Date(monday).toISOString(), weekEnd: new Date(nextMonday).toISOString() };
}

/** [from, to) UTC calendar bounds for a Cumulative time filter. `to: null` means open-ended ("to date"). */
function periodBounds(period: CumulativePeriod, now: number): { from: string | null; to: string | null } {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-11
  switch (period) {
    case 'all-time':
      return { from: null, to: null };
    case 'this-month':
      return { from: new Date(Date.UTC(y, m, 1)).toISOString(), to: null };
    case 'last-month':
      return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
    case 'this-year':
      return { from: new Date(Date.UTC(y, 0, 1)).toISOString(), to: null };
    case 'last-year':
      return { from: new Date(Date.UTC(y - 1, 0, 1)).toISOString(), to: new Date(Date.UTC(y, 0, 1)).toISOString() };
  }
}

interface CompanyRow {
  id: string;
  vertical: string;
  review_status: string | null;
  discovery_source: string | null;
  discovery_run_id: string | null;
  discovered_at: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  quarantined: number;
}

/**
 * Last HUMAN touch only. last_refreshed is deliberately excluded — it is
 * also written by the automated bulk connector/stale-record refresh
 * sweep (server/services/refresh.ts), which is not a human reviewing
 * anything. last_reviewed_at is stamped only by recordReviewDecision for
 * subject_type='company' (server/db/repos/operations.ts), which counts
 * only interactive analyst-route actions — see that function's doc
 * comment for the full list and how it was verified.
 */
function lastTouchMs(c: CompanyRow): number {
  return new Date(c.last_reviewed_at ?? c.discovered_at ?? c.created_at).getTime();
}

/** A company's EFFECTIVE discovery/sourcing date, for "Discovered This Week" and Cumulative's time filters — never review/refresh/enrichment/scoring dates. */
function companyDiscoveryMs(c: Pick<CompanyRow, 'discovered_at' | 'created_at'>): number {
  return new Date(c.discovered_at ?? c.created_at).getTime();
}

interface RunPartialInfo {
  isPartial: boolean;
  warningCount: number;
  affectedSources: string[];
}

/** Partial-run detail for a source_runs row: which sources failed/were skipped. */
function companyRunPartialInfo(db: ReturnType<typeof getDb>, runId: string, status: string): RunPartialInfo {
  if (status !== 'Completed with warnings') return { isPartial: false, warningCount: 0, affectedSources: [] };
  const rows = db.prepare(`
    SELECT source_id FROM source_run_results WHERE run_id = ? AND mode IN ('failed', 'skipped')
  `).all(runId) as { source_id: string }[];
  const affectedSources = [...new Set(rows.map((r) => r.source_id))];
  return { isPartial: true, warningCount: rows.length, affectedSources };
}

function companyRows(db: ReturnType<typeof getDb>): CompanyRow[] {
  return db.prepare(`
    SELECT id, vertical, review_status, discovery_source, discovery_run_id, discovered_at, last_reviewed_at, created_at, quarantined
    FROM companies WHERE status = 'active'
  `).all() as unknown as CompanyRow[];
}

export function computeCompanyKpis(now: number = Date.now()): EntityKpis {
  const db = getDb();
  const rows = companyRows(db);

  // Last Run: the most recent run_discovery run that reached a completed
  // state (Completed / Completed with warnings) — Cancelled/Failed runs
  // pulled nothing worth reporting as "the last run", and must never be
  // selected here regardless of how recent they are. Simulated runs are
  // excluded too: by definition no live source ran, so nothing was
  // genuinely pulled. Retained for consumers other than the Overview
  // cards (see RunAttributedBreakdown doc comment) — the visible "Last
  // Run" card was replaced by "Discovered This Week" per updated
  // feedback, but nothing about computing this changed.
  // Tie-break on rowid (SQLite's implicit insertion-order column — this
  // table is not WITHOUT ROWID) in case two rows ever share the same
  // completed_at millisecond. In practice this can't happen for
  // discovery runs specifically: they're mutex-serialized
  // (acquireRunLock/releaseRunLock in server/services/discovery.ts), so
  // no two can be executing — and therefore completing — at once. The
  // tie-break is defensive, not a response to an observed collision.
  /**
   * `mode <> 'simulated'` is in the query now, not only in the comment
   * above it.
   *
   * The comment claimed simulated runs were excluded "by definition no
   * live source ran"; the predicate filtered on `status` and
   * `completed_at` only. `source_runs.mode` is a real column whose values
   * include 'simulated' and 'mixed' (shared/discovery.ts), so a simulated
   * run could be selected and reported as the latest run that pulled
   * data. A stated guarantee that the SQL does not implement is worse
   * than no guarantee, because the next reader trusts it.
   *
   * 'mixed' is kept: part of that run did hit live sources.
   */
  const lastRunRow = db.prepare(`
    SELECT id, completed_at, status FROM source_runs
    WHERE status IN ('Completed', 'Completed with warnings')
      AND completed_at IS NOT NULL
      AND (mode IS NULL OR mode <> 'simulated')
    ORDER BY completed_at DESC, rowid DESC LIMIT 1
  `).get() as { id: string; completed_at: string; status: string } | undefined;

  const lastRunCompanies = lastRunRow
    ? rows.filter((c) => c.discovery_run_id === lastRunRow.id)
    : [];
  const partialInfo = lastRunRow ? companyRunPartialInfo(db, lastRunRow.id, lastRunRow.status) : { isPartial: false, warningCount: 0, affectedSources: [] };
  const lastRun = {
    ...buildBreakdown(lastRunCompanies.map((c) => c.vertical)),
    runId: lastRunRow?.id ?? null,
    runType: 'discovery' as const,
    runLabel: 'Company-sourcing run',
    runStatus: lastRunRow?.status ?? null,
    runCompletedAt: lastRunRow?.completed_at ?? null,
    ...partialInfo,
  };

  // Discovered This Week: retained SOURCED companies whose effective
  // discovery date (discovered_at, falling back to created_at) falls
  // within the current ISO-8601 UTC week [Monday 00:00, next Monday).
  const { weekStart, weekEnd } = isoWeekBounds(now);
  const weekStartMs = new Date(weekStart).getTime();
  const weekEndMs = new Date(weekEnd).getTime();
  const discoveredThisWeekCompanies = rows.filter((c) => {
    if (!c.discovery_source) return false;
    const t = companyDiscoveryMs(c);
    return t >= weekStartMs && t < weekEndMs;
  });
  const discoveredThisWeek = { ...buildBreakdown(discoveredThisWeekCompanies.map((c) => c.vertical)), weekStart, weekEnd };

  // Awaiting Review: the SAME predicate the application already used
  // (formerly Overview.tsx's client-side "awaitingReview" stat, traced
  // rather than reinvented) — an active, non-quarantined company whose
  // review_status is still New or Awaiting Review (absent review_status
  // defaults to 'New', matching companyMetaView's own convention).
  // Quarantined records (publicly traded, fund/SPV, etc.) are already
  // DECIDED, not waiting on anyone, so they're excluded here exactly as
  // the original stat excluded them.
  const awaitingReviewCompanies = rows.filter((c) => {
    if (c.quarantined) return false;
    const status = c.review_status ?? 'New';
    return status === 'New' || status === 'Awaiting Review';
  });
  const awaitingReview = buildBreakdown(awaitingReviewCompanies.map((c) => c.vertical));

  // `companies.status` is the RECORD-LIFECYCLE field — its only two
  // values are 'active' and 'merged' (set exclusively by an actual
  // merge-into-another-company action, server/db/repos/companies.ts).
  // It is NOT the pipeline-disposition field: New, Awaiting Review,
  // Research Needed, Approved for HubSpot, Synced to HubSpot, Monitor,
  // and Passed all live in the SEPARATE `review_status` column and never
  // touch `status`. So `WHERE status = 'active'` here and throughout
  // this file excludes only confirmed-duplicate merges — every pipeline
  // disposition, including Passed/Monitor/Approved/Synced, is included.
  //
  // Cumulative: every company that came from sourcing (as opposed to a
  // CSV import or another manual path, which never set discovery_source),
  // regardless of its current pipeline disposition. This is the
  // ALL-TIME figure; see computeCumulativePeriod for the time-filtered
  // versions the Cumulative modal offers. Note: a company can be
  // hard-deleted via the "Clear imported" admin action
  // (server/services/imports.ts clearCompanies) — this count reflects
  // all RETAINED discovered companies still in the database, not a
  // separately-tracked ledger, and cannot recover anything hard-deleted
  // before this reads.
  const sourced = rows.filter((c) => !!c.discovery_source);
  const cumulative = buildBreakdown(sourced.map((c) => c.vertical));

  // Stale: fixed 7-day rule, HUMAN review only (see lastTouchMs).
  // Never-reviewed counts as stale once it has existed 7+ days; a
  // reviewed record is stale once its last human review is 7+ days old.
  // Terminal statuses (Synced to HubSpot, Passed) are never stale — the
  // same exclusion companyMetaView already applies elsewhere.
  const staleCompanies = rows.filter((c) => {
    if (c.review_status && (TERMINAL_COMPANY_STATUSES as readonly string[]).includes(c.review_status)) return false;
    // Age-only check: a never-reviewed company's lastTouch falls back to
    // discovered_at/created_at, so "never reviewed, 7+ days old" and
    // "reviewed, but not for 7+ days" both fall out of the same age test.
    return now - lastTouchMs(c) >= SEVEN_DAYS_MS;
  });
  const stale = buildBreakdown(staleCompanies.map((c) => c.vertical));

  // Hot: the MOST RECENT scoring_results row per company (MAX(id), see
  // latestScoresForAllCompanies) must itself be non-provisional and
  // >= HOT_THRESHOLD. This is deliberately "is the current score hot",
  // not "was any past score hot" — if the latest scoring pass for a
  // company happens to be provisional, that company is not Hot this
  // instant even if an older pass had scored higher; falling back to a
  // stale earlier score would contradict "always reflects current state".
  const scores = latestScoresForAllCompanies();
  const hotCompanies = rows.filter((c) => {
    const s = scores.get(c.id);
    return !!s && !s.provisional && s.score >= HOT_THRESHOLD;
  });
  const hot = buildBreakdown(hotCompanies.map((c) => c.vertical));

  return { lastRun, discoveredThisWeek, awaitingReview, stale, hot, cumulative };
}

interface FounderRow {
  id: number;
  company_id: string;
  review_decision: string | null;
  reviewed_at: string | null;
  first_seen_at: string;
  discovered_run_id: string | null;
  vertical: string | null;
}

interface EnrichmentSourceError { sourceFamily: string; detail: string; count: number }

/** Partial-run detail for an enrichment_runs row: which source families reported errors. */
function enrichmentRunPartialInfo(sourceErrorsJson: string, status: string): RunPartialInfo {
  if (status !== 'Completed with warnings') return { isPartial: false, warningCount: 0, affectedSources: [] };
  let errors: EnrichmentSourceError[] = [];
  try {
    errors = JSON.parse(sourceErrorsJson);
  } catch {
    errors = [];
  }
  return {
    isPartial: true,
    warningCount: errors.reduce((sum, e) => sum + (e.count ?? 1), 0),
    affectedSources: [...new Set(errors.map((e) => e.sourceFamily))],
  };
}

function founderRows(db: ReturnType<typeof getDb>): FounderRow[] {
  // ALL sourced founder candidates — including rejected ones. A rejection
  // is a human verdict recorded AFTER the platform surfaced the
  // candidate; it does not mean the candidate was never sourced. "Hot"
  // is the one metric that still excludes rejected candidates, since a
  // dismissed candidate isn't a live prospect — a narrower, deliberate
  // exception, not the default for every metric.
  return db.prepare(`
    SELECT fc.id, fc.company_id, fc.review_decision, fc.reviewed_at, fc.first_seen_at, fc.discovered_run_id,
           c.vertical AS vertical
    FROM founder_candidates fc
    JOIN companies c ON c.id = fc.company_id AND c.status = 'active'
  `).all() as unknown as FounderRow[];
}

export function computeFounderKpis(now: number = Date.now()): EntityKpis {
  const db = getDb();
  const rows = founderRows(db);

  // "Last Run" here is NOT a founder-sourcing run — no such thing exists
  // in this codebase. Founder candidates are a side effect of company
  // enrichment (server/services/enrichment.ts upsertFounderCandidate),
  // so this is explicitly labelled and typed as an enrichment run
  // (runType/runLabel below), never described as sourcing. A Failed
  // enrichment run must never be selected, same as for companies.
  // Unlike discovery runs, enrichment runs have NO mutex — nothing in
  // this codebase prevents two enrichment runs from executing
  // concurrently (confirmed: no acquireRunLock-equivalent exists for
  // enrichment). A completed_at tie is therefore a real, if unlikely,
  // possibility here, not just a defensive formality — rowid (SQLite's
  // implicit insertion-order column) breaks the tie deterministically.
  const lastRunRow = db.prepare(`
    SELECT id, completed_at, status, source_errors FROM enrichment_runs
    WHERE mode = 'apply' AND status IN ('Completed', 'Completed with warnings') AND completed_at IS NOT NULL
    ORDER BY completed_at DESC, rowid DESC LIMIT 1
  `).get() as { id: string; completed_at: string; status: string; source_errors: string } | undefined;

  const lastRunFounders = lastRunRow
    ? rows.filter((f) => f.discovered_run_id === lastRunRow.id)
    : [];
  const founderPartialInfo = lastRunRow ? enrichmentRunPartialInfo(lastRunRow.source_errors, lastRunRow.status) : { isPartial: false, warningCount: 0, affectedSources: [] };
  const lastRun = {
    ...buildBreakdown(lastRunFounders.map((f) => f.vertical)),
    runId: lastRunRow?.id ?? null,
    runType: 'enrichment' as const,
    runLabel: 'Latest enrichment run',
    runStatus: lastRunRow?.status ?? null,
    runCompletedAt: lastRunRow?.completed_at ?? null,
    ...founderPartialInfo,
  };

  // Discovered This Week: founders whose first_seen_at (their own
  // sourcing/discovery timestamp — never reviewed_at) falls within the
  // current ISO-8601 UTC week.
  const { weekStart, weekEnd } = isoWeekBounds(now);
  const weekStartMs = new Date(weekStart).getTime();
  const weekEndMs = new Date(weekEnd).getTime();
  const discoveredThisWeekFounders = rows.filter((f) => {
    const t = new Date(f.first_seen_at).getTime();
    return t >= weekStartMs && t < weekEndMs;
  });
  const discoveredThisWeek = { ...buildBreakdown(discoveredThisWeekFounders.map((f) => f.vertical)), weekStart, weekEnd };

  // Awaiting Review: the SAME predicate the Stealth Radar UI already
  // uses to decide whether to show the confirm/reject action for a
  // candidate (src/pages/StealthRadar.tsx: `{!person.reviewDecision && (...)}`)
  // — a founder candidate with no review_decision yet. Traced from that
  // existing UI condition, not invented.
  const awaitingReviewFounders = rows.filter((f) => f.review_decision === null);
  const awaitingReview = buildBreakdown(awaitingReviewFounders.map((f) => f.vertical));

  // Cumulative: every RETAINED founder candidate, rejected or not — same
  // caveat as companies' cumulative above, and it applies transitively
  // here too: founder_candidates.company_id REFERENCES companies(id) ON
  // DELETE CASCADE (server/db/migrations.ts), and this database runs
  // with `PRAGMA foreign_keys = ON` (server/db/client.ts) — proven with
  // an isolated in-memory test, not assumed — so hard-deleting a company
  // (clearCompanies()) silently cascade-deletes its founder_candidates
  // rows too. This count reflects what still exists, not an append-only
  // ledger of everything ever sourced.
  const cumulative = buildBreakdown(rows.map((f) => f.vertical));

  // Stale: fixed 7-day rule, human review only. founder_candidates.
  // reviewed_at is ALREADY human-only — it is written exclusively by
  // reviewFounderCandidate (server/db/repos/enrichment.ts), called only
  // from the Stealth Radar confirm/reject action
  // (server/services/stealthRadar.ts reviewCandidate). No automated
  // process ever touches it, so — unlike companies — no schema change
  // was needed here; this was already correct.
  const staleFounders = rows.filter((f) => {
    const lastTouch = new Date(f.reviewed_at ?? f.first_seen_at).getTime();
    return now - lastTouch >= SEVEN_DAYS_MS;
  });
  const stale = buildBreakdown(staleFounders.map((f) => f.vertical));

  // Hot: inherited from the associated company's score — founders carry
  // no fit score of their own, the same inheritance the task specifies
  // for vertical. Rejected candidates are excluded here specifically:
  // a dismissed candidate is not a live prospect regardless of its
  // company's score.
  const scores = latestScoresForAllCompanies();
  const hotFounders = rows.filter((f) => {
    if (f.review_decision === 'rejected') return false;
    const s = scores.get(f.company_id);
    return !!s && !s.provisional && s.score >= HOT_THRESHOLD;
  });
  const hot = buildBreakdown(hotFounders.map((f) => f.vertical));

  return { lastRun, discoveredThisWeek, awaitingReview, stale, hot, cumulative };
}

export function computeExecutiveKpis(now: number = Date.now()): ExecutiveKpis {
  const errors: string[] = [];
  let companies: EntityKpis | null = null;
  let founders: EntityKpis | null = null;

  try {
    companies = computeCompanyKpis(now);
  } catch (e) {
    errors.push(`companies: ${(e as Error).message}`);
  }
  try {
    founders = computeFounderKpis(now);
  } catch (e) {
    errors.push(`founders: ${(e as Error).message}`);
  }

  return {
    companies,
    founders,
    lastUpdated: new Date(now).toISOString(),
    partial: errors.length > 0,
    errors,
  };
}

/**
 * Time-filtered Cumulative for the breakdown modal's period selector.
 * Always a fresh query against the FULL database — never a client-side
 * filter of already-loaded rows, per the requirement that period
 * filtering reflect the complete dataset. Filters by the record's
 * EFFECTIVE SOURCING/DISCOVERY date only (see periodBounds' doc comment
 * on shared/executiveKpis.ts for the exact UTC boundaries) — never
 * review, refresh, enrichment, or scoring dates.
 */
export function computeCumulativePeriod(entity: 'companies' | 'founders', period: CumulativePeriod, now: number = Date.now()): CumulativePeriodResult {
  const db = getDb();
  const { from, to } = periodBounds(period, now);
  const fromMs = from ? new Date(from).getTime() : null;
  const toMs = to ? new Date(to).getTime() : null;
  const inPeriod = (t: number) => (fromMs === null || t >= fromMs) && (toMs === null || t < toMs);

  if (entity === 'companies') {
    const rows = companyRows(db).filter((c) => !!c.discovery_source);
    const filtered = rows.filter((c) => inPeriod(companyDiscoveryMs(c)));
    return { ...buildBreakdown(filtered.map((c) => c.vertical)), period, from, to };
  }
  const rows = founderRows(db);
  const filtered = rows.filter((f) => inPeriod(new Date(f.first_seen_at).getTime()));
  return { ...buildBreakdown(filtered.map((f) => f.vertical)), period, from, to };
}

export { CORE_VERTICAL_IDS };
