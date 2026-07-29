# Known Limitations

Honest, current as of 2026-07-29 (Phase 14). This is not a marketing document —
it exists so the next engineer or reviewer knows exactly what to double-check
before relying on the app for anything consequential.

## Authentication — now real, but single-shared-password only

Phase 9 closed the "anyone can hit any route" gap: `ADMIN_PASSWORD`
(`.env`) gates a real, signed, HttpOnly session cookie (`server/lib/auth.ts`,
`requireAdmin` middleware) in front of every administrator-plane action —
scheduled sourcing (all of `/api/schedule/*`), connector management and
refresh runs (all of `/api/refresh/*`), the admin status panel
(`/api/admin/status`), and HubSpot/Outlook connect/disconnect/pipeline-mapping.
Without `ADMIN_PASSWORD` set, those actions are entirely unusable (fails
closed), not open. This is still **one shared password for the whole team,
not per-user accounts** — there's no way to tell which admin performed a
given action beyond the `actor` string the client sends (unverified), and
no role beyond "admin" vs. "everyone else." Company-review actions (status
changes, refresh, HubSpot sync-company, Outlook drafts) remain intentionally
open to any user, matching the product's original "reviewer, not admin"
design — see `TECHNICAL_HANDOFF.md` for the exact route-by-route breakdown.
Real per-user accounts are the natural next step before a larger team joins.

## Persistence

- SQLite (`node:sqlite`, WAL mode) at `server/.data/deal-radar.db` — good for
  one team on one machine/VM, not a distributed deployment. There's no
  connection pooling story or read-replica story; a real production
  deployment behind multiple app instances would need Postgres.
- Migrations are forward-only and run automatically on boot
  (`server/db/migrations.ts`). There's no rollback tooling — a bad migration
  needs a manual fix or a restore from backup.
