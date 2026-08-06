# Sourcing Pipeline Roadmap — Tier 2 (not implemented in this pass)

This is the concrete follow-up plan for the sourcing-volume work explicitly
deferred from the production-readiness pass completed 2026-08-05. It exists so
this remains a named, scoped commitment rather than a vague "future work"
line. Nothing described here has been built yet.

## What this pass DID ship (for context, not part of the roadmap)

- `server/lib/retry.ts` — a shared exponential-backoff-with-jitter helper,
  already wired into `server/sourcing/index.ts`'s `runSource()` dispatcher. It
  retries a `timeout`/`network` failure up to twice before recording the
  source as failed. This is real infrastructure the per-adapter work below
  reuses directly — it is not a placeholder.
- A dedup fix (`server/services/discovery.ts`) so a 'likely' duplicate of an
  already-pending candidate from an earlier run enriches that row instead of
  adding a second pending row.
- `companies.discovery_run_id` / `founder_candidates.discovered_run_id`
  columns, set precisely at creation time, used by the new Executive Overview
  "Last Run" KPIs.

## Why pagination and incremental sync are still missing

Every one of the 8 sourcing adapters (`server/sourcing/adapters/*.ts`) fetches
exactly one page/request per run and re-fetches its full result set from
scratch every time — confirmed by direct code reading, not assumption. This
was correctly scoped OUT of the current pass: doing it properly for all 8
adapters, safely, means real changes to how each adapter talks to a live
external API, which is higher-risk than anything else in this pass and
deserves its own focused review (including, where relevant, re-verifying
against the actual live API rather than just types).

## Per-adapter plan

| Adapter | Current | Change needed |
|---|---|---|
| `producthunt.ts` | Single GraphQL page, `first: min(maxResults,20)`, `after` cursor unused despite the API supporting it | Thread Product Hunt's own `after`/`endCursor` through repeated pages until `maxResults` is reached or the API reports `hasNextPage: false` |
| `github.ts` | Single page, `per_page` capped at 10, no `since` param | Add GitHub search pagination (`page`/`per_page` up to 100) and a persisted `since` cursor (see below) to only ask for repos updated after the last successful run |
| `sec.ts` | Single search page + up to `DETAIL_BUDGET` detail fetches, rolling 540-day window recomputed from `Date.now()` every run | Replace the rolling window with a persisted `lastFilingDateSeen` cursor per run, advanced only on a fully-successful run; add pagination through EDGAR's full-text search result pages |
| `ycombinator.ts` | Single request, no offset/cursor | Confirm whether the underlying directory endpoint supports an offset/page param (undocumented — needs investigation, not assumed); if not, this one may stay single-page by necessity, honestly documented as such |
| `arxiv.ts` | Single request, `start=0` | arXiv's API supports `start`/`max_results` paging — loop until `maxResults` or the feed is exhausted |
| `sbir.ts` | Single page, `rows` capped at 25 | The SBIR awards API supports `start`/`rows` — loop the same way |
| `rss.ts` / `investorNews.ts` | One fetch per configured feed, no paging (feeds don't paginate) | Not a pagination problem — the fix here is incremental sync (below), since re-parsing a full feed every run is the actual inefficiency |

## Incremental sync — the bigger piece

None of the 8 adapters persist a "last synced" marker. Plan:

1. New table `source_cursors (source_id TEXT PRIMARY KEY, cursor_value TEXT,
   updated_at TEXT NOT NULL)` — a nullable-safe additive migration, same
   pattern as this pass's `discovery_run_id` columns.
2. Each adapter's `run()` signature gains an optional `cursor?: string` input
   and returns `nextCursor?: string` in its outcome; `runSource()` reads/writes
   `source_cursors` around the call.
3. Cursor semantics are adapter-specific and must be chosen per source, not
   generically: a filing date for SEC, a repo-updated timestamp for GitHub, an
   arXiv submission id, an RSS item GUID high-water mark for rss/investorNews.
4. Cursor advances ONLY on a run that completed without a failure for that
   source — a partial/failed run must not silently skip records by advancing
   past them.
5. Backfill support: an explicit `--full-resync` flag (CLI + admin-triggered
   option) that ignores the stored cursor for one run, for recovering from a
   suspected gap — never automatic, never silent.

## Concurrent adapter execution

`server/services/discovery.ts`'s `for (const sourceId of q.sources)` loop is
strictly sequential today. Plan: a small bounded-concurrency pool (e.g. 3-4
concurrent adapters) replacing the loop, keeping the existing per-source
try/catch isolation (one adapter's failure already can't affect another's
results — that invariant must survive the change) and the existing
`RequestBudget`/`maxApiCalls` accounting, which currently assumes sequential
decrement and needs to become concurrency-safe (an atomic counter or a
pre-partitioned budget per source).

## Per-source explicit timeout config

Timeouts today are hardcoded per adapter (`fetchWithTimeout(..., 8000)` in
several, per-host values in `politeness.ts` for others) with no single place
to see or tune them. Plan: one `SOURCE_TIMEOUTS: Record<DiscoverySourceId,
number>` config object, defaulted sensibly per source's typical latency,
overridable via environment variable for operators who need to tune it
without a code change.

## Tests this needs (none exist yet for this tier)

- Per-adapter pagination-boundary tests (page N+1 requested only when page N
  was full; stops correctly at `maxResults`).
- Incremental-sync tests: a second run with a stored cursor only re-fetches
  records after that cursor; a `--full-resync` run ignores it.
- Concurrency tests: two adapters' budgets don't cross-contaminate; one
  adapter throwing doesn't cancel the others already in flight.
- Cursor-advance-only-on-success tests: a failed run's cursor doesn't move.

## Sequencing suggestion

1. `source_cursors` table + cursor plumbing through `runSource()` (foundational,
   everything else depends on it existing).
2. Pagination for the 2-3 highest-volume/highest-value adapters first (SEC,
   GitHub, arXiv — each has a real, documented paging mechanism already
   confirmed to exist), each shipped with its own test and before/after
   volume numbers, rather than all 8 at once.
3. Remaining adapters (SBIR, Product Hunt, YC-if-supported).
4. Concurrency pool, once cursor/pagination changes have stabilized — doing
   concurrency first would make debugging any pagination regression harder
   by removing the current sequential, easy-to-reason-about execution order.
5. Per-source timeout config (independent of the above, can land anytime).
