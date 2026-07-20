# Technical Handoff

Written 2026-07-18 at the end of Phase 8; updated 2026-07-19 through Phase
10. This is the single document meant to bring a new engineer (human or
Claude Code) from zero to productive. It assumes no prior context beyond
what's in this repo. For phase-by-phase history of *how* the app got here,
see `IMPLEMENTATION_STATUS.md`. For an honest list of what's not done, see
`KNOWN_LIMITATIONS.md`. For what's actually been proven against real
external services, see `LIVE_READINESS.md`. For a security/IT reviewer's
version of the architecture, see `PLIANCY_SECURITY_REVIEW.md`.

## What this platform is

An internal VC deal-sourcing dashboard for VamosVentures. It helps a small
team: discover early-stage companies from public sources, score them against
the firm's investment thesis with a fully explainable model, track a
lightweight review status per company, optionally sync approved companies to
HubSpot, and optionally draft (never send) founder outreach emails in
Outlook. It also runs a "Stealth Founder Radar" that records *hypotheses*
about people who might be building something, built only from information
they chose to publish, always labeled unverified.

## What this platform explicitly does NOT do

- **It does not send email.** The only mail action anywhere in the codebase
  is "Save to Outlook Drafts." A human sends from their own mailbox.
- **It does not scrape LinkedIn, PitchBook, or Crunchbase.** Any request
  that references them by name is rejected with a 422, everywhere.
- **It does not infer demographic identity.** Latino-led/female-led/etc.
  indicators require a self-identification basis and a named source or they
  are rejected by the schema before they ever reach the database.
- **It does not auto-approve, auto-reject, auto-sync, or auto-contact
  anything.** Every discovery run leaves candidates in a human review queue.
  Every HubSpot sync and every Outlook draft is a deliberate, explicit user
  action.
- **It is not a full CRM.** The company-status lifecycle has 7 values plus
  one computed "Stale" overlay — no pipelines, no assignment, no SLAs.
- **It does not have per-user accounts.** A single shared `ADMIN_PASSWORD`
  now gates every administrator-plane action (Phase 9) — see
  `KNOWN_LIMITATIONS.md` for exactly what that does and doesn't cover.

## Folder structure

