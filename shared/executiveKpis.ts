/**
 * Shared response shape for GET /api/overview/kpis — the Executive
 * Overview's ten KPI cards (Companies + Stealth Founders, five each).
 * See server/services/executiveKpis.ts for how each number is computed.
 */

export interface VerticalBreakdown {
  total: number;
  /** Keyed by VerticalId — the 5 APPROVED core verticals only, including zero-count ones. Legacy/unapproved verticals (e.g. 'aoi') and anything unrecognized fold into `unassigned` — see CORE_VERTICAL_IDS in src/data/taxonomy.ts. */
  byVertical: Record<string, number>;
  /** Companies/founders whose vertical isn't one of the 5 approved core verticals — keeps total reconciling exactly. */
  unassigned: number;
}

/**
 * `runLabel` is the human-facing name of what this run actually was —
 * "Company-sourcing run" for companies (a real source_runs discovery
 * run), "Latest enrichment run" for founders (founder candidates are a
 * side effect of company enrichment; there is no dedicated
 * founder-sourcing run in this codebase, and this metric must never
 * imply there is one — see server/services/executiveKpis.ts).
 *
 * Retained in the API even though the Overview cards no longer display
 * it directly (replaced on-screen by "Discovered This Week" per
 * Marcos's updated feedback) — this run metadata remains useful
 * elsewhere (e.g. Source Health) and nothing about computing it changed.
 */
export interface RunAttributedBreakdown extends VerticalBreakdown {
  runId: string | null;
  runType: 'discovery' | 'enrichment';
  runLabel: string;
  runStatus: string | null;
  runCompletedAt: string | null;
  /** True only for a run that completed with some sources failing/skipped — never for Failed/Cancelled (those can't be "the latest completed run" at all). */
  isPartial: boolean;
  /** Count of affected (failed/skipped) sources on a partial run — 0 otherwise. */
  warningCount: number;
  /** Which sources were affected on a partial run — empty otherwise. */
  affectedSources: string[];
}

/** A VerticalBreakdown plus the exact UTC week window it was computed over. */
export interface WeekBoundBreakdown extends VerticalBreakdown {
  /** ISO-8601 week: Monday 00:00:00.000 UTC. */
  weekStart: string;
  /** Exclusive: the following Monday 00:00:00.000 UTC. */
  weekEnd: string;
}

export interface EntityKpis {
  /** Kept for run-metadata consumers other than the Overview cards (see RunAttributedBreakdown doc). */
  lastRun: RunAttributedBreakdown;
  discoveredThisWeek: WeekBoundBreakdown;
  awaitingReview: VerticalBreakdown;
  stale: VerticalBreakdown;
  hot: VerticalBreakdown;
  /** Always the "All Time" figure — see /api/overview/kpis/cumulative for other periods. */
  cumulative: VerticalBreakdown;
}

export interface ExecutiveKpis {
  companies: EntityKpis | null;
  founders: EntityKpis | null;
  lastUpdated: string;
  partial: boolean;
  errors: string[];
}

/**
 * Time filters for the Cumulative breakdown modal. Filtering is always
 * by the record's EFFECTIVE SOURCING/DISCOVERY date — companies:
 * discovered_at (falling back to created_at when absent, documented at
 * the query site); founders: first_seen_at. Never by review, refresh,
 * enrichment, or scoring dates.
 *
 * Boundaries are UTC calendar periods (this codebase has no other
 * timezone convention — every stored timestamp is UTC):
 *   all-time:   no filter.
 *   this-month: [start of the current UTC month, now).
 *   last-month: [start of the previous UTC month, start of the current UTC month).
 *   this-year:  [start of the current UTC year, now).
 *   last-year:  [start of the previous UTC year, start of the current UTC year).
 */
export const CUMULATIVE_PERIODS = ['all-time', 'this-month', 'last-month', 'this-year', 'last-year'] as const;
export type CumulativePeriod = (typeof CUMULATIVE_PERIODS)[number];

export interface CumulativePeriodResult extends VerticalBreakdown {
  period: CumulativePeriod;
  /** Inclusive lower bound (ISO UTC), or null for all-time. */
  from: string | null;
  /** Exclusive upper bound (ISO UTC), or null when the period is open-ended ("to date"). */
  to: string | null;
}