- **Backup/restore tooling added in Phase 10** (`server/services/backup.ts`,
  `npm run db:backup` / `db:list-backups` / `db:restore` / `db:integrity`):
  `VACUUM INTO` snapshots with retention (default: 14 files or 30 days) live
  in a local `backups/` directory next to the active database. This is
  **local-disk-only** — there is still no automated *offsite/cloud* backup
  destination, and no automated schedule that triggers `db:backup` on a
  cadence (it must be run manually or wired into whatever the hosting
  environment's own job scheduler is). Restore is deliberately a CLI-only
  action (validates the target file, takes an automatic safety backup of
  current data, runs an integrity check before and after, and auto-rolls-back
  on failure) — there is no restore button anywhere in the browser UI, by
  design.

## SSRF protection is resolution-aware now, but still not airtight

`server/lib/http.ts#isSafeExternalUrlResolved` (used by the `websites`
refresh connector) does the literal hostname check AND resolves the
hostname via DNS, rejecting it if any resolved address is
loopback/private/link-local/cloud-metadata — closing the original gap
where a public-looking hostname that actually pointed at internal
infrastructure would have passed. What's still true: the resolved address
isn't pinned for the actual fetch that follows, so a narrow TOCTOU window
remains if DNS changes between the check and the request. True
DNS-rebinding-proof behavior would require a custom fetch agent that
connects to the exact IP it checked. The plain literal-only
`isSafeExternalUrl` also still exists for callers that can't await a DNS
lookup; don't reach for it over the resolved version for anything that
actually fetches a URL.

## Discovery/sourcing sources

- **Verified live** (Phase 3, re-confirmed against the real health check in
  Settings): GitHub public API, SEC EDGAR Form D full-text search, YC public
  directory, public funding-news RSS, SBIR/STTR awards API. The SEC adapter
  (`server/sourcing/adapters/sec.ts`) parses real Form D filings into
  candidates with company name, CIK, filing-index URL, business state, and
  filing date — not just a reachability ping. (A *separate*, intentionally
  reachability-only connector of the same name exists under Settings →
  "Refresh connectors" — that one is a connectivity test for the dashboard,
  not part of the sourcing pipeline; don't confuse the two.)
- **Added in Phase 9**: **arXiv** (public research publications) — real,
  key-free, live-verified against the actual API. A weak, honestly-labeled
  signal: it only creates a candidate when a paper's `<arxiv:affiliation>`
  field is present (used verbatim, never guessed at from an author's name),
  and most papers omit that field entirely — an honest zero is the common
  outcome, not a bug. **Product Hunt** — real GraphQL client against
  `api.producthunt.com`, confirmed reachable (a real unauthenticated request
  returns Product Hunt's own `invalid_oauth_token` error), but the query
  shape has **not** been exercised against a real `PRODUCTHUNT_TOKEN` from
  this environment — treat it like HubSpot/Outlook/AI ("implemented,
  awaiting credentials") until someone runs it with a real token.
- **Patent databases (USPTO/PatentsView) remain unimplemented, and not for
  lack of trying**: PatentsView's free key-free API was checked during
  Phase 9 and found retired — `api.patentsview.org` now redirects to
  `data.uspto.gov`'s transition guide, and the newer `search.patentsview.org`
  host doesn't resolve in DNS at all from this environment. Rather than ship
  an adapter against a guessed schema for an API that couldn't be confirmed
  working, this source honestly still returns zero results. Whoever picks
  this up next should start by confirming the current, correct USPTO Open
  Data Portal endpoint and its auth requirements before writing any parsing
  code.
- Several other sources listed in the schedule UI's "Enabled sources"
  checklist (accelerator/fellowship sites, hackathon/demo-day sites, state
  registries, licensed data) still have **no adapter implementation** —
  enabling them in a schedule has no effect because `runSource` only
  dispatches to sources that exist in `server/sourcing/adapters/`. They are
  present in the UI as forward-looking configuration, not working
  integrations.
- LinkedIn, PitchBook, and Crunchbase are explicitly rejected (422) anywhere
  they appear in a request — never scraped, by design.

## HubSpot, Outlook, AI providers

All three have complete, real client implementations that have never been
exercised against a live external account from this development environment
— only against stubbed/mocked responses in tests. Each requires:

- **HubSpot**: `HUBSPOT_ACCESS_TOKEN` (or OAuth app credentials) + the
  `vamos_*` custom properties pre-created in the target portal, or writes
  fail on the CRM's side.
- **Outlook**: a real Entra app registration, tenant admin consent for
  delegated `Mail.ReadWrite`/`User.Read`/`offline_access`, and
  `SESSION_SECRET` for token-at-rest encryption.
- **AI**: `AI_PROVIDER` + a real API key. Without one, the app uses a
  labeled deterministic local template — this is intentional, not a bug.

None of these should be marked "Live and verified" until a real request
against a real account has actually succeeded — see `LIVE_READINESS.md`.

## Scheduled sourcing

- Schedules are always stored as configuration and can always be triggered
  on demand via "Run sourcing now" (`POST /api/schedule/:id/run-now`) even
  when the automatic cadence is inactive.
- The automatic cadence only executes when `RUN_SCHEDULER=true` **and** the
  backend process stays running continuously — there is no persistent
  external cron/queue. If the process restarts, an in-flight job is lost
  (not resumed) and the next due-check happens on the next hourly tick after
  restart. This is fine for a single long-running Node process; it is not a
  distributed job scheduler.
- The overlap lock (`discovery-run-lock` in `sourcing_config`) is
  process-wide, not per-job — only one sourcing run (manual, scheduled, or
  admin run-now) can be in flight at a time, by design (shared API rate
  limits and cost budgets). A lock older than 15 minutes is treated as
  abandoned and reclaimed, so a crashed run cannot wedge the system forever.

## Company status lifecycle

- Deliberately not a CRM: seven statuses (New, Awaiting Review, Research
  Needed, Approved for HubSpot, Synced to HubSpot, Monitor, Passed) and one
  computed overlay (Stale). There is no approval workflow, no multi-step
  pipeline, no per-user assignment, and no history/audit trail beyond the
  existing `review_decisions` table and system audit log.
- "Stale" is never a stored status — it's computed at read time from
  `last_refreshed`/`discovered_at`/`created_at` versus an **admin-configurable**
  threshold (Phase 10: `staleAfterDays`, 1–365, default 30, in Settings'
  "Stale-record settings" panel — no code change or restart required to
  change it), and only for companies not already in a terminal status
  (`Passed`, `Synced to HubSpot`) unless the admin has separately toggled
  Monitor/Research-Needed to also count. The per-schedule "Refresh age"
  field controls the *stale-record refresh job type*, and Discovery's
  "evidence-recency" filter is a third, separate concept — all three are
  intentionally independent and could be confused with each other.
- There are now **two distinct** company-level actions, not one: "Mark
  reviewed" (`POST /api/companies/:id/refresh`) just records that a human
  looked at the company again and does not re-run external verification;
  "Refresh live research" (`POST /api/companies/:id/refresh-research`,
  added in Phase 10) actually re-queries company-level-capable public
  sources, merges new evidence, applies field updates through the existing
  provenance guard (never overwriting a verified/user-entered value with a
  weaker one), and recomputes the score. Founder names found during a
  refresh are **never auto-merged** — they're only ever surfaced for a human
  to review, since founder identity is treated as unusually sensitive
  throughout this codebase.
- Bulk review-queue actions (Phase 10: select multiple companies, then
  Pass/Monitor/Research-Needed/Awaiting-Review) are **server-validated**
  against an explicit allow-list that excludes any HubSpot-bound status —
  there is no bulk HubSpot sync anywhere in this codebase, and a company
  already `Synced to HubSpot` is silently skipped (never force-changed) even
  inside a bulk request.

## Deployment (Phase 10 — prepared, not performed)

- Health endpoints (`/health/live`, `/health/ready`), graceful shutdown,
  `npm start`, and a Dockerfile all exist and were exercised via
  `npm run smoke-test` (a real production-mode process was started, probed,
  and cleanly stopped in this environment). **No deployment has actually
  happened anywhere** — no hosting provider is chosen, and the Docker image
  itself has not been built or run, since `docker` is not installed in this
  development environment. Docker configuration implemented — image build
  not verified in this environment.
- SQLite backups are local-disk-only (see the Persistence section above) —
  a real deployment needs a persistent volume for the database file and a
  plan for getting backup snapshots off that volume, neither of which exists
  yet.
- `PLIANCY_SECURITY_REVIEW.md` documents the architecture and requests
  specific review decisions from Pliancy; **no security approval has been
  granted**, and this document does not claim otherwise.

## Rate limiting (test-mode override, worth knowing about)

The global `/api` rate limiter is 300 requests/min/IP in production. It is
raised to 5,000/min **only** when `NODE_ENV=test` (`server/app.ts`) — added
in Phase 10 after the Playwright suite's Settings-page tests (which fire a
few dozen requests per page load) legitimately tripped the production limit
inside one 60-second test run. This does not weaken the production limit;
it only applies when the process is explicitly started in test mode (as the
E2E harness and vitest both do).

## Frontend

- Route-level code-splitting (Phase 9, `React.lazy` + `Suspense` in
  `src/App.tsx`) replaced the single ~817 kB bundle with one chunk per page
  (largest is Overview + Recharts at ~352 kB) — the build no longer warns
  about chunk size. Not pursued further than route-level; a very large page
  could still be split internally if it grows.
- The Settings page now requires a real sign-in (Phase 9) before rendering
  any admin panel — see the Authentication section above.

## Testing

- 242 tests across 22 files, all passing. Integration tests for
  HubSpot/Outlook use in-memory stubs under `server/tests/mocks/` and
  `server/tests/fixtures/`, injected through test-only hooks
  (`__set*ForTests`) that do not exist in any code path reachable by the
  running application.
- **Phase 10 adds a Playwright end-to-end suite** (`e2e/`, 26 tests, `npm run
  test:e2e`) against a fully isolated backend/frontend/SQLite stack — real
  browser automation, not just HTTP-level integration tests. Discovery's spec
  intercepts every third-party network call (`page.route()`), so no live
  GitHub/SEC/etc. traffic occurs during a browser-test run. This closes the
  previous gap ("no end-to-end test suite exists"), but coverage is scoped to
  the workflows in the task list (auth, discovery, company review, settings,
  responsive nav) — it is not exhaustive of every UI interaction.
- **GitHub Actions CI now exists** (`.github/workflows/ci.yml`, Phase 10) and
  runs the full chain (typecheck/lint/test/build/e2e) on every PR and push to
  `main` — but as of this writing it has never actually executed on GitHub's
  infrastructure from this environment (no push access here); every command
  it runs has been verified locally, and the YAML has been syntax-checked,
  but the workflow run itself is unverified until it fires on a real PR.

## Environment loading (fixed in Phase 9, worth knowing about)

The dev server previously never actually loaded `.env` at all — no
`dotenv` call and no `--env-file` flag existed anywhere, so every
credential-dependent behavior in local dev depended on variables being
exported into the shell some other way. `dev:server` now runs with
`--env-file-if-exists=.env` (Node's built-in loader, no new dependency).
A second, related bug surfaced once loading actually worked: a
freshly-copied `.env.example` ships every key present but blank (e.g.
`AI_PROVIDER=`), and blank strings fail Zod's `.optional()` checks
(`""` is not `undefined`) — `server/env.ts` now strips blank-valued keys
before validating, so a literal copy of the example file boots cleanly.

---

## Funding-news (RSS) — what it can and cannot establish

RSS is live and importing real, corroborated opportunities. These are its real
edges.

### Two sectors have no qualified opportunity at all

Future of Work: **0 of 5**. Space Tech: **0 of 5**. This is a genuine shortage,
not a bug and not a placeholder. The pipeline considered 7 FoW candidates and
12 Space Tech candidates; none met the bar. Venus Aerospace was extracted
correctly from a real $90M Series B article and classified `spacetech`, but no
second independent source could be found for it and its website could not be
confirmed (5 candidate domains tried), so it is held as a company lead. The
correct fix is another source family, not a lowered bar.

### Only two source families overall

17 qualified opportunities: 8 regulatory (SEC), 9 press (RSS). The target is
three families per sector. The accelerator family is the obvious third, and
Phase 14 tightened rather than loosened it: a YC batch is now a fundraising
signal only alongside a *verified operating website*, and it is labelled
**"Recent accelerator signal / Financing amount unknown / Current fundraising
not confirmed."** A directory listing is participation in a cohort, and a
cohort is not a raise.

### A common single-word name blocks domain discovery, by design

Companies called *Natural*, *Cascade*, *Enigma*, *Multiverse*, *Antares*,
*Ramp*, *Infinity* are stored as real leads with their real articles, but no
website is guessed for them. A page containing the word "natural" is not
evidence about a company called Natural — a previous run "confirmed"
natural.com and enigma.com on exactly that reasoning. Without a second source
these stay company leads. The word list lives in
`server/sourcing/classify.ts` (`AMBIGUOUS_NAME_WORDS`); it is curated and
auditable rather than inferred, so it is incomplete by construction.

### Cybersecurity and semiconductors have no sector

Real, correctly-extracted rounds — Pangram ($9M), Spur ($200M), Act Security
($60M), AegisAI ($36M), Eliyan ($145M), ZuriQ ($25.5M) — carry no sector,
because none of the seven verticals covers them. They are stored as leads and
excluded from every shortlist. Forcing them into `ai` on the strength of the
word "AI" is exactly the failure the classifier refuses to commit.

### Non-USD amounts are recorded but not converted

A €4M or £10M round is stored with the symbol the source printed and
`amountUsd = null`. No conversion rate is a stated fact, so none is applied.
Amount-based filters and sorts will not see these rounds.

### The pipeline reads feeds, not articles

Only the headline, summary/content, link, date, author, categories, and the
outbound links a publisher puts *in the syndicated content* are used. Article
pages are never fetched. So a round whose amount, round name, or investors
appear only in the article body is recorded with those fields null.

### Rounds without an attributable subject are dropped

21 of 241 articles in the verification run had funding language that could not
be attributed to a named company ("Micron, MediaTek back ChipAgents as AI
startup extends Series A", "Fish Audio makes a splash after raising $52M").
These are reported under `financing-not-attributed` rather than guessed at.

### Two syndicated copies are one source

Independence is counted per publisher, so a story rewritten by one outlet
twice counts once. This is deliberate, and it means a widely-syndicated press
release does not manufacture corroboration.