```
.
├── server/
│   ├── index.ts             entrypoint: boots createApp(), starts scheduler if enabled
│   ├── app.ts                Express app factory: middleware, routers, sanitized error handler
│   ├── env.ts                 Zod-validated environment; integration-configured?() helpers
│   ├── db/
│   │   ├── client.ts          SQLite connection (node:sqlite, WAL mode); getDbPath()/closeDb() for backup/restore + shutdown
│   │   ├── migrations.ts      versioned forward-only migrations (v1–v5); latestMigrationVersion() for /health/ready
│   │   └── repos/
│   │       ├── companies.ts   company/founder/evidence CRUD + computed status/stale view (reads stale settings live)
│   │       └── operations.ts  runs, review decisions, scoring, config key/value store, locks, stale/backup settings
│   ├── sourcing/               pluggable discovery pipeline building blocks
│   │   ├── adapters/           one file per live source (github, sec, sbir, rss, ycombinator, arxiv, producthunt)
│   │   ├── types.ts, errors.ts, validate.ts, normalize.ts, dedupe.ts, enrich.ts, runlog.ts (+ durationMs)
│   │   └── index.ts            adapter registry + getSourceMeta() (live/credentials-required/planned/unavailable)
│   ├── services/                business logic consumed by routes
│   │   ├── discovery.ts         runDiscovery(): the full sourcing pipeline + run-lock + filters
│   │   ├── companyRefresh.ts    refreshCompanyResearch(): real per-company live research refresh (Phase 10)
│   │   ├── sourceAnalytics.ts   computeSourceAnalytics(): aggregates persisted run history (Phase 10)
│   │   ├── backup.ts            VACUUM INTO backup/restore, retention, integrity checks (Phase 10)
│   │   ├── schedule.ts          scheduled jobs, cadence tick loop, runJobNow(), stopScheduler()/schedulerRunning()
│   │   ├── imports.ts           CSV import + validation guardrails + bulk status changes
│   │   ├── hubspot.ts, outlook.ts, ai.ts, analysis.ts, refresh.ts, stealth.ts, sources.ts
│   ├── routes/                   one Express router per domain, thin — validate & delegate only
│   │   ├── status.ts, admin.ts, hubspot.ts, outlook.ts, ai.ts, outreach.ts, health.ts
│   │   ├── refresh.ts, discovery.ts, stealth.ts, schedule.ts, portfolio.ts
│   │   ├── duplicates.ts, imports.ts, helpers.ts, auth.ts
│   ├── lib/
│   │   ├── store.ts             legacy JSON-backed KV used for non-relational operational state
│   │   ├── http.ts              fetchWithTimeout/fetchWithRetry + isSafeExternalUrlResolved (SSRF guard, DNS-aware)
│   │   ├── auth.ts              admin session signing/verification + requireAdmin middleware
│   │   ├── guard.ts             audit() with secret redaction, request logging, idempotency guard
│   │   ├── errors.ts            sanitizeErrorForClient() — the one place errors become user-safe
│   │   └── crypto.ts            token-at-rest encryption for OAuth tokens
│   └── tests/                    vitest + supertest; mocks/ and fixtures/ never reachable in prod
├── scripts/
│   ├── db-backup.ts, db-list-backups.ts, db-restore.ts, db-integrity.ts   CLI wrappers around server/services/backup.ts
│   └── smoke-test.ts             starts a real prod-mode server, checks health/frontend/auth, stops it cleanly
├── e2e/                            Playwright end-to-end suite (Phase 10) — isolated backend/frontend/SQLite, never dev data
│   ├── env.ts                     dedicated ports, temp-directory DB, test-only ADMIN_PASSWORD/SESSION_SECRET
│   ├── global-setup.ts / global-teardown.ts   seeds 2 real companies via a real import call; wipes the temp dir after
│   └── auth.spec.ts, discovery.spec.ts, companies.spec.ts, settings.spec.ts, responsive.spec.ts
├── .github/workflows/ci.yml         PRs + pushes to main: typecheck/lint/test/build/e2e, no secrets required
├── Dockerfile, .dockerignore        multi-stage build; runs the full verification chain before assembling the runtime image
├── shared/
│   ├── integrations.ts           Zod schemas + constants shared by frontend & backend (statuses, stale settings, etc.)
│   └── discovery.ts               discovery query/run/candidate schemas
├── src/                            React 19 frontend (Vite, Tailwind v4, React Router, Recharts)
│   ├── pages/                     Overview, Discovery, Companies, StealthRadar, DataSources (Settings)
│   ├── components/                CompanyTable, Schedule, HubSpotModal, Connectors, Ranking, ui,
│   │                               SourceAnalytics, StaleSettingsPanel, ...
│   ├── lib/                       api.ts (typed fetch client), scoring.ts (Vamos Fit Score), crm.ts
│   └── store/                     companies.tsx (React context/state for the company list)
├── .env.example                     every environment variable the code reads, documented inline
├── PLIANCY_SECURITY_REVIEW.md       architecture/data-flow/secrets/risks package for a security reviewer
└── IMPLEMENTATION_STATUS.md, KNOWN_LIMITATIONS.md, LIVE_READINESS.md, TECHNICAL_HANDOFF.md, README.md
```

## Environment variables

See `.env.example` for the authoritative, currently-accurate list (the app
boots with none of them set — everything is simply "not connected"). The dev
server (`npm run dev:server`) actually loads `.env` via Node's
`--env-file-if-exists` flag (fixed in Phase 9 — it silently wasn't loaded at
all before that). Summary:

| Variable | Purpose |
|---|---|
| `FRONTEND_URL` | CORS-allowed origin / OAuth redirect target |
| `ADMIN_PASSWORD` | Gates every administrator-plane action (schedule, connectors, HubSpot/Outlook connect) behind a real session — unset means those actions are unusable, not open |
| `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_PORTAL_ID` | HubSpot private-app auth |
| `HUBSPOT_CLIENT_ID/SECRET/REDIRECT_URI` | HubSpot OAuth app (alternative to a private-app token) |
| `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID/REDIRECT_URI` | Outlook (Microsoft Graph) OAuth app |
| `SESSION_SECRET` | Encrypts OAuth tokens at rest (required for live Outlook) and signs admin session cookies (optional there — falls back to an ephemeral per-process key) |
| `AI_PROVIDER`, `AI_API_KEY` (or `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`), `AI_MODEL` | AI-backed outreach drafting / analysis |
| `GITHUB_TOKEN` | Optional — raises GitHub API rate limits |
| `SEC_CONTACT_EMAIL` | SEC EDGAR asks automated clients to self-identify |
| `FUNDING_NEWS_FEEDS` | Comma-separated RSS feed override for the funding-news source |
| `PRODUCTHUNT_TOKEN` | Product Hunt developer token — the source refuses to run without it |
| `DATABASE_FILE` | SQLite file path (defaults to `server/.data/deal-radar.db`; use `:memory:` in tests) |
| `PORT` | Backend port (default 8787) |
| `RUN_SCHEDULER` | `true` only on a continuously hosted backend — enables the hourly cadence tick |

A freshly-copied `.env.example` ships every key present but blank
(`AI_PROVIDER=`) — `server/env.ts` treats a blank value as unset (Phase 9
fix), so a literal copy boots cleanly instead of crashing on Zod's
`.optional()` rejecting an empty string.

## Database setup & migrations

No manual setup step is required — on boot, `server/db/client.ts` opens (or
creates) the SQLite file at `DATABASE_FILE` (default
`server/.data/deal-radar.db`) and `runMigrations()` applies any migration
whose version isn't yet recorded in the `migrations` table, in a transaction,
forward-only. To reset local dev data:

```bash
rm -f server/.data/deal-radar.db server/.data/deal-radar.db-wal server/.data/deal-radar.db-shm
```

The next boot recreates it from scratch via the full migration chain
(currently v1–v5 — see `server/db/migrations.ts` for exactly what each one
does). There is no separate "migrate" command; migrations run automatically
whenever the server process starts. Before wiping it, consider `npm run
db:backup` instead (see the backup/restore section below).

## Startup commands

```bash
npm install
npm run dev          # frontend (5173) + backend (8787) together, recommended for local work
npm run dev:web       # frontend only
npm run dev:server    # backend only
npm start             # production mode: NODE_ENV=production, serves the built dist/ from the backend
npm test              # vitest — 242 tests across 22 files
npm run test:e2e      # Playwright — 26 tests, isolated backend/frontend/SQLite, real Chromium
npm run test:e2e:ui   # Playwright's interactive UI runner
npm run lint          # oxlint
npm run typecheck     # tsc -b (app + node + server project references, incl. scripts/)
npm run build         # typecheck + production Vite build
npm run preview       # serve the production build locally
npm run smoke-test    # starts a real prod-mode server, checks health/frontend/401-gating, stops it cleanly
npm run db:backup           # create a timestamped VACUUM INTO snapshot
npm run db:list-backups     # list backups + metadata
npm run db:integrity        # PRAGMA integrity_check on the active database
npm run db:restore -- <file> --yes   # CLI-only restore (see below) — never a browser button
```

## How live sourcing works

1. A **discovery query** (vertical, stage, geography, keywords, max results,
   evidence-recency threshold, sources, mode) is submitted either from the
   Deal Discovery page (ad hoc) or a saved schedule (`server/services/
   schedule.ts`).
2. `runDiscovery()` (`server/services/discovery.ts`) takes a persisted,
   process-wide lock so only one run — manual, scheduled, or an admin's
   "Run sourcing now" — executes at a time; a lock older than 15 minutes is
   treated as abandoned. Restricted-source names (LinkedIn/PitchBook/
   Crunchbase) are rejected before anything else runs.
3. For each requested source, `runSource()` (`server/services/sources.ts` →
   `server/sourcing/index.ts`) dispatches to that source's adapter if one
   exists, or returns zero results with an honest "no adapter configured"
   detail if it doesn't.
4. Every candidate is normalized, Zod-validated, checked against the query
   filters (vertical/stage/geography/confidence/evidence-recency/stale-only),
   checked for duplicates against existing companies (`sourcing/dedupe.ts`),
   and — if it matches an already-accepted candidate from a different
   source in the same run — merged into that candidate's evidence instead
   of creating a second row (`sourcing/enrich.ts`).
5. Everything that survives lands in a **candidate preview** for human
   review — nothing is auto-imported. A human explicitly imports selected
   candidates (`POST /api/companies/import-csv` or the discovery import
   route), which creates them with `review_status = 'New'`.
6. The run's full detail — start time, end time, sources queried, results
   retrieved, companies created/updated, duplicates identified, records
   filtered by policy, errors, and final status — is persisted to
   `source_runs`/`source_run_results` and shown in Settings → "Sourcing runs
   (persisted history)".

## Live sources currently working (real requests succeed)

GitHub public API, SEC EDGAR Form D full-text search (parses real filings
into candidates — company name, CIK, filing-index URL, business state, filing
date, not just a reachability ping), Y Combinator public directory, public
funding-news RSS, SBIR/STTR government awards API, and (added Phase 9) arXiv's
public search API. See `LIVE_READINESS.md`
for what "working" was actually verified against.

## Source-availability states (Phase 10)

Every source now has one explicit `state` from `getSourceMeta()`
(`server/sourcing/index.ts`), computed fresh on every call (not cached) so a
credential added at runtime reflects immediately:

- **`live`** — a real adapter exists and no credential is required (github,
  sec, grants, funding-news, yc, research, user-uploaded CSV).
- **`credentials-required`** — a real adapter exists but needs a token that
  isn't currently set (product hunt, until `PRODUCTHUNT_TOKEN` exists).
- **`planned`** — no adapter exists yet; shown, but never selectable as if
  it worked (accelerator/fellowship sites, hackathon/demo-day sites, state
  registries, licensed data).
- **`unavailable`** — not a discovery source at all, or confirmed to have no
  usable API (company websites — that's a refresh-check, not discovery;
  patent databases — PatentsView's key-free API is confirmed retired, see
  Phase 9's finding).

Discovery, Schedule, Settings, and the source-analytics table all read from
this one function — there is exactly one place that decides what "live"
means for a source, not several UI-level guesses.

## Sources requiring credentials or not yet adapted

- **GitHub**: works unauthenticated at low rate limits; `GITHUB_TOKEN`
  raises them (optional, not required).
- **SEC EDGAR**: works without credentials, but the SEC asks automated
  clients to self-identify — set `SEC_CONTACT_EMAIL`.
- **arXiv**: works without credentials — key-free, live-verified. Only
  creates a candidate when a paper lists an author affiliation (rare); an
  honest zero is the common, expected outcome.
- **Product Hunt**: requires `PRODUCTHUNT_TOKEN` (a developer token from
  producthunt.com/v2/oauth/applications); refuses to run without one. The
  endpoint is confirmed reachable but the adapter hasn't been exercised
  against a real token from this environment — treat as "implemented,
  awaiting credentials."
- **HubSpot / Outlook / AI provider**: fully implemented, require real
  credentials to go live (see the Environment table above and
  `LIVE_READINESS.md`).
- **No adapter yet** (return zero results honestly, regardless of whether
  they're checked in the schedule UI): accelerator/fellowship sites, patent
  databases (PatentsView's key-free API was checked in Phase 9 and found
  retired — see `KNOWN_LIMITATIONS.md` for what to check before adapting
  this one), hackathon/demo-day sites, state registries, licensed data.

## How to add another source adapter

0. **Verify the endpoint is real, current, and reachable before writing any
   parsing code** — `curl` it, check the response shape, confirm auth
   requirements. Phase 9's patents attempt is the cautionary example: the
   previously-known key-free PatentsView API turned out to have been
   retired (redirects to a USPTO transition-guide page; the newer host
   doesn't even resolve in DNS). Shipping an adapter against a guessed
   schema for an API you haven't confirmed works risks either fabricating
   data or silently always failing — both violate this codebase's core
   "never guess, never simulate" rule.
1. Create `server/sourcing/adapters/<name>.ts` exporting a `SourceAdapter`
   (see `server/sourcing/types.ts` for the interface — it takes a
   `DiscoveryQuery` and a remaining API-call budget, returns raw candidates
   plus `{ mode: 'live' | 'failed', detail, apiCalls, failureKind? }`).
2. Use `fetchWithTimeout`/`fetchWithRetry` from `server/lib/http.ts` for the
   outbound call — never bare `fetch()` — so the new source inherits the
   existing 10s timeout and single-retry-on-429/5xx behavior automatically.
3. Only use an official API or a feed published for automated consumption.
   Never bypass a login wall, paywall, CAPTCHA, robots.txt, or rate limit.
4. Register the adapter in `ADAPTERS` and add its `SourceMeta` entry (name,
   `liveCapable: true`, what credentials/network access it needs) in
   `server/sourcing/index.ts`.
5. Add it to `DiscoverySourceId` in `shared/discovery.ts` if it's new.
6. Write a test in `server/tests/sourcing.test.ts` with the network call
   stubbed (never hit the real endpoint from tests).
7. Run `npm test && npm run typecheck && npm run lint && npm run build`
   before considering it done.

## Scoring methodology — Vamos Fit Score v3.0

Deterministic, 100-point weighted model (`src/lib/scoring.ts`), displayed as
1.0–10.0 with a full point-by-point rationale:

| Component | Points |
|---|---|
| Thesis / vertical fit | 20 |
| Stage fit | 15 |
| Mission alignment (verified identity only) | 15 |
| Traction signal | 10 |
| Founder & team evidence | 10 |
| Geography | 10 |
| Funding evidence | 5 |
| Accelerator / institutional validation | 5 |
| Evidence quality | 5 |
| Evidence recency | 5 |

Every score snapshot also records a separate **evidence confidence**
percentage — how well-sourced the record is, independent of thesis fit — and
is versioned (`scoring_results.version`) so historical snapshots remain
interpretable even if the model changes later. Mission alignment scores 0
without a verified basis; nothing is ever inferred from a name, photo, or
geography. Invariants (weights sum to 100, every component explains itself,
version is recorded) are tested in `server/tests/scoring.test.ts`.

## Company-review workflow (not a CRM)

Every company has one status from `COMPANY_STATUSES`
(`shared/integrations.ts`): **New → Awaiting Review → Research Needed →
Approved for HubSpot → Synced to HubSpot**, or a side-branch to **Monitor**
or **Passed**. Plus a computed, never-stored **Stale** flag for any
non-terminal company whose `last_refreshed`/`discovered_at`/`created_at` is
older than an **admin-configurable threshold** (Settings → "Stale-record
settings", `staleAfterDays` 1–365, default 30 — see `getStaleSettings()`/
`setStaleSettings()` in `server/db/repos/operations.ts`; changes apply
immediately, no restart needed). From the expanded company fact sheet a
reviewer can: **Mark reviewed** (stamps today's date, no status change, no
re-query), **Refresh live research** (see below), **Send for research**,
**Monitor**, or **Pass** — plus the existing **Approve & add to HubSpot**
(sets status and opens the sync modal in one action) and **Generate founder
outreach**. Every transition is recorded in `review_decisions` and the
system audit log. `Synced to HubSpot` is set automatically **only** by a
confirmed successful HubSpot sync — it's the one status transition allowed
to happen without a human clicking a status button, because it reflects a
fact, not a guess.

### Refresh live research (Phase 10) — distinct from "Mark reviewed"

`POST /api/companies/:id/refresh-research` (`server/services/
companyRefresh.ts`, rate-limited 20/min) is a **real** re-verification, not a
timestamp bump:

1. Loads the company's normalized identity and queries only
   company-level-capable sources (`github`, `sec`, `grants`, `yc`,
   `funding-news`, `research`, `producthunt`) within the usual API-call
   budget.
2. Matches returned candidates back to this company via the same identity
   logic used elsewhere (`server/sourcing/identity.ts`).
3. New evidence is **appended**, never replacing existing evidence
   (URL-deduped, same as every other evidence-writing path).
4. Field-by-field changes go through the **existing** provenance guard
   (`applyFieldUpdate`) — a refresh can never overwrite a verified or
   user-entered value with a weaker extracted/AI-inferred one. A field the
   guard refuses to update is reported back as a **conflict**, not silently
   dropped.
5. **Founder names found during a refresh are never auto-merged** — they're
   only surfaced as `newFounderNamesFound`, requiring a human to add them
   deliberately. Founders are treated as identity-sensitive throughout this
   codebase; this refresh path is no exception.
6. The score is recomputed and saved as a new versioned snapshot
   (`scoreCompany()` + `saveScore()`), and `last_refreshed` is updated.
7. The response (`RefreshResearchResult`) distinguishes: new evidence,
   updated fields, conflicting fields, unchanged-field count, new founder
   names found, which sources ran/failed/were skipped, fields requiring
   human review, and old vs. new score — rendered in the UI as a "What
   changed" panel right where the action was triggered.

### Bulk review-queue actions (Phase 10)

`CompanyTable.tsx` supports selecting multiple companies and applying one
bulk status change (Pass / Monitor / Research Needed / Awaiting Review) with
a confirmation step and a result summary (updated vs. skipped counts) —
backed by `POST /api/companies/bulk-status` (`server/routes/imports.ts`, max
200 ids/request). **HubSpot-bound statuses are not in the allowed list at
all** — there is no way to bulk-sync to HubSpot, by design; that stays an
individual, deliberate action per company. A company already `Synced to
HubSpot` is silently skipped, never force-changed, even inside a bulk
request. Every change in the batch gets its own `review_decisions` row and
audit-log entry — a bulk action is not a single opaque event.

New filters (possible-duplicate only, missing-information only, minimum
evidence confidence, "not reviewed in N days") and sort modes (Fit Score /
evidence recency / discovery date) live alongside the bulk toolbar. The
possible-duplicate badge/filter is wired to the `possible_duplicates`
table and `/api/duplicates` routes that existed since Phase 4 but had no
frontend surface until this phase.

## Source-quality analytics (Phase 10)

`server/services/sourceAnalytics.ts` → `computeSourceAnalytics()` aggregates
**only already-persisted** `source_runs`/`source_run_results` rows — no new
tracking, nothing fabricated. Exposed as `GET /api/admin/source-analytics`
and a Settings table: total/successful/failed/skipped runs, failure rate,
average response time (per-source `duration_ms`, added via migration v5),
results retrieved/imported, companies eventually approved/synced, average
Vamos Fit Score of imported companies, most recent successful/failed run. A
source showing all zeros has simply never been selected in a run yet — say
so, don't leave it ambiguous.

## Backup and restore (Phase 10)

`server/services/backup.ts` uses SQLite's `VACUUM INTO` to produce one
consistent, WAL-safe snapshot file (plus a JSON metadata sidecar — counts
and timestamps only, never row contents) in a sibling `backups/` directory,
never inside the active database path. Retention (`maxBackups` 1–500,
default 14; `maxBackupAgeDays` 1–3650, default 30 — admin-configurable via
`PUT /api/admin/backup-settings`) prunes after every successful backup. A
file lock prevents two backup jobs from overlapping.

**Restore is deliberately CLI-only — there is no restore button anywhere in
the browser UI:**

```bash
npm run db:restore -- deal-radar-2026-07-19T12-00-00.000Z.db --yes
```

`scripts/db-restore.ts` requires `--yes`, does a best-effort `/health/live`
check and warns if the backend still appears to be running, validates the
target file's SQLite header and `PRAGMA integrity_check`, takes an automatic
safety backup of the *current* database before touching anything, replaces
the active file, clears any stale `-wal`/`-shm` sidecars, re-runs the
integrity check, and **automatically rolls back to the safety backup** with
a clear error message if that post-restore check fails. Admin routes exist
for listing/creating/locating backups (`GET/POST /api/admin/backups`, `GET
/api/admin/backups/:file/metadata`, `GET /api/admin/backups/:file/location`)
but intentionally not for restoring one.

## Deployment preparation (Phase 10 — prepared, not performed)

- **Health endpoints** (`server/routes/health.ts`, mounted at bare paths,
  never rate-limited or gated): `GET /health/live` (process is up) and `GET
  /health/ready` (real `SELECT 1`, migration-version check, config parse
  check; reports HubSpot/Outlook/AI/GitHub/Product Hunt connection state as
  **informational only** — it never blocks readiness on an optional
  integration not being configured).
- **Graceful shutdown** (`server/index.ts`): on `SIGTERM`/`SIGINT`, stops
  the scheduler's tick, lets in-flight requests finish (bounded by a 10s
  force-exit timer), closes the HTTP server, closes the database
  (`closeDb()`), flushes the legacy KV store, then exits.
- **Production start**: `npm start` runs `NODE_ENV=production tsx
  --env-file-if-exists=.env server/index.ts`; `server/app.ts` serves the
  built `dist/` directly when present (a clear 503, never a silent 404, if
  it's missing under `NODE_ENV=production`).
- **Dockerfile + .dockerignore**: multi-stage (`node:24-slim`) — the build
  stage runs the full verification chain before the runtime image is
  assembled; the runtime stage runs as a non-root user, exposes only the
  app port, declares a volume for the SQLite data directory, and has a
  `HEALTHCHECK` against `/health/live`. **Not built or run in this
  environment** — `docker` isn't installed here; the Dockerfile is
  implemented but its build is unverified. Say so exactly this way if asked
  — don't claim it was tested.
- **`npm run smoke-test`** (`scripts/smoke-test.ts`) was actually executed
  in this environment: builds the frontend if missing, starts a real
  prod-mode server on an isolated port/database with **no**
  `ADMIN_PASSWORD` (proving the fail-closed behavior), checks both health
  endpoints, checks the frontend loads, checks an unauthenticated admin
  route 401s, and stops the server via `SIGTERM`.
- No hosting provider has been chosen. See `PLIANCY_SECURITY_REVIEW.md` for
  the specific review decisions being requested before that happens.

## HubSpot workflow

Settings → HubSpot card → Test connection (or Connect via OAuth) → map
pipeline stages (blocked until every status in use has a mapped stage — no
stage ID is ever guessed) → from a company's fact sheet, **Approve & add to
HubSpot** opens a review modal showing exactly what will be sent → on
confirm, `performSync()` runs the full duplicate-check ladder (radar ID →
domain → name → founder email against HubSpot contacts) before creating
anything, records the outcome (success or failure) in
`hubspot_sync_history`, and on success sets the company's status to `Synced
to HubSpot`. Failed syncs appear in a retry queue (Settings → "HubSpot
failed synchronizations") with a stored payload so they can be retried
without re-entering data.

## Outlook draft workflow

Settings → Outlook card → Connect Outlook (OAuth, Entra app required) → from
a company's fact sheet, **Generate founder outreach** creates a draft (AI
provider if configured, otherwise a labeled local template built only from
verified facts) → **Save to Outlook Drafts** creates a real draft in the
connected mailbox and links it (`webLink`) → a human reviews and sends it
themselves from Outlook. There is no send path in the codebase. Draft status
can be checked (`GET /api/outlook/drafts`) to confirm a draft still exists;
this does not confirm it was sent or replied to.

## Troubleshooting

- **"This integration is not connected"** on any action → the relevant
  environment variables aren't set. Check Settings → Integrations for the
  exact missing credential name; nothing is silently simulated.
- **A sourcing run returns `409` immediately** → another run (manual,
  scheduled, or run-now) is already in progress; wait, or check Settings →
  Sourcing runs for a run stuck past its expected duration (the lock
  self-clears after 15 minutes if truly abandoned).
- **A CSV row silently doesn't appear after import** → check
  `report.skipped` in the import response; the most common cause is a field
  failing its Zod minimum-length constraint (e.g. `oneLiner`/founder
  `background` under 3 characters) — validation failures are silent skips,
  by design, not errors that abort the whole file.
- **HubSpot sync fails immediately in a real portal** → the `vamos_*`
  custom properties likely don't exist yet in that portal; create them
  first (see the README's recommended property set).
- **Scheduled jobs never run automatically** → `RUN_SCHEDULER` is `false`
  (the default) or the backend process isn't staying up continuously. The
  UI's "Configured but inactive" label is accurate, not a bug.
- **Typecheck/build fails after adding a new shared schema field** →
  `shared/*.ts` types are consumed by both `tsconfig.app.json` (frontend)
  and `tsconfig.server.json` (backend); run `npm run typecheck` (which runs
  `tsc -b` across all project references) rather than checking one side
  only.

## Pliancy / firm security review requirements

**No security approval from Pliancy (or any firm security reviewer) has been
sought or granted for this codebase.** Nothing in this repo or its
documentation should be read as claiming that approval.
`PLIANCY_SECURITY_REVIEW.md` (Phase 10) is the formal package prepared to
request that review — architecture, a data-flow inventory, the external-
systems/secret inventories, security controls, known risks, and eleven
specific review decisions. Before any shared, externally-reachable, or
production deployment, the following need a real security review — not just
the read-only self-audits already performed in Phase 8, Phase 9, and Phase
10 (see `IMPLEMENTATION_STATUS.md`):

1. **Authentication** — Phase 9 added a real gate (`server/lib/auth.ts`:
   signed HttpOnly session cookie, `requireAdmin` middleware, fail-closed
   without `ADMIN_PASSWORD`), verified in this repo's own tests and in a
   live browser pass. It has **not** had outside security review — it's a
   single shared password with no rate-limit beyond a basic 10-attempts/15-min
   limiter on `/api/auth/login`, no MFA, no per-user accounts, and no
   password rotation/strength enforcement. Treat it as a meaningful
   improvement over "nothing," not as reviewed-and-approved.
2. **HubSpot integration** — token storage, scope minimization, and the
   duplicate-check ladder should be reviewed against the firm's CRM data
   handling policy before it touches a real portal.
3. **Outlook/Microsoft Graph integration** — OAuth consent scope,
   token-at-rest encryption (`SESSION_SECRET`-derived key), and mailbox
   access boundaries should be reviewed before connecting a real mailbox.
4. **AI provider integrations (Anthropic/OpenAI)** — what data leaves the
   system in prompts (company facts, evidence) should be reviewed against
   the firm's data-sharing policy before enabling a real API key.
5. **SSRF guard** (`server/lib/http.ts#isSafeExternalUrlResolved`) — Phase 9
   made it DNS-resolution-aware (rejects a hostname that resolves to a
   private/internal IP), but the resolved address isn't pinned for the
   actual fetch, so a narrow TOCTOU window remains; not proven against real
   DNS-rebinding attack tooling.
6. **Hosting/deployment environment** — secrets management, network
   exposure, and backup/durability of the SQLite file (or a migration to a
   managed database) need a real infrastructure review once a hosting
   target is chosen.

## Safe vs. sensitive areas of the codebase

**Safe to change freely** (low blast radius, well-tested):
- `src/pages/*`, `src/components/*` — UI only; the API contracts they call
  are typed and Zod-validated on both ends, so a mismatch fails loudly.
- `server/sourcing/adapters/*` — each adapter is isolated; a bug in one
  can't corrupt another (partial failures are caught and logged per-source).
- `src/lib/scoring.ts` — deterministic and heavily tested; changing weights
  or rationale text is low-risk as long as `server/tests/scoring.test.ts`'s
  invariants (weights sum to 100, every component explains itself) still
  hold.
- `server/services/sourceAnalytics.ts` — pure aggregation over already-
  persisted data; can't corrupt anything, only misreport if the aggregation
  logic itself is wrong (covered by tests).
- Documentation files.

**Change carefully, with tests first:**
- `server/db/migrations.ts` — migrations are forward-only and run on every
  boot; a mistake here is felt on every developer's machine and any live
  deployment. Always add a new versioned migration, never edit a past one.
- `server/services/discovery.ts` (`runDiscovery`) — the run-lock, filters,
  and counters are load-bearing for the "no overlapping runs" and "honest
  run-log" guarantees; several tests in
  `server/tests/scheduling-status-security.test.ts` pin this behavior down.
- `shared/integrations.ts` / `shared/discovery.ts` — these types cross the
  frontend/backend boundary; a change here often requires touching both
  sides plus the relevant Zod schema and its tests.
- `server/lib/guard.ts` (audit/redaction) and `server/lib/errors.ts`
  (error sanitization) — these are the two places that decide what
  ever reaches a log or a client response; a regression here could leak a
  secret or a stack trace. Both have dedicated unit tests — keep them green.
- `server/lib/auth.ts` and `server/routes/auth.ts` — session signing,
  password comparison, and the `requireAdmin` gate. A subtle bug here is a
  real authorization bypass, not just a UX issue. Notably: `requireAdmin`
  MUST be applied per-route (or via `router.use()` on a router mounted at
  its OWN path prefix, e.g. `/api/schedule`), never via `router.use()` on a
  router mounted at the shared `/api` prefix — that mistake (made and
  caught during Phase 9) causes the gate to intercept and 401 every request
  reaching Express afterward, not just its own routes, because an
  unauthorized response never calls `next()`. `server/tests/auth.test.ts`
  and the auth-agent usage throughout the test suite pin the correct
  behavior down.
- `server/services/companyRefresh.ts` — the provenance-guard call
  (`applyFieldUpdate`) is what stops a live refresh from overwriting a
  verified fact with a weaker one; don't bypass it with a direct column
  write. Founder-merging logic must stay surface-only (never call
  `replaceFounders()` from this path) — see the section above for why.
- `server/services/backup.ts` — lock ordering and `closeDb()` timing matter
  here (see `IMPLEMENTATION_STATUS.md`'s Phase 10 section for the two real
  bugs this produced before it was fixed); test any change against
  `server/tests/backup.test.ts` before considering it done, and never add a
  browser-facing restore endpoint.

**Do not casually touch:**
- Anything under `server/tests/mocks/` or `server/tests/fixtures/` being
  imported from non-test code — these exist so tests never depend on live
  external services, and must never become reachable from a production code
  path.
- `server/lib/http.ts` (`isSafeExternalUrl`/`isSafeExternalUrlResolved`) —
  don't loosen the private-hostname patterns without understanding the SSRF
  implications; see the security review item above.
- Routers that gate their ENTIRE contents with `router.use(requireAdmin)`
  (`schedule.ts`, `refresh.ts`, `admin.ts`) must stay mounted at their own
  path prefix (`/api/schedule`, `/api/refresh`, `/api/admin`) in `app.ts`,
  never the shared `/api` prefix — see the auth section above for why.

## How a future user should ask Claude Code to modify this project

- **Be specific about scope.** "Add a new discovery source for X" is a
  self-contained, low-risk ask (follow the adapter guide above). "Add
  authentication" or "change the database" are cross-cutting and should be
  scoped as their own phase, with an explicit plan reviewed before
  implementation.
- **State whether the goal is UI-only, backend-only, or both** — most
  features touch `shared/*.ts` schemas on both ends; saying so up front
  avoids a half-finished change.
- **Ask for the full verification loop every time**: `npm test`, `npm run
  typecheck`, `npm run lint`, `npm run build`, and — for anything
  UI-visible — an actual browser check, not just "the code looks right."
  Do not accept a claim of completion if the build fails.
- **Ask explicitly for updated documentation** when a change affects
  anything described in this file, `README.md`, `KNOWN_LIMITATIONS.md`, or
  `LIVE_READINESS.md` — these drift fast if left to catch up later.
- **Never ask for (or accept) a claim of live-verified status without a
  real external request having succeeded.** If credentials aren't
  available, the honest status is "implemented, awaiting credentials," not
  "done."
- **Know which actions are actually gated.** `ADMIN_PASSWORD`-backed
  sign-in protects the administrator plane (schedule, connectors, admin
  status, HubSpot/Outlook connect) — but company-review actions, HubSpot
  sync-company, and Outlook draft-saving are deliberately open to any
  reviewer. Don't assume a UI label alone means something is enforced;
  check whether the route actually has `requireAdmin` before relying on it.
  And it's still one shared password, not per-user accounts.
